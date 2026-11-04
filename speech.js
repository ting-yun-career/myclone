const MALE_VOICES = ['Google UK English Male', 'Microsoft Guy', 'Microsoft Ryan', 'Microsoft David', 'Microsoft Mark', 'Daniel', 'Alex', 'Fred'];
const MIN_WATCHDOG_MS = 8000;
const WATCHDOG_MS_PER_CHAR = 150;

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
    speechSynthesis.cancel(); // speech from the previous page load can still be playing
    speechSynthesis.getVoices();
  }

  get speaking() {
    return this.active.size > 0;
  }

  speak(text) {
    const spoken = text.replace(/[*_#`]/g, '').trim();
    if (!spoken) return;
    const utterance = new SpeechSynthesisUtterance(spoken);
    const voice = pickVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    const wasIdle = !this.speaking;
    this.active.add(utterance);
    // Chrome sometimes never fires end, which would leave the microphone paused.
    const watchdog = setTimeout(() => done(), Math.max(MIN_WATCHDOG_MS, spoken.length * WATCHDOG_MS_PER_CHAR));
    const done = () => {
      clearTimeout(watchdog);
      if (!this.active.delete(utterance)) return;
      if (!this.speaking) this.h.onIdle?.();
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
    this.active.clear();
    speechSynthesis.cancel();
    if (wasSpeaking) this.h.onIdle?.();
  }
}
