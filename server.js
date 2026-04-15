require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { v4: uuidv4 } = require('uuid');
const { toFile } = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// In-memory session store
const sessions = new Map();
const sseClients = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '80mb' }));

// --- Upload and kick off processing ---
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const sessionId = uuidv4();
  sessions.set(sessionId, {
    status: 'processing', steps: [], subject: null, error: null,
    _createdAt: Date.now(),
    // Store original image for feedback comparisons
    originalBuffer: req.file.buffer,
    originalMime: req.file.mimetype
  });
  res.json({ sessionId });

  // Fire-and-forget background processing
  processImage(sessionId, req.file.buffer, req.file.mimetype).catch(err => {
    console.error('Processing error:', err);
    const session = sessions.get(sessionId);
    if (session) {
      session.status = 'error';
      session.error = err.message;
    }
    sendSSE(sessionId, { type: 'error', message: err.message });
  });
});

// --- SSE stream for progress ---
app.get('/api/stream/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send a heartbeat comment to open the connection
  res.write(': connected\n\n');

  const session = sessions.get(sessionId);
  if (!session) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Session not found' })}\n\n`);
    res.end();
    return;
  }

  // Replay already-completed steps
  if (session.subject) {
    res.write(`data: ${JSON.stringify({ type: 'analysis', subject: session.subject, totalSteps: session.totalSteps })}\n\n`);
  }
  for (const step of session.steps) {
    res.write(`data: ${JSON.stringify({ type: 'step', step })}\n\n`);
  }
  if (session.status === 'complete') {
    res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
    res.end();
    return;
  }
  if (session.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', message: session.error })}\n\n`);
    res.end();
    return;
  }

  sseClients.set(sessionId, res);

  req.on('close', () => {
    sseClients.delete(sessionId);
  });
});

function sendSSE(sessionId, data) {
  const client = sseClients.get(sessionId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
    if (data.type === 'complete' || data.type === 'error') {
      client.end();
      sseClients.delete(sessionId);
    }
  }
}

