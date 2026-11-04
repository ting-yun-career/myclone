const CJK_CHARS = '\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const WORD = new RegExp(`[${CJK_CHARS}]|[^\\s${CJK_CHARS}]+`, 'g');
const CJK = new RegExp(`^[${CJK_CHARS}]$`);
const HISTORY_LIMIT = 10;
const SYSTEM_PROMPT = 'You are a friendly person having a spoken conversation. Reply in one or two short, natural sentences. Use plain words. Do not use lists or markdown.';

export const isCjk = (word) => CJK.test(word);

const wordDuration = (word) => {
  if (/^[，、；：]$/.test(word)) return 220;
  if (/^[。！？]$/.test(word)) return 420;
  if (CJK.test(word)) return 230;
  let ms = Math.min(650, 170 + 35 * word.length);
  if (/[,;:]$/.test(word)) ms += 220;
  if (/[.!?]$/.test(word)) ms += 420;
  return ms;
};

/**
 * Conversation with a local LLM. Replies come out one word at a time, at speaking pace.
 * Handlers: onProgress, onReady, onLoadFailed, onThinking, onWord, onReplyEnd, onReplyFailed
 */
export class Chat {
  constructor(handlers = {}) {
    this.h = handlers;
    this.ready = false;
    this.history = [];
    this.waiting = null; // text said before the model was ready
    this.replyId = 0;
    this.words = [];
    this.tail = '';
    this.spoken = [];
    this.generating = false;
    this.timer = null;
  }

  get active() {
    return this.generating || this.timer !== null || this.words.length > 0;
  }

  load(model) {
    this.worker = new Worker(new URL('./chat-worker.js', import.meta.url), { type: 'module' });
    this.worker.onerror = (e) => {
      console.error('Chat worker failed to start', e);
      this.h.onLoadFailed?.();
    };
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.postMessage({ type: 'load', model });
  }

  _onMessage(m) {
    switch (m.type) {
      case 'progress':
        this.h.onProgress?.(m.p);
        break;
      case 'ready':
        this.ready = true;
        this.h.onReady?.(m.device);
        if (this.waiting) {
          const text = this.waiting;
          this.waiting = null;
          this.send(text);
        }
        break;
      case 'token':
        if (m.id === this.replyId) this._addText(m.text);
        break;
      case 'done':
        if (m.id !== this.replyId) break;
        this.generating = false;
        this._addText(' ');
        this._pump();
        break;
      case 'error':
        if (m.id === undefined) {
          this.h.onLoadFailed?.();
        } else if (m.id === this.replyId) {
          this.generating = false;
          this.h.onReplyFailed?.();
        }
        break;
    }
  }

  send(text) {
    this.interrupt();
    this.history.push({ role: 'user', content: text });
    if (!this.ready) {
      this.history.pop();
      this.waiting = text;
      return;
    }
    this.generating = true;
    this.h.onThinking?.();
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history.slice(-HISTORY_LIMIT)];
    this.worker.postMessage({ type: 'generate', id: ++this.replyId, messages });
  }

  // The listener started talking: stop at the current word and remember what was said.
  interrupt() {
    if (!this.active) return;
    if (this.generating) this.worker.postMessage({ type: 'interrupt' });
    this.replyId++;
    this.generating = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.words = [];
    this.tail = '';
    this._remember();
  }

  _remember() {
    if (this.spoken.length) this.history.push({ role: 'assistant', content: this.spoken.join(' ') });
    this.spoken = [];
  }

  _addText(text) {
    this.tail += text;
    const parts = this.tail.match(WORD) || [];
    const open = parts.length && this.tail.endsWith(parts[parts.length - 1]) && !CJK.test(parts[parts.length - 1]);
    this.tail = open ? parts.pop() : '';
    this.words.push(...parts);
    this._pump();
  }

  _pump() {
    if (this.timer !== null) return;
    const word = this.words.shift();
    if (word === undefined) {
      if (!this.generating && this.spoken.length) {
        this._remember();
        this.h.onReplyEnd?.();
      }
      return;
    }
    const ms = wordDuration(word);
    this.spoken.push(word);
    this.h.onWord?.(word, ms, this.spoken.length === 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      this._pump();
    }, ms);
  }
}

/** Scripted stand-in so the reply flow can be previewed without downloading a model (?demochat). */
export class DemoChat extends Chat {
  load() {
    this.ready = true;
    this.h.onReady?.('demo');
  }

  send(text) {
    this.interrupt();
    this.generating = true;
    this.h.onThinking?.();
    const id = ++this.replyId;
    const reply = 'Yes, I can hear you clearly. What would you like to talk about today?';
    setTimeout(() => {
      this._onMessage({ type: 'token', id, text: reply });
      this._onMessage({ type: 'done', id });
    }, 800);
  }
}
