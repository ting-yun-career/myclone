import { Character } from './character.js';
import { BrowserDictation, Dictation, DemoDictation } from './dictation.js';
import { Chat, DemoChat, isCjk } from './chat.js';

const $ = (id) => document.getElementById(id);
const MODEL = 'onnx-community/whisper-base';
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const DEMO_CHAT = params.has('demochat');
const WHISPER = params.has('whisper');

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
    this.lastMessage = '';
    this.chatStatus = 'Connecting to chat model…';
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
        if (this.editing) return;
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
      onInterim: (text) => {
        if (!this.editing) this.showMessage(text);
      },
      onText: (text) => {
        if (!this.editing) this.addLine(text);
      },
      onError: (msg) => this.fail(msg),
    };
    const DictationClass = DEMO ? DemoDictation : WHISPER ? Dictation : BrowserDictation;
    this.dictation = new DictationClass(handlers);

    const ChatClass = DEMO_CHAT ? DemoChat : Chat;
    this.chat = new ChatClass({
      onReady: () => {
        this.chatStatus = null;
        this.refresh();
      },
      onLoadFailed: (message) => {
        this.chatStatus = message;
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
      onReplyFailed: (message) => {
        this.thinking = false;
        this.replying = false;
        this.ui.reply.textContent = message;
        this.refresh();
      },
    });

    this.ui.caption.addEventListener('keydown', (e) => this.onCaptionKey(e));
    this.ui.caption.addEventListener('blur', () => {
      if (!this.ui.caption.value.trim()) this.ui.caption.value = this.lastMessage;
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

  get editing() {
    return document.activeElement === this.ui.caption;
  }

  showMessage(text) {
    this.ui.caption.value = text;
    this.ui.caption.hidden = false;
  }

  onCaptionKey(e) {
    if (e.key === 'Escape') {
      this.ui.caption.value = this.lastMessage;
      this.ui.caption.blur();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    const text = this.ui.caption.value.trim();
    if (!text) return;
    this.ui.caption.value = text;
    this.ui.caption.blur();
    this.lastMessage = text;
    this.ui.reply.textContent = '';
    this.thinking = true;
    this.replying = false;
    this.chat.replaceLast(text);
    this.refresh();
  }

  addLine(text) {
    this.showMessage(text);
    this.lastMessage = text;
    this.ui.caption.classList.remove('fade');
    void this.ui.caption.offsetWidth;
    this.ui.caption.classList.add('fade');
    this.thinking = true;
    this.chat.send(text);
    this.refresh();
  }

  showWord(word, ms, first) {
    if (first) this.ui.reply.textContent = '';
    this.chatStatus = null;
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
        thinking: this.pending > 0 ? 'Transcribing…' : 'Thinking…',
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
      this.chat.load();
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
