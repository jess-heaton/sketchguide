/* =====================================================
   SKETCHGUIDE — Addictive Frontend Logic
   ===================================================== */

// ── State ──────────────────────────────────────────────
const state = {
  file: null,
  sessionId: null,
  subject: '',
  totalSteps: 0,
  completedSteps: 0,
  currentIndex: 0,   // which step is on screen (0-based)
  xp: 0,
  steps: [],         // step data as it arrives
  done: [],          // which step numbers are completed
  sseSource: null,
  allReceived: false
};

// ── DOM refs ───────────────────────────────────────────
const screens     = { home: id('screen-home'), loading: id('screen-loading'), tutorial: id('screen-tutorial'), portfolio: id('screen-portfolio'), detail: id('screen-portfolio-detail') };
const uploadZone  = id('upload-zone');
const uploadCard  = id('upload-card');
const uploadPrev  = id('upload-preview');
const fileInput   = id('file-input');
const previewImg  = id('preview-img');
const prevName    = id('preview-filename');
const removeBtn   = id('remove-image');
const generateBtn = id('btn-generate');
const stepViewer  = id('step-viewer');
const stepDots    = id('step-dots');
const xpCount     = id('xp-count');
const toastEl     = id('toast');
const floatingXp  = id('floating-xp');
const modalOverlay= id('modal-overlay');
const loadingBar  = id('loading-bar');
const loadingPct  = id('loading-pct');
const loadingMsg  = id('loading-message');
const loadPrevImg = id('loading-preview-img');

function id(x) { return document.getElementById(x); }

const ls = {
  1: { el: id('ls-1'), status: id('ls-1-status'), spinner: id('ls-1-spinner') },
  2: { el: id('ls-2'), status: id('ls-2-status'), spinner: id('ls-2-spinner') },
  3: { el: id('ls-3'), status: id('ls-3-status'), spinner: id('ls-3-spinner') }
};

// ── Loading messages (rotate while waiting) ────────────
const LOADING_MESSAGES = [
  'Studying your image...', 'Mapping out the shapes...', 'Planning the drawing steps...',
  'Thinking like an art tutor...', 'Breaking it down beautifully...', 'Almost there — generating step 1...',
  'Painting with pixels...', 'Crafting your first sketch...', 'Building the tutorial...',
  'Making it super clear...', 'Step by step, stroke by stroke...'
];
let msgInterval = null;

// ── Encouragement messages ─────────────────────────────
const ENCOURAGEMENTS = [
  '🔥 You\'re on fire!', '✨ Amazing work!', '🎨 Artist alert!',
  '💪 Keep it up!', '⭐ Nailed it!', '🚀 Crushing it!',
  '👏 Beautiful!', '🌟 Incredible!', '💥 Perfect!',
  '🦄 Legendary!', '🎯 Spot on!'
];

// ── Audio ──────────────────────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, duration, type = 'sine', vol = 0.18) {
  try {
    const ctx = getAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch(e) {}
}
function playStepComplete() {
  playTone(523, .12);
  setTimeout(() => playTone(659, .12), 100);
  setTimeout(() => playTone(784, .2), 200);
}
function playAllComplete() {
  [523,659,784,1047].forEach((f,i) => setTimeout(() => playTone(f, .25, 'triangle', .22), i * 120));
}

// ── Screen switch ──────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([k,el]) => el.classList.toggle('active', k === name));
}

// ── Drag & drop / file pick ────────────────────────────
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadCard.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadCard.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadCard.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) setFile(f);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
removeBtn.addEventListener('click', clearFile);

function setFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast('⚠️ Please upload an image file');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showToast('⚠️ Image is too large (max 20MB)');
    return;
  }
  state.file = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  prevName.textContent = file.name;
  uploadZone.style.display = 'none';
  uploadPrev.style.display = 'block';
  generateBtn.disabled = false;
  // Animate button ready
  generateBtn.style.transform = 'scale(1.04)';
  setTimeout(() => generateBtn.style.transform = '', 200);
}
function clearFile() {
  state.file = null;
  previewImg.src = '';
  uploadZone.style.display = 'flex';
  uploadPrev.style.display = 'none';
  fileInput.value = '';
  generateBtn.disabled = true;
}

