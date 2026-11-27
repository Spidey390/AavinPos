import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch, setLogLevel } from 'firebase/firestore';
import { createServer } from 'vite';
import { createRequire } from 'node:module';
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
const projectId = 'demo-pos-rules';
const dbFor = uid => env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore();
const profile = (role, active = true) => ({ role, active, name: role, email: `${role}@example.test` });

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
after(async () => { await moduleServer?.close(); await env?.cleanup(); await deleteAdminApp(adminApp); });

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

test('account payments preserve history and exactly reconcile the balance', async () => {
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

test('account refunds remain denied until server reconciliation is available', async () => {
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
