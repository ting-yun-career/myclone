import { Character } from './character.js';
import { BrowserDictation, DemoDictation } from './dictation.js';
import { Chat, DemoChat, isCjk } from './chat.js';
import { Speaker } from './speech.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const DEMO_CHAT = params.has('demochat');
const FAKE_NEURONS = params.get('neurons'); // test hook: ?neurons=9700 pretends 9,700 neurons are used
const SLEEP_AT = 0.95;
const NEURON_POLL_MS = 60000;
const SLEEP_REASON = { budget: 'chat budget nearly used up', chat: 'chat unavailable' };
const ONE_TAB_NOTICE = 'Voice input moved to another tab running this site. For the best experience, please keep the site open in only one tab.';
const BUDGET_NOTICE = 'Sleeping. The daily chat budget is nearly used up. It resets at 00:00 UTC.';

class App {
  constructor() {
    this.ui = {
      pill: $('pill'),
      pillText: $('pillText'),
      said: $('said'),
      statusMain: $('statusMain'),
      statusNeurons: $('statusNeurons'),
      statusSound: $('statusSound'),
      statusVoice: $('statusVoice'),
      status: $('status'),
      caption: $('caption'),
      reply: $('reply'),
    };
    this.speaking = false;
    this.modelReady = false;
    this.running = false;
    this.busy = false;
    this.happyUntil = 0;
    this.thinking = false;
    this.replying = false;
    this.utteranceId = 0;
    this.typing = false;
    this.tabNoticeShown = false;
    this.sleepReason = null;
    this.neurons = null;
    this.lastPoll = 0;
    this.statusText = '';
    this.chatStatus = 'Connecting to chat model…';

    this.character = new Character($('stage'));
    this.speaker = new Speaker({ onStart: () => this.refresh(), onIdle: () => this.refresh() });
    const handlers = {
      isEcho: (text) => this.speaker.isEcho(text),
      onYield: () => {
        this.refresh();
        if (this.tabNoticeShown) return;
        this.tabNoticeShown = true;
        setTimeout(() => alert(ONE_TAB_NOTICE));
      },
      onReady: (device) => {
        this.modelReady = true;
        this.setStatus(device === 'demo' ? 'Demo mode' : `Model ready (${device})`);
      },
      onSpeechStart: () => {
        if (this.ignoresSpeech) return;
        this.speaking = true;
        this.utteranceId++;
        this.chat.interrupt();
        this.speaker.cancel();
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
      onInterim: (text) => {
        if (!this.ignoresSpeech) this.showInterim(text);
      },
      onText: (text) => {
        if (!this.ignoresSpeech) this.addLine(text);
      },
      onError: (msg) => this.fail(msg),
    };
    const DictationClass = DEMO ? DemoDictation : BrowserDictation;
    this.dictation = new DictationClass(handlers);

    const ChatClass = DEMO_CHAT ? DemoChat : Chat;
    this.chat = new ChatClass({
      onReady: () => {
        this.chatStatus = null;
        this.refresh();
      },
      onThinking: () => {
        this.thinking = true;
        this.refresh();
      },
      onWord: (word, ms, first) => this.showWord(word, ms, first),
      onSentence: (sentence) => this.speaker.speak(sentence),
      onReplyEnd: () => {
        this.thinking = false;
        this.replying = false;
        if (Date.now() - this.lastPoll > NEURON_POLL_MS / 3) this.pollNeurons();
        this.refresh();
      },
      onReplyFailed: (message) => {
        this.thinking = false;
        this.replying = false;
        this.ui.reply.textContent = message;
        this.sleep('chat');
      },
    });

    this.ui.caption.addEventListener('keydown', (e) => this.onCaptionKey(e));
    this.ui.caption.addEventListener('input', () => {
      this.typing = this.ui.caption.value.trim() !== '';
    });

    setInterval(() => this.refresh(), 250); // lets the "happy" state expire
    this.pollNeurons();
    setInterval(() => this.pollNeurons(), NEURON_POLL_MS);
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

  get editing() {
    return this.typing && document.activeElement === this.ui.caption;
  }

  get asleep() {
    return this.sleepReason !== null;
  }

  // The budget is nearly gone: stop listening and stop sending.
  get budgetSleep() {
    return this.sleepReason === 'budget';
  }

  get ignoresSpeech() {
    return this.editing || this.budgetSleep;
  }

  sleep(reason) {
    this.sleepReason = reason;
    this.chat.interrupt();
    this.speaker.cancel();
    this.speaking = false;
    this.thinking = false;
    this.replying = false;
    this.character.setSpeech(0);
    this.refresh();
  }

  wake() {
    this.sleepReason = null;
    this.refresh();
  }

  async pollNeurons() {
    this.lastPoll = Date.now();
    try {
      if (FAKE_NEURONS !== null) {
        this.neurons = { used: Number(FAKE_NEURONS), limit: 10000 };
      } else {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const { neuronsUsed, neuronsLimit } = await res.json();
        this.neurons = { used: neuronsUsed, limit: neuronsLimit };
      }
    } catch (err) {
      console.warn('Neuron usage unavailable', err);
      this.neurons = null;
    }
    const full = this.neurons && this.neurons.used >= SLEEP_AT * this.neurons.limit;
    if (full && !this.budgetSleep) this.sleep('budget');
    else if (!full && this.budgetSleep) this.wake();
    else this.refresh();
  }

  showInterim(text) {
    this.ui.caption.value = text;
  }

  // The sent message moves from the input to the line above it.
  showSent(text) {
    this.ui.caption.value = '';
    this.typing = false;
    this.ui.said.textContent = text;
    this.ui.said.classList.remove('fade');
    void this.ui.said.offsetWidth;
    this.ui.said.classList.add('fade');
  }

  onCaptionKey(e) {
    if (e.key === 'Escape') {
      this.ui.caption.blur();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    const text = this.ui.caption.value.trim();
    if (!text) return;
    this.showSent(text);
    this.ui.reply.textContent = '';
    this.replying = false;
    if (this.budgetSleep) {
      this.ui.reply.textContent = BUDGET_NOTICE;
      return;
    }
    this.correctAndSend(text);
  }

  addLine(text) {
    this.showSent(text);
    this.correctAndSend(text);
    this.refresh();
  }

  async correctAndSend(text) {
    const id = ++this.utteranceId;
    this.chat.interrupt();
    this.speaker.cancel();
    this.thinking = true;
    this.refresh();
    const fixed = await this.chat.correct(text);
    if (id !== this.utteranceId) return;
    this.ui.said.textContent = fixed;
    this.chat.send(fixed);
  }

  showWord(word, ms, first) {
    if (first) this.ui.reply.textContent = '';
    if (this.sleepReason === 'chat') this.sleepReason = null; // the chat answered again
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
    if (this.asleep) state = 'sleep';
    else if (this.busy && !this.modelReady) state = 'loading';
    else if (this.speaking) state = 'listening';
    else if (this.replying || this.speaker.speaking) state = 'speaking';
    else if (this.thinking) state = 'thinking';
    else if (performance.now() < this.happyUntil) state = 'happy';
    this.character.setState(state);
    this.ui.pill.dataset.state = state;
    if (this.running && this.modelReady) {
      const label = {
        idle: this.chatStatus || 'Listening…',
        listening: 'Hearing you',
        thinking: 'Thinking…',
        speaking: 'Speaking',
        happy: 'Got it',
        sleep: 'Sleeping',
      }[state];
      if (label) this.setStatus(label);
    }
    this.renderStatus();
  }

  renderStatus() {
    const { neurons } = this;
    const voice = this.budgetSleep ? 'paused' : this.dictation.yielded ? 'in another tab' : this.running ? 'on' : 'off';
    const lines = [
      this.asleep ? `Status: Sleeping (${SLEEP_REASON[this.sleepReason]})` : `Status: Awake${DEMO_CHAT ? ' (scripted replies)' : ''}`,
      this.editing ? '' : `Voice: ${voice}`,
      neurons ? `Token: ${Math.max(0, Math.round(100 - (100 * neurons.used) / neurons.limit))}% left` : 'Token: ?',
    ];
    this.ui.statusSound.hidden = !this.speaker.needsGesture;
    const text = lines.join('\n');
    if (text === this.statusText) return;
    this.statusText = text;
    const { statusMain, statusNeurons, statusVoice, status } = this.ui;
    [statusMain.textContent, statusVoice.textContent, statusNeurons.textContent] = lines;
    statusVoice.hidden = !lines[1];
    status.toggleAttribute('data-sleeping', this.asleep);
  }

  // ---- actions -----------------------------------------------------------

  async start() {
    this.busy = true;
    this.setStatus('Starting…');
    try {
      this.refresh();
      await this.dictation.loadModel();
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
