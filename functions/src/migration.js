import { randomUUID } from 'node:crypto';
import { cents, id, fingerprint } from './financial.js';

const publicFields = ['id', 'name', 'phone', 'email', 'notes', 'ordersCount', 'totalSpent', 'avgOrderValue', 'dueBalance', 'financialSchema', 'archived'];
const snapshotHash = snapshot => fingerprint([snapshot.updateTime?.toMillis(), snapshot.data()]);
const account = (db, workspace, customerId) => db.doc(`posWorkspaces/${workspace}/customerAccounts/${customerId}`);
const migration = (db, workspace) => db.doc(`posWorkspaces/${workspace}/config/financialMigration`);

async function customers(db, workspace) {
  const rows = [];
  let cursor;
  for (;;) {
    let query = db.collection(`posWorkspaces/${workspace}/customers`).orderBy('__name__').limit(250);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    rows.push(...page.docs);
    if (page.size < 250) return rows;
    cursor = page.docs.at(-1);
  }
}

export function prepareCustomer(snapshot) {
  const data = snapshot.data();
  if (!id(snapshot.id) || !data || typeof data.name !== 'string' || !/^[+][0-9]{8,15}$/.test(data.phone)) throw new Error('Invalid customer identity.');
  for (const [key, max] of [['name', 100], ['email', 120], ['notes', 500]]) if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > max)) throw new Error('Invalid legacy customer text.');
  if (data.archived !== undefined && typeof data.archived !== 'boolean') throw new Error('Invalid archive flag.');
  cents(data.avgOrderValue ?? 0);
  for (const key of ['ordersCount']) if (!Number.isSafeInteger(data[key] ?? 0) || (data[key] ?? 0) < 0) throw new Error('Invalid customer count.');
  cents(data.dueBalance ?? 0, true); cents(data.creditLimit ?? 0); cents(data.totalSpent ?? 0);
  const source = data.accountTransactions ?? [];
  if (!Array.isArray(source)) throw new Error('Invalid legacy history.');
  const entries = source.map((entry, index) => {
    if (!entry || !['charge', 'payment', 'refund', 'opening'].includes(entry.type) || typeof entry.date !== 'string' || !Number.isFinite(Date.parse(entry.date))) throw new Error('Invalid legacy entry type/date.');
    cents(entry.amount);
    if (entry.type === 'payment' && entry.amount <= 0) throw new Error('Invalid legacy payment amount.');
    if (entry.balanceAfter != null) cents(entry.balanceAfter, true);
    const entryId = `legacy-${fingerprint([snapshot.id, index, entry]).slice(0, 40)}`;
    return { ...entry, id: entryId, date: new Date(entry.date).toISOString(), legacy: true, legacySource: entry };
  });
  const totalDelta = entries.reduce((sum, entry) => sum + (['charge', 'opening'].includes(entry.type) ? cents(entry.amount) : -cents(entry.amount)), 0);
  let balance = cents(data.dueBalance ?? 0, true) - totalDelta;
  const openingBalance = balance / 100;
  for (const entry of entries) {
    const delta = ['charge', 'opening'].includes(entry.type) ? cents(entry.amount) : -cents(entry.amount);
    entry.balanceBefore = balance / 100;
    balance += delta;
    if (entry.balanceAfter != null && cents(entry.balanceAfter, true) !== balance) throw new Error('Legacy history does not reconcile; owner review is required.');
    entry.balanceAfter = balance / 100;
  }
  const summary = Object.fromEntries(publicFields.filter(key => key in data).map(key => [key, data[key]]));
  Object.assign(summary, { id: snapshot.id, financialSchema: 2, archived: data.archived ?? false, ordersCount: data.ordersCount ?? 0, totalSpent: data.totalSpent ?? 0, avgOrderValue: data.avgOrderValue ?? 0, dueBalance: data.dueBalance ?? 0 });
  const legacyFields = Object.fromEntries(Object.entries(data).filter(([key]) => !publicFields.includes(key) && !['creditLimit', 'accountTransactions'].includes(key)));
  const privateData = { status: 'ready', creditLimit: data.creditLimit ?? 0, openingBalance, historyComplete: false, legacyFields };
  if ([privateData, ...entries].some(value => Buffer.byteLength(JSON.stringify(value)) > 750000)) throw new Error('Legacy record exceeds the safe document size; administrator review is required.');
  return { summary, entries, privateData };
}

