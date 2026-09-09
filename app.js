'use strict';

// ─────────────────────────────────────────
//  Constants & state
// ─────────────────────────────────────────
const MAX_TIMERS = 7;
const ITEM_H = 40; // px per picker row

let timers = [];          // Array<TimerState>
let nextId = 0;
const activeIntervals = {}; // id -> intervalId

let wakeLock = null;      // screen wake lock while timers run
let keepAliveEl = null;   // silent looping audio; stops Android freezing the page

// ─────────────────────────────────────────
//  Persistence
// ─────────────────────────────────────────
function saveTimers() {
  try {
    localStorage.setItem('eyelash-timers', JSON.stringify(timers));
    localStorage.setItem('eyelash-next-id', String(nextId));
  } catch (_) {}
}

function loadTimers() {
  try {
    const raw = localStorage.getItem('eyelash-timers');
    const rawId = localStorage.getItem('eyelash-next-id');
    const parsedId = parseInt(rawId, 10);
    if (Number.isFinite(parsedId)) nextId = parsedId;
    if (!raw) return;

    const parsed = JSON.parse(raw);
    timers = Array.isArray(parsed) ? parsed.map(normalizeTimer) : [];

    // Restore running timers using saved endTime. endTime is kept so the
    // countdown resumes at the exact moment it left off, not from the top.
    timers.forEach(t => {
      if (t.isRunning && t.endTime) {
        const remaining = t.endTime - Date.now();
        if (remaining <= 0) {
          t.remainingMs = 0;
          t.isRunning = false;
          t.endTime = null;
        } else {
          t.remainingMs = remaining;
        }
      } else {
        t.isRunning = false;
      }
    });

    // Any id collision from a partially-written save would silently merge two
    // cards into one, so keep nextId ahead of everything we just loaded.
    timers.forEach(t => { if (t.id >= nextId) nextId = t.id + 1; });
  } catch (_) {
    timers = [];
  }
}

// ─────────────────────────────────────────
//  Timer state helpers
// ─────────────────────────────────────────
function normalizeTimer(t) {
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  return {
    id:          num(t?.id, 0),
    label:       typeof t?.label === 'string' ? t.label : 'Timer',
    hours:       num(t?.hours, 0),
    minutes:     num(t?.minutes, 0),
    seconds:     num(t?.seconds, 0),
    isRunning:   !!t?.isRunning,
    isPaused:    !!t?.isPaused,
    remainingMs: num(t?.remainingMs, -1),
    endTime:     num(t?.endTime, null),
  };
}

function totalMs(t) {
  return (t.hours * 3600 + t.minutes * 60 + t.seconds) * 1000;
}

function formatMs(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ─────────────────────────────────────────
//  Audio (Web Audio API)
// ─────────────────────────────────────────
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // iOS requires resume after user interaction
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playBeeps() {
  try {
    const ctx = getAudioCtx();
    for (let i = 0; i < 3; i++) {
      const t = ctx.currentTime + i * 0.6;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.5, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t);
      osc.stop(t + 0.36);
    }
  } catch (_) {}
}

// ─────────────────────────────────────────
//  Staying alive in the background
// ─────────────────────────────────────────

// Android freezes a backgrounded page and its intervals stop firing, so the
// alarm never goes off. A page that is playing audio is exempt from freezing,
// so we loop one second of silence for as long as a timer is counting down.
function silentWavUrl() {
  const sampleRate = 8000, samples = sampleRate; // 1 second, 16-bit mono
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM header size
  view.setUint16(20, 1, true);             // format: PCM
  view.setUint16(22, 1, true);             // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  // Sample data stays zero-filled — that is the silence.

  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function anyRunning() {
  return timers.some(t => t.isRunning);
}

function updateKeepAlive() {
  const needed = anyRunning();

  if (needed) {
    if (!keepAliveEl) {
      keepAliveEl = document.createElement('audio');
      keepAliveEl.src = silentWavUrl();
      keepAliveEl.loop = true;
      keepAliveEl.setAttribute('playsinline', '');
      document.body.appendChild(keepAliveEl);
    }
    keepAliveEl.play().catch(() => {});
  } else if (keepAliveEl) {
    keepAliveEl.pause();
  }

  updateWakeLock(needed);
}

// Keep the screen on while a timer runs — a lash tech's hands are busy.
async function updateWakeLock(needed) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (needed && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!needed && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (_) {
    wakeLock = null;
  }
}

function requestNotifyPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

// Fires when the app is behind another app, so the alarm is actually noticed.
function notifyDone(t) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = `${t.label || 'Timer'} finished`;
  navigator.serviceWorker?.ready
    .then(reg => reg.showNotification('Eyelash Timer', {
      body,
      tag: `timer-${t.id}`,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [300, 150, 300, 150, 300],
      renotify: true,
    }))
    .catch(() => {});
}

