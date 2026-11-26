import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch, setLogLevel } from 'firebase/firestore';
import { createServer } from 'vite';

setLogLevel('silent'); // Expected permission denials are asserted below.

let env;
let moduleServer;
let database;
const projectId = 'demo-pos-rules';
const dbFor = uid => env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore();
const profile = (role, active = true) => ({ role, active, name: role, email: `${role}@example.test` });

before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile('firestore.rules', 'utf8') } });
  globalThis.__posTestFirestore = dbFor('staff-a');
  moduleServer = await createServer({ configFile: false, server: { middlewareMode: true }, plugins: [{
    name: 'local-rules-test-database',
    enforce: 'pre',
    load(id) {
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
      'posWorkspaces/live/products/p1': { id: 'p1', name: 'Milk', price: 25 },
      'posWorkspaces/live/customers/c1': {
        id: 'c1', name: 'Customer', phone: '+919000000000', ordersCount: 0, totalSpent: 0,
        avgOrderValue: 0, dueBalance: 100, creditLimit: 150, accountTransactions: []
      },
      'posWorkspaces/live/identity/customers-phone-%2B919000000000': { id: 'c1' },
      'posWorkspaces/archive/products/p1': { id: 'p1', name: 'Archived Milk', price: 20 },
      'posWorkspaces/live/expenses/a': { id: 'a', recordedBy: 'staff-a', amount: 10, paymentMethod: 'Cash', reason: 'Delivery' },
      'posWorkspaces/live/expenses/b': { id: 'b', recordedBy: 'staff-b', amount: 20, paymentMethod: 'Cash', reason: 'Delivery' }
    })) await setDoc(doc(db, path), data);
  });
});
after(async () => { await moduleServer?.close(); await env?.cleanup(); });

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
  await assertSucceeds(batch.commit());
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
  await assertSucceeds(updateDoc(ref, changes));
  await assertFails(updateDoc(ref, { ...changes, dueBalance: 60 }));
  const next = { ...entry, id: 'tx-2', balanceAfter: 60 };
  await assertFails(updateDoc(ref, { ...changes, dueBalance: 60, accountTransactions: [next] }));
  await assertSucceeds(updateDoc(ref, { ...changes, dueBalance: 60, accountTransactions: [entry, next] }));
});

test('cash checkout atomically saves an invoice and its sequence', async () => {
  await assertSucceeds(saleBatch(dbFor('staff-a')).commit());
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
  await assertSucceeds(saleBatch(db, saved, { ordersCount: 1, totalSpent: 25, avgOrderValue: 25, dueBalance: 125,
    accountTransactions: [charge] }).commit());
});

test('customer visit and spend updates require a new matching invoice, preventing replay', async () => {
  const db = dbFor('staff-a');
  const changes = { ordersCount: 1, totalSpent: 25, avgOrderValue: 25, dueBalance: 100, accountTransactions: [] };
  await assertSucceeds(saleBatch(db, order(), changes).commit());
  await assertFails(updateDoc(doc(db, 'posWorkspaces/live/customers/c1'), { ordersCount: 2, totalSpent: 50 }));
});

test('KNOWN BLOCKER: scalar rules still trust arbitrary line-item totals', async () => {
  // This diagnostic intentionally demonstrates the remaining backend decision.
  // It is not a claim that invoice arithmetic is secure end-to-end.
  const forged = order({ items: [{ id: 'p1', name: 'Milk', price: 1000, quantity: 100, total: 100000 }] });
  await assertSucceeds(saleBatch(dbFor('staff-a'), forged).commit());
  assert.notEqual(forged.items[0].total, forged.subtotal);
});

test('KNOWN BLOCKER: staff can read ledger fields hidden by the owner-only UI', async () => {
  await env.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posWorkspaces/live/customers/c1'), {
    accountTransactions: [{ id: 'private-history', type: 'payment', amount: 100 }]
  }));
  const snapshot = await assertSucceeds(getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/customers/c1')));
  assert.equal(snapshot.data().accountTransactions[0].id, 'private-history');
});

test('KNOWN BLOCKER: refunding an account invoice does not reverse customer debt', async () => {
  await env.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posWorkspaces/live/config/settings'), { allowStaffRefunds: true }));
  const saved = await database.executeOrderTransaction('live', { order: order({ paymentMethod: 'Account' }), customerId: 'c1' });
  await database.refundOrder('live', saved, { reason: 'Local audit fixture', recordedAt: new Date().toISOString(), cashierUid: 'staff-a', cashierName: 'Staff' });
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

test('real account payments work with a full rolling ledger and reject fractional paise', async () => {
  await env.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posWorkspaces/live/customers/c1'), {
    accountTransactions: Array.from({ length: 50 }, (_, n) => ({ id: `old-${n}`, amount: 1, type: 'payment' }))
  }));
  const result = await database.recordCustomerAccountPayment('live', 'c1', { amount: 12.50, method: 'UPI' });
  assert.equal(result.dueBalance, 87.50);
  const customer = (await getDoc(doc(dbFor('staff-a'), 'posWorkspaces/live/customers/c1'))).data();
  assert.equal(customer.accountTransactions.length, 50);
  assert.equal(customer.accountTransactions[0].id, 'old-1');
  assert.throws(() => database.recordCustomerAccountPayment('live', 'c1', { amount: 1.001 }), /two decimal/);
});
