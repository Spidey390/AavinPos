import express from 'express';
import { resolve } from 'node:path';
import { securityHeaders } from '../../config/security.js';
import { callableNames } from './callables.js';
const rpcError = (res, code, status, message) => res.status(code).json({ error: { status, message } });
export function createHttpApp({ handlers, origins, distPath, requestsPerMinute = 180, clock = Date.now }) {
  const app = express(), counters = new Map();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => { for (const [name, value] of Object.entries(securityHeaders())) res.setHeader(name, value); next(); });
  app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin && !origins.includes(req.headers.origin)) return rpcError(res, 403, 'PERMISSION_DENIED', 'Origin is not allowed.');
    const window = Math.floor(clock() / 60000);
    if (counters.size >= 10000) for (const [key, entry] of counters) if (entry.window !== window) counters.delete(key);
    const previous = counters.get(req.ip);
    if (!previous && counters.size >= 10000) return rpcError(res, 503, 'UNAVAILABLE', 'The service is busy. Retry shortly.');
    const count = previous?.window === window ? previous.count + 1 : 1;
    counters.set(req.ip, { window, count });
    if (count > requestsPerMinute) { res.set('Retry-After', String(60 - Math.floor(clock() / 1000) % 60)); return rpcError(res, 429, 'RESOURCE_EXHAUSTED', 'Too many requests. Retry shortly.'); }
    next();
  }, express.json({ limit: 512000 }));
  for (const name of callableNames) app.all(`/api/${name}`, (req, res, next) => {
    if (!['POST', 'OPTIONS'].includes(req.method)) return rpcError(res, 405, 'INVALID_ARGUMENT', 'Use POST for financial operations.');
    Promise.resolve(handlers[name](req, res)).catch(next);
  });
  app.use('/api', (req, res) => rpcError(res, 404, 'NOT_FOUND', 'API endpoint not found.'));
  app.use(express.static(distPath, { dotfiles: 'deny', etag: false, setHeaders(res, path) { res.setHeader('Cache-Control', /\/assets\/[^/]+-[A-Za-z0-9_-]+\.[a-z]+$/.test(path) ? 'public, max-age=31536000, immutable' : 'no-store'); } }));
  app.use((req, res) => res.status(404).sendFile(resolve(distPath, '404.html')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return rpcError(res, 413, 'INVALID_ARGUMENT', 'Request is too large.');
    if (error.type === 'entity.parse.failed') return rpcError(res, 400, 'INVALID_ARGUMENT', 'Invalid JSON request.');
    console.error('http-request-failed');
    return rpcError(res, 500, 'INTERNAL', 'The request could not be completed.');
  });
  return app;
}
