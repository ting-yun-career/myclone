const GATEWAY_ID = 'default';
const MODEL = 'workers-ai/@cf/qwen/qwen3-30b-a3b-fp8';
const NEURON_LIMIT = 10000;
const STATUS_CACHE_MS = 30000;
const UPSTREAM_TIMEOUT_MS = 60000;
const MAX_BODY_CHARS = 16000;
const MAX_MESSAGES = 40;
const MAX_TOKENS = 300;
const ROLES = ['system', 'user', 'assistant'];
const PASS_THROUGH_STATUS = [401, 403, 404, 429];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const methodNotAllowed = () => json({ error: 'Method not allowed' }, 405);

const validMessages = (messages) =>
  Array.isArray(messages)
  && messages.length > 0
  && messages.length <= MAX_MESSAGES
  && messages.every((m) => ROLES.includes(m?.role) && typeof m.content === 'string');

// Only known fields reach the model, so visitors cannot pick the model or raise the token limit.
const chat = async (request, env) => {
  const { success } = await env.CHAT_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success) return json({ error: 'Too many requests' }, 429);

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return json({ error: 'Request too large' }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!validMessages(body?.messages)) return json({ error: 'Invalid request' }, 400);

  const payload = {
    model: env.CHAT_MODEL ?? MODEL,
    messages: body.messages.map(({ role, content }) => ({ role, content })),
    stream: body.stream === true,
    max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
    chat_template_kwargs: { enable_thinking: false },
  };
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;

  let upstream;
  try {
    upstream = await fetch(`https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${GATEWAY_ID}/compat/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('Gateway request failed', err.message);
    return json({ error: 'Chat is not reachable' }, 502);
  }
  if (!upstream.ok) {
    console.error(`Gateway answered ${upstream.status}`);
    return json({ error: 'Chat request failed' }, PASS_THROUGH_STATUS.includes(upstream.status) ? upstream.status : 502);
  }
  return new Response(upstream.body, {
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' },
  });
};

const fetchNeuronsUsed = async (env) => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const query = `{viewer{accounts(filter:{accountTag:"${env.CLOUDFLARE_ACCOUNT_ID}"}){aiInferenceAdaptiveGroups(limit:100,filter:{datetime_geq:"${start.toISOString()}",datetime_leq:"${now.toISOString()}"}){sum{totalNeurons}}}}}`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.AI_GATEWAY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error(data.errors?.[0]?.message ?? `GraphQL status ${res.status}`);
  return data.data.viewer.accounts[0].aiInferenceAdaptiveGroups[0]?.sum.totalNeurons ?? 0;
};

let statusCache = null;

const status = async (env) => {
  try {
    if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS) {
      statusCache = { at: Date.now(), used: await fetchNeuronsUsed(env) };
    }
    return json({ neuronsUsed: statusCache.used, neuronsLimit: NEURON_LIMIT });
  } catch (err) {
    console.error('Token usage unavailable', err.message);
    return json({ error: 'Token usage is not available' }, 502);
  }
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/ai/chat/completions') return request.method === 'POST' ? chat(request, env) : methodNotAllowed();
    if (pathname === '/api/status') return request.method === 'GET' ? status(env) : methodNotAllowed();
    if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