function fireAlarm(t) {
  playBeeps();
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  if (document.visibilityState !== 'visible') notifyDone(t);
}

// ─────────────────────────────────────────
//  Timer actions
// ─────────────────────────────────────────
function addTimer() {
  if (timers.length >= MAX_TIMERS) return;
  timers.push({
    id: nextId++,
    label: `Timer ${timers.length + 1}`,
    hours: 0, minutes: 0, seconds: 0,
    isRunning: false, isPaused: false,
    remainingMs: -1, endTime: null
  });
  saveTimers();
  renderAll();
  // Scroll new card into view
  requestAnimationFrame(() => {
    const cards = document.querySelectorAll('.timer-card');
    cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function deleteTimer(id) {
  stopInterval(id);
  timers = timers.filter(t => t.id !== id);
  saveTimers();
  renderAll();
  updateKeepAlive();
}

function startTimer(id) {
  // Unlock audio on first user interaction
  getAudioCtx();
  requestNotifyPermission();

  const t = timers.find(x => x.id === id);
  if (!t) return;
  // Resume from what is left whenever there is something left — a paused timer
  // and a running one restored from storage both have to pick up where they
  // stopped, not restart at the full duration.
  const ms = ((t.isPaused || t.isRunning) && t.remainingMs > 0) ? t.remainingMs : totalMs(t);
  if (ms <= 0) return;

  t.isRunning = true;
  t.isPaused = false;
  t.remainingMs = ms;
  t.endTime = Date.now() + ms;
  saveTimers();
  ensureInterval(t);
  updateCardDisplay(t);
  updateKeepAlive();
}

// Attaches the ticking interval to a timer that already has a valid endTime.
// Used on re-render so redrawing the list never shifts a running countdown.
function ensureInterval(t) {
  if (activeIntervals[t.id] != null) return;
  if (!t.isRunning || !t.endTime) return;

  activeIntervals[t.id] = setInterval(() => tick(t), 250);
  updateKeepAlive();
}

function tick(t) {
  const remaining = t.endTime - Date.now();

  if (remaining <= 0) {
    stopInterval(t.id);
    t.remainingMs = 0;
    t.isRunning = false;
    t.endTime = null;
    saveTimers();
    updateCardDisplay(t);
    fireAlarm(t);
    updateKeepAlive();
    return;
  }

  t.remainingMs = remaining;
  // Only update the countdown text, not the whole card
  const el = document.querySelector(`.timer-card[data-id="${t.id}"] .countdown`);
  if (el) el.textContent = formatMs(remaining);
}

// Coming back from a locked screen or another app: the interval may have been
// frozen, so settle every timer against the wall clock before redrawing.
function resyncTimers() {
  timers.forEach(t => {
    if (!t.isRunning || !t.endTime) return;
    if (t.endTime - Date.now() <= 0) {
      tick(t);
    } else {
      ensureInterval(t);
      updateCardDisplay(t);
    }
  });
  updateKeepAlive();
}

function pauseTimer(id) {
  const t = timers.find(x => x.id === id);
  if (!t) return;
  stopInterval(id);
  t.isRunning = false;
  t.isPaused = true;
  t.endTime = null;
  saveTimers();
  updateCardDisplay(t);
  updateKeepAlive();
}

function resetTimer(id) {
  const t = timers.find(x => x.id === id);
  if (!t) return;
  stopInterval(id);
  t.isRunning = false;
  t.isPaused = false;
  t.remainingMs = -1;
  t.endTime = null;
  saveTimers();
  updateCardDisplay(t);
  updateKeepAlive();
}

function stopInterval(id) {
  if (activeIntervals[id] != null) {
    clearInterval(activeIntervals[id]);
    delete activeIntervals[id];
  }
}

// ─────────────────────────────────────────
//  ScrollPicker class
// ─────────────────────────────────────────
class ScrollPicker {
  constructor(min, max, initial, onChange) {
    this.min = min;
    this.max = max;
    this.onChange = onChange;
    this._settling = false;
    // A picker built inside a hidden card cannot take a scrollTop, so it reads
    // back as 0. Until it has been positioned while visible, its scroll events
    // are meaningless and must never be written back over the saved duration.
    this._ready = false;

    this.wrap = document.createElement('div');
    this.wrap.className = 'picker-wrap';

    this.inner = document.createElement('div');
    this.inner.className = 'picker-inner';

    // Top spacer
    const top = document.createElement('div');
    top.className = 'picker-spacer';
    this.inner.appendChild(top);

    // Items
    for (let i = min; i <= max; i++) {
      const item = document.createElement('div');
      item.className = 'picker-item';
      item.textContent = pad(i);
      this.inner.appendChild(item);
    }

    // Bottom spacer
    const bot = document.createElement('div');
    bot.className = 'picker-spacer';
    this.inner.appendChild(bot);

    this.wrap.appendChild(this.inner);

    // Set value without animation (must happen after DOM insert)
    this._initial = initial;
    requestAnimationFrame(() => this.setValue(initial));

    // Scroll end detection
    let tid;
    this.inner.addEventListener('scroll', () => {
      clearTimeout(tid);
      tid = setTimeout(() => this._onSettle(), 120);
    }, { passive: true });
  }

  getValue() {
    return this.min + Math.round(this.inner.scrollTop / ITEM_H);
  }

  setValue(val) {
    this._initial = val;
    this.inner.scrollTop = (val - this.min) * ITEM_H;
    // Only trust the widget once the assignment actually took effect.
    if (this.inner.clientHeight > 0) this._ready = true;
  }

  _onSettle() {
    if (!this._ready) {
      // Laid out at last — restore the real value instead of reporting 0.
      this.setValue(this._initial);
      return;
    }
    const val = this.getValue();
    // Snap to nearest
    this.inner.scrollTop = (val - this.min) * ITEM_H;
    if (this.onChange) this.onChange(val);
  }
}

// ─────────────────────────────────────────
//  Render helpers
// ─────────────────────────────────────────

// SVG icons (inline, no external deps)
const ICON_PLAY = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
  <path d="M8 5v14l11-7L8 5z" fill="#89CFF0"/>
</svg>`;

const ICON_PAUSE = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
  <rect x="6" y="5" width="4" height="14" rx="1" fill="#89CFF0"/>
  <rect x="14" y="5" width="4" height="14" rx="1" fill="#89CFF0"/>
</svg>`;

const ICON_DELETE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#7a9bb5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function createTimerCard(timer) {
  const card = document.createElement('div');
  card.className = 'timer-card';
  card.dataset.id = timer.id;

  // ── Top row ──────────────────────────────
  const topRow = document.createElement('div');
  topRow.className = 'card-top';

  const labelBlock = document.createElement('div');
  labelBlock.className = 'label-block';

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'timer-label';
  labelInput.placeholder = 'Timer name';
  labelInput.value = timer.label;
  labelInput.maxLength = 30;
  labelInput.addEventListener('change', () => {
    timer.label = labelInput.value;
    saveTimers();
  });

  const setDur = document.createElement('span');
  setDur.className = 'timer-set-dur';

  labelBlock.appendChild(labelInput);
  labelBlock.appendChild(setDur);

  const btnStart = document.createElement('button');
  btnStart.className = 'icon-btn btn-start';
  btnStart.innerHTML = ICON_PLAY;
  btnStart.setAttribute('aria-label', 'Start timer');
  btnStart.addEventListener('click', () => startTimer(timer.id));

  const btnPause = document.createElement('button');
  btnPause.className = 'icon-btn btn-pause';
  btnPause.innerHTML = ICON_PAUSE;
  btnPause.setAttribute('aria-label', 'Pause timer');
  btnPause.addEventListener('click', () => pauseTimer(timer.id));

  const btnDelete = document.createElement('button');
  btnDelete.className = 'icon-btn btn-delete';
  btnDelete.innerHTML = ICON_DELETE;
  btnDelete.setAttribute('aria-label', 'Delete timer');
  btnDelete.addEventListener('click', () => deleteTimer(timer.id));

  topRow.appendChild(labelBlock);
  topRow.appendChild(btnStart);
  topRow.appendChild(btnPause);
  topRow.appendChild(btnDelete);

  // ── Divider ───────────────────────────────
  const divider = document.createElement('div');
  divider.className = 'card-divider';

  // ── Pickers ───────────────────────────────
  const pickersRow = document.createElement('div');
  pickersRow.className = 'pickers-row';

  function makeCol(pickerWidget, labelText) {
    const col = document.createElement('div');
    col.className = 'picker-col';
    const lbl = document.createElement('span');
    lbl.className = 'picker-label';
    lbl.textContent = labelText;
    col.appendChild(pickerWidget.wrap);
    col.appendChild(lbl);
    return col;
  }

  function makeColon() {
    const c = document.createElement('span');
    c.className = 'colon';
    c.textContent = ':';
    return c;
  }

  function updateSetDur() {
    const ms = totalMs(timer);
    if (ms > 0) {
      setDur.textContent = formatMs(ms);
      setDur.style.display = 'block';
    } else {
      setDur.style.display = 'none';
    }
  }

  const pickerH = new ScrollPicker(0, 23, timer.hours, v => {
    timer.hours = v; updateSetDur(); saveTimers();
  });
  const pickerM = new ScrollPicker(0, 59, timer.minutes, v => {
    timer.minutes = v; updateSetDur(); saveTimers();
  });
  const pickerS = new ScrollPicker(0, 59, timer.seconds, v => {
    timer.seconds = v; updateSetDur(); saveTimers();
  });

  // Store references for later updates
  card._pickerH = pickerH;
  card._pickerM = pickerM;
  card._pickerS = pickerS;
  card._updateSetDur = updateSetDur;

  pickersRow.appendChild(makeCol(pickerH, 'HRS'));
  pickersRow.appendChild(makeColon());
  pickersRow.appendChild(makeCol(pickerM, 'MIN'));
  pickersRow.appendChild(makeColon());
  pickersRow.appendChild(makeCol(pickerS, 'SEC'));

  // ── Countdown display ─────────────────────
  const countdown = document.createElement('div');
  countdown.className = 'countdown';

  // ── Reset button ──────────────────────────
  const btnReset = document.createElement('button');
  btnReset.className = 'btn-reset';
  btnReset.textContent = 'Reset';
  btnReset.addEventListener('click', () => resetTimer(timer.id));

  card.appendChild(topRow);
  card.appendChild(divider);
  card.appendChild(pickersRow);
  card.appendChild(countdown);
  card.appendChild(btnReset);

  // Init display
  updateSetDur();
  applyCardState(card, timer);

  // Resume the countdown if it was running — attach to the existing endTime
  // rather than calling startTimer, which would restart it from the top.
  if (timer.isRunning) {
    ensureInterval(timer);
  }

  return card;
}

function applyCardState(card, timer) {
  const isDone = timer.remainingMs === 0;
  const showPickers = !timer.isRunning && !timer.isPaused && !isDone;

  const pickersRow = card.querySelector('.pickers-row');
  const countdown  = card.querySelector('.countdown');
  const btnStart   = card.querySelector('.btn-start');
  const btnPause   = card.querySelector('.btn-pause');
  const btnReset   = card.querySelector('.btn-reset');

  pickersRow.style.display = showPickers ? '' : 'none';
  countdown.style.display  = showPickers ? 'none' : 'block';

  // Pickers just came back on screen (a reset, or a reload of a stopped
  // timer) — re-seat them on the saved duration now that they have a layout.
  if (showPickers && card._pickerH) {
    card._pickerH.setValue(timer.hours);
    card._pickerM.setValue(timer.minutes);
    card._pickerS.setValue(timer.seconds);
  }

  btnStart.style.display = (!timer.isRunning && !isDone) ? '' : 'none';
  btnPause.style.display = timer.isRunning ? '' : 'none';
  btnReset.style.display = (timer.isPaused || isDone) ? '' : 'none';

  if (isDone) {
    countdown.textContent = 'Done!';
    countdown.classList.add('done');
  } else {
    countdown.classList.remove('done');
    const ms = timer.remainingMs > 0 ? timer.remainingMs : totalMs(timer);
    countdown.textContent = formatMs(ms);
  }
}

function updateCardDisplay(timer) {
  const card = document.querySelector(`.timer-card[data-id="${timer.id}"]`);
  if (card) applyCardState(card, timer);
}

// ─────────────────────────────────────────
//  Full render
// ─────────────────────────────────────────
function renderAll() {
  const list = document.getElementById('timer-list');
  list.innerHTML = '';

  timers.forEach(t => list.appendChild(createTimerCard(t)));

  // Update count
  document.getElementById('timer-count').textContent = `${timers.length} / ${MAX_TIMERS}`;

  // Add button state
  document.getElementById('btn-add').disabled = (timers.length >= MAX_TIMERS);
}

// ─────────────────────────────────────────
//  Tab switching
// ─────────────────────────────────────────
function initTabs() {
  const tabBtns  = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const timerCount = document.getElementById('timer-count');
  const headerTitle = document.getElementById('header-title');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
      tabPanes.forEach(p => p.classList.toggle('active', p.id === `tab-${target}`));

      if (target === 'timer') {
        headerTitle.textContent = 'Eyelash Timer';
        timerCount.style.display = '';
      } else {
        headerTitle.textContent = 'Translate';
        timerCount.style.display = 'none';
      }
    });
  });
}

