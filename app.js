import { Character } from './character.js';
import { Dictation, DemoDictation } from './dictation.js';

const $ = (id) => document.getElementById(id);
const MODEL = 'onnx-community/whisper-base';
const DEMO = new URLSearchParams(location.search).has('demo');

class App {
  constructor() {
    this.ui = {
      pill: $('pill'),
      pillText: $('pillText'),
      caption: $('caption'),
      bar: $('bar'),
      barWrap: $('barWrap'),
    };
    this.speaking = false;
    this.pending = 0;
    this.modelReady = false;
    this.running = false;
    this.busy = false;
    this.happyUntil = 0;
    this.fileProgress = new Map();

    this.character = new Character($('stage'));
    const handlers = {
      onStatus: (t) => this.setStatus(t),
      onProgress: (p) => this.showProgress(p),
      onReady: (device) => {
        this.modelReady = true;
        this.ui.barWrap.hidden = true;
        this.setStatus(device === 'demo' ? 'Demo mode' : `Model ready (${device})`);
      },
      onSpeechStart: () => {
        this.speaking = true;
        this.refresh();
      },
      onSpeechEnd: () => {
        this.speaking = false;
        this.character.setSpeech(0);
        this.refresh();
      },
      onFrame: (p) => this.character.setSpeech(this.character.speech * 0.7 + p * 0.3),
      onPending: (n) => {
        this.pending = n;
        this.refresh();
      },
      onText: (text, ms) => this.addLine(text, ms),
      onError: (msg) => this.fail(msg),
    };
    this.dictation = DEMO ? new DemoDictation(handlers) : new Dictation(handlers);

    setInterval(() => this.refresh(), 250); // lets the "happy" state expire
  }

  async init() {
    try {
      await this.character.load('./facecap.glb', (p) => this.setStatus(`Loading character… ${Math.round(p * 100)}%`));
      this.character.start();
      this.character.setState('idle');
      await this.start();
    } catch (err) {
      this.fail(`Could not load the character: ${err.message}`);
    }
  }

  // ---- UI ----------------------------------------------------------------

  setStatus(text) {
    this.ui.pillText.textContent = text;
  }

  showProgress(p) {
    if (!p || p.status !== 'progress') return;
    this.fileProgress.set(p.file, p.progress);
    const all = [...this.fileProgress.values()];
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    this.ui.barWrap.hidden = false;
    this.ui.bar.style.width = `${avg.toFixed(0)}%`;
    this.setStatus(`Downloading model… ${avg.toFixed(0)}%`);
  }

  addLine(text) {
    this.ui.caption.textContent = text;
    this.ui.caption.classList.remove('fade');
    void this.ui.caption.offsetWidth;
    this.ui.caption.classList.add('fade');
    this.happyUntil = performance.now() + 1600;
    this.refresh();
  }

  fail(msg) {
    this.error = msg;
    this.setStatus(msg);
    this.ui.pill.dataset.state = 'error';
    this.character.setState('error');
    this.busy = false;
    this.running = false;
  }

  refresh() {
    if (this.error) return;
    let state = 'idle';
    if (this.busy && !this.modelReady) state = 'loading';
    else if (this.speaking) state = 'listening';
    else if (this.pending > 0) state = 'thinking';
    else if (performance.now() < this.happyUntil) state = 'happy';
    this.character.setState(state);
    this.ui.pill.dataset.state = state;
    if (this.running && this.modelReady) {
      const label = { idle: 'Listening…', listening: 'Hearing you', thinking: 'Transcribing…', happy: 'Got it' }[state];
      if (label) this.setStatus(label);
    }
  }

  // ---- actions -----------------------------------------------------------

  async start() {
    this.busy = true;
    this.setStatus('Starting…');
    try {
      this.refresh();
      await this.dictation.loadModel(MODEL);
      this.modelReady = true;
      this.setStatus('Asking for microphone…');
      await this.dictation.start();
      this.running = true;
    } catch (err) {
      this.fail(err?.name === 'NotAllowedError' ? 'Microphone permission was denied' : `Error: ${err?.message || err}`);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }
}

try {
  new App().init();
} catch (err) {
  $('pillText').textContent = `Cannot start 3D: ${err.message}. Enable hardware acceleration in the browser.`;
  $('pill').dataset.state = 'error';
}
