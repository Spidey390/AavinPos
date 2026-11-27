import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch, setLogLevel } from 'firebase/firestore';
import { createServer } from 'vite';
import { createServer as createHTTPServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHttpApp } from '../functions/src/http-app.js';
import { createStaffService } from '../functions/src/staff.js';
import { localApiPlugin } from '../config/local-api.js';
const requireFunctions = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp: initializeAdminApp, deleteApp: deleteAdminApp } = requireFunctions('firebase-admin/app');
const { getFirestore: getAdminFirestore } = requireFunctions('firebase-admin/firestore');
import { createFinancialService } from '../functions/src/financial.js';
import { planMigration, applyMigration } from '../functions/src/migration.js';

setLogLevel('silent'); // Expected permission denials are asserted below.

let env;
let moduleServer;
let database;
let adminApp;
let service;
let callableServer;
let authLookupServer;
let callableOrigin;
let callableModule;
const projectId = 'demo-pos-rules';
const dbFor = uid => env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore();
const profile = (role, active = true) => ({ role, active, name: role, email: `${role}@example.test` });
const emulatorToken = uid => {
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: uid, user_id: uid, aud: projectId, iss: `https://securetoken.google.com/${projectId}`, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'password' } })}.`;
};

before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile('firestore.rules', 'utf8') } });
  adminApp = initializeAdminApp({ projectId }, 'financial-tests');
  service = createFinancialService(getAdminFirestore(adminApp));
  globalThis.__posTestFirestore = dbFor('staff-a');
  globalThis.__callFinancial = (name, data) => service[name]({ auth: { uid: 'staff-a' }, data });
  moduleServer = await createServer({ configFile: false, server: { middlewareMode: true }, plugins: [{
    name: 'local-rules-test-database',
    enforce: 'pre',
    load(id) {
      if (id.endsWith('/src/services/functions.js')) return 'export const callFinancial = globalThis.__callFinancial; export const callFinancialOnce = (name, data) => globalThis.__callFinancial(name, { ...data, idempotencyKey: crypto.randomUUID() });';
      if (id.endsWith('/src/services/firebase.js')) return 'export const firestore = globalThis.__posTestFirestore;';
    }
  }] });
  database = await moduleServer.ssrLoadModule('/src/db/db.js');
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId });
  process.env.FUNCTIONS_EMULATOR = 'true';
  process.env.ENABLE_RECONCILED_REFUNDS = 'false';
  authLookupServer = createHTTPServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ users: (body.localId ?? []).map(uid => ({ localId: uid, email: `${uid}@example.test`, validSince: '0', disabled: false })) }));
  });
  await new Promise(resolve => authLookupServer.listen(0, '127.0.0.1', resolve));
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${authLookupServer.address().port}`; // loopback Auth lookup fixture for emulator tokens
  callableModule = await import('../functions/src/index.js');
  callableServer = createHTTPServer(createHttpApp({ handlers: callableModule, origins: ['http://localhost:3000'], distPath: resolve('public') }));
  await new Promise(resolve => callableServer.listen(0, '127.0.0.1', resolve));
  callableOrigin = `http://127.0.0.1:${callableServer.address().port}/api`;
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const [path, data] of Object.entries({
      'operators/owner': profile('owner'),
      'operators/staff-a': profile('staff'),
      'operators/staff-b': profile('staff'),
      'operators/disabled': profile('staff', false),
      'posConfig/current': { workspace: 'live' },
      'posConfig/branding': { brandName: 'Test POS' },
      'posWorkspaces/live/config/settings': { brandName: 'Test POS', gstRate: 0, startingNumber: 1001, invoicePrefix: 'AP-', allowCashierDiscounts: false },
      'posWorkspaces/live/config/invoiceSequence': { next: 1001, count: 0 },
      'posWorkspaces/live/config/financialMigration': { status: 'ready', schemaVersion: 2 },
      'posWorkspaces/live/customerAccounts/c1': { status: 'ready', creditLimit: 150, historyComplete: true },
      'posWorkspaces/live/products/p1': { id: 'p1', name: 'Milk', price: 25 },
      'posWorkspaces/live/customers/c1': {
        id: 'c1', name: 'Customer', phone: '+919000000000', ordersCount: 0, totalSpent: 0,
        avgOrderValue: 0, dueBalance: 100, financialSchema: 2, archived: false
      },
      'posWorkspaces/live/identity/customers-phone-%2B919000000000': { id: 'c1' },
      'posWorkspaces/archive/products/p1': { id: 'p1', name: 'Archived Milk', price: 20 },
      'posWorkspaces/live/expenses/a': { id: 'a', recordedBy: 'staff-a', amount: 10, paymentMethod: 'Cash', reason: 'Delivery' },
      'posWorkspaces/live/expenses/b': { id: 'b', recordedBy: 'staff-b', amount: 20, paymentMethod: 'Cash', reason: 'Delivery' }
    })) await setDoc(doc(db, path), data);
  });
});
after(async () => { if (callableServer) await new Promise(resolve => callableServer.close(resolve)); if (authLookupServer) await new Promise(resolve => authLookupServer.close(resolve)); await moduleServer?.close(); await env?.cleanup(); await deleteAdminApp(adminApp); const { getApp } = requireFunctions('firebase-admin/app'); await deleteAdminApp(getApp()); });