// ─────────────────────────────────────────
//  Translate — state
// ─────────────────────────────────────────
let mediaRecorder    = null;
let audioChunks      = [];
let currentTranscript = '';
let lastTranslatedLang = ''; // the lang we last ran a translation for

const MIC_SVG = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none">
  <rect x="9" y="2" width="6" height="11" rx="3" fill="#89CFF0"/>
  <path d="M5 10a7 7 0 0 0 14 0" stroke="#89CFF0" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="17" x2="12" y2="21" stroke="#89CFF0" stroke-width="2" stroke-linecap="round"/>
  <line x1="8" y1="21" x2="16" y2="21" stroke="#89CFF0" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const STOP_SVG = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none">
  <rect x="6" y="6" width="12" height="12" rx="3" fill="#ff5050"/>
</svg>`;

// ─────────────────────────────────────────
//  Translate — init
// ─────────────────────────────────────────
function initTranslate() {
  // ── API key ──────────────────────────────
  const keyInput     = document.getElementById('api-key-input');
  const keyInputRow  = document.getElementById('key-input-row');
  const keySavedRow  = document.getElementById('key-saved-row');
  const btnSaveKey   = document.getElementById('btn-save-key');
  const btnChangeKey = document.getElementById('btn-change-key');

  function showKeySaved() {
    keyInput.value   = '';       // never leave key visible in the field
    keyInputRow.style.display  = 'none';
    keySavedRow.style.display  = 'flex';
  }

  function showKeyInput() {
    keyInputRow.style.display  = 'flex';
    keySavedRow.style.display  = 'none';
    keyInput.value = '';
    keyInput.focus();
  }

  // On load: if key already saved, show saved state; otherwise show input
  if (localStorage.getItem('openai-api-key')) {
    showKeySaved();
  } else {
    showKeyInput();
  }

  btnSaveKey.addEventListener('click', () => {
    const key = keyInput.value.trim();
    if (!key) return;
    localStorage.setItem('openai-api-key', key);
    showKeySaved();
  });

  btnChangeKey.addEventListener('click', () => {
    localStorage.removeItem('openai-api-key');
    showKeyInput();
  });

  // ── Source language select ───────────────
  const sourceLangSelect = document.getElementById('source-lang-select');
  const savedSourceLang  = localStorage.getItem('translate-source-lang') || '';
  if (savedSourceLang) sourceLangSelect.value = savedSourceLang;

  sourceLangSelect.addEventListener('change', () => {
    localStorage.setItem('translate-source-lang', sourceLangSelect.value);
  });

  // ── Target language select ───────────────
  const langSelect = document.getElementById('lang-select');
  const savedLang  = localStorage.getItem('translate-lang') || '';
  if (savedLang) langSelect.value = savedLang;

  langSelect.addEventListener('change', () => {
    const lang = langSelect.value;
    localStorage.setItem('translate-lang', lang);

    // If transcript exists and language differs from what we last translated → show button
    if (currentTranscript && lang && lang !== lastTranslatedLang) {
      showTranslateButton();
    } else if (currentTranscript && lang && lang === lastTranslatedLang) {
      // Already have a translation for this language — hide the button
      document.getElementById('btn-translate').style.display = 'none';
    }
  });

  // ── Editable transcription ───────────────
  const transcriptArea = document.getElementById('transcription-text');
  transcriptArea.addEventListener('input', () => {
    currentTranscript = transcriptArea.value.trim();
    const lang = langSelect.value;
    // If there's content and a target language, offer to re-translate
    if (currentTranscript && lang) {
      showTranslateButton();
    }
  });

  // ── Mic button ───────────────────────────
  const btnMic   = document.getElementById('btn-mic');
  const recStatus = document.getElementById('rec-status');

  btnMic.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    } else {
      startRecording();
    }
  });

  // ── Manual translate button ──────────────
  document.getElementById('btn-translate').addEventListener('click', () => {
    const lang = langSelect.value;
    if (currentTranscript && lang) {
      translateText(currentTranscript, lang);
    }
  });

  // ── Copy buttons ─────────────────────────
  document.getElementById('btn-copy-transcript').addEventListener('click', () => {
    const text = document.getElementById('transcription-text').value;
    navigator.clipboard.writeText(text).catch(() => {});
  });

  document.getElementById('btn-copy-translation').addEventListener('click', () => {
    const text = document.getElementById('translation-text').innerText;
    navigator.clipboard.writeText(text).catch(() => {});
  });
}

// ─────────────────────────────────────────
//  Translate — recording
// ─────────────────────────────────────────
async function startRecording() {
  const btnMic    = document.getElementById('btn-mic');
  const micIcon   = document.getElementById('mic-icon');
  const recStatus = document.getElementById('rec-status');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    // Pick a MIME type Whisper accepts
    const mimeType = ['audio/webm', 'audio/ogg', 'audio/mp4']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';

    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btnMic.classList.remove('recording');
      micIcon.innerHTML = MIC_SVG;
      recStatus.textContent = 'Transcribing…';
      recStatus.classList.remove('error');

      const mimeUsed = mediaRecorder.mimeType || 'audio/webm';
      const ext = mimeUsed.includes('ogg') ? 'ogg' : mimeUsed.includes('mp4') ? 'mp4' : 'webm';
      const audioBlob = new Blob(audioChunks, { type: mimeUsed });

      await transcribeAudio(audioBlob, ext);
    };

    mediaRecorder.start();
    btnMic.classList.add('recording');
    micIcon.innerHTML = STOP_SVG;
    recStatus.textContent = 'Recording… tap to stop';
    recStatus.classList.remove('error');

  } catch (err) {
    recStatus.textContent = 'Microphone access denied';
    recStatus.classList.add('error');
  }
}

// ─────────────────────────────────────────
//  Translate — transcription (Whisper)
// ─────────────────────────────────────────
async function transcribeAudio(audioBlob, ext) {
  const recStatus = document.getElementById('rec-status');
  const apiKey    = localStorage.getItem('openai-api-key');

  if (!apiKey) {
    recStatus.textContent = 'No API key — add one above';
    recStatus.classList.add('error');
    return;
  }

  try {
    const formData = new FormData();
    formData.append('file', audioBlob, `audio.${ext}`);
    formData.append('model', 'whisper-1');
    const sourceLang = document.getElementById('source-lang-select').value;
    if (sourceLang) formData.append('language', sourceLang);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }

    const data = await res.json();
    currentTranscript = (data.text || '').trim();

    if (!currentTranscript) {
      recStatus.textContent = 'No speech detected — try again';
      return;
    }

    recStatus.textContent = 'Tap to record';
    showTranscription(currentTranscript);

    const lang = document.getElementById('lang-select').value;
    if (lang) {
      // Language pre-selected: auto-translate
      translateText(currentTranscript, lang);
    } else {
      // No language selected yet: show translation section with prompt
      showTranslationSection('');
      showTranslateButton();
    }

  } catch (err) {
    recStatus.textContent = `Error: ${err.message}`;
    recStatus.classList.add('error');
  }
}

// ─────────────────────────────────────────
//  Translate — translation (GPT)
// ─────────────────────────────────────────
async function translateText(text, lang) {
  const section         = document.getElementById('translation-section');
  const translationText = document.getElementById('translation-text');
  const translationLabel = document.getElementById('translation-label');
  const btnTranslate    = document.getElementById('btn-translate');
  const apiKey          = localStorage.getItem('openai-api-key');

  section.style.display = 'block';
  translationLabel.textContent = `Translation · ${lang}`;
  translationText.textContent  = 'Translating…';
  translationText.classList.add('loading');
  btnTranslate.style.display   = 'none';

  if (!apiKey) {
    translationText.textContent = 'No API key — add one above';
    translationText.classList.remove('loading');
    return;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a professional translator. Translate the following text to ${lang}.

Apply smart formatting to the translation:
- If the content contains a list of items, steps, or ingredients, format them as markdown bullet points (- item) or numbered lists (1. item) as appropriate
- If the content is formal (business, legal, medical, official), preserve a formal tone and structure
- Use **bold** for key terms, names, or important phrases where it adds clarity
- Preserve paragraph breaks from the original
- Do NOT add headers, titles, or any extra text beyond the translation itself

Output only the translated and formatted text in markdown. No explanations, no preamble, no headers.`,
          },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const translated = data.choices?.[0]?.message?.content?.trim() || '';

    translationText.innerHTML = renderMarkdown(translated);
    translationText.classList.remove('loading');
    lastTranslatedLang = lang;

  } catch (err) {
    translationText.textContent = `Error: ${err.message}`;
    translationText.classList.remove('loading');
  }
}

