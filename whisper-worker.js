// Runs Whisper off the main thread so the character never stutters.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

let asr = null;
let queue = Promise.resolve(); // one job at a time, in order

const post = (msg) => self.postMessage(msg);

// Whisper tends to invent these on near-silent or very short clips.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?)$/i;

async function load(model) {
  post({ type: 'status', text: 'Checking GPU…' });
  const timeout = new Promise((r) => setTimeout(() => r(null), 5000));
  const hasGPU = 'gpu' in navigator && (await Promise.race([navigator.gpu.requestAdapter().catch(() => null), timeout]));
  const big = /large|turbo/.test(model);
  const plans = [];
  if (hasGPU) {
    plans.push({
      device: 'webgpu',
      dtype: { encoder_model: big ? 'fp16' : 'fp32', decoder_model_merged: 'q4' },
    });
  }
  plans.push({ device: 'wasm', dtype: 'q8' });

  let lastError;
  for (const plan of plans) {
    try {
      post({ type: 'status', text: `Loading ${model} on ${plan.device}…` });
      asr = await pipeline('automatic-speech-recognition', model, {
        ...plan,
        progress_callback: (p) => post({ type: 'progress', p }),
      });
      // Warm-up compiles shaders so the first real utterance isn't slow.
      await asr(new Float32Array(16000));
      post({ type: 'ready', device: plan.device });
      return;
    } catch (err) {
      lastError = err;
      post({ type: 'status', text: `${plan.device} failed (${err.message || err}), trying next option…` });
    }
  }
  throw lastError;
}

async function transcribe({ id, audio, language }) {
  const t0 = performance.now();
  const opts = { task: 'transcribe', return_timestamps: false, chunk_length_s: 30 };
  if (language && language !== 'auto') opts.language = language;
  const out = await asr(audio, opts);
  let text = (out.text || '').trim();
  const seconds = audio.length / 16000;
  if (!/[\p{L}\p{N}]/u.test(text) || (seconds < 1.2 && HALLUCINATIONS.test(text))) text = '';
  post({ type: 'result', id, text, ms: Math.round(performance.now() - t0) });
}

self.onmessage = (e) => {
  const msg = e.data;
  queue = queue
    .then(() => (msg.type === 'load' ? load(msg.model) : transcribe(msg)))
    .catch((err) => post({ type: 'error', id: msg.id, message: String(err?.message || err) }));
};