test('anonymous and unprovisioned users cannot read business data', async () => {
  for (const db of [env.unauthenticatedContext().firestore(), dbFor('stranger'), dbFor('disabled')]) {
    await assertFails(getDoc(doc(db, 'posConfig/current')));
    await assertFails(getDocs(collection(db, 'posWorkspaces/live/products')));
  }
  await assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'posConfig/branding')));
});

test('users cannot self-provision or escalate to owner, regardless of email', async () => {
  for (const uid of ['stranger', 'staff-a', 'disabled']) {
    await assertFails(setDoc(doc(dbFor(uid), 'operators', uid), profile('owner')));
  }
  const spoof = env.authenticatedContext('spoof', { email: 'aavinkvp.attacker@example.test' }).firestore();
  await assertFails(setDoc(doc(spoof, 'operators/spoof'), profile('owner')));
  await assertFails(setDoc(doc(dbFor('stranger'), 'operators/stranger'), profile('staff')));
});

test('only an owner provisions staff and can never create another owner through the client', async () => {
  await assertSucceeds(setDoc(doc(dbFor('owner'), 'operators/new-staff'), profile('staff')));
  await assertFails(setDoc(doc(dbFor('staff-a'), 'operators/new-staff-2'), profile('staff')));
  await assertFails(setDoc(doc(dbFor('owner'), 'operators/new-owner'), profile('owner')));
  await assertFails(updateDoc(doc(dbFor('staff-a'), 'operators/staff-a'), { role: 'owner' }));
});

test('staff cannot read another staff expense or enumerate all expenses (IDOR)', async () => {
  const db = dbFor('staff-a');
  await assertSucceeds(getDoc(doc(db, 'posWorkspaces/live/expenses/a')));
  await assertFails(getDoc(doc(db, 'posWorkspaces/live/expenses/b')));
  await assertFails(getDocs(collection(db, 'posWorkspaces/live/expenses')));
  const own = await assertSucceeds(getDocs(query(collection(db, 'posWorkspaces/live/expenses'), where('recordedBy', '==', 'staff-a'))));
  assert.equal(own.size, 1);
  await assertFails(updateDoc(doc(db, 'posWorkspaces/live/expenses/b'), { amount: 1 }));
});

test('staff cannot access archived workspaces or change configuration and catalog', async () => {
  const db = dbFor('staff-a');
  await assertFails(getDoc(doc(db, 'posWorkspaces/archive/products/p1')));
  await assertFails(updateDoc(doc(db, 'posWorkspaces/live/products/p1'), { price: 0 }));
  await assertFails(updateDoc(doc(db, 'posWorkspaces/live/config/settings'), { brandName: 'Attacker' }));
  await assertFails(setDoc(doc(db, 'posConfig/current'), { workspace: 'archive' }));
});

function order(overrides = {}) {
  return {
    id: 'order-1', cashierUid: 'staff-a', status: 'Completed', channel: 'Counter', tableId: null,
    customerName: 'Customer', customerPhone: '+919000000000', createdAt: new Date().toISOString(),
    items: [{ id: 'p1', name: 'Milk', price: 25, quantity: 1, total: 25 }],
    subtotal: 25, discount: 0, total: 25, discountPercent: 0, fixedDiscount: 0,
    paymentMethod: 'Cash', amountReceived: 25, referenceNo: '', invoiceSequence: 1001, invoiceNo: 'AP-1001',
    ...overrides
  };
}

function saleBatch(db, saved = order(), customerChanges) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'posWorkspaces/live/orders', saved.id), saved);
  batch.update(doc(db, 'posWorkspaces/live/config/invoiceSequence'), { next: saved.invoiceSequence + 1, count: 1, lastOrderId: saved.id });
  if (customerChanges) batch.update(doc(db, 'posWorkspaces/live/customers/c1'), customerChanges);
  return batch;
}

test('staff customer creation validates zero balances and a matching unique identity', async () => {
  const db = dbFor('staff-a');
  const customer = { id: 'c2', name: 'New customer', phone: '+919000000001', ordersCount: 0, totalSpent: 0,
    avgOrderValue: 0, dueBalance: 0, creditLimit: 0, accountTransactions: [] };
  await assertFails(setDoc(doc(db, 'posWorkspaces/live/customers/c2'), { ...customer, dueBalance: -500 }));
  await assertFails(setDoc(doc(db, 'posWorkspaces/live/identity/customers-phone-forged'), { id: 'c1' }));
  const batch = writeBatch(db);
  batch.set(doc(db, 'posWorkspaces/live/customers/c2'), customer);
  batch.set(doc(db, 'posWorkspaces/live/identity/customers-phone-%2B919000000001'), { id: 'c2' });
  await assertFails(batch.commit());
  await invoke('saveCustomer', { workspace: 'live', customer: { id: 'c2', name: 'New customer', phone: '+919000000001' } });
});