// ── Generate ───────────────────────────────────────────
generateBtn.addEventListener('click', async () => {
  if (!state.file) return;
  // Show uploaded image in loading screen
  loadPrevImg.src = URL.createObjectURL(state.file);
  await startTutorial();
});

async function startTutorial() {
  // Reset
  Object.assign(state, { sessionId: null, subject: '', totalSteps: 0, completedSteps: 0, currentIndex: 0, xp: 0, steps: [], done: [], allReceived: false });
  if (state.sseSource) { state.sseSource.close(); state.sseSource = null; }

  showScreen('loading');
  resetLoadingUI();
  startLoadingMessages();
  setLStep(1, 'active');

  const fd = new FormData();
  fd.append('image', state.file);

  let sessionId;
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Upload failed'); }
    const data = await res.json();
    sessionId = data.sessionId;
    state.sessionId = sessionId;
  } catch(err) {
    showError('Upload failed: ' + err.message);
    showScreen('home');
    return;
  }

  setLStep(1, 'done');
  setLStep(2, 'active');
  setProgress(20);
  stepViewer.innerHTML = '';
  connectSSE(sessionId);
}

// ── Loading UI ─────────────────────────────────────────
function resetLoadingUI() {
  [1,2,3].forEach(i => setLStep(i, 'pending'));
  setProgress(0);
}
function setLStep(n, st) {
  const s = ls[n];
  s.el.className = 'loading-step ' + st;
  const labels = { active: 'In progress', done: 'Complete ✓', pending: 'Waiting' };
  s.status.textContent = labels[st];
  if (st === 'done') {
    s.spinner.style.animation = 'none';
  } else if (st === 'active') {
    s.spinner.style.animation = 'spin .8s linear infinite';
  }
}
function setProgress(pct) {
  loadingBar.style.width = pct + '%';
  loadingPct.textContent = Math.round(pct) + '%';
}
function startLoadingMessages() {
  let i = 0;
  loadingMsg.textContent = LOADING_MESSAGES[0];
  msgInterval = setInterval(() => {
    i = (i + 1) % LOADING_MESSAGES.length;
    loadingMsg.style.opacity = '0';
    setTimeout(() => { loadingMsg.textContent = LOADING_MESSAGES[i]; loadingMsg.style.opacity = '1'; }, 300);
  }, 3000);
}
function stopLoadingMessages() {
  clearInterval(msgInterval);
}

// ── SSE ────────────────────────────────────────────────
function connectSSE(sessionId) {
  const src = new EventSource(`/api/stream/${sessionId}`);
  state.sseSource = src;
  src.onmessage = e => handleMsg(JSON.parse(e.data));
  src.onerror = () => {
    src.close();
    if (state.steps.length === 0) { showError('Something went wrong. Please try again.'); showScreen('home'); }
  };
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'analysis':
      setLStep(2, 'done');
      setLStep(3, 'active');
      setProgress(35);
      state.totalSteps = msg.totalSteps;
      state.subject = msg.subject || '';
      // Pre-build dots
      buildDots(msg.totalSteps);
      id('tutorial-subject') && (id('tutorial-subject').textContent = capitalize(msg.subject));
      break;

    case 'step':
      state.steps.push(msg.step);
      const pct = 35 + (state.steps.length / state.totalSteps) * 60;
      setProgress(Math.min(pct, 96));

      // If this is the first step, flip to tutorial screen
      if (state.steps.length === 1 && screens.loading.classList.contains('active')) {
        stopLoadingMessages();
        showScreen('tutorial');
        renderCurrentStep();
      } else {
        // If user is waiting on a generating card for this step, render it now
        updateGeneratingCard(msg.step);
        updateDots();
      }
      break;

    case 'complete':
      stopLoadingMessages();
      state.allReceived = true;
      setProgress(100);
      if (state.sseSource) { state.sseSource.close(); state.sseSource = null; }
      if (screens.loading.classList.contains('active')) {
        showScreen('tutorial');
        renderCurrentStep();
      }
      updateDots();
      break;

    case 'error':
      stopLoadingMessages();
      showError(msg.message);
      showScreen('home');
      if (state.sseSource) { state.sseSource.close(); state.sseSource = null; }
      break;
  }
}

