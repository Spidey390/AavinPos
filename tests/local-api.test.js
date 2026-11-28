import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, preview } from 'vite';
import { localApiPlugin } from '../config/local-api.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { freePort } from './ports.js';

// These short-lived servers exercise HTTP/SSR, not browser dependency warm-up.
const optimizeDeps = { noDiscovery: true, entries: [] };

before(() => {
  Object.assign(process.env, { VITE_FIREBASE_API_KEY: 'public-test-key', VITE_FIREBASE_PROJECT_ID: 'test-pos', VITE_FIREBASE_AUTH_DOMAIN: 'test-pos.firebaseapp.com', VITE_FIREBASE_APP_ID: 'test-app-id', VITE_USE_FIREBASE_EMULATORS: 'false', POS_PROJECT_ID: 'test-pos' });
  // This child test process never authenticates a request or queries live data.
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FUNCTIONS_EMULATOR', 'GOOGLE_APPLICATION_CREDENTIALS']) delete process.env[key];
});
const post = (origin, name, headers = {}) => fetch(`${origin}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: JSON.stringify({ data: {} }) });

test('actual Vite dev config mounts every protected API and preserves frontend/HMR requests', async () => {
  const server = await createServer({ configFile: resolve('vite.config.js'), optimizeDeps, cacheDir: await mkdtemp(join(tmpdir(), 'pos-vite-api-cache-')), logLevel: 'silent', server: { host: '127.0.0.1', port: await freePort(), strictPort: true, preTransformRequests: false } });
  await server.listen();
  try {
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const name of ['checkout', 'initializeWorkspace', 'saveCustomer', 'archiveCustomer', 'recordPayment', 'refund', 'recordStaffLogin', 'recordStaffLogout', 'getStaffSummary']) {
      const response = await post(origin, name);
      assert.equal(response.status, 401, name);
      assert.equal((await response.json()).error.status, 'UNAUTHENTICATED');
    }
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await fetch(`${origin}/@vite/client`)).status, 200);
    assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { status: 'ok' });
  } finally { await server.close(); }
});

test('local API origin whitelist follows the actual Vite fallback port', async () => {
  const occupied = createHttpServer((req, res) => res.end()).listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const requestedPort = occupied.address().port;
  const server = await createServer({ configFile: resolve('vite.config.js'), optimizeDeps, cacheDir: await mkdtemp(join(tmpdir(), 'pos-vite-api-cache-')), logLevel: 'silent', server: { host: '127.0.0.1', port: requestedPort, strictPort: false } });
  try {
    await server.listen();
    const port = server.httpServer.address().port, origin = `http://127.0.0.1:${port}`;
    assert.notEqual(port, requestedPort);
    const response = await post(origin, 'recordStaffLogin');
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal((await post(origin, 'checkout', { Origin: `http://127.0.0.1:${requestedPort}` })).status, 403);
  } finally { await server.close(); await new Promise(resolve => occupied.close(resolve)); }
});

test('actual Vite preview uses the protected API and validates the selected browser build', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'pos-preview-api-'));
  await Promise.all([writeFile(join(dist, 'index.html'), '<h1>Preview fixture</h1>'), writeFile(join(dist, 'build-info.json'), JSON.stringify({ projectId: 'test-pos', emulators: false }))]);
  const server = await preview({ configFile: resolve('vite.config.js'), logLevel: 'silent', build: { outDir: dist }, preview: { host: '127.0.0.1', port: await freePort(), strictPort: true } });
  try {
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    assert.equal((await post(origin, 'checkout')).status, 401);
    assert.equal((await post(origin, 'recordStaffLogin')).status, 401);
    assert.equal((await fetch(origin)).status, 200);
  } finally { await new Promise(resolve => server.httpServer.close(resolve)); }
  await writeFile(join(dist, 'build-info.json'), JSON.stringify({ projectId: 'other-pos', emulators: false }));
  const mismatch = await preview({ configFile: resolve('vite.config.js'), logLevel: 'silent', build: { outDir: dist }, preview: { host: '127.0.0.1', port: await freePort(), strictPort: true } });
  try { assert.equal((await post(`http://127.0.0.1:${mismatch.httpServer.address().port}`, 'checkout')).status, 503); }
  finally { await new Promise(resolve => mismatch.httpServer.close(resolve)); }
});