test('staff cannot directly rewrite balances, visits, spend or ledger history', async () => {
  const ref = doc(dbFor('staff-a'), 'posWorkspaces/live/customers/c1');
  for (const changes of [{ dueBalance: 0, accountTransactions: [] }, { ordersCount: 1, totalSpent: 9000 },
    { creditLimit: 999999 }, { accountTransactions: [{ amount: -100, type: 'payment' }] }]) {
    await assertFails(updateDoc(ref, changes));
  }
});

test('direct customer balance and embedded-history writes are denied', async () => {
  const ref = doc(dbFor('staff-a'), 'posWorkspaces/live/customers/c1');
  const entry = { id: 'tx-1', date: new Date().toISOString(), type: 'payment', amount: 20,
    method: 'Cash', referenceNo: '', notes: '', balanceAfter: 80 };
  const changes = { dueBalance: 80, accountTransactions: [entry], lastPaymentAt: entry.date, lastPaymentAmount: 20 };
  await assertFails(updateDoc(ref, { ...changes, dueBalance: 0 }));
  await assertFails(updateDoc(ref, changes));
  await assertFails(updateDoc(ref, { ...changes, dueBalance: 60 }));
  const next = { ...entry, id: 'tx-2', balanceAfter: 60 };
  await assertFails(updateDoc(ref, { ...changes, dueBalance: 60, accountTransactions: [next] }));
  await assertFails(updateDoc(ref, { ...changes, dueBalance: 60, accountTransactions: [entry, next] }));
});

test('cash checkout runs on the server and direct invoice writes are denied', async () => {
  await assertFails(saleBatch(dbFor('staff-a')).commit());
  await database.executeOrderTransaction('live', { order: order(), customerId: 'c1' });
  assert.equal((await getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/orders/order-1'))).data().total, 25);
});

test('order totals, tender types, disabled discounts and invoice numbering are validated', async () => {
  for (const overrides of [{ total: 1 }, { amountReceived: -1 }, { amountReceived: 25.001 },
    { paymentMethod: 'Split', splitBreakdown: { cash: '20', upi: 5 } },
    { discount: 5, discountPercent: 20, total: 20 }, { invoiceNo: 'FORGED' },
    { invoiceSequence: 9000, invoiceNo: 'AP-9000' }, { refund: { amount: 25 } }]) {
    await assertFails(saleBatch(dbFor('staff-a'), order(overrides)).commit());
  }
});

test('account invoices require an atomic customer debit within the credit limit', async () => {
  const db = dbFor('staff-a');
  const saved = order({ paymentMethod: 'Account' });
  await assertFails(saleBatch(db, saved).commit());
  const over = order({ paymentMethod: 'Account', subtotal: 100, total: 100, amountReceived: 100 });
  const charge = { id: 'tx-1', date: saved.createdAt, type: 'charge', amount: 25, method: 'Account',
    orderId: saved.id, invoiceNo: saved.invoiceNo, items: saved.items, balanceAfter: 125 };
  await assertFails(saleBatch(db, over, { ordersCount: 1, totalSpent: 100, avgOrderValue: 100, dueBalance: 200,
    accountTransactions: [{ ...charge, amount: 100, balanceAfter: 200 }] }).commit());
  await database.executeOrderTransaction('live', { order: saved, customerId: 'c1' });
});

test('customer visit and spend updates require a new matching invoice, preventing replay', async () => {
  const db = dbFor('staff-a');
  const changes = { ordersCount: 1, totalSpent: 25, avgOrderValue: 25, dueBalance: 100, accountTransactions: [] };
  await database.executeOrderTransaction('live', { order: order(), customerId: 'c1' });
  await assertFails(updateDoc(doc(db, 'posWorkspaces/live/customers/c1'), { ordersCount: 2, totalSpent: 50 }));
});

function checkoutData(overrides = {}) {
  return { workspace: 'live', idempotencyKey: 'callable-order', channel: 'Counter',
    items: [{ productId: 'p1', variant: null, addons: [], quantity: 1, note: '' }],
    paymentMethod: 'Cash', amountReceived: 25, ...overrides };
}
const invoke = (name, data, uid = 'staff-a') => service[name]({ auth: uid ? { uid } : null, data });

test('regression: forged invoice lines and direct writes are rejected', async () => {
  const forged = order({ items: [{ id: 'p1', name: 'Milk', price: 1000, quantity: 100, total: 100000 }] });
  for (const uid of ['staff-a', 'owner']) await assertFails(saleBatch(dbFor(uid), forged).commit());
  await assert.rejects(invoke('checkout', checkoutData({ items: [{ productId: 'p1', quantity: 1, price: 1 }] })), { code: 'invalid-argument' });
  await assert.rejects(invoke('checkout', checkoutData({ total: 1 })), { code: 'invalid-argument' });
  const saved = await invoke('checkout', checkoutData());
  assert.equal(saved.total, 25);
  assert.equal(saved.items[0].price, 25);
});

test('callables enforce operator status, active workspace and catalog options', async () => {
  for (const uid of [null, 'stranger', 'disabled', 'owner']) await assert.rejects(invoke('checkout', checkoutData(), uid));
  await assert.rejects(invoke('checkout', checkoutData({ workspace: 'archive' })), { code: 'failed-precondition' });
  await assert.rejects(invoke('checkout', checkoutData({ items: [{ productId: 'custom-untrusted', quantity: 1 }] })), { code: 'failed-precondition' });
  await assert.rejects(invoke('checkout', checkoutData({ items: [{ productId: 'p1', quantity: 1, addons: ['forged-addon'] }] })), { code: 'invalid-argument' });
  await assert.rejects(invoke('checkout', checkoutData({ discountPercent: 50 })), { code: 'permission-denied' });
  await assert.rejects(invoke('checkout', checkoutData({ expectedTotal: 1 })), { code: 'failed-precondition' });
});

test('catalog variants and add-ons are priced from current database records', async () => {
  await env.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posWorkspaces/live/products/p1'), {
    hasSizes: true, sizes: [{ name: 'Large', price: 40 }], hasAddons: true, addons: [{ name: 'Extra', price: 5 }]
  }));
  const saved = await invoke('checkout', checkoutData({ amountReceived: 90, items: [{ productId: 'p1', variant: 'Large', addons: ['Extra'], quantity: 2 }] }));
  assert.equal(saved.total, 90);
  assert.equal(saved.items[0].price, 45);
});

