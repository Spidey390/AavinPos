import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Store } from '../desktop/core/store.js';
import { Engine } from '../desktop/core/engine.js';
import { estimate } from '../desktop/core/billing.js';
import { backendOrigin, CloudError, createCloud, decodeFields } from '../desktop/core/cloud.js';
import { assetPath, trustedSender, COUNTER_URL, desktopCsp } from '../desktop/core/security.js';

function codec() {
  const key = randomBytes(32);
  return {
    seal(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); },
    open(value) { const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); }
  };
}
const pin = () => randomBytes(12).toString('hex');
const items = [{ productId: 'milk', variant: null, addons: [], quantity: 2, note: '' }];
function cloud() {
  const state = { connected: false, price: 25, role: 'staff', calls: [], committed: new Map(), uncertain: false };
  return Object.assign(state, {
    checkBackend: async () => {},
    signIn: async email => ({ uid: 'staff-a', email, token: 'test', refreshToken: 'not-a-real-token' }),
    profile: async () => ({ uid: 'staff-a', role: state.role, active: true, workspace: 'live', name: 'Cashier' }),
    catalog: async () => ({ settings: { brandName: 'Test Shop' }, products: [{ id: 'milk', name: 'Milk', price: 25 }] }),
    refresh: async () => { if (!state.connected) throw new CloudError('unavailable', 'offline'); return { uid: 'staff-a', token: 'test', refreshToken: 'not-a-real-token' }; },
    call: async (origin, method, token, data) => {
      if (method !== 'checkout') return {};
      state.calls.push(data);
      if (state.role !== 'staff') throw new CloudError('permission-denied', 'revoked');
      if (data.expectedTotal !== state.price * 2) throw new CloudError('failed-precondition', 'price changed');
      const invoice = state.committed.get(data.idempotencyKey) ?? { id: data.idempotencyKey, cashierUid: 'staff-a', total: state.price * 2, financialSchema: 2, invoiceNo: 'AP-1001' };
      state.committed.set(data.idempotencyKey, invoice);
      if (state.uncertain) { state.uncertain = false; throw new CloudError('unavailable', 'response lost after commit'); }
      return invoice;
    }
  });
}
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'aavin-desktop-'));
  const filename = join(folder, 'pos.sqlite'), encryption = codec();
  const store = new Store(filename, encryption), remote = cloud();
  let now = Date.now(); const engine = new Engine(store, remote, { clock: () => now });
  const passphrase = pin();
  await engine.configure({ origin: 'https://pos.example.test' });
  await engine.signIn({ email: 'staff@example.test', password: 'placeholder', pin: passphrase });
  while (engine.busy) await new Promise(resolve => setTimeout(resolve, 2));
  return { filename, encryption, store, remote, engine, passphrase, advance: ms => { now += ms; } };
}
async function saved(f, id = 'sale-1') {
  const sale = await f.engine.checkout({ id, items, amountReceived: 100, channel: 'Counter' });
  while (f.engine.busy) await new Promise(resolve => setTimeout(resolve, 2));
  return sale;
}
test('offline receipt is durable across restarts; tokens, catalog and bills are encrypted', async () => {
  const f = await fixture(); await saved(f); await f.engine.lock();
  await f.store.close();
  const bytes = await readFile(f.filename);
  for (const value of ['not-a-real-token', 'Milk', 'staff@example.test', 'Test Shop']) assert.equal(bytes.includes(Buffer.from(value)), false);
  const reopened = new Store(f.filename, f.encryption), engine = new Engine(reopened, f.remote);
  assert.equal((await engine.view()).sales.length, 0);
  await engine.unlock({ email: 'staff@example.test', pin: f.passphrase });
  while (engine.busy) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal((await engine.view()).sales[0].state, 'pending');
  f.remote.connected = true; await engine.retry();
  assert.equal((await engine.view()).sales[0].serverInvoice.invoiceNo, 'AP-1001');
  await reopened.close();
});
test('lost server response retries the same immutable payload without duplicate revenue', async () => {
  const f = await fixture(); f.remote.connected = true; f.remote.uncertain = true;
  await saved(f); await f.engine.retry();
  assert.equal(f.remote.committed.size, 1);
  assert.equal(f.remote.calls.length, 2);
  assert.deepEqual(f.remote.calls[0], f.remote.calls[1]);
  assert.equal((await f.engine.view()).counts.synced, 1);
  await f.store.close();
});
test('catalog changes and revoked access retain bills for review and prevent further offline sales', async () => {
  const f = await fixture(); await saved(f); f.remote.connected = true; f.remote.price = 30;
  await f.engine.retry();
  assert.equal((await f.engine.view()).counts.review, 1);
  assert.equal(f.remote.committed.size, 0);
  f.remote.price = 25; f.remote.role = 'owner'; await f.engine.retry();
  assert.equal((await f.engine.view()).operator.revoked, true);
  await assert.rejects(saved(f, 'sale-2'), /expired|clock/);
  await f.store.close();
});
test('offline lease, clock rollback, PIN lockout, owner role and operator isolation are enforced', async () => {
  const f = await fixture(); await saved(f); await f.engine.lock();
  assert.equal((await f.engine.view()).sales.length, 0);
  for (let n = 0; n < 5; n++) await assert.rejects(f.engine.unlock({ email: 'staff@example.test', pin: pin() }));
  await assert.rejects(f.engine.unlock({ email: 'staff@example.test', pin: f.passphrase }), /locked/);
  f.advance(31000); await f.engine.unlock({ email: 'staff@example.test', pin: f.passphrase });
  f.advance(-400000); await assert.rejects(saved(f, 'clock-sale'), /clock/);
  f.advance(25 * 3600000); await assert.rejects(saved(f, 'expired-sale'), /expired/);
  while (f.engine.busy) await new Promise(resolve => setTimeout(resolve, 2));
  await f.store.close();
});
test('renderer cannot supply prices, credit, discounts, customer IDs or short cash', async () => {
  const f = await fixture();
  for (const extra of [{ paymentMethod: 'Account' }, { customerId: 'other' }, { discountPercent: 50 }, { total: 1 }]) await assert.rejects(f.engine.checkout({ id: 'forged', items, channel: 'Counter', amountReceived: 100, ...extra }));
  await assert.rejects(f.engine.checkout({ id: 'short', items, channel: 'Counter', amountReceived: 1 }));
  assert.throws(() => estimate(f.remote.catalog.products ?? [], [{ ...items[0], price: 1 }]));
  await saved(f); await assert.rejects(f.engine.checkout({ id: 'sale-1', items, channel: 'Takeaway', amountReceived: 100 }), /already used/);
  await f.store.close();
});
test('network origins, Firestore data, expired credentials and redirect policy are constrained', async () => {
  for (const url of ['file:///tmp', 'http://public.example', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=x']) assert.throws(() => backendOrigin(url));
  assert.equal(backendOrigin('http://localhost:3000/'), 'http://localhost:3000');
  assert.deepEqual(decodeFields({ price: { doubleValue: 25.5 }, sizes: { arrayValue: { values: [{ mapValue: { fields: { name: { stringValue: 'L' } } } }] } } }), { price: 25.5, sizes: [{ name: 'L' }] });
  let options;
  const api = createCloud({ projectId: 'test-project', apiKey: 'public-registration' }, async (url, opts) => { options = opts; return new Response(JSON.stringify({ error: { message: 'INVALID_REFRESH_TOKEN' } }), { status: 400 }); });
  await assert.rejects(api.refresh('fake'), { code: 'unauthenticated' });
  assert.equal(options.redirect, 'error');
});

test('local asset protocol and IPC deny foreign frames, filesystem paths and remote renderer code', () => {
  const root = '/app/ui-build';
  assert.equal(assetPath(root, COUNTER_URL), '/app/ui-build/index.html');
  for (const url of ['file:///etc/passwd', 'pos://other/index.html', 'pos://counter/%2e%2e%2fsecret.json', 'pos://counter/%5csecret.json', 'pos://counter/file.sqlite', 'pos://counter/file.env', 'pos://counter/%00.js']) assert.throws(() => assetPath(root, url));
  const mainFrame = { url: COUNTER_URL }, contents = { mainFrame };
  assert.equal(trustedSender({ sender: contents, senderFrame: mainFrame }, contents), true);
  assert.equal(trustedSender({ sender: contents, senderFrame: { url: COUNTER_URL } }, contents), false);
  assert.equal(trustedSender({ sender: {}, senderFrame: mainFrame }, contents), false);
  assert.match(desktopCsp, /connect-src 'none'/);
  assert.doesNotMatch(desktopCsp, /unsafe-eval/);
});

test('unacknowledged saved receipt blocks a second bill and acknowledgement preserves sync results', async () => {
  const f = await fixture(); await saved(f);
  await assert.rejects(saved(f, 'sale-2'), /last saved receipt/);
  await assert.rejects(f.engine.acknowledge({ id: 'someone-elses-receipt' }), /denied/);
  f.remote.connected = true;
  await Promise.all([f.engine.retry(), f.engine.acknowledge({ id: 'sale-1' })]);
  const sale = await f.store.sale('sale-1');
  assert.equal(sale.acknowledged, true);
  assert.equal(sale.state, 'synced');
  assert.equal(sale.amountReceived, 100);
  assert.equal(sale.change, 50);
  await saved(f, 'sale-2');
  await f.store.close();
});

test('cached variants and add-ons use integer currency and owner accounts cannot unlock or sell offline', async () => {
  assert.deepEqual(estimate([{ id: 'p1', name: 'Tea', hasSizes: true, sizes: [{ name: 'L', price: 19.99 }], addons: [{ name: 'Milk', price: 2.56 }] }], [{ productId: 'p1', variant: 'L', addons: ['Milk'], quantity: 2 }]).total, 45.1);
  const f = await fixture(); f.remote.role = 'owner';
  await f.engine.signIn({ email: 'staff@example.test', password: 'placeholder', pin: f.passphrase });
  await assert.rejects(saved(f), /staff account/);
  await f.engine.lock();
  await assert.rejects(f.engine.unlock({ email: 'staff@example.test', pin: f.passphrase }), /Owners require internet/);
  while (f.engine.busy) await new Promise(resolve => setTimeout(resolve, 2));
  await f.store.close();
});