// ─────────────────────────────────────────
//  Markdown renderer (inline, no deps)
// ─────────────────────────────────────────
function renderMarkdown(raw) {
  // 1. Escape HTML to prevent injection
  let text = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Process line by line for block elements
  const lines = text.split('\n');
  const out   = [];
  let inUl = false, inOl = false;

  const closeList = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^[-*]\s+/.test(line)) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${line.replace(/^[-*]\s+/, '')}</li>`);

    } else if (/^\d+\.\s+/.test(line)) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${line.replace(/^\d+\.\s+/, '')}</li>`);

    } else if (line.trim() === '') {
      closeList();
      out.push('<br>');

    } else {
      closeList();
      out.push(`<p>${line}</p>`);
    }
  }

  closeList();

  // 3. Inline formatting
  return out.join('')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>');
}

// ─────────────────────────────────────────
//  Translate — UI helpers
// ─────────────────────────────────────────
function showTranscription(text) {
  const section = document.getElementById('transcription-section');
  const el      = document.getElementById('transcription-text');
  el.value = text;
  section.style.display = 'block';
}

function showTranslationSection(text) {
  const section = document.getElementById('translation-section');
  const el      = document.getElementById('translation-text');
  el.textContent = text;
  section.style.display = 'block';
}

function showTranslateButton() {
  const section      = document.getElementById('translation-section');
  const btnTranslate = document.getElementById('btn-translate');
  section.style.display  = 'block';
  btnTranslate.style.display = 'block';
}