test('regression: staff cannot read private ledger or legacy embedded history', async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'posWorkspaces/live/customerAccounts/c1/ledger/private-history'), { type: 'payment', amount: 100 });
    await setDoc(doc(db, 'posWorkspaces/live/customers/legacy'), { name: 'Legacy', accountTransactions: [{ amount: 100 }] });
  });
  await assertFails(getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/customerAccounts/c1')));
  await assertFails(getDocs(collection(dbFor('staff-a'), 'posWorkspaces/live/customerAccounts/c1/ledger')));
  await assertFails(getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/customers/legacy')));
  await assertFails(getDocs(collection(dbFor('staff-a'), 'posWorkspaces/live/customers')));
  await assertSucceeds(getDocs(query(collection(dbFor('staff-a'), 'posWorkspaces/live/customers'), where('financialSchema', '==', 2))));
  await assertSucceeds(getDocs(collection(dbFor('owner'), 'posWorkspaces/live/customerAccounts/c1/ledger')));
  await assertSucceeds(getDoc(doc(dbFor('owner'), 'posWorkspaces/live/customerAccounts/c1')));
});

test('customer administration preserves server balances and private limits', async () => {
  await invoke('saveCustomer', { workspace: 'live', customer: { id: 'c1', name: 'Renamed', phone: '+919000000000', creditLimit: 130, openingDue: 9000 } }, 'owner');
  const customer = (await getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/customers/c1'))).data();
  assert.equal(customer.dueBalance, 100);
  assert.equal(customer.creditLimit, undefined);
  assert.equal((await getDoc(doc(dbFor('owner'), 'posWorkspaces/live/customerAccounts/c1'))).data().creditLimit, 130);
  await assert.rejects(invoke('saveCustomer', { workspace: 'live', customer: { id: 'c1', name: 'Attack', phone: '+919000000000', creditLimit: 999 } }));
  await assert.rejects(invoke('archiveCustomer', { workspace: 'live', customerId: 'c1' }, 'owner'));
});

test('migration dry-run is read-only, rejects stale plans, and moves legacy history privately', async () => {
  const admin = getAdminFirestore(adminApp);
  const ref = admin.doc('posWorkspaces/live/customers/legacy');
  await ref.set({ id: 'legacy', name: 'Legacy', phone: '+919000000001', dueBalance: 80, creditLimit: 150, ordersCount: 0, totalSpent: 0,
    accountTransactions: [{ id: 'old', type: 'payment', date: '2026-11-25T00:00:00.000Z', amount: 20, method: 'Cash', balanceAfter: 80 }] });
  const plan = await planMigration(admin, projectId, 'live');
  assert.equal(plan.customers.length, 1);
  assert.equal(plan.errors.length, 0);
  assert.equal((await ref.get()).data().financialSchema, undefined);
  assert.equal((await admin.doc('posWorkspaces/live/customerAccounts/legacy').get()).exists, false);
  await applyMigration(admin, projectId, plan);
  await applyMigration(admin, projectId, plan);
  const publicData = (await ref.get()).data();
  assert.equal(publicData.accountTransactions, undefined);
  assert.equal(publicData.creditLimit, undefined);
  assert.equal(publicData.dueBalance, 80);
  const payments = await admin.collection('posWorkspaces/live/customerAccounts/legacy/payments').get();
  assert.equal(payments.size, 1);
  assert.equal((await admin.doc('posWorkspaces/live/customerAccounts/legacy').get()).data().historyComplete, false);
  await assertFails(getDocs(collection(dbFor('staff-a'), 'posWorkspaces/live/customerAccounts/legacy/payments')));
});

test('migration blocks invalid history and cannot apply an altered dry-run plan', async () => {
  const admin = getAdminFirestore(adminApp);
  await admin.doc('posWorkspaces/live/customers/bad').set({ name: 'Bad', phone: '+919000000002', dueBalance: 10,
    accountTransactions: [{ type: 'payment', amount: -1, date: 'invalid' }] });
  const plan = await planMigration(admin, projectId, 'live');
  assert.equal(plan.errors.length, 1);
  await assert.rejects(applyMigration(admin, projectId, plan));
  await assert.rejects(applyMigration(admin, 'other-project', { ...plan, errors: [] }));
});

test('regression: production refunds stay disabled even if owner settings allow them', async () => {
  await env.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posWorkspaces/live/config/settings'), { allowStaffRefunds: true }));
  const saved = await database.executeOrderTransaction('live', { order: order({ paymentMethod: 'Account' }), customerId: 'c1' });
  await assert.rejects(database.refundOrder('live', saved, { reason: 'Local audit fixture', recordedAt: new Date().toISOString(), cashierUid: 'staff-a', cashierName: 'Staff' }));
  const customer = (await getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/customers/c1'))).data();
  assert.equal(customer.dueBalance, 125);
});

test('real checkout transaction updates customer totals once and safely retries the same invoice', async () => {
  const saved = await database.executeOrderTransaction('live', { order: order(), customerId: 'c1' });
  assert.equal(saved.invoiceNo, 'AP-1001');
  const retried = await database.executeOrderTransaction('live', { order: order(), customerId: 'c1' });
  assert.equal(retried.invoiceNo, saved.invoiceNo);
  const customer = (await getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/customers/c1'))).data();
  assert.equal(customer.ordersCount, 1);
  assert.equal(customer.totalSpent, 25);
});

test('concurrent real account checkouts respect the current credit limit', async () => {
  const outcomes = await Promise.allSettled([1, 2, 3].map(n => database.executeOrderTransaction('live', {
    order: order({ id: `order-${n}`, paymentMethod: 'Account' }), customerId: 'c1'
  })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  const customer = (await getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/customers/c1'))).data();
  assert.equal(customer.dueBalance, 150);
  assert.equal(customer.ordersCount, 2);
});

test('payments are immutable documents with no 50-entry retention cap', async () => {
  for (let index = 0; index < 55; index++) await invoke('recordPayment', { workspace: 'live', customerId: 'c1', idempotencyKey: `pay-${index}`, amount: 1, method: 'Cash' });
  const admin = getAdminFirestore(adminApp);
  const payments = await admin.collection('posWorkspaces/live/customerAccounts/c1/payments').get();
  const ledger = await admin.collection('posWorkspaces/live/customerAccounts/c1/ledger').get();
  assert.equal(payments.size, 55);
  assert.equal(ledger.size, 55);
  assert.equal((await admin.doc('posWorkspaces/live/customers/c1').get()).data().dueBalance, 45);
  for (const uid of ['staff-a', 'owner']) {
    const db = dbFor(uid);
    await assertFails(setDoc(doc(db, 'posWorkspaces/live/customerAccounts/c1/payments/forged'), { amount: 1 }));
    await assertFails(updateDoc(doc(db, 'posWorkspaces/live/customerAccounts/c1/payments/payment-pay-0'), { amount: 0 }));
    await assertFails(setDoc(doc(db, 'posWorkspaces/live/customerAccounts/c1/ledger/forged'), { amount: 1 }));
  }
  await assertFails(getDocs(collection(dbFor('staff-a'), 'posWorkspaces/live/customerAccounts/c1/payments')));
});

test('payment retries are idempotent, conflict-safe and reject forged balances', async () => {
  const data = { workspace: 'live', customerId: 'c1', idempotencyKey: 'safe-retry', amount: 20, method: 'UPI' };
  const results = await Promise.all([invoke('recordPayment', data), invoke('recordPayment', data)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].dueBalance, 80);
  await assert.rejects(invoke('recordPayment', { ...data, amount: 50 }), { code: 'already-exists' });
  await assert.rejects(invoke('recordPayment', { ...data, balanceAfter: 0 }), { code: 'invalid-argument' });
  await assert.rejects(invoke('recordPayment', { ...data, idempotencyKey: 'bad-amount', amount: 1.001 }), { code: 'invalid-argument' });
  for (const uid of [null, 'disabled', 'stranger']) await assert.rejects(invoke('recordPayment', data, uid));
  const owner = await invoke('recordPayment', { ...data, idempotencyKey: 'owner-payment', amount: 10 }, 'owner');
  assert.equal(owner.dueBalance, 70);
});

test('data subscriptions wait for the server instead of emitting an empty initial cache', { timeout: 5000 }, async () => {
  let stop;
  try {
    const rows = await new Promise((resolve, reject) => {
      stop = database.watchRows('live', 'products', resolve, reject);
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'p1');
  } finally { stop?.(); }
});


test('stale migration plans fail closed without changing customer balances', async () => {
  const admin = getAdminFirestore(adminApp), ref = admin.doc('posWorkspaces/live/customers/stale');
  await ref.set({ id: 'stale', name: 'Stale', phone: '+919000000003', dueBalance: 10, accountTransactions: [] });
  const plan = await planMigration(admin, projectId, 'live');
  await ref.update({ name: 'Changed after dry-run' });
  await assert.rejects(applyMigration(admin, projectId, plan), /Source changed/);
  assert.equal((await ref.get()).data().dueBalance, 10);
  assert.equal((await admin.doc('posWorkspaces/live/config/financialMigration').get()).data().status, 'migrating');
  await assert.rejects(invoke('checkout', checkoutData()), { code: 'failed-precondition' });
});


test('migration preserves more than fifty legacy payments and duplicate legacy IDs', async () => {
  const admin = getAdminFirestore(adminApp);
  await admin.doc('posWorkspaces/live/customers/long-history').set({ id: 'long-history', name: 'Legacy', phone: '+919000000005', dueBalance: 40,
    accountTransactions: Array.from({ length: 60 }, (_, index) => ({ id: 'duplicate-legacy-id', type: 'payment', date: '2026-11-25T00:00:00.000Z', amount: 1, method: 'Cash', balanceAfter: 99 - index })) });
  const plan = await planMigration(admin, projectId, 'live');
  assert.equal(plan.errors.length, 0);
  await applyMigration(admin, projectId, plan);
  await applyMigration(admin, projectId, plan);
  assert.equal((await admin.collection('posWorkspaces/live/customerAccounts/long-history/payments').get()).size, 60);
  assert.equal((await admin.doc('posWorkspaces/live/customers/long-history').get()).data().dueBalance, 40);
});


test('enabled reconciled Account refunds reduce debt once and preserve immutable history', async () => {
  const admin = getAdminFirestore(adminApp), enabled = createFinancialService(admin, { allowRefunds: true });
  await admin.doc('posWorkspaces/live/config/settings').update({ allowStaffRefunds: true });
  const saved = await invoke('checkout', checkoutData({ customerId: 'c1', paymentMethod: 'Account' }));
  const data = { workspace: 'live', orderId: saved.id, idempotencyKey: 'credit-refund', reason: 'Full credit refund' };
  const result = await enabled.refund({ auth: { uid: 'staff-a' }, data });
  assert.equal(result.amount, 25);
  assert.equal(result.settlement, 'account-credit');
  assert.equal((await admin.doc('posWorkspaces/live/customers/c1').get()).data().dueBalance, 100);
  assert.deepEqual(await enabled.refund({ auth: { uid: 'staff-a' }, data }), result);
  await assert.rejects(enabled.refund({ auth: { uid: 'staff-a' }, data: { ...data, idempotencyKey: 'second-refund' } }), { code: 'already-exists' });
  await assert.rejects(enabled.refund({ auth: { uid: 'staff-a' }, data: { ...data, amount: 999 } }), { code: 'invalid-argument' });
  const refunds = await admin.collection(`posWorkspaces/live/financialInvoices/${saved.id}/refunds`).get();
  assert.equal(refunds.size, 1);
  assert.equal((await admin.doc(`posWorkspaces/live/customerAccounts/c1/ledger/refund-${saved.id}`).get()).data().balanceDelta, -25);
  for (const uid of ['staff-a', 'owner']) await assertFails(updateDoc(doc(dbFor(uid), 'posWorkspaces/live/orders', saved.id), { refund: null }));
});

test('cash refunds leave customer debt unchanged and refunds need both server and owner gates', async () => {
  const admin = getAdminFirestore(adminApp), enabled = createFinancialService(admin, { allowRefunds: true });
  const saved = await invoke('checkout', checkoutData({ customerId: 'c1' }));
  const data = { workspace: 'live', orderId: saved.id, idempotencyKey: 'cash-refund', reason: 'Cash returned' };
  await assert.rejects(enabled.refund({ auth: { uid: 'staff-a' }, data }), { code: 'permission-denied' });
  await admin.doc('posWorkspaces/live/config/settings').update({ allowStaffRefunds: true });
  const result = await enabled.refund({ auth: { uid: 'staff-a' }, data });
  assert.equal(result.settlement, 'external-return-recorded');
  assert.equal((await admin.doc('posWorkspaces/live/customers/c1').get()).data().dueBalance, 100);
  assert.equal((await admin.doc(`posWorkspaces/live/customerAccounts/c1/ledger/refund-${saved.id}`).get()).data().balanceDelta, 0);
});

test('paid credit refunds create customer credit and serialize with simultaneous payments', async () => {
  const admin = getAdminFirestore(adminApp), enabled = createFinancialService(admin, { allowRefunds: true });
  await admin.doc('posWorkspaces/live/config/settings').update({ allowStaffRefunds: true });
  const saved = await invoke('checkout', checkoutData({ customerId: 'c1', paymentMethod: 'Account' }));
  await Promise.all([
    enabled.refund({ auth: { uid: 'staff-a' }, data: { workspace: 'live', orderId: saved.id, idempotencyKey: 'parallel-refund', reason: 'Return' } }),
    invoke('recordPayment', { workspace: 'live', customerId: 'c1', idempotencyKey: 'parallel-payment', amount: 125, method: 'Cash' })
  ]);
  assert.equal((await admin.doc('posWorkspaces/live/customers/c1').get()).data().dueBalance, -25);
});

test('legacy invoices cannot bypass refund reconciliation using forged client metadata', async () => {
  const admin = getAdminFirestore(adminApp), enabled = createFinancialService(admin, { allowRefunds: true });
  await admin.doc('posWorkspaces/live/config/settings').update({ allowStaffRefunds: true });
  await admin.doc('posWorkspaces/live/orders/legacy-invoice').set({ ...order(), id: 'legacy-invoice', financialSchema: 2, requestHash: 'forged', paymentMethod: 'Account', customerId: 'c1' });
  await assert.rejects(enabled.refund({ auth: { uid: 'staff-a' }, data: { workspace: 'live', orderId: 'legacy-invoice', idempotencyKey: 'legacy-refund', reason: 'Legacy return' } }), { code: 'failed-precondition' });
  assert.equal((await admin.doc('posWorkspaces/live/customers/c1').get()).data().dueBalance, 100);
});

test('callable HTTP envelopes verify emulator Auth tokens and reject unauthenticated or forged requests', async () => {
  const token = emulatorToken;
  const call = (name, data, uid) => fetch(`${callableOrigin}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000', ...(uid ? { Authorization: `Bearer ${token(uid)}` } : {}) }, body: JSON.stringify({ data }) });
  const anonymous = await call('checkout', checkoutData());
  assert.equal(anonymous.status, 401);
  const outsider = await call('checkout', checkoutData(), 'stranger');
  assert.equal(outsider.status, 403);
  const forged = await call('checkout', checkoutData({ items: [{ productId: 'p1', quantity: 1, price: 1 }] }), 'staff-a');
  assert.equal(forged.status, 400);
  const saved = await call('checkout', checkoutData(), 'staff-a');
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.result.total, 25);
  assert.ok((await getAdminFirestore(adminApp).doc('operatorActivity/staff-a').get()).data()?.lastLoginAt);
  assert.equal(saved.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3000');
  const payment = await call('recordPayment', { workspace: 'live', customerId: 'c1', idempotencyKey: 'http-payment', amount: 10, method: 'Cash' }, 'staff-a');
  assert.equal(payment.status, 200);
  assert.equal((await payment.json()).result.dueBalance, 90);
  const refund = await call('refund', { workspace: 'live', orderId: body.result.id, idempotencyKey: 'http-refund', reason: 'Disabled' }, 'staff-a');
  assert.equal(refund.status, 400);
  const login = await call('recordStaffLogin', {}, 'staff-a');
  assert.equal(login.status, 200);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const reportData = { workspace: 'live', start: today, end: today };
  assert.equal((await call('getStaffSummary', reportData)).status, 401);
  assert.equal((await call('getStaffSummary', reportData, 'staff-a')).status, 403);
  const report = await call('getStaffSummary', reportData, 'owner');
  assert.equal(report.status, 200);
  assert.ok((await report.json()).result.staff.find(row => row.uid === 'staff-a').lastLoginAt);
});


test('financial client writes are denied for every role, including inactive workspaces', async () => {
  for (const uid of ['owner', 'staff-a']) for (const path of [
    'posWorkspaces/archive/orders/forged', 'posWorkspaces/live/financialOperations/forged',
    'posWorkspaces/live/financialInvoices/forged', 'posWorkspaces/live/financialInvoices/forged/payments/forged',
    'posWorkspaces/live/financialInvoices/forged/refunds/forged', 'posWorkspaces/live/config/invoiceSequence'
  ]) await assertFails(setDoc(doc(dbFor(uid), path), { amount: 1 }));
});

test('staff login records use verified auth times and are owner-readable but never client-writable', async () => {
  const admin = getAdminFirestore(adminApp), staff = createStaffService(admin);
  const authTime = Math.floor(Date.now() / 1000);
  const request = { auth: { uid: 'staff-a', token: { auth_time: authTime } }, data: {} };
  await staff.recordStaffLogin(request);
  await staff.recordStaffLogin({ ...request, auth: { uid: 'staff-a', token: { auth_time: authTime - 100 } } });
  assert.equal((await admin.doc('operatorActivity/staff-a').get()).data().authTime, authTime);
  await assert.rejects(staff.recordStaffLogin({ ...request, data: { uid: 'staff-b', lastLoginAt: 'forged' } }), { code: 'invalid-argument' });
  await assert.rejects(staff.recordStaffLogin({ data: {} }), { code: 'unauthenticated' });
  await assert.rejects(staff.recordStaffLogin({ auth: { uid: 'disabled', token: { auth_time: authTime } }, data: {} }), { code: 'permission-denied' });
  await assertSucceeds(getDoc(doc(dbFor('owner'), 'operatorActivity/staff-a')));
  for (const uid of ['staff-a', 'staff-b']) await assertFails(getDoc(doc(dbFor(uid), 'operatorActivity/staff-a')));
  for (const uid of ['owner', 'staff-a']) await assertFails(setDoc(doc(dbFor(uid), 'operatorActivity/forged'), { authTime }));
});

test('owner staff reports scope private cash payments to the active workspace and deny staff access', async () => {
  const admin = getAdminFirestore(adminApp), staff = createStaffService(admin);
  const date = new Date().toISOString(), today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  await admin.doc('posWorkspaces/live/orders/staff-sale').set({ id: 'staff-sale', cashierUid: 'staff-a', total: 100, status: 'Completed', paymentMethod: 'Cash', amountReceived: 200, createdAt: date });
  await admin.doc('posWorkspaces/live/expenses/staff-expense').set({ recordedBy: 'staff-a', amount: 15, paymentMethod: 'Cash', createdAt: date, date: today });
  for (const workspace of ['live', 'archive']) await admin.doc(`posWorkspaces/${workspace}/customerAccounts/c1/payments/payment`).set({ type: 'payment', recordedBy: 'staff-a', method: 'Cash', amount: workspace === 'live' ? 25 : 999, date });
  const data = { workspace: 'live', start: today, end: today };
  await assert.rejects(staff.getStaffSummary({ auth: { uid: 'staff-a' }, data }), { code: 'permission-denied' });
  await assert.rejects(staff.getStaffSummary({ auth: { uid: 'owner' }, data: { ...data, uid: 'staff-b' } }), { code: 'invalid-argument' });
  await assert.rejects(staff.getStaffSummary({ auth: { uid: 'owner' }, data: { ...data, workspace: 'archive' } }), { code: 'failed-precondition' });
  const report = await staff.getStaffSummary({ auth: { uid: 'owner' }, data });
  const row = report.staff.find(row => row.uid === 'staff-a');
  assert.equal(row.totalSales, 100); assert.equal(row.cashReceived, 125); assert.equal(row.totalExpenses, 15); assert.equal(row.remaining, 110);
});

test('owner can read legacy sales and expenses before migration without cash guesses or database writes', async () => {
  const admin = getAdminFirestore(adminApp), staff = createStaffService(admin), date = new Date().toISOString();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  await admin.doc('posWorkspaces/live/config/financialMigration').delete();
  await admin.doc('posWorkspaces/live/orders/legacy-summary').set({ cashierUid: 'staff-a', cashierName: 'Staff', status: 'Completed', total: 100, paymentMethod: 'Cash', createdAt: date });
  await admin.doc('posWorkspaces/live/expenses/legacy-summary').set({ recordedBy: 'staff-a', amount: 15, paymentMethod: 'Cash', createdAt: date });
  const report = await staff.getStaffSummary({ auth: { uid: 'owner' }, data: { workspace: 'live', start: today, end: today } });
  const row = report.staff.find(row => row.uid === 'staff-a');
  assert.equal(report.cashState, 'migration-required'); assert.equal(row.totalSales, 100); assert.equal(row.totalExpenses, 15);
  assert.equal(row.cashReceived, null); assert.equal(row.remaining, null);
  assert.equal((await admin.collection('financialRateLimits').get()).size, 0);
  assert.equal((await admin.doc('posWorkspaces/live/config/financialMigration').get()).exists, false);
  await assert.rejects(invoke('checkout', checkoutData({ idempotencyKey: 'must-stay-blocked' })), { code: 'failed-precondition' });
  assert.equal((await admin.doc('posWorkspaces/live/orders/must-stay-blocked').get()).exists, false);
});

test('Vite bridge executes authenticated checkout against the emulator and retains the migration gate', async () => {
  const vite = await createServer({ configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0, strictPort: true }, plugins: [localApiPlugin({ projectId, loadApi: options => createHttpApp({ handlers: callableModule, origins: options.origins, distPath: resolve('public') }) })] });
  await vite.listen();
  try {
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const call = data => fetch(`${origin}/api/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Authorization: `Bearer ${emulatorToken('staff-a')}` }, body: JSON.stringify({ data }) });
    const response = await call(checkoutData({ idempotencyKey: 'vite-invoice' }));
    assert.equal(response.status, 200); assert.equal((await response.json()).result.total, 25);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    await getAdminFirestore(adminApp).doc('posWorkspaces/live/config/financialMigration').update({ status: 'migrating' });
    const blocked = await call(checkoutData({ idempotencyKey: 'vite-blocked' }));
    assert.equal(blocked.status, 400); assert.equal((await blocked.json()).error.status, 'FAILED_PRECONDITION');
    assert.equal((await getAdminFirestore(adminApp).doc('posWorkspaces/live/orders/vite-blocked').get()).exists, false);
  } finally { await vite.close(); }
});