// --- Core processing logic ---
async function processImage(sessionId, buffer, mimeType) {
  const session = sessions.get(sessionId);
  const base64Image = buffer.toString('base64');

  // Step 1: Claude analyzes the image — returns step structure only (no DALL-E prompts yet)
  console.log(`[${sessionId}] Starting Claude analysis...`);

  const claudeResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64Image }
        },
        {
          type: 'text',
          text: `You are an expert drawing instructor with a strict content policy. First, moderate the image, then analyze it.

CONTENT POLICY — if the image contains ANY of the following, set "safe": false and leave all other fields empty/null:
- Nudity, sexual content, or sexually suggestive imagery
- Graphic violence, gore, or injury
- Real people in identifiable/private contexts (a generic photo of a recognizable person's face is allowed only if appropriate and not a minor)
- Minors in any suggestive or sensitive context
- Hate symbols, extremist imagery, weapons being used against people
- Illegal activity, drugs, or other inappropriate content for a general-audience learning app

If the image is clean and appropriate for a drawing tutorial, set "safe": true and fill in the tutorial.

Study the WHOLE image closely — the main subject AND the background, scenery, foreground, and any secondary elements. The tutorial must teach the learner to draw the entire picture, not just the main subject in isolation. Note composition, framing, spatial relationships, proportions, and distinctive features of every major element.

Return ONLY valid JSON (no markdown, no code fences) in this exact format:
{
  "safe": true,
  "rejectionReason": null,
  "subject": "concise description of what the image shows",
  "subjectDetail": "2-3 sentences describing the subject's key visual characteristics, proportions, and distinctive features a drawing instructor would note",
  "mood": "one of: playful, elegant, bold, gentle, dramatic",
  "steps": [
    {
      "stepNumber": 1,
      "title": "Basic Shapes",
      "emoji": "🔵",
      "description": "What the learner is achieving in this step (1-2 sentences)",
      "drawingStage": "construction|silhouette|features|details|shading|polish",
      "instructions": [
        "Specific actionable instruction referencing the actual subject",
        "Specific actionable instruction 2",
        "Specific actionable instruction 3"
      ],
      "tip": "A helpful pro tip for this step"
    }
  ]
}

Rules for the steps:
- Create EXACTLY 4 steps — no more, no fewer
- Step 1 (construction): Basic geometric shapes only — circles, ovals, rectangles, lines. No details at all.
- Step 2 (silhouette): Rough outer contour/silhouette following the construction shapes, erase guides
- Step 3 (details): Add the key defining features, textures, and line weight variation specific to this subject
- Step 4 (shading): Full shading, shadows, depth — hatching/cross-hatching to make it look three-dimensional

Instructions must reference the actual subject AND the background/scenery elements (e.g. "Draw a large oval for the cat's body, then a rectangle behind it for the windowsill" not "Draw an oval for the body"). Make sure the tutorial covers the whole composition, not just the main subject.

If "safe" is false, return: { "safe": false, "rejectionReason": "<brief, non-graphic reason>", "subject": null, "subjectDetail": null, "mood": null, "steps": [] }

Return ONLY the JSON object.`
        }
      ]
    }]
  });

  const rawText = claudeResponse.content[0].text.trim();
  let parsedData;
  try {
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    parsedData = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse Claude response: ${e.message}`);
  }

  if (parsedData.safe === false) {
    throw new Error(parsedData.rejectionReason
      ? `This image can't be used: ${parsedData.rejectionReason}. Please try a different photo.`
      : `This image isn't suitable for a drawing tutorial. Please try a different photo.`);
  }

  session.subject = parsedData.subject;
  session.mood = parsedData.mood;
  session.totalSteps = parsedData.steps.length;
  console.log(`[${sessionId}] Analysis complete: "${parsedData.subject}" — ${parsedData.steps.length} steps`);

  sendSSE(sessionId, {
    type: 'analysis',
    subject: parsedData.subject,
    mood: parsedData.mood,
    totalSteps: parsedData.steps.length
  });

  // Step 2: REVERSE generation — generate the final polished drawing first (using the
  // original photo as reference), then progressively strip shading → details → outline,
  // using each generated image as the reference for the next one. This keeps all 4 steps
  // visually consistent with a single evolving drawing.
  const reversePrompts = {
    4: `Create a finished pencil sketch of the ENTIRE scene in the reference image — include every element: the main subject AND the background, surroundings, foreground objects, ground, sky, scenery, and any secondary elements. Preserve the original composition, framing, and spatial relationships exactly. Accurate proportions and likeness throughout. Full graphite shading with a clear light source, cast shadows, mid-tones, and depth using hatching and cross-hatching. Confident varied line weights. Nothing omitted from the reference image — draw the whole picture. Traditional pencil drawing on white paper, tutorial illustration style.`,
    3: `Take the exact pencil drawing shown in the reference image and REMOVE all shading, hatching, and tonal work. Keep every outline, contour, and fine detail of BOTH the main subject AND all background/scenery elements exactly as they are, in the same composition, framing, and spatial layout. Nothing is cropped out or omitted. The result is a clean pencil line drawing of the whole scene with details but no shading. White paper.`,
    2: `Take the exact pencil line drawing shown in the reference image and REMOVE the small interior details, textures, and fine features. Keep the main outer contours/silhouettes of BOTH the subject AND the background elements (scenery, ground, sky, surrounding objects), plus the largest internal dividing lines, in the same full composition and framing. Do not crop or drop any part of the scene. A loose, sketchy outline drawing of the whole picture. White paper.`,
    1: `Take the outline drawing shown in the reference image and REDUCE it to basic geometric construction shapes — circles, ovals, rectangles, and straight centre lines — that map to the major masses and proportions of the ENTIRE scene (main subject AND background/scenery elements). Preserve the same composition and framing as the reference. No outlines, no details, no shading — just a loose ball-and-stick construction skeleton of the whole picture in light pencil on white paper.`
  };

  const stepsByNumber = new Map(parsedData.steps.map(s => [s.stepNumber, s]));
  const generatedUrls = new Map(); // stepNumber -> dataUrl

  let refBuffer = buffer;
  let refMime = mimeType;

  const order = [...parsedData.steps].map(s => s.stepNumber).sort((a, b) => b - a); // 4,3,2,1

  for (const stepNumber of order) {
    console.log(`[${sessionId}] Generating step ${stepNumber} (reverse) with gpt-image-1...`);
    const step = stepsByNumber.get(stepNumber);
    const prompt = reversePrompts[stepNumber] ||
      `Pencil sketch tutorial illustration for step ${stepNumber} ("${step.title}") based on the reference image. ${step.description}. Pencil on white paper.`;

    try {
      const ext = refMime === 'image/jpeg' ? 'jpg' : refMime === 'image/webp' ? 'webp' : 'png';
      const imageFile = await toFile(refBuffer, `reference.${ext}`, { type: refMime });

      const imageResponse = await openai.images.edit({
        model: 'gpt-image-1',
        image: imageFile,
        prompt,
        size: '1024x1024',
        quality: 'high'
      });

      const b64 = imageResponse.data[0].b64_json;
      generatedUrls.set(stepNumber, `data:image/png;base64,${b64}`);

      // Use this generated image as the reference for the next (lower-numbered) step
      refBuffer = Buffer.from(b64, 'base64');
      refMime = 'image/png';
    } catch (imgErr) {
      console.warn(`[${sessionId}] gpt-image-1 failed for step ${stepNumber}:`, imgErr.message);
      generatedUrls.set(stepNumber, null);
    }
  }

  // Emit steps in forward order (1 → 4) so the tutorial plays naturally
  for (const step of parsedData.steps) {
    const stepData = {
      stepNumber: step.stepNumber,
      title: step.title,
      emoji: step.emoji,
      description: step.description,
      instructions: step.instructions,
      tip: step.tip,
      imageUrl: generatedUrls.get(step.stepNumber) || null
    };

    session.steps.push(stepData);
    sendSSE(sessionId, { type: 'step', step: stepData });
    console.log(`[${sessionId}] Step ${step.stepNumber} sent`);
  }

  session.status = 'complete';
  sendSSE(sessionId, { type: 'complete' });
  console.log(`[${sessionId}] Processing complete!`);
}

