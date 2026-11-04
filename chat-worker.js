// Runs the chat LLM off the main thread so the character never stutters.
import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
  InterruptableStoppingCriteria,
  env,
} from '@huggingface/transformers';

env.allowLocalModels = false;

const MAX_NEW_TOKENS = 80;

let tokenizer = null;
let model = null;
let queue = Promise.resolve(); // one job at a time, in order
const stopping = new InterruptableStoppingCriteria();

const post = (msg) => self.postMessage(msg);

async function load(modelId) {
  const timeout = new Promise((r) => setTimeout(() => r(null), 5000));
  const adapter = 'gpu' in navigator ? await Promise.race([navigator.gpu.requestAdapter().catch(() => null), timeout]) : null;
  const plans = [];
  if (adapter) plans.push({ device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'q4f16' : 'q4' });
  plans.push({ device: 'wasm', dtype: 'int8' });

  const progress_callback = (p) => post({ type: 'progress', p });
  tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback });

  let lastError;
  for (const plan of plans) {
    try {
      model = await AutoModelForCausalLM.from_pretrained(modelId, { ...plan, progress_callback });
      // Warm-up compiles shaders so the first real reply isn't slow.
      const inputs = tokenizer('Hi');
      await model.generate({ ...inputs, max_new_tokens: 1 });
      post({ type: 'ready', device: plan.device });
      return;
    } catch (err) {
      lastError = err;
      console.error(`Chat model failed on ${plan.device}`, err);
    }
  }
  throw lastError;
}

async function generate({ id, messages }) {
  stopping.reset();
  const inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true });
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => post({ type: 'token', id, text }),
  });
  await model.generate({
    ...inputs,
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: true,
    temperature: 0.7,
    top_p: 0.9,
    repetition_penalty: 1.1,
    streamer,
    stopping_criteria: stopping,
  });
  post({ type: 'done', id });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'interrupt') {
    stopping.interrupt();
    return;
  }
  queue = queue
    .then(() => (msg.type === 'load' ? load(msg.model) : generate(msg)))
    .catch((err) => {
      console.error('Chat worker error', err);
      post({ type: 'error', id: msg.id });
    });
};
