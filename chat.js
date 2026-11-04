const CJK_CHARS = '\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const WORD = new RegExp(`[${CJK_CHARS}]|[^\\s${CJK_CHARS}]+`, 'g');
const CJK = new RegExp(`^[${CJK_CHARS}]$`);
const API = '/api/ollama';
const MODEL = import.meta.env.VITE_OLLAMA_MODEL;
const MAX_TOKENS = 150;
const HISTORY_LIMIT = 10;
const SYSTEM_PROMPT = 'You are a helpful, knowledgeable assistant talking out loud with a friend. Answer the question directly and correctly in one or two short sentences. Do not use emoji, lists or markdown.';

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

const failureMessage = (status) => {
  if (status === 401 || status === 403) return 'The chat server refused the request.';
  if (status === 404) return 'The chat model is not installed on the server.';
  if (status === 429) return 'The chat server is busy. Try again soon.';
  return 'The chat server is not reachable.';
};

/**
 * Conversation through the Ollama proxy. Replies come out one word at a time, at speaking pace.
 * Handlers: onReady, onLoadFailed, onThinking, onWord, onReplyEnd, onReplyFailed
 */
export class Chat {
  constructor(handlers = {}) {
    this.h = handlers;
    this.history = [];
    this.replyId = 0;
    this.words = [];
    this.tail = '';
    this.spoken = [];
    this.generating = false;
    this.timer = null;
    this.request = null;
  }

  get active() {
    return this.generating || this.timer !== null || this.words.length > 0;
  }

  // Checks that the server answers and has the model. Replies are still attempted if this fails.
  async load() {
    try {
      const res = await fetch(`${API}/models`);
      if (!res.ok) return this.h.onLoadFailed?.(failureMessage(res.status));
      const { data } = await res.json();
      if (!data.some((m) => m.id === MODEL)) return this.h.onLoadFailed?.(failureMessage(404));
      this.h.onReady?.();
    } catch (err) {
      console.error('Chat server check failed', err);
      this.h.onLoadFailed?.(failureMessage());
    }
  }

  send(text) {
    this.interrupt();
    this.history.push({ role: 'user', content: text });
    this.generating = true;
    this.h.onThinking?.();
    this._stream(++this.replyId);
  }

  // Sends a corrected message in place of the last exchange.
  replaceLast(text) {
    this.interrupt();
    if (this.history.at(-1)?.role === 'assistant') this.history.pop();
    if (this.history.at(-1)?.role === 'user') this.history.pop();
    this.send(text);
  }

  async _stream(id) {
    this.request = new AbortController();
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history.slice(-HISTORY_LIMIT)];
    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, stream: true, max_tokens: MAX_TOKENS, messages }),
        signal: this.request.signal,
      });
      if (!res.ok) return this._fail(id, failureMessage(res.status));
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: {') || id !== this.replyId) continue;
          const content = JSON.parse(line.slice(6)).choices[0]?.delta?.content;
          if (content) this._addText(content);
        }
      }
      this._finish(id);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Chat reply failed', err);
      this._fail(id, failureMessage());
    }
  }

  _finish(id) {
    if (id !== this.replyId) return;
    this.generating = false;
    this._addText(' ');
    if (!this.spoken.length && !this.words.length) this.h.onReplyEnd?.();
  }

  _fail(id, message) {
    if (id !== this.replyId) return;
    if (this.spoken.length || this.words.length) return this._finish(id);
    this.generating = false;
    this.history.pop();
    this.h.onReplyFailed?.(message);
  }

  // The listener started talking: stop at the current word and remember what was said.
  interrupt() {
    if (!this.active) return;
    this.request?.abort();
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

/** Scripted stand-in so the reply flow can be previewed without the server (?demochat). */
export class DemoChat extends Chat {
  load() {
    this.h.onReady?.();
  }

  send(text) {
    this.interrupt();
    this.generating = true;
    this.h.onThinking?.();
    const id = ++this.replyId;
    setTimeout(() => {
      if (id !== this.replyId) return;
      this._addText('Yes, I can hear you clearly. What would you like to talk about today?');
      this._finish(id);
    }, 800);
  }
}