// --- Drawing feedback endpoint ---
app.post('/api/feedback', upload.single('drawing'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No drawing uploaded' });

  const { sessionId, stepNumber } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const step = session.steps.find(s => s.stepNumber === parseInt(stepNumber));
  if (!step) return res.status(404).json({ error: 'Step not found' });

  const drawingBase64 = req.file.buffer.toString('base64');
  const originalBase64 = session.originalBuffer.toString('base64');

  // Build content: original reference + step illustration (if available) + user drawing
  const content = [
    {
      type: 'image',
      source: { type: 'base64', media_type: session.originalMime, data: originalBase64 }
    }
  ];

  if (step.imageUrl && step.imageUrl.startsWith('data:image/')) {
    // Extract base64 from data URL
    const b64 = step.imageUrl.split(',')[1];
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: b64 }
    });
  }

  content.push({
    type: 'image',
    source: { type: 'base64', media_type: req.file.mimetype, data: drawingBase64 }
  });

  content.push({
    type: 'text',
    text: `You are an encouraging, expert drawing tutor reviewing a student's work.

Image 1: The original reference subject they are learning to draw.
${step.imageUrl ? 'Image 2: The tutorial illustration showing what step ' + stepNumber + ' ("' + step.title + '") should look like.' : ''}
Last image: The STUDENT'S actual drawing attempt at step ${stepNumber} ("${step.title}").

The goal of this step was: ${step.description}

Give warm, specific, actionable feedback in this exact JSON format (no markdown, no code fences):
{
  "score": <number 1-5>,
  "scoreLabel": "<one of: Keep Trying | Getting There | Looking Good | Great Work | Perfect!>",
  "strengths": ["specific thing done well 1", "specific thing done well 2"],
  "improvements": ["one specific, clear, actionable fix"],
  "encouragement": "one warm motivational sentence tailored to what you see",
  "readyForNext": <true if score >= 3, otherwise false>
}

Be generous and encouraging. Even a rough sketch deserves praise for what's right. Keep improvements to ONE clear, focused suggestion. Reference specific things you actually see in their drawing.

Return ONLY the JSON.`
  });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content }]
    });

    const raw = response.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const feedback = JSON.parse(raw);
    res.json(feedback);
  } catch (err) {
    console.error('Feedback error:', err);
    res.status(500).json({ error: 'Could not analyze drawing: ' + err.message });
  }
});

// --- Portfolio ---
const PORTFOLIO_FILE = path.join(__dirname, 'portfolio.json');

function loadPortfolio() {
  try { return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8')); }
  catch { return []; }
}
function savePortfolioFile(entries) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(entries, null, 2));
}

app.get('/api/portfolio', (req, res) => {
  const all = loadPortfolio();
  res.json(all.filter(e => e.isPublic));
});

app.post('/api/portfolio/save', (req, res) => {
  const { subject, steps, isPublic } = req.body;
  if (!subject || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  // Trim to a short display-friendly subject
  const cleanSubject = String(subject).trim().slice(0, 80);

  const entry = {
    id: uuidv4(),
    subject: cleanSubject,
    savedAt: new Date().toISOString(),
    isPublic: isPublic !== false,
    // Only store sketch steps — never the original uploaded image
    steps: steps.slice(0, 8).map(s => ({
      stepNumber: s.stepNumber,
      title: s.title,
      emoji: s.emoji || '✏️',
      imageUrl: s.imageUrl || null
    }))
  };

  try {
    const entries = loadPortfolio();
    entries.unshift(entry);
    savePortfolioFile(entries);
    res.json({ id: entry.id });
  } catch (e) {
    console.error('Portfolio save failed:', e);
    res.status(500).json({ error: 'Could not save portfolio' });
  }
});

// Cleanup old sessions every 30 min (TTL 2 hours)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (!s._createdAt) s._createdAt = now;
    if (now - s._createdAt > 2 * 60 * 60 * 1000) sessions.delete(id);
  }
}, 30 * 60 * 1000);

// --- Error handling ---
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🎨 SketchGuide is running at http://localhost:${PORT}\n`);
});
