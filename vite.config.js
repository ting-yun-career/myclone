import { defineConfig, loadEnv } from 'vite';

const CHAT_PATH = '/api/ai/chat/completions';

export default defineConfig(({ mode }) => {
  // Secrets stay on the dev server: only VITE_ variables reach the browser.
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = loadEnv(mode, process.cwd(), 'CLOUDFLARE_');
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.warn('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in listening-avatar/.env');
  }

  return {
    server: {
      proxy: {
        '/api/ai': {
          target: 'https://api.cloudflare.com',
          changeOrigin: true,
          bypass: (req) => (req.url === CHAT_PATH && req.method === 'POST' ? undefined : false),
          rewrite: () => `/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.removeHeader('origin');
              proxyReq.removeHeader('cookie');
              proxyReq.setHeader('Authorization', `Bearer ${CLOUDFLARE_API_TOKEN}`);
            });
            proxy.on('error', (err, req, res) => {
              console.error(`Workers AI proxy: ${err.message}`);
              if (res.headersSent || res.writableEnded) return;
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Workers AI is not reachable' }));
            });
          },
        },
      },
    },
  };
});
