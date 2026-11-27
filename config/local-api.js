import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Vite serves the browser, but financial calls still execute in the trusted
// Node runtime. Load server packages natively, never through a browser bundle.
export function localApiPlugin({ projectId, useEmulators = false, loadApi } = {}) {
  function attach(server, preview) {
    if (useEmulators) return; // The Firebase client talks to Functions emulator directly.
    let api;
    const getApi = () => {
      if (api) return api;
      api = (async () => {
        const address = server.httpServer?.address();
        if (!address || typeof address === 'string' || !loopback.has(address.address)) throw new Error('The local financial API requires a loopback listener.');
        const protocol = (preview ? server.config.preview.https : server.config.server.https) ? 'https' : 'http';
        const origins = [`${protocol}://localhost:${address.port}`, `${protocol}://127.0.0.1:${address.port}`, `${protocol}://[::1]:${address.port}`];
        const options = { projectId, origins, root: server.config.root, distPath: resolve(server.config.root, server.config.build.outDir), preview };
        if (loadApi) return loadApi(options);
        const module = await import(pathToFileURL(resolve(server.config.root, 'functions/src/local-api.js')).href);
        return module.createLocalApi(options);
      })();
      return api;
    };
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split('?')[0];
      if (path !== '/health' && path !== '/api' && !path?.startsWith('/api/')) return next();
      getApi().then(handler => handler(request, response, next)).catch(() => {
        server.config.logger.error('Local financial API unavailable. Check functions dependencies, ADC sign-in, matching project configuration and loopback binding.');
        if (response.headersSent) { response.end(); return; }
        response.statusCode = 503;
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'The local billing service is unavailable. Check the server setup and retry.' } }));
      });
    });
  }
  return {
    name: 'pos-local-financial-api',
    configureServer(server) { attach(server, false); },
    configurePreviewServer(server) { attach(server, true); }
  };
}
