import { defineConfig, loadEnv } from 'vite';

const CHAT_PATH = '/api/ai/chat/completions';
const GATEWAY_ID = 'default';
const NEURON_LIMIT = 10000;
const STATUS_CACHE_MS = 30000;

const fetchNeuronsUsed = async (accountId, token) => {
  if (!token) throw new Error('AI_GATEWAY_TOKEN is not set');
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const query = `{viewer{accounts(filter:{accountTag:"${accountId}"}){aiInferenceAdaptiveGroups(limit:100,filter:{datetime_geq:"${start.toISOString()}",datetime_leq:"${now.toISOString()}"}){sum{totalNeurons}}}}}`;
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(json.errors?.[0]?.message ?? `GraphQL status ${res.status}`);
  return json.data.viewer.accounts[0].aiInferenceAdaptiveGroups[0]?.sum.totalNeurons ?? 0;
};

// Neurons used today, read server-side so the token stays off the page.
const neuronStatus = (accountId, token) => {
  let cache = null;
  return {
    name: 'neuron-status',
    configureServer(server) {
      server.middlewares.use('/api/status', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'GET') {
          res.statusCode = 405;
          return res.end(JSON.stringify({ error: 'Method not allowed' }));
        }
        try {
          if (!cache || Date.now() - cache.at > STATUS_CACHE_MS) cache = { at: Date.now(), used: await fetchNeuronsUsed(accountId, token) };
          res.end(JSON.stringify({ neuronsUsed: cache.used, neuronsLimit: NEURON_LIMIT }));
        } catch (err) {
          console.error(`Neuron status: ${err.message}`);
          res.statusCode = 502;
          res.end(JSON.stringify({ error: 'Neuron usage is not available' }));
        }
      });
    },
  };
};

export default defineConfig(({ mode }) => {
  // Secrets stay on the dev server: only VITE_ variables reach the browser.
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, AI_GATEWAY_TOKEN } = loadEnv(mode, process.cwd(), ['CLOUDFLARE_', 'AI_GATEWAY_']);
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.warn('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in listening-avatar/.env');
  }

  return {
    plugins: [neuronStatus(CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_TOKEN)],
    server: {
      proxy: {
        '/api/ai': {
          target: 'https://gateway.ai.cloudflare.com',
          changeOrigin: true,
          bypass: (req) => (req.url === CHAT_PATH && req.method === 'POST' ? undefined : false),
          rewrite: () => `/v1/${CLOUDFLARE_ACCOUNT_ID}/${GATEWAY_ID}/compat/chat/completions`,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.removeHeader('origin');
              proxyReq.removeHeader('cookie');
              proxyReq.setHeader('Authorization', `Bearer ${CLOUDFLARE_API_TOKEN}`);
              if (AI_GATEWAY_TOKEN) proxyReq.setHeader('cf-aig-authorization', `Bearer ${AI_GATEWAY_TOKEN}`);
            });
            proxy.on('error', (err, req, res) => {
              console.error(`AI Gateway proxy: ${err.message}`);
              if (res.headersSent || res.writableEnded) return;
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'AI Gateway is not reachable' }));
            });
          },
        },
      },
    },
  };
});