// ── Step dots ──────────────────────────────────────────
function buildDots(total) {
  stepDots.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('div');
    dot.className = 'step-dot locked';
    dot.dataset.index = i;
    dot.addEventListener('click', () => {
      if (state.done.includes(i) || i === state.currentIndex) goToStep(i, i < state.currentIndex ? 'left' : 'right');
    });
    stepDots.appendChild(dot);
  }
  updateDots();
}
function updateDots() {
  const dots = stepDots.querySelectorAll('.step-dot');
  dots.forEach((d, i) => {
    d.className = 'step-dot';
    if (state.done.includes(i)) d.classList.add('done');
    else if (i === state.currentIndex) d.classList.add('active');
    else if (i < state.steps.length) d.classList.add('locked'); // arrived but not done
    else d.classList.add('locked');
  });
}

// ── Render step ────────────────────────────────────────
function renderCurrentStep(direction = 'right') {
  const idx = state.currentIndex;
  const step = state.steps[idx];

  // Clear old cards
  const old = stepViewer.querySelector('.step-card');
  if (old) {
    old.classList.add(direction === 'right' ? 'slide-out-left' : 'slide-out-right');
    old.addEventListener('animationend', () => old.remove(), { once: true });
  }

  if (!step) {
    // Step hasn't arrived yet — show generating card
    showGeneratingCard();
    return;
  }

  const card = buildStepCard(step, idx);
  card.classList.add(direction === 'right' ? 'slide-in-right' : 'slide-in-left');
  stepViewer.appendChild(card);
  updateDots();
}

function buildStepCard(step, idx) {
  const isCompleted = state.done.includes(idx);
  const isLast = idx === state.totalSteps - 1;

  const card = document.createElement('div');
  card.className = 'step-card';
  card.id = `card-${idx}`;

  // Step banner — always obvious which step you're on
  const banner = document.createElement('div');
  banner.className = 'step-banner';
  banner.textContent = `STEP ${step.stepNumber} OF ${state.totalSteps}  ·  ${step.title.toUpperCase()}`;
  card.appendChild(banner);

  // Image section
  const imgSection = document.createElement('div');
  imgSection.className = 'step-img-section';

  const tag = document.createElement('div');
  tag.className = 'step-tag';
  tag.textContent = `Step ${step.stepNumber} of ${state.totalSteps}`;
  imgSection.appendChild(tag);

  if (step.imageUrl) {
    const img = document.createElement('img');
    img.src = step.imageUrl;
    img.alt = `Step ${step.stepNumber} illustration`;
    img.addEventListener('click', () => openZoom(step.imageUrl));
    imgSection.appendChild(img);
  } else {
    const loading = document.createElement('div');
    loading.className = 'step-img-loading';
    loading.id = `img-loading-${idx}`;
    loading.innerHTML = '<div class="img-spinner"></div><p>Loading illustration...</p>';
    imgSection.appendChild(loading);
  }
  card.appendChild(imgSection);

  // Info row
  const info = document.createElement('div');
  info.className = 'step-info';
  const badge = document.createElement('div');
  badge.className = 'step-num-badge' + (isCompleted ? ' complete' : '');
  badge.textContent = isCompleted ? '✓' : step.stepNumber;
  const titleGroup = document.createElement('div');
  titleGroup.innerHTML = `<div class="step-title">${step.emoji || '✏️'} ${esc(step.title)}</div><div class="step-desc">${esc(step.description)}</div>`;
  info.appendChild(badge);
  info.appendChild(titleGroup);
  card.appendChild(info);

  // Body
  const body = document.createElement('div');
  body.className = 'step-body';
  const ul = document.createElement('ul');
  ul.className = 'instructions-list';
  (step.instructions || []).forEach((instr, i) => {
    ul.innerHTML += `<li><span class="instr-bullet">${i+1}</span>${esc(instr)}</li>`;
  });
  body.appendChild(ul);
  if (step.tip) {
    body.innerHTML += `<div class="tip-box"><span class="tip-icon">💡</span><span>${esc(step.tip)}</span></div>`;
  }
  card.appendChild(body);

  // CTA / nav
  if (isCompleted) {
    const nav = document.createElement('div');
    nav.className = 'step-nav';
    if (idx > 0) {
      nav.innerHTML += `<button class="btn-nav" onclick="goToStep(${idx-1},'left')">← Previous</button>`;
    }
    if (!isLast) {
      nav.innerHTML += `<button class="btn-nav next-step" onclick="goToStep(${idx+1},'right')">Next Step →</button>`;
    }
    card.appendChild(nav);
  } else {
    const cta = document.createElement('div');
    cta.className = 'step-cta';
    const btn = document.createElement('button');
    btn.className = 'btn-did-it';
    btn.textContent = isLast ? '🏆 I Drew This! Complete!' : '✓ I Drew This Step!';
    btn.onclick = () => completeStep(idx);
    cta.appendChild(btn);

    // "Check My Drawing" button
    const checkBtn = document.createElement('button');
    checkBtn.className = 'btn-check-drawing';
    checkBtn.innerHTML = '📷 Check My Drawing';
    checkBtn.onclick = () => openFeedbackDrawer(idx);
    cta.appendChild(checkBtn);

    card.appendChild(cta);
  }

  return card;
}

