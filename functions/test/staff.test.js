import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaffService, reportPeriod, summarizeStaff } from '../src/staff.js';

const now = '2026-11-27T09:00:00.000Z';
const sale = (cashierUid, total, paymentMethod, extra = {}) => ({ cashierUid, cashierName: 'Same name', total, paymentMethod, status: 'Completed', createdAt: now, ...extra });
const data = () => ({ workspace: 'live', period: reportPeriod('2026-11-27', '2026-11-27'), operators: [{ uid: 'a', role: 'staff', name: 'Same name', active: true }, { uid: 'b', role: 'staff', name: 'Same name', active: true }, { uid: 'owner', role: 'owner' }], activity: [{ uid: 'a', lastLoginAt: now }], orders: [], refunds: [], expenses: [], payments: [] });

test('staff cash balances separate tender, change, customer collections, refunds and expense attribution', () => {
  const report = summarizeStaff({ ...data(), orders: [sale('a', 100, 'Cash', { amountReceived: 200 }), sale('a', 100, 'Split', { splitBreakdown: { cash: 40, upi: 60 } }), sale('a', 300, 'Account'), sale('a', 200, 'UPI'), sale('b', 80, 'Cash')],
    refunds: [sale('a', 100, 'Cash', { refund: { amount: 100, cashierUid: 'b', recordedAt: now } }), sale('a', 300, 'Account', { refund: { amount: 300, cashierUid: 'b', recordedAt: now } })],
    expenses: [{ recordedBy: 'a', amount: 15, paymentMethod: 'Cash', createdAt: now }, { recordedBy: 'a', amount: 10, paymentMethod: 'UPI', createdAt: now }, { recordedBy: 'b', amount: 5, paymentMethod: 'Cash', createdAt: now }],
    payments: [{ path: 'posWorkspaces/live/customerAccounts/c/payments/p', type: 'payment', recordedBy: 'a', amount: 25, method: 'Cash', date: now }, { path: 'posWorkspaces/live/financialInvoices/order/payments/settlement', type: 'invoice-payment', recordedBy: 'a', amount: 100, method: 'Cash', date: now }, { path: 'posWorkspaces/other/customerAccounts/c/payments/p', type: 'payment', recordedBy: 'a', amount: 900, method: 'Cash', date: now }] });
  const a = report.staff.find(row => row.uid === 'a'), b = report.staff.find(row => row.uid === 'b');
  assert.equal(a.totalSales, 700); assert.equal(a.bills, 4); assert.equal(a.cashReceived, 165); assert.equal(a.totalExpenses, 25); assert.equal(a.cashExpenses, 15); assert.equal(a.remaining, 150);
  assert.equal(b.cashRefunds, 100); assert.equal(b.remaining, -25); assert.equal(a.lastLoginAt, now);
});

test('staff reporting uses India dates and flags ambiguous legacy cash instead of inventing a balance', () => {
  const report = summarizeStaff({ ...data(), cutoverAt: now, orders: [sale('a', 100, 'Cash', { createdAt: '2026-11-26T18:29:59Z' }), sale('a', 50, 'Cash', { createdAt: '2026-11-26T18:30:00Z' }), sale('b', 40, 'Split'), sale(undefined, 20, 'Cash'), sale('owner', 900, 'Cash')] });
  assert.equal(report.staff.find(row => row.uid === 'a').totalSales, 50);
  assert.equal(report.staff.find(row => row.uid === 'b').remaining, null);
  assert.equal(report.staff.find(row => row.uid === 'unattributed').needsReview, true);
  assert.equal(report.staff.some(row => row.uid === 'owner'), false);
  assert.equal(report.historyIncomplete, true);
});

test('staff report date ranges reject invalid or oversized periods and use inclusive business days', () => {
  assert.equal(reportPeriod('2026-11-27', '2026-11-27').from, '2026-11-26T18:30:00.000Z');
  assert.equal(reportPeriod('2026-11-27', '2026-11-27').until, '2026-11-27T18:30:00.000Z');
  for (const pair of [['2026-02-30', '2026-03-01'], ['2026-11-28', '2026-11-27'], ['2026-01-01', '2026-02-01'], ['', '2026-11-27']]) assert.throws(() => reportPeriod(...pair));
});

test('staff partial reports expose recorded totals but never invent cash balances before setup', () => {
  for (const cashState of ['migration-required', 'index-required']) {
    const report = summarizeStaff({ ...data(), cashState, orders: [sale('a', 100, 'Cash')], expenses: [{ recordedBy: 'a', amount: 15, paymentMethod: 'Cash', createdAt: now }] });
    const row = report.staff.find(row => row.uid === 'a');
    assert.equal(report.cashState, cashState); assert.equal(row.totalSales, 100); assert.equal(row.totalExpenses, 15);
    assert.equal(row.remaining, null); assert.equal(row.cashReceived, null); assert.equal(row.cashRefunds, null); assert.equal(row.cashExpenses, null);
  }
});

test('missing payment index produces a read-only partial owner report with actionable readiness', async () => {
  const empty = { size: 0, docs: [] };
  const query = kind => ({ kind, where() { return this; }, limit() { return this; }, select() { return this; } });
  const db = { doc: path => ({ path }), collection: path => query(path), collectionGroup: name => query(`group:${name}`),
    runTransaction: async (callback, options) => {
      assert.equal(options.readOnly, true);
      return callback({ get: async ref => {
        if (ref.path === 'operators/owner') return { data: () => ({ active: true, role: 'owner' }) };
        if (ref.path === 'posConfig/current') return { data: () => ({ workspace: 'live' }) };
        if (ref.path?.endsWith('/config/financialMigration')) return { data: () => ({ status: 'ready' }) };
        if (ref.kind === 'group:payments') throw Object.assign(new Error('The query requires an index.'), { code: 9 });
        return empty;
      }, set() { throw new Error('Reports must not write database records.'); } });
    }
  };
  const report = await createStaffService(db).getStaffSummary({ auth: { uid: 'owner' }, data: { workspace: 'live', start: '2026-11-27', end: '2026-11-27' } });
  assert.equal(report.cashState, 'index-required');
});
