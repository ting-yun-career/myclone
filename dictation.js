const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const MAX_SEGMENT_MS = 20000; // force a cut if someone talks this long without pausing

/**
 * Live dictation: microphone -> Silero VAD (utterance boundaries) -> Whisper worker.
 * Handlers: onStatus, onProgress, onReady, onSpeechStart, onSpeechEnd, onFrame,
 *           onPending, onText, onError
 */
export class Dictation {
  constructor(handlers = {}) {
    this.h = handlers;
    this.language = 'auto';
    this.worker = null;
    this.vad = null;
    this.ready = false;
    this.pending = 0;
    this.nextId = 1;
    this.speechStartedAt = 0;
    this.cutting = false;
  }

  _emit(name, ...args) {
    this.h[name]?.(...args);
  }

  loadModel(model) {
    return new Promise((resolve, reject) => {
      this.worker?.terminate();
      this.ready = false;
      this.worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
      this.worker.onerror = (e) => {
        this._emit('onError', `Worker failed: ${e.message || 'could not start'}`);
        reject(e);
      };
      this.worker.onmessage = (e) => {
        const m = e.data;
        switch (m.type) {
          case 'status':
            this._emit('onStatus', m.text);
            break;
          case 'progress':
            this._emit('onProgress', m.p);
            break;
          case 'ready':
            this.ready = true;
            this._emit('onReady', m.device);
            resolve(m.device);
            break;
          case 'result':
            this.pending--;
            this._emit('onPending', this.pending);
            if (m.text) this._emit('onText', m.text, m.ms);
            break;
          case 'error':
            if (m.id) {
              this.pending--;
              this._emit('onPending', this.pending);
            } else {
              reject(new Error(m.message));
            }
            this._emit('onError', m.message);
            break;
        }
      };
      this.worker.postMessage({ type: 'load', model });
    });
  }

  async start() {
    if (this.vad) return this.vad.start();
    const { MicVAD } = window.vad;
    this.vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: VAD_BASE,
      onnxWASMBasePath: ORT_BASE,
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionMs: 700, // silence needed to close an utterance
      preSpeechPadMs: 300,
      minSpeechMs: 300,
      submitUserSpeechOnPause: true,
      onSpeechStart: () => {
        this.speechStartedAt = performance.now();
        this._emit('onSpeechStart');
      },
      onSpeechEnd: (audio) => {
        this.speechStartedAt = 0;
        this._emit('onSpeechEnd');
        this._submit(audio);
      },
      onVADMisfire: () => {
        this.speechStartedAt = 0;
        this._emit('onSpeechEnd');
      },
      onFrameProcessed: (probs) => {
        this._emit('onFrame', probs.isSpeech);
        if (this.speechStartedAt && !this.cutting && performance.now() - this.speechStartedAt > MAX_SEGMENT_MS) {
          this._forceCut();
        }
      },
    });
    await this.vad.start();
  }

  async _forceCut() {
    this.cutting = true;
    await this.vad.pause(); // submitUserSpeechOnPause emits the current segment
    await this.vad.start();
    this.cutting = false;
  }

  _submit(audio) {
    this.pending++;
    this._emit('onPending', this.pending);
    this.worker.postMessage({ type: 'transcribe', id: this.nextId++, audio, language: this.language }, [audio.buffer]);
  }

  async stop() {
    await this.vad?.pause();
  }
}

/** Scripted stand-in so the character can be previewed without a mic or models (?demo). */
export class DemoDictation {
  constructor(handlers = {}) {
    this.h = handlers;
    this.language = 'auto';
    this.timer = null;
  }

  async loadModel() {
    for (let i = 1; i <= 10; i++) {
      this.h.onProgress?.({ status: 'progress', file: 'demo.onnx', progress: i * 10 });
      await new Promise((r) => setTimeout(r, 120));
    }
    this.h.onReady?.('demo');
    return 'demo';
  }

  async start() {
    const lines = ['Hello, can you hear me?', 'This is a demo transcript.', '你好，這是一個測試。'];
    let i = 0;
    const cycle = () => {
      this.h.onSpeechStart?.();
      const frames = setInterval(() => this.h.onFrame?.(0.6 + Math.random() * 0.4), 32);
      setTimeout(() => {
        clearInterval(frames);
        this.h.onFrame?.(0);
        this.h.onSpeechEnd?.();
        this.h.onPending?.(1);
        setTimeout(() => {
          this.h.onPending?.(0);
          this.h.onText?.(lines[i++ % lines.length], 640);
          this.timer = setTimeout(cycle, 3000);
        }, 1200);
      }, 2200);
    };
    this.timer = setTimeout(cycle, 800);
  }

  async stop() {
    clearTimeout(this.timer);
  }
}