function showGeneratingCard() {
  const card = document.createElement('div');
  card.className = 'generating-card';
  card.id = 'generating-card';
  card.innerHTML = `
    <div class="gen-spinner"></div>
    <div class="gen-title">Generating step ${state.currentIndex + 1}...</div>
    <div class="gen-sub">Creating your illustration ✨</div>
  `;
  stepViewer.appendChild(card);
}

function updateGeneratingCard(step) {
  // If the user is on a generating-card waiting for this step, replace it
  const gen = id('generating-card');
  const idx = step.stepNumber - 1;
  if (gen && idx === state.currentIndex) {
    gen.remove();
    const card = buildStepCard(step, idx);
    card.classList.add('slide-in-right');
    stepViewer.appendChild(card);
    updateDots();
  }
}

// ── Navigate to a step ─────────────────────────────────
function goToStep(idx, direction = 'right') {
  if (idx < 0 || idx >= state.totalSteps) return;
  state.currentIndex = idx;
  renderCurrentStep(direction);
}

// ── Complete a step ────────────────────────────────────
function completeStep(idx) {
  if (state.done.includes(idx)) return;
  state.done.push(idx);
  state.completedSteps++;
  state.xp += 20;

  // Update XP display
  xpCount.textContent = state.xp;
  const pill = id('xp-pill');
  pill.style.transform = 'scale(1.35)';
  setTimeout(() => { pill.style.transform = ''; }, 250);

  // Float XP
  floatXP('+20 ⭐');
  playStepComplete();
  showToast(ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)]);

  updateDots();

  const isLast = idx === state.totalSteps - 1;
  const allDone = state.completedSteps === state.totalSteps;

  if (allDone) {
    setTimeout(() => { showCompletionModal(); }, 900);
  } else if (!isLast) {
    // Auto-advance to next step after brief pause
    setTimeout(() => {
      state.currentIndex = idx + 1;
      renderCurrentStep('right');
    }, 700);
  } else {
    // On last step but not all done — re-render as completed
    renderCurrentStep('right');
  }
}

// ── Float XP ───────────────────────────────────────────
function floatXP(text) {
  floatingXp.textContent = text;
  floatingXp.classList.remove('pop');
  void floatingXp.offsetWidth; // reflow
  floatingXp.classList.add('pop');
}

// ── Toast ──────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// ── Completion modal ───────────────────────────────────
function showCompletionModal() {
  playAllComplete();
  id('modal-xp').textContent = `+${state.xp} XP earned!`;
  id('modal-step-count').textContent = state.totalSteps;

  // Build filmstrip
  const strip = id('modal-filmstrip');
  strip.innerHTML = '';
  state.steps.forEach(step => {
    const thumb = document.createElement('div');
    thumb.className = 'filmstrip-thumb';
    if (step.imageUrl) {
      thumb.innerHTML = `<img src="${step.imageUrl}" alt="Step ${step.stepNumber}" />`;
    } else {
      thumb.classList.add('blank');
      thumb.textContent = step.emoji || '✏️';
    }
    strip.appendChild(thumb);
  });

  modalOverlay.style.display = 'flex';
  launchConfetti();
}

function launchConfetti() {
  const container = id('confetti-container');
  container.innerHTML = '';
  const colors = ['#7C3AED','#F97316','#F59E0B','#10B981','#EC4899','#3B82F6','#FCD34D'];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.cssText = `left:${Math.random()*100}%;top:0;background:${colors[i%colors.length]};width:${6+Math.random()*7}px;height:${6+Math.random()*7}px;border-radius:${Math.random()>.5?'50%':'2px'};animation:confetti-fall ${1.5+Math.random()*2}s ${Math.random()*.8}s linear forwards;`;
    container.appendChild(p);
  }
}

