const CJK_CHARS = '\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const WORD = new RegExp(`[${CJK_CHARS}]|[^\\s${CJK_CHARS}]+`, 'g');
const CJK = new RegExp(`^[${CJK_CHARS}]$`);
const CHAT_URL = '/api/ai/chat/completions';
const MODEL = import.meta.env.VITE_CF_MODEL;
const MAX_TOKENS = 150;
const HISTORY_LIMIT = 10;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const SYSTEM_PROMPT = 'You are John Smith, a warm person talking out loud with someone. Stay John Smith at all times. Always reply in one or two short sentences, never more than 25 words, even when explaining something. Answer questions directly and correctly. Do not use emoji, lists or markdown.';

const CORRECTION_PROMPT = 'You fix speech recognition errors. The input is what a speech recognizer heard. A word may be misheard as a similar-sounding word, which makes the phrase odd or impossible. Replace such words with the word the speaker meant. Keep all other words and punctuation exactly as they are. Do not rephrase, answer, translate or add anything. If nothing is wrong, return the input unchanged. Return only the sentence.';
const CORRECTION_EXAMPLES = [
  ['My favorite ice cream is meat chocolate.', 'My favorite ice cream is mint chocolate.'],
  ['I want to by a new car.', 'I want to buy a new car.'],
  ['Can you here me?', 'Can you hear me?'],
  ['I would like a glass of whine.', 'I would like a glass of wine.'],
  ['I ate meat and rice for dinner.', 'I ate meat and rice for dinner.'],
  ['I saw a bear in the woods.', 'I saw a bear in the woods.'],
  ['Tell me a joke.', 'Tell me a joke.'],
].flatMap(([heard, meant]) => [{ role: 'user', content: heard }, { role: 'assistant', content: meant }]);
const CORRECTION_MAX_TOKENS = 200;
const CORRECTION_TIMEOUT_MS = 3000;
const MAX_WORDS_CHANGED = 2;

const wordCount = (text) => text.trim().split(/\s+/).length;

// A correction swaps a few words. Anything else means the model answered or rewrote the text.
const isPlausibleFix = (original, fixed) =>
  fixed.length > 0
  && fixed.length <= original.length * 1.5 + 10
  && Math.abs(wordCount(fixed) - wordCount(original)) <= MAX_WORDS_CHANGED;

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
  if (status === 404) return 'The chat model is not available.';
  if (status === 429) return 'The chat limit is reached. Try again later.';
  return 'The chat server is not reachable.';
};

/**
 * Conversation with Workers AI through the dev server proxy. Replies come out one word at a time, at speaking pace.
 * Handlers: onReady, onThinking, onWord, onReplyEnd, onReplyFailed
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

  load() {
    this.h.onReady?.();
  }

  // Fixes misheard words in dictated text. Any failure returns the text unchanged.
  async correct(text) {
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          stream: false,
          temperature: 0,
          max_tokens: CORRECTION_MAX_TOKENS,
          messages: [{ role: 'system', content: CORRECTION_PROMPT }, ...CORRECTION_EXAMPLES, { role: 'user', content: text }],
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(CORRECTION_TIMEOUT_MS),
      });
      if (!res.ok) return text;
      const { message } = (await res.json()).choices[0];
      // Workers AI returns non-streamed Qwen3 text in the reasoning field.
      const fixed = (message.content || message.reasoning || '').trim();
      return isPlausibleFix(text, fixed) ? fixed : text;
    } catch (err) {
      console.warn('Speech correction skipped', err);
      return text;
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
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          stream: true,
          max_tokens: MAX_TOKENS,
          messages,
          chat_template_kwargs: { enable_thinking: false }, // reasoning would use up max_tokens
        }),
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
    this.tail += text.replace(EMOJI, '');
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
  async correct(text) {
    return text;
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
