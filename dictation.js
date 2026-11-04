const RESTART_DELAY_MS = 250;

/**
 * Live dictation with Chrome's built-in speech recognition. Chrome sends the audio to Google.
 * Android ends sessions after each pause and plays a system sound on every start, so it listens per tap instead.
 * Handlers: onReady, onSpeechStart, onSpeechEnd, onFrame, onInterim, onText, onError, onYield, isEcho, onListenChange, onTapError
 */
export class BrowserDictation {
  constructor(handlers = {}, { tapToTalk = false } = {}) {
    this.h = handlers;
    this.tapToTalk = tapToTalk;
    this.running = false;
    this.active = false;
    this.speaking = false;
    this.interim = '';
    this.restartTimer = null;
    this.yielded = false;
  }

  async loadModel() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) throw new Error('This browser has no built-in speech recognition');
    this.recognition = new Recognition();
    this.recognition.continuous = !this.tapToTalk;
    this.recognition.interimResults = true;
    this.recognition.lang = navigator.language;
    this.recognition.onresult = (e) => this._onResult(e);
    this.h.onReady?.('browser');
  }

  start() {
    return new Promise((resolve, reject) => {
      this.running = true;
      this.recognition.onstart = () => {
        this.active = true;
        this.h.onListenChange?.();
        resolve();
      };
      this.recognition.onerror = (e) => {
        if (e.error === 'no-speech') return;
        if (this.tapToTalk) {
          if (e.error !== 'aborted') this.h.onTapError?.(this._errorMessage(e.error));
          return;
        }
        if (e.error === 'aborted') {
          this.yielded = true; // another tab took the session
          this.h.onYield?.();
          return;
        }
        this.running = false;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          const denied = new Error('Microphone permission was denied');
          denied.name = 'NotAllowedError';
          reject(denied);
          return;
        }
        console.error(`Speech recognition error: ${e.error}`);
        const message = this._errorMessage(e.error);
        reject(new Error(message));
        this.h.onError?.(message);
      };
      // Chrome ends a session after silence or about a minute, so restart it.
      this.recognition.onend = () => {
        this.active = false;
        this._closeUtterance();
        this.h.onListenChange?.();
        if (!this.tapToTalk) this._restartSoon();
      };
      document.addEventListener('visibilitychange', () => this._onVisibilityChange());
      addEventListener('focus', () => this._reclaim());
      addEventListener('pointerdown', () => this._reclaim());
      if (document.hidden || this.tapToTalk) resolve();
      else this.recognition.start();
    });
  }

  get listening() {
    return this.tapToTalk && this.active;
  }

  // Tap to talk: starts one session, or ends the current one.
  toggleListening() {
    if (this.active) this.recognition.stop();
    else this.recognition.start();
  }

  _errorMessage(error) {
    if (error === 'not-allowed' || error === 'service-not-allowed') return 'Microphone permission was denied';
    return error === 'network' ? 'Speech recognition service is not reachable' : 'Speech recognition stopped working';
  }

  // Chrome runs one recognition session at a time, and open tabs would keep aborting each other.
  // The tab that started last keeps it. A hidden tab lets go, and a tab the user returns to takes it back.
  _onVisibilityChange() {
    if (!document.hidden) this._reclaim();
    else if (this.active) this.recognition.stop();
  }

  _reclaim() {
    if (!this.yielded) return;
    this.yielded = false;
    this._restartSoon();
  }

  _restartSoon() {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (this.running && !this.active && !this.yielded && !document.hidden) this.recognition.start();
    }, RESTART_DELAY_MS);
  }

  _onResult(e) {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        if (this._isEcho(text)) continue;
        this.interim = text;
        this._closeUtterance();
      } else {
        interim += text;
      }
    }
    if (!interim.trim() || this._isEcho(interim)) return;
    if (!this.speaking) {
      this.speaking = true;
      this.h.onSpeechStart?.();
    }
    this.interim = interim;
    this.h.onFrame?.(1);
    this.h.onInterim?.(interim.trim());
  }

  // Once the user is talking, nothing more is treated as the avatar's voice.
  _isEcho(text) {
    return !this.speaking && Boolean(this.h.isEcho?.(text));
  }

  _closeUtterance() {
    const text = this.interim.trim();
    this.interim = '';
    if (this.speaking) {
      this.speaking = false;
      this.h.onSpeechEnd?.();
    }
    if (text) this.h.onText?.(text, 0);
  }

  async stop() {
    this.running = false;
    this.recognition?.stop();
  }
}

/** Scripted stand-in so the character can be previewed without a mic (?demo). */
export class DemoDictation {
  constructor(handlers = {}) {
    this.h = handlers;
    this.timer = null;
  }

  async loadModel() {
    this.h.onReady?.('demo');
  }

  async start() {
    const lines = ['My favorite flavor is meat chocolate.', 'Hello, can you hear me?', 'This is a demo transcript.', '你好，這是一個測試。'];
    let i = 0;
    const cycle = () => {
      this.h.onSpeechStart?.();
      const frames = setInterval(() => this.h.onFrame?.(0.6 + Math.random() * 0.4), 32);
      setTimeout(() => {
        clearInterval(frames);
        this.h.onFrame?.(0);
        this.h.onSpeechEnd?.();
        setTimeout(() => {
          this.h.onText?.(lines[i++ % lines.length], 640);
          this.timer = setTimeout(cycle, 25000);
        }, 1200);
      }, 2200);
    };
    this.timer = setTimeout(cycle, 800);
  }

  async stop() {
    clearTimeout(this.timer);
  }
}