// ── Modal: restart ─────────────────────────────────────
id('modal-restart').addEventListener('click', () => { modalOverlay.style.display = 'none'; resetToHome(); });
id('back-btn').addEventListener('click', () => {
  if (state.sseSource) { state.sseSource.close(); state.sseSource = null; }
  stopLoadingMessages();
  resetToHome();
});

function resetToHome() {
  clearFile();
  Object.assign(state, { sessionId: null, subject: '', totalSteps: 0, completedSteps: 0, currentIndex: 0, xp: 0, steps: [], done: [], allReceived: false });
  xpCount.textContent = '0';
  stepDots.innerHTML = '';
  stepViewer.innerHTML = '';
  showScreen('home');
}

// ── Error ──────────────────────────────────────────────
function showError(msg) { alert(msg); }

// ── Image zoom ─────────────────────────────────────────
const zoomOverlay = id('zoom-overlay');
const zoomImg = id('zoom-img');
function openZoom(src) {
  zoomImg.src = src;
  zoomOverlay.classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeZoom() {
  zoomOverlay.classList.remove('show');
  zoomImg.src = '';
  document.body.style.overflow = '';
}
zoomOverlay.addEventListener('click', closeZoom);
id('zoom-close').addEventListener('click', e => { e.stopPropagation(); closeZoom(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && zoomOverlay.classList.contains('show')) closeZoom(); });
window.openZoom = openZoom;

// ── Utils ──────────────────────────────────────────────
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

// =====================================================
// FEEDBACK DRAWER
// =====================================================
const feedbackDrawer   = id('feedback-drawer');
const feedbackBackdrop = id('feedback-backdrop');
const fbUploadState    = id('fb-upload-state');
const fbLoadingState   = id('fb-loading-state');
const fbResultState    = id('fb-result-state');
const fbFileInput      = id('fb-file-input');
const fbFileInputGallery = id('fb-file-input-gallery');
const fbPreviewWrap    = id('fb-preview-wrap');
const fbPreviewImg     = id('fb-preview-img');
const fbUploadZone     = id('fb-upload-zone');
const fbRetake         = id('fb-retake');
const btnAnalyze       = id('btn-analyze');

let feedbackStepIndex = null; // which step the feedback is for
let feedbackFile = null;

function openFeedbackDrawer(stepIdx) {
  feedbackStepIndex = stepIdx;
  feedbackFile = null;
  // Reset to upload state
  showFbState('upload');
  resetFbUpload();
  feedbackDrawer.classList.add('open');
  feedbackBackdrop.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeFeedbackDrawer() {
  feedbackDrawer.classList.remove('open');
  feedbackBackdrop.classList.remove('show');
  document.body.style.overflow = '';
}

feedbackBackdrop.addEventListener('click', closeFeedbackDrawer);
id('feedback-close').addEventListener('click', closeFeedbackDrawer);

function showFbState(state) {
  fbUploadState.style.display  = state === 'upload'  ? 'block' : 'none';
  fbLoadingState.style.display = state === 'loading' ? 'block' : 'none';
  fbResultState.style.display  = state === 'result'  ? 'block' : 'none';
}

function resetFbUpload() {
  fbPreviewWrap.style.display = 'none';
  fbUploadZone.style.display = 'flex';
  fbFileInput.value = '';
  fbFileInputGallery.value = '';
  btnAnalyze.disabled = true;
  feedbackFile = null;
}

function handleFbFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  feedbackFile = file;
  fbPreviewImg.src = URL.createObjectURL(file);
  fbPreviewWrap.style.display = 'block';
  fbUploadZone.style.display = 'none';
  btnAnalyze.disabled = false;
}

fbFileInput.addEventListener('change', () => handleFbFile(fbFileInput.files[0]));
fbFileInputGallery.addEventListener('change', () => handleFbFile(fbFileInputGallery.files[0]));
fbRetake.addEventListener('click', resetFbUpload);

btnAnalyze.addEventListener('click', async () => {
  if (!feedbackFile || feedbackStepIndex === null) return;
  const step = state.steps[feedbackStepIndex];
  if (!step) return;

  showFbState('loading');

  const fd = new FormData();
  fd.append('drawing', feedbackFile);
  fd.append('sessionId', state.sessionId);
  fd.append('stepNumber', step.stepNumber);

  try {
    const res = await fetch('/api/feedback', { method: 'POST', body: fd });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const feedback = await res.json();
    renderFeedback(feedback, feedbackStepIndex);
  } catch(err) {
    showFbState('upload');
    showToast('❌ Could not analyze — try again');
    console.error('Feedback error:', err);
  }
});

function renderFeedback(fb, stepIdx) {
  showFbState('result');

  // Stars (animate in with delays)
  const starsEl = id('fb-stars');
  starsEl.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('span');
    s.className = 'fb-star' + (i <= fb.score ? ' lit' : '');
    s.textContent = '⭐';
    if (i <= fb.score) s.style.animationDelay = (i * 0.1) + 's';
    starsEl.appendChild(s);
  }

  id('fb-score-label').textContent = fb.scoreLabel;

  const strengthsEl = id('fb-strengths');
  strengthsEl.innerHTML = (fb.strengths || []).map(s => `<li>${esc(s)}</li>`).join('');

  const improvementsEl = id('fb-improvements');
  improvementsEl.innerHTML = (fb.improvements || []).map(s => `<li>${esc(s)}</li>`).join('');

  id('fb-encouragement').textContent = fb.encouragement || '';

  // Retry button
  id('fb-retry').onclick = () => { showFbState('upload'); resetFbUpload(); };

  // Next step button — only show if score is good and not on last step
  const nextBtn = id('fb-next-step-btn');
  const isLast = stepIdx === state.totalSteps - 1;
  if (fb.readyForNext && !isLast) {
    nextBtn.style.display = 'flex';
    nextBtn.onclick = () => {
      closeFeedbackDrawer();
      // Complete this step if not already done
      if (!state.done.includes(stepIdx)) completeStep(stepIdx);
    };
  } else {
    nextBtn.style.display = 'none';
  }

  // Play a little sound based on score
  if (fb.score >= 4) playStepComplete();
  else playTone(440, .15, 'sine', .1);
}

