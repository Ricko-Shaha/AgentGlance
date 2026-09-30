import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function localStatus(): Plugin {
  let pending: Promise<unknown> | undefined;
  let cached: unknown;
  let checked = 0;
  const middleware = async (req: any, res: any, next: () => void) => {
    if (req.url?.split('?')[0] !== '/api/status') return next();
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!cached || Date.now() - checked > 4000) {
        pending ??= require('./electron/providers.cjs').getSnapshot();
        cached = await pending;
        checked = Date.now();
        pending = undefined;
      }
      res.end(JSON.stringify(cached));
    } catch {
      pending = undefined;
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'Local status detection is unavailable. Try again.' }));
    }
  };
  return {
    name: 'statusline-local-status',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), localStatus(), {
    name: 'statusline-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'")
        .replace("connect-src 'self' ws://127.0.0.1:* ws://localhost:*", "connect-src 'self'");
    },
  }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