export async function planMigration(db, projectId, workspace) {
  if (!id(workspace)) throw new Error('Invalid workspace.');
  const plan = { version: 1, projectId, workspace, customers: [], errors: [], warning: 'Previously discarded payments cannot be recovered. Reconcile older backups and legacy account refunds before cutover.' };
  for (const snapshot of await customers(db, workspace)) {
    if (snapshot.data().financialSchema === 2) {
      const value = snapshot.data(), privateData = (await account(db, workspace, snapshot.id).get()).data();
      if (Object.keys(value).some(key => !publicFields.includes(key)) || privateData?.status !== 'ready') plan.errors.push({ id: snapshot.id, message: 'Version-2 customer has private fields or an incomplete private account.' });
      continue;
    }
    try {
      const prepared = prepareCustomer(snapshot);
      plan.customers.push({ id: snapshot.id, sourceHash: snapshotHash(snapshot), entries: prepared.entries.length, payments: prepared.entries.filter(entry => entry.type === 'payment').length });
    } catch (error) { plan.errors.push({ id: snapshot.id, message: error.message }); }
  }
  plan.digest = fingerprint(plan);
  return plan;
}

export async function applyMigration(db, projectId, plan) {
  const { digest, ...body } = plan;
  if (!Array.isArray(plan.customers) || !Array.isArray(plan.errors) || plan.customers.some(item => !id(item.id) || !/^[a-f0-9]{64}$/.test(item.sourceHash)) || new Set(plan.customers.map(item => item.id)).size !== plan.customers.length) throw new Error('Invalid migration entries.');
  if (plan.version !== 1 || plan.projectId !== projectId || !id(plan.workspace) || plan.errors.length || fingerprint(body) !== digest) throw new Error('Invalid or unresolved dry-run plan.');
  const gate = migration(db, plan.workspace);
  const leaseId = randomUUID();
  const lease = { leaseId, leaseUntil: Date.now() + 120000 };
  async function owned(tx) {
    const state = (await tx.get(gate)).data();
    if (state?.leaseId !== leaseId || state.planDigest !== digest || state.status !== 'migrating') throw new Error('Migration lease was lost. Stop and review before resuming.');
  }
  await db.runTransaction(async tx => {
    const state = (await tx.get(gate)).data();
    if (state?.status === 'migrating' && state.leaseUntil > Date.now()) throw new Error('Another migration is active. After a stopped process, wait two minutes before resuming.');
    tx.set(gate, { status: 'migrating', schemaVersion: 2, planDigest: digest, ...lease });
  });
  for (const item of plan.customers) {
    const ref = db.doc(`posWorkspaces/${plan.workspace}/customers/${item.id}`), privateRef = account(db, plan.workspace, item.id);
    const snapshot = await ref.get();
    if (snapshot.data()?.financialSchema === 2) {
      if ((await privateRef.get()).data()?.migration?.sourceHash !== item.sourceHash) throw new Error('Migrated customer does not match this plan.');
      continue;
    }
    if (snapshotHash(snapshot) !== item.sourceHash) throw new Error('Source changed since dry-run. Generate a new plan after review.');
    const prepared = prepareCustomer(snapshot);
    await db.runTransaction(async tx => {
      await owned(tx);
      const source = await tx.get(ref), existing = (await tx.get(privateRef)).data();
      if (snapshotHash(source) !== item.sourceHash || (existing && existing.migration?.sourceHash !== item.sourceHash)) throw new Error('Migration source or destination changed.');
      tx.set(privateRef, { ...prepared.privateData, status: 'migrating', migration: { sourceHash: item.sourceHash, planDigest: digest } });
    });
    // Bounded chunks support arbitrarily long embedded histories without exceeding
    // Firestore transaction write limits. Existing immutable entries are verified.
    for (let offset = 0; offset < prepared.entries.length; offset += 100) {
      const writes = prepared.entries.slice(offset, offset + 100).flatMap(entry => [
        [privateRef.collection('ledger').doc(entry.id), entry],
        ...(entry.type === 'payment' ? [[privateRef.collection('payments').doc(entry.id), entry]] : [])
      ]);
      await db.runTransaction(async tx => {
        await owned(tx);
        const existing = await Promise.all(writes.map(([target]) => tx.get(target)));
        writes.forEach(([target, value], index) => {
          if (existing[index].exists) {
            if (fingerprint(existing[index].data()) !== fingerprint(value)) throw new Error('Existing history conflicts with the migration plan.');
          } else tx.create(target, value);
        });
        tx.update(gate, { leaseUntil: Date.now() + 120000 });
      });
    }
    await db.runTransaction(async tx => {
      await owned(tx);
      if (snapshotHash(await tx.get(ref)) !== item.sourceHash) throw new Error('Customer changed before migration finalization.');
      tx.set(ref, prepared.summary);
      tx.update(privateRef, { status: 'ready' });
    });
  }
  for (const snapshot of await customers(db, plan.workspace)) if (snapshot.data().financialSchema !== 2) throw new Error('Unplanned legacy customers remain; migration stays locked.');
  await db.runTransaction(async tx => {
    await owned(tx);
    tx.set(gate, { status: 'ready', schemaVersion: 2, planDigest: digest, completedAt: new Date().toISOString() });
  });
  return { migrated: plan.customers.length };
}
