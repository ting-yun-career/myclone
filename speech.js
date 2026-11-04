const MALE_VOICES = ['Google UK English Male', 'Microsoft Guy', 'Microsoft Ryan', 'Microsoft David', 'Microsoft Mark', 'Daniel', 'Alex', 'Fred'];
const MIN_WATCHDOG_MS = 8000;
const WATCHDOG_MS_PER_CHAR = 150;
const ECHO_TAIL_MS = 1500;
const ECHO_MATCH = 0.5;

const wordsOf = (text) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

const pickVoice = () => {
  const voices = speechSynthesis.getVoices();
  for (const name of MALE_VOICES) {
    const voice = voices.find((v) => v.name.startsWith(name));
    if (voice) return voice;
  }
  return voices.find((v) => v.lang.startsWith('en')) ?? null;
};

/**
 * Reads sentences aloud with the browser's built-in speech synthesis.
 * Handlers: onStart, onIdle
 */
export class Speaker {
  constructor(handlers = {}) {
    this.h = handlers;
    this.active = new Set(); // Chrome can drop an utterance that nothing references
    this.recentWords = new Set();
    this.forgetTimer = null;
    this.blocked = [];
    this._replayOnFirstGesture();
    speechSynthesis.cancel(); // speech from the previous page load can still be playing
    speechSynthesis.getVoices();
  }

  get speaking() {
    return this.active.size > 0;
  }

  // Chrome silently drops speech until the user clicks or presses a key on the page.
  get needsGesture() {
    return navigator.userActivation?.hasBeenActive === false;
  }

  _replayOnFirstGesture() {
    const onGesture = () => {
      if (this.needsGesture) return;
      removeEventListener('click', onGesture, true);
      removeEventListener('keydown', onGesture, true);
      const sentences = this.blocked;
      this.blocked = [];
      for (const sentence of sentences) this.speak(sentence);
    };
    addEventListener('click', onGesture, true);
    addEventListener('keydown', onGesture, true);
  }

  // The microphone stays open, so it can hear this voice. Mostly known words mean it did.
  isEcho(text) {
    if (!this.recentWords.size) return false;
    const words = wordsOf(text);
    if (!words.length) return true;
    return words.filter((w) => this.recentWords.has(w)).length / words.length >= ECHO_MATCH;
  }

  speak(text) {
    const spoken = text.replace(/[*_#`]/g, '').trim();
    if (!spoken) return;
    if (this.needsGesture) {
      this.blocked.push(spoken);
      return;
    }
    clearTimeout(this.forgetTimer);
    for (const word of wordsOf(spoken)) this.recentWords.add(word);
    const utterance = new SpeechSynthesisUtterance(spoken);
    const voice = pickVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    const wasIdle = !this.speaking;
    this.active.add(utterance);
    // Chrome sometimes never fires end, which would leave the avatar marked as speaking.
    const watchdog = setTimeout(() => done(), Math.max(MIN_WATCHDOG_MS, spoken.length * WATCHDOG_MS_PER_CHAR));
    const done = () => {
      clearTimeout(watchdog);
      if (!this.active.delete(utterance)) return;
      if (this.speaking) return;
      this.forgetTimer = setTimeout(() => this.recentWords.clear(), ECHO_TAIL_MS);
      this.h.onIdle?.();
    };
    utterance.onend = done;
    utterance.onerror = (e) => {
      if (e.error !== 'canceled' && e.error !== 'interrupted') console.warn(`Speech synthesis error: ${e.error}`);
      done();
    };
    if (wasIdle) this.h.onStart?.();
    speechSynthesis.speak(utterance);
  }

  cancel() {
    const wasSpeaking = this.speaking;
    this.blocked = [];
    this.active.clear();
    clearTimeout(this.forgetTimer);
    this.recentWords.clear();
    speechSynthesis.cancel();
    if (wasSpeaking) this.h.onIdle?.();
  }
}
