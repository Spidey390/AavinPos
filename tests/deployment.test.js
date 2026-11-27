import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveFirebaseConfig } from '../src/domain/firebaseConfig.js';
import { securityHeaders } from '../config/security.js';

test('production config fails closed on missing, demo or unreviewed public variables', () => {
  const config = { VITE_FIREBASE_API_KEY: 'public-web-api-key', VITE_FIREBASE_PROJECT_ID: 'test-pos',
    VITE_FIREBASE_AUTH_DOMAIN: 'test-pos.firebaseapp.com', VITE_FIREBASE_APP_ID: 'test-app-id' };
  assert.equal(resolveFirebaseConfig(config).projectId, 'test-pos');
  for (const env of [{}, { ...config, VITE_FIREBASE_API_KEY: 'your_key' },
    { ...config, VITE_USE_FIREBASE_EMULATORS: 'true' }, { ...config, VITE_FIREBASE_PROJECT_ID: 'demo-pos' },
    { ...config, VITE_PRIVATE_TOKEN: 'must-not-be-public' }]) assert.throws(() => resolveFirebaseConfig(env));
  assert.equal(resolveFirebaseConfig({ VITE_USE_FIREBASE_EMULATORS: 'true' }, true).projectId, 'demo-billingapp');
});

test('hosting and preview share strict headers and route the complete callable API', async () => {
  const firebase = JSON.parse(await readFile('firebase.json', 'utf8'));
  const shared = Object.fromEntries(firebase.hosting.headers.find(entry => entry.source === '**').headers.map(({ key, value }) => [key, value]));
  assert.deepEqual(shared, securityHeaders());
  const policy = shared['Content-Security-Policy'];
  assert.match(policy, /script-src 'self';/);
  assert.doesNotMatch(policy, /localhost|127\.0\.0\.1|https:\/\/\*/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.deepEqual(firebase.hosting.rewrites.filter(route => !route.function), [{ source: '/health', destination: '/health.json' }]);
  const callables = ['checkout', 'initializeWorkspace', 'saveCustomer', 'archiveCustomer', 'recordPayment', 'refund', 'recordStaffLogin', 'recordStaffLogout', 'getStaffSummary'];
  assert.deepEqual(firebase.hosting.rewrites.filter(route => route.function), callables.map(functionId => ({ source: `/api/${functionId}`, function: { functionId, region: 'asia-south1' } })));
  const indexes = JSON.parse(await readFile(firebase.firestore.indexes, 'utf8'));
  assert.ok(indexes.fieldOverrides.some(field => field.collectionGroup === 'payments' && field.fieldPath === 'date' && field.indexes.some(index => index.queryScope === 'COLLECTION_GROUP' && index.order === 'ASCENDING')));
  assert.equal(JSON.parse(await readFile('public/health.json', 'utf8')).status, 'ok');
});