// ─────────────────────────────────────────
//  Floating mic button (FAB)
// ─────────────────────────────────────────
function initFab() {
  const fab = document.getElementById('fab-mic');
  const SLOP = 6; // px — below this it's a tap, above it's a drag

  let startX = 0, startY = 0;
  let startRight = 16, startBottom = 0;
  let dragging = false;

  // Use right/bottom so it starts anchored to the default corner
  // and we convert to left/top during drag for free movement
  function getComputedPos() {
    const rect = fab.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  function onPointerDown(e) {
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX;
    startY = pt.clientY;
    dragging = false;

    // Switch to left/top absolute positioning so drag is unconstrained
    const pos = getComputedPos();
    fab.style.right  = 'auto';
    fab.style.bottom = 'auto';
    fab.style.left   = pos.left + 'px';
    fab.style.top    = pos.top  + 'px';

    document.addEventListener('mousemove', onPointerMove, { passive: false });
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('mouseup',   onPointerUp);
    document.addEventListener('touchend',  onPointerUp);
  }

  function onPointerMove(e) {
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;
    if (!dragging && (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP)) dragging = true;
    if (dragging) {
      e.preventDefault();
      fab.style.left = (parseFloat(fab.style.left) + dx) + 'px';
      fab.style.top  = (parseFloat(fab.style.top)  + dy) + 'px';
      startX = pt.clientX;
      startY = pt.clientY;
    }
  }

  function onPointerUp() {
    document.removeEventListener('mousemove', onPointerMove);
    document.removeEventListener('touchmove', onPointerMove);
    document.removeEventListener('mouseup',   onPointerUp);
    document.removeEventListener('touchend',  onPointerUp);

    if (!dragging) handleFabTap();
  }

  fab.addEventListener('mousedown',  onPointerDown);
  fab.addEventListener('touchstart', onPointerDown, { passive: true });

  function handleFabTap() {
    const onTimer = document.getElementById('tab-timer').classList.contains('active');
    if (onTimer) {
      // Switch to Translate tab
      document.querySelector('.tab-btn[data-tab="translate"]').click();
    } else {
      // On Translate tab — toggle recording
      const btnMic = document.getElementById('btn-mic');
      btnMic.click();
    }
  }

  // Keep FAB icon in sync with recording state
  const observer = new MutationObserver(() => {
    const recording = document.getElementById('btn-mic')?.classList.contains('recording');
    fab.classList.toggle('recording', !!recording);
    // Swap icon: stop square when recording, mic when not
    fab.querySelector('svg').innerHTML = recording
      ? '<rect x="6" y="6" width="12" height="12" rx="2" fill="white"/>'
      : `<rect x="9" y="2" width="6" height="11" rx="3" fill="white"/>
         <path d="M5 10a7 7 0 0 0 14 0" stroke="white" stroke-width="2" stroke-linecap="round"/>
         <line x1="12" y1="17" x2="12" y2="21" stroke="white" stroke-width="2" stroke-linecap="round"/>
         <line x1="8" y1="21" x2="16" y2="21" stroke="white" stroke-width="2" stroke-linecap="round"/>`;
  });

  const btnMic = document.getElementById('btn-mic');
  if (btnMic) observer.observe(btnMic, { attributes: true, attributeFilter: ['class'] });
}

// ─────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadTimers();
  renderAll();
  updateKeepAlive();

  document.getElementById('btn-add').addEventListener('click', addTimer);

  initTabs();
  initTranslate();
  initFab();

  // Returning from another app or a locked screen: the interval may have been
  // frozen and the wake lock dropped, so settle against the clock and re-arm.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resyncTimers();
  });
  window.addEventListener('pageshow', resyncTimers);

  // Last chance to record where every countdown stands before we get killed.
  window.addEventListener('pagehide', saveTimers);

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
