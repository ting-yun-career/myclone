import { defineConfig, loadEnv } from 'vite';

const PROXY_PATH = '/api/ollama';

export default defineConfig(({ mode }) => {
  const { OLLAMA_BASE_URL, VITE_OLLAMA_MODEL } = loadEnv(mode, process.cwd(), ['OLLAMA_', 'VITE_OLLAMA_']);
  if (!OLLAMA_BASE_URL) throw new Error('Set OLLAMA_BASE_URL in listening-avatar/.env');
  if (!VITE_OLLAMA_MODEL) throw new Error('Set VITE_OLLAMA_MODEL in listening-avatar/.env');

  return {
    server: {
      proxy: {
        [PROXY_PATH]: {
          target: OLLAMA_BASE_URL,
          changeOrigin: true,
          rewrite: (path) => path.slice(PROXY_PATH.length),
          configure: (proxy) => {
            // Ollama rejects browser origins it does not know. The proxy is the only caller it sees.
            proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
            proxy.on('error', (err, req, res) => {
              console.error(`Ollama proxy: ${err.message}`);
              if (res.headersSent || res.writableEnded) return;
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Ollama server is not reachable' }));
            });
          },
        },
      },
    },
  };
});
