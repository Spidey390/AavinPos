import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';

let env;
const projectId = 'demo-pos-rules';
const dbFor = uid => env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore();
const profile = (role, active = true) => ({ role, active, name: role, email: `${role}@example.test` });

before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules: await readFile('firestore.rules', 'utf8') } });
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
      'posWorkspaces/archive/products/p1': { id: 'p1', name: 'Archived Milk', price: 20 },
      'posWorkspaces/live/expenses/a': { id: 'a', recordedBy: 'staff-a', amount: 10, paymentMethod: 'Cash', reason: 'Delivery' },
      'posWorkspaces/live/expenses/b': { id: 'b', recordedBy: 'staff-b', amount: 20, paymentMethod: 'Cash', reason: 'Delivery' }
    })) await setDoc(doc(db, path), data);
  });
});
after(async () => { await env?.cleanup(); });

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
