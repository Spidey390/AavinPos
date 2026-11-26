import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveFirebaseConfig } from './src/domain/firebaseConfig.js';
import { securityHeaders } from './config/security.js';

export default defineConfig(({ command, mode, isPreview }) => {
  const development = command === 'serve' && !isPreview && mode !== 'production';
  resolveFirebaseConfig(loadEnv(mode, process.cwd(), 'VITE_'), development);
  const headers = securityHeaders(development);
  return {
  appType: 'mpa',
  plugins: [react(), {
    name: 'hosting-health-and-404',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
        const pathname = request.url?.split('?')[0];
        if (pathname === '/health') {
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(readFileSync(new URL('./public/health.json', import.meta.url)));
        } else if (pathname !== '/' && pathname !== '/index.html' && pathname !== '/404.html' &&
            pathname !== '/health.json' && !pathname?.startsWith('/assets/')) {
          response.statusCode = 404;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(readFileSync(new URL('./public/404.html', import.meta.url)));
        } else next();
      });
    }
  }],
  server: {
    port: 3000,
    open: false,
    cors: false,
    headers
  },
  preview: {
    port: 3000,
    cors: false,
    headers
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 600
  },
  esbuild: {
    drop: mode === 'production' ? ['debugger'] : []
  }
  };
});
