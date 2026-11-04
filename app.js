import { Character } from './character.js';
import { Dictation, DemoDictation } from './dictation.js';
import { Chat, DemoChat, isCjk } from './chat.js';

const $ = (id) => document.getElementById(id);
const MODEL = 'onnx-community/whisper-base';
const CHAT_MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const DEMO_CHAT = params.has('demochat');

class App {
  constructor() {
    this.ui = {
      pill: $('pill'),
      pillText: $('pillText'),
      caption: $('caption'),
      reply: $('reply'),
      bar: $('bar'),
      barWrap: $('barWrap'),
    };
    this.speaking = false;
    this.pending = 0;
    this.modelReady = false;
    this.running = false;
    this.busy = false;
    this.happyUntil = 0;
    this.thinking = false;
    this.replying = false;
    this.chatStatus = 'Loading chat model…';
    this.chatFiles = new Map();
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
        this.chat.interrupt();
        this.thinking = false;
        this.replying = false;
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

    const ChatClass = DEMO_CHAT ? DemoChat : Chat;
    this.chat = new ChatClass({
      onProgress: (p) => this.showChatProgress(p),
      onReady: (device) => {
        console.info(`Chat model ready on ${device}`);
        this.chatStatus = null;
        this.ui.barWrap.hidden = true;
        this.refresh();
      },
      onLoadFailed: () => {
        this.chatStatus = 'Chat model could not load';
        this.ui.barWrap.hidden = true;
        this.thinking = false;
        this.refresh();
      },
      onThinking: () => {
        this.thinking = true;
        this.refresh();
      },
      onWord: (word, ms, first) => this.showWord(word, ms, first),
      onReplyEnd: () => {
        this.replying = false;
        this.refresh();
      },
      onReplyFailed: () => {
        this.thinking = false;
        this.replying = false;
        this.ui.reply.textContent = 'Sorry, I lost my train of thought.';
        this.refresh();
      },
    });

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

  showChatProgress(p) {
    if (!p || p.status !== 'progress' || !p.total) return;
    this.chatFiles.set(p.file, p);
    const files = [...this.chatFiles.values()];
    const loaded = files.reduce((a, f) => a + f.loaded, 0);
    const total = files.reduce((a, f) => a + f.total, 0);
    const percent = Math.round((loaded / total) * 100);
    this.ui.barWrap.hidden = false;
    this.ui.bar.style.width = `${percent}%`;
    this.chatStatus = percent < 100 ? `Downloading chat model… ${percent}%` : 'Starting chat model…';
    this.refresh();
  }

  addLine(text) {
    this.ui.caption.textContent = text;
    this.ui.caption.classList.remove('fade');
    void this.ui.caption.offsetWidth;
    this.ui.caption.classList.add('fade');
    this.thinking = true;
    this.chat.send(text);
    this.refresh();
  }

  showWord(word, ms, first) {
    if (first) this.ui.reply.textContent = '';
    this.thinking = false;
    this.replying = true;
    const span = document.createElement('span');
    span.className = 'word';
    span.textContent = word;
    if (this.ui.reply.childNodes.length && !isCjk(word) && !isCjk(this.ui.reply.lastChild.textContent)) this.ui.reply.append(' ');
    this.ui.reply.append(span);
    this.ui.reply.scrollTop = this.ui.reply.scrollHeight;
    this.character.sayWord(word, ms);
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
    else if (this.replying) state = 'speaking';
    else if (this.pending > 0 || this.thinking) state = 'thinking';
    else if (performance.now() < this.happyUntil) state = 'happy';
    this.character.setState(state);
    this.ui.pill.dataset.state = state;
    if (this.running && this.modelReady) {
      const label = {
        idle: this.chatStatus || 'Listening…',
        listening: 'Hearing you',
        thinking: this.pending > 0 ? 'Transcribing…' : this.chat.ready ? 'Thinking…' : this.chatStatus,
        speaking: 'Speaking',
        happy: 'Got it',
      }[state];
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
      this.chat.load(CHAT_MODEL);
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