test('local backend setup errors are explicit 503 responses and emulator mode never starts a live API', async () => {
  let loaded = false;
  const server = await createServer({ configFile: false, optimizeDeps, cacheDir: await mkdtemp(join(tmpdir(), 'pos-vite-api-cache-')), logLevel: 'silent', plugins: [localApiPlugin({ projectId: 'test-pos', loadApi() { throw new Error('private-setup-detail'); } })], server: { host: '127.0.0.1', port: await freePort(), strictPort: true } });
  await server.listen();
  try {
    const response = await post(`http://127.0.0.1:${server.httpServer.address().port}`, 'checkout');
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private-setup-detail|stack/);
  } finally { await server.close(); }
  const emulator = await createServer({ configFile: false, optimizeDeps, cacheDir: await mkdtemp(join(tmpdir(), 'pos-vite-api-cache-')), appType: 'mpa', logLevel: 'silent', plugins: [localApiPlugin({ useEmulators: true, loadApi() { loaded = true; throw new Error('must not start'); } })], server: { host: '127.0.0.1', port: await freePort(), strictPort: true } });
  await emulator.listen();
  try {
    assert.equal((await post(`http://127.0.0.1:${emulator.httpServer.address().port}`, 'checkout')).status, 404);
    assert.equal(loaded, false);
  } finally { await emulator.close(); }
});

test('Vite blocks local server environment, backup and service-account files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pos-private-paths-'));
  await mkdir(join(root, '.migration-reports'));
  await Promise.all([writeFile(join(root, 'server.env'), 'private-fixture'), writeFile(join(root, 'firebase-service-account-test.json'), 'private-fixture'), writeFile(join(root, '.migration-reports/backup.json'), 'private-fixture'), writeFile(join(root, 'asset.txt'), 'public-fixture')]);
  const server = await createServer({ root, configFile: resolve('vite.config.js'), optimizeDeps, logLevel: 'silent', server: { host: '127.0.0.1', port: await freePort(), strictPort: true } });
  await server.listen();
  try {
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const path of ['/server.env', '/firebase-service-account-test.json', '/.migration-reports/backup.json']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 403, path);
      assert.doesNotMatch(await response.text(), /private-fixture/);
    }
    assert.equal(await (await fetch(`${origin}/asset.txt`)).text(), 'public-fixture');
  } finally { await server.close(); }
});

test('staff setup view keeps recorded totals visible and never formats unknown cash as zero', async () => {
  const server = await createServer({ configFile: false, optimizeDeps, cacheDir: await mkdtemp(join(tmpdir(), 'pos-staff-ssr-')), server: { middlewareMode: true } });
  try {
    const { default: View } = await server.ssrLoadModule('/src/components/staff/StaffActivityView.jsx');
    const report = { period: { start: '2026-11-27', end: '2026-11-27' }, generatedAt: '2026-11-27T09:00:00Z', cashState: 'migration-required', staff: [{ uid: 'test', name: 'Fixture staff', bills: 1, totalSales: 100, totalExpenses: 15, cashReceived: null, cashRefunds: null, cashExpenses: null, remaining: null }] };
    const html = renderToStaticMarkup(View({ report, expandedStaffId: 'test', start: '2026-11-27', end: '2026-11-27' }));
    assert.match(html, /₹100\.00/); assert.match(html, /₹15\.00/); assert.match(html, /Setup required/);
    assert.doesNotMatch(html, /₹0\.00/);
  } finally { await server.close(); }
});

test('attendance screen renders separate today/selected-day hours, session times and interrupted exits', async () => {
  const server = await createServer({ configFile: false, optimizeDeps, cacheDir: await mkdtemp(join(tmpdir(), 'pos-attendance-ssr-')), server: { middlewareMode: true } });
  try {
    const { default: View } = await server.ssrLoadModule('/src/components/staff/StaffAttendanceView.jsx');
    const attendance = { today: { date: '2026-11-27', workingMs: 1800000 }, workingMs: 7200000, days: [{ date: '2026-11-26', workingMs: 7200000, sessions: [{ id: 'one', loginAt: '2026-11-26T03:30:00Z', startedAt: '2026-11-26T03:30:00Z', logoutAt: '2026-11-26T04:30:00Z', workingMs: 3600000, status: 'signed-out' }, { id: 'two', loginAt: '2026-11-26T05:30:00Z', startedAt: '2026-11-26T05:30:00Z', endedAt: '2026-11-26T06:30:00Z', logoutAt: null, workingMs: 3600000, status: 'interrupted' }] }] };
    const html = renderToStaticMarkup(View({ attendance, singleDay: true }));
    for (const text of ['Working hours today', 'Selected day’s hours', '0h 30m', '2h 00m', 'Login time', 'Logout time', 'Connection interrupted', 'Not recorded']) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /Still signed in/);
  } finally { await server.close(); }
});
