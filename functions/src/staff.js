import { HttpsError } from 'firebase-functions/v2/https';
import { cents, id, object } from './financial.js';

const fail = (code, message) => { throw new HttpsError(code, message); };
const shopDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : Number.isFinite(Date.parse(value)) ? shopDate.format(new Date(value)) : '';
const label = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : fallback;

export function reportPeriod(start, end) {
  for (const date of [start, end]) if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail('invalid-argument', 'Choose valid report dates.');
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days < 0 || days > 30) fail('invalid-argument', 'Choose a range of up to 31 days.');
  const from = new Date(`${start}T00:00:00+05:30`), until = new Date(`${end}T00:00:00+05:30`);
  until.setUTCDate(until.getUTCDate() + 1);
  return { start, end, from: from.toISOString(), until: until.toISOString(), nextDay: new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10) };
}

export function summarizeStaff({ workspace, period, operators, activity, orders, refunds, expenses, payments, cutoverAt, cashState = 'ready' }) {
  const profiles = new Map(operators.map(person => [person.uid, person]));
  const logins = new Map(activity.map(person => [person.uid, person]));
  const rows = new Map();
  const actor = (uid, name) => {
    if (profiles.get(uid)?.role === 'owner') return null;
    const key = id(uid) ? uid : 'unattributed';
    if (!rows.has(key)) {
      const profile = profiles.get(uid), login = logins.get(uid);
      rows.set(key, { uid: key, name: label(profile?.name, label(login?.name, label(name, key === 'unattributed' ? 'Unattributed legacy activity' : 'Former staff'))), email: profile?.email ?? login?.email ?? '', active: profile?.active === true,
        lastLoginAt: login?.lastLoginAt ?? null, bills: 0, totalSales: 0, totalExpenses: 0, cashReceived: 0, cashRefunds: 0, cashExpenses: 0, needsReview: key === 'unattributed' });
    }
    return rows.get(key);
  };
  for (const person of operators) if (person.role === 'staff') actor(person.uid, person.name);
  const within = value => { const date = day(value); return date && date >= period.start && date <= period.end; };
  const cashFor = (order, row) => {
    if (order.paymentMethod === 'Cash') return cents(order.total);
    if (order.paymentMethod === 'Split') {
      if (order.splitBreakdown?.cash == null) { row.needsReview = true; return 0; }
      const cash = cents(order.splitBreakdown.cash);
      if (cash > cents(order.total)) fail('failed-precondition', 'A legacy split payment requires review.');
      return cash;
    }
    if (!['UPI', 'Card', 'Account', 'Credit'].includes(order.paymentMethod)) row.needsReview = true;
    return 0;
  };
  for (const order of orders) {
    if (order.status !== 'Completed' || !within(order.createdAt)) continue;
    const row = actor(order.cashierUid, order.cashierName);
    if (!row) continue;
    row.bills++; row.totalSales += cents(order.total); row.cashReceived += cashFor(order, row);
  }
  for (const order of refunds) {
    if (order.status !== 'Completed' || !order.refund || !within(order.refund.recordedAt)) continue;
    const row = actor(order.refund.cashierUid, order.refund.cashierName);
    if (!row) continue;
    const amount = cents(order.refund.amount ?? order.total), original = cents(order.total);
    if (amount > original) fail('failed-precondition', 'A legacy refund requires review.');
    if (order.paymentMethod === 'Cash') row.cashRefunds += amount;
    else if (order.paymentMethod === 'Split' && amount !== original) row.needsReview = true;
    else row.cashRefunds += cashFor(order, row);
  }
  for (const expense of expenses) {
    if (!within(expense.date || expense.createdAt)) continue;
    const row = actor(expense.recordedBy, expense.recordedByName);
    if (!row) continue;
    row.totalExpenses += cents(expense.amount);
    if (expense.paymentMethod === 'Cash') row.cashExpenses += cents(expense.amount);
    else if (!['UPI', 'Card'].includes(expense.paymentMethod)) row.needsReview = true;
  }
  for (const payment of payments) {
    const parts = payment.path.split('/');
    if (parts.length !== 6 || parts[0] !== 'posWorkspaces' || parts[1] !== workspace || parts[2] !== 'customerAccounts' || parts[4] !== 'payments' || payment.type !== 'payment' || !within(payment.date)) continue;
    const row = actor(payment.recordedBy, payment.recordedByName);
    if (row && payment.method === 'Cash') row.cashReceived += cents(payment.amount);
    else if (row && !['UPI', 'Card'].includes(payment.method)) row.needsReview = true;
  }
  const cashReady = cashState === 'ready';
  const staff = [...rows.values()].map(row => ({ ...row,
    totalSales: row.totalSales / 100, totalExpenses: row.totalExpenses / 100, cashReceived: cashReady ? row.cashReceived / 100 : null,
    cashRefunds: cashReady ? row.cashRefunds / 100 : null, cashExpenses: cashReady ? row.cashExpenses / 100 : null,
    remaining: row.needsReview || !cashReady ? null : (row.cashReceived - row.cashRefunds - row.cashExpenses) / 100
  })).sort((a, b) => b.totalSales - a.totalSales || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
  return { period: { start: period.start, end: period.end }, generatedAt: new Date().toISOString(), staff, cashState,
    historyIncomplete: Boolean(cutoverAt && period.from < cutoverAt) };
}

export function createStaffService(db) {
  const reportRequests = new Map();
  async function operator(tx, request, roles) {
    if (!id(request.auth?.uid)) fail('unauthenticated', 'Sign in to continue.');
    const profile = (await tx.get(db.doc(`operators/${request.auth.uid}`))).data();
    if (!profile?.active || !roles.includes(profile.role)) fail('permission-denied', 'Operator access denied.');
    return { ...profile, uid: request.auth.uid };
  }
  async function recordStaffLogin(request) {
    object(request.data, []);
    return db.runTransaction(async tx => {
      const profile = await operator(tx, request, ['staff', 'owner']);
      if (profile.role === 'owner') return { recorded: false };
      const authTime = request.auth.token?.auth_time;
      if (!Number.isSafeInteger(authTime) || authTime <= 0 || authTime > Date.now() / 1000 + 300) fail('unauthenticated', 'A verified sign-in timestamp is required.');
      const ref = db.doc(`operatorActivity/${profile.uid}`), previous = (await tx.get(ref)).data();
      if ((previous?.authTime ?? 0) >= authTime) return { recorded: true };
      tx.set(ref, { authTime, lastLoginAt: new Date(authTime * 1000).toISOString(), name: label(profile.name, 'Staff'), email: profile.email ?? '', recordedAt: new Date().toISOString() });
      return { recorded: true };
    });
  }
  async function getStaffSummary(request) {
    object(request.data, ['workspace', 'start', 'end']);
    const { workspace, start, end } = request.data;
    if (!id(workspace)) fail('invalid-argument', 'Invalid workspace.');
    const period = reportPeriod(start, end);
    return db.runTransaction(async tx => {
      const profile = await operator(tx, request, ['owner']);
      if ((await tx.get(db.doc('posConfig/current'))).data()?.workspace !== workspace) fail('failed-precondition', 'The active workspace changed.');
      const base = db.collection(`posWorkspaces/${workspace}/orders`), gate = (await tx.get(db.doc(`posWorkspaces/${workspace}/config/financialMigration`))).data();
      const window = Math.floor(Date.now() / 60000), rate = reportRequests.get(profile.uid);
      const count = rate?.window === window ? rate.count + 1 : 1;
      if (count > 12) fail('resource-exhausted', 'Wait a minute before refreshing the staff report.');
      if (reportRequests.size >= 1000) for (const [uid, rate] of reportRequests) if (rate.window !== window) reportRequests.delete(uid);
      if (!rate && reportRequests.size >= 1000) fail('resource-exhausted', 'The report service is busy. Retry shortly.');
      reportRequests.set(profile.uid, { window, count });
      const invoiceFields = ['cashierUid', 'cashierName', 'status', 'total', 'paymentMethod', 'splitBreakdown', 'createdAt', 'refund'];
      const inTime = (query, field) => query.where(field, '>=', period.from).where(field, '<', period.until).limit(10001);
      const expenseCollection = db.collection(`posWorkspaces/${workspace}/expenses`), expenseFields = ['recordedBy', 'recordedByName', 'amount', 'paymentMethod', 'date', 'createdAt'];
      const queries = [db.collection('operators').select('name', 'email', 'role', 'active').limit(501), db.collection('operatorActivity').select('lastLoginAt', 'name', 'email').limit(501),
        inTime(base, 'createdAt').select(...invoiceFields), inTime(base, 'refund.recordedAt').select(...invoiceFields),
        inTime(expenseCollection, 'createdAt').select(...expenseFields), expenseCollection.where('date', '>=', start).where('date', '<', period.nextDay).limit(10001).select(...expenseFields)];
      const snapshots = await Promise.all(queries.map(query => tx.get(query)));
      let cashState = gate?.status === 'ready' ? 'ready' : 'migration-required', paymentSnapshot;
      if (cashState === 'ready') {
        try { paymentSnapshot = await tx.get(inTime(db.collectionGroup('payments'), 'date').select('recordedBy', 'recordedByName', 'amount', 'method', 'date', 'type')); }
        catch (error) {
          if (error?.code === 9 && /index/i.test(error.message ?? '')) cashState = 'index-required';
          else throw error;
        }
      }
      if (snapshots.some((snapshot, index) => snapshot.size > (index < 2 ? 500 : 10000))) fail('failed-precondition', 'This report is too large. Choose a shorter date range.');
      if (paymentSnapshot?.size > 10000) fail('failed-precondition', 'This report is too large. Choose a shorter date range.');
      const rows = snapshot => snapshot.docs.map(doc => ({ ...doc.data(), uid: doc.id, path: doc.ref.path }));
      const expenseRows = [...new Map([...rows(snapshots[4]), ...rows(snapshots[5])].map(expense => [expense.path, expense])).values()];
      return summarizeStaff({ workspace, period, operators: rows(snapshots[0]), activity: rows(snapshots[1]), orders: rows(snapshots[2]), refunds: rows(snapshots[3]), expenses: expenseRows, payments: paymentSnapshot ? rows(paymentSnapshot) : [], cutoverAt: gate?.completedAt, cashState });
    }, { readOnly: true });
  }
  return { recordStaffLogin, getStaffSummary };
}