// =====================================================
// PORTFOLIO
// =====================================================

// localStorage key for "my" saved entry IDs
const MY_IDS_KEY = 'sketchguide_my_ids';
function getMyIds() { try { return JSON.parse(localStorage.getItem(MY_IDS_KEY) || '[]'); } catch { return []; } }
function addMyId(id) { const ids = getMyIds(); ids.push(id); localStorage.setItem(MY_IDS_KEY, JSON.stringify(ids)); }

// Nav wiring
id('nav-portfolio').addEventListener('click', openPortfolio);
id('nav-home-from-portfolio').addEventListener('click', () => showScreen('home'));
id('portfolio-new-btn').addEventListener('click', () => showScreen('home'));
id('detail-back-btn').addEventListener('click', () => showScreen('portfolio'));

// Privacy toggle (private is coming soon — disabled)
let isPublic = true;
id('privacy-public').addEventListener('click', () => {
  isPublic = true;
  id('privacy-public').classList.add('active');
  id('privacy-private').classList.remove('active');
});
id('privacy-private').addEventListener('click', () => {
  showToast('🔒 Private portfolios coming soon!');
});

function openPortfolio() {
  showScreen('portfolio');
  loadMyDrawings();
  loadCommunity();
}

async function loadCommunity() {
  const grid = id('community-grid');
  grid.innerHTML = '<div class="portfolio-loading-row"><div class="p-skeleton"></div><div class="p-skeleton"></div><div class="p-skeleton"></div></div>';
  try {
    const res = await fetch('/api/portfolio');
    const entries = await res.json();
    renderPortfolioGrid(grid, entries, false);
  } catch {
    grid.innerHTML = '<p style="color:var(--text-2);padding:1rem;font-weight:600;">Could not load community drawings.</p>';
  }
}

function loadMyDrawings() {
  const grid = id('my-grid');
  const myIds = getMyIds();

  if (myIds.length === 0) {
    grid.innerHTML = '<div class="portfolio-empty"><div class="empty-icon">🎨</div><p>No drawings yet — complete a tutorial to save it here!</p></div>';
    return;
  }

  // Fetch all public and filter to mine
  fetch('/api/portfolio').then(r => r.json()).then(entries => {
    const mine = entries.filter(e => myIds.includes(e.id));
    if (mine.length === 0) {
      grid.innerHTML = '<div class="portfolio-empty"><div class="empty-icon">🎨</div><p>No saved drawings yet.</p></div>';
    } else {
      renderPortfolioGrid(grid, mine, true);
    }
  }).catch(() => {
    grid.innerHTML = '<div class="portfolio-empty"><div class="empty-icon">🎨</div><p>Could not load your drawings.</p></div>';
  });
}

function renderPortfolioGrid(container, entries, isMine) {
  if (entries.length === 0) {
    container.innerHTML = '<div class="portfolio-empty"><div class="empty-icon">🌍</div><p>No public drawings yet — be the first!</p></div>';
    return;
  }
  container.innerHTML = '';
  entries.forEach(entry => {
    const card = buildPortfolioCard(entry, isMine);
    container.appendChild(card);
  });
}

function buildPortfolioCard(entry, isMine) {
  const card = document.createElement('div');
  card.className = 'portfolio-card';
  card.onclick = () => openPortfolioDetail(entry);

  // Show first 2 step thumbnails in a 2x1 grid, or 4 in 2x2
  const thumbSteps = entry.steps.slice(0, 4);
  const thumbsHTML = thumbSteps.map(s =>
    s.imageUrl
      ? `<img src="${s.imageUrl}" alt="Step ${s.stepNumber}" loading="lazy" />`
      : `<div class="p-thumb-empty">${s.emoji || '✏️'}</div>`
  ).join('');

  const date = new Date(entry.savedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  const badgeHTML = isMine
    ? `<span class="p-card-badge mine">✏️ Mine</span>`
    : `<span class="p-card-badge public">🌍 Public</span>`;

  card.innerHTML = `
    <div class="p-card-thumbs">${thumbsHTML}</div>
    <div class="p-card-body">
      <div class="p-card-subject">${esc(capitalize(entry.subject))}</div>
      <div class="p-card-meta">
        <span class="p-card-date">${date}</span>
        ${badgeHTML}
      </div>
    </div>
  `;
  return card;
}

function openPortfolioDetail(entry) {
  id('detail-subject').textContent = '✏️ ' + capitalize(entry.subject);
  const stepsContainer = id('detail-steps');
  stepsContainer.innerHTML = '';

  entry.steps.forEach(step => {
    const card = document.createElement('div');
    card.className = 'detail-card';
    card.innerHTML = `
      ${step.imageUrl ? `<img src="${step.imageUrl}" alt="Step ${step.stepNumber}" loading="lazy" style="cursor:zoom-in" />` : ''}
      <div class="detail-card-body">
        <div class="detail-card-title">${step.emoji || '✏️'} Step ${step.stepNumber}: ${esc(step.title)}</div>
      </div>
    `;
    const img = card.querySelector('img');
    if (img) img.addEventListener('click', () => openZoom(step.imageUrl));
    stepsContainer.appendChild(card);
  });

  showScreen('detail');
}

// Reset save UI + wire save-to-portfolio each time the modal opens
const _origShowCompletionModal = showCompletionModal;
showCompletionModal = function() {
  _origShowCompletionModal();
  const btn = id('btn-save-portfolio');
  btn.disabled = false;
  btn.textContent = '💾 Save to Portfolio';
  id('modal-save-note').textContent = '';
  isPublic = true;
  id('privacy-public').classList.add('active');
  id('privacy-private').classList.remove('active');
};

id('btn-save-portfolio').addEventListener('click', async () => {
  const btn = id('btn-save-portfolio');
  const note = id('modal-save-note');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '💾 Saving...';
  try {
    const res = await fetch('/api/portfolio/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: state.subject || 'My Drawing', steps: state.steps, isPublic })
    });
    if (!res.ok) throw new Error();
    const { id: savedId } = await res.json();
    addMyId(savedId);
    btn.textContent = '✅ Saved!';
    note.textContent = isPublic ? '🌍 Visible in the community gallery' : '🔒 Saved privately';
    playStepComplete();
  } catch {
    btn.disabled = false;
    btn.textContent = '💾 Save to Portfolio';
    note.textContent = '❌ Could not save — try again';
  }
});

// =====================================================
// Expose globals for inline onclick
// =====================================================
window.completeStep = completeStep;
window.goToStep = goToStep;
window.openFeedbackDrawer = openFeedbackDrawer;
