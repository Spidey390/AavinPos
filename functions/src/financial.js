import { createHash, randomUUID } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';

const fail = (code, message) => { throw new HttpsError(code, message); };
export const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('invalid-argument', 'Unexpected request fields.');
}
export function text(value = '', max = 120) {
  if (typeof value !== 'string' || value.length > max) fail('invalid-argument', 'Invalid text field.');
  return value.normalize('NFKC').trim();
}
export function cents(value, signed = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9 || (!signed && value < 0) || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) fail('invalid-argument', 'Invalid currency amount.');
  return Math.round(value * 100);
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const revision = draft => draft?.revision ?? draft?.updatedAt ?? null;
const initialSettings = { brandName: 'Aavin POS', invoicePrefix: 'AP-', startingNumber: 1001, gstRate: 0, allowCashierDiscounts: true, allowStaffRefunds: false, audioBeepsEnabled: true, defaultThermalSize: '80mm Standard POS Thermal', commonCategories: [], commonAddons: [], upiVpaId: '', upiQrImage: '', payeeName: 'Aavin POS' };

export function createFinancialService(db) {
  const row = (workspace, type, key) => db.doc(`posWorkspaces/${workspace}/${type}/${key}`);
  const current = db.doc('posConfig/current');
  async function access(tx, request, workspace, roles) {
    if (!id(request.auth?.uid)) fail('unauthenticated', 'Sign in to continue.');
    if (workspace !== null && !id(workspace)) fail('invalid-argument', 'Invalid workspace.');
    const operator = (await tx.get(db.doc(`operators/${request.auth.uid}`))).data();
    if (!operator?.active || !roles.includes(operator.role)) fail('permission-denied', 'Operator access denied.');
    const active = (await tx.get(current)).data();
    if (workspace !== null && active?.workspace !== workspace) fail('failed-precondition', 'The active workspace changed.');
    if (workspace !== null && (await tx.get(row(workspace, 'config', 'financialMigration'))).data()?.status !== 'ready') fail('failed-precondition', 'Financial migration must finish before making changes.');
    return { ...operator, uid: request.auth.uid, workspace: active?.workspace };
  }
  async function throttle(tx, uid, action) {
    const ref = db.doc(`financialRateLimits/${uid}-${action}`);
    const previous = (await tx.get(ref)).data();
    const window = Math.floor(Date.now() / 60000);
    const count = previous?.window === window ? previous.count + 1 : 1;
    if (count > 60) fail('resource-exhausted', 'Too many operations. Wait a minute and retry.');
    return () => tx.set(ref, { window, count });
  }
  function lines(input) {
    if (!Array.isArray(input) || !input.length || input.length > 100) fail('invalid-argument', 'Choose 1 to 100 catalog lines.');
    return input.map(item => {
      object(item, ['productId', 'variant', 'addons', 'quantity', 'note']);
      if (!id(item.productId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000) fail('invalid-argument', 'Invalid product or quantity.');
      const addons = item.addons ?? [];
      if (!Array.isArray(addons) || addons.length > 25 || new Set(addons).size !== addons.length) fail('invalid-argument', 'Invalid add-ons.');
      return { productId: item.productId, variant: item.variant == null ? null : text(item.variant, 40), addons: addons.map(name => text(name, 40)), quantity: item.quantity, note: text(item.note, 300) };
    });
  }
  async function checkout(request) {
    const data = request.data;
    object(data, ['workspace', 'idempotencyKey', 'items', 'customerId', 'tableId', 'tableRevision', 'channel', 'discountPercent', 'paymentMethod', 'amountReceived', 'splitBreakdown', 'referenceNo', 'expectedTotal']);
    if (!id(data.idempotencyKey) || (data.customerId != null && !id(data.customerId)) || (data.tableId != null && !id(data.tableId))) fail('invalid-argument', 'Invalid operation identifiers.');
    const requested = lines(data.items);
    const percent = data.discountPercent ?? 0;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100 || Math.round(percent * 100) !== percent * 100) fail('invalid-argument', 'Invalid discount.');
    if (!['Counter', 'Dine-In', 'Takeaway', 'Delivery'].includes(data.channel) || (data.tableId && data.channel !== 'Dine-In')) fail('invalid-argument', 'Invalid channel.');
    const received = cents(data.amountReceived);
    const referenceNo = text(data.referenceNo);
    const normalized = { ...data, items: requested, referenceNo };
    const hash = fingerprint(normalized);
    return db.runTransaction(async tx => {
      const operator = await access(tx, request, data.workspace, ['staff']);
      const orderRef = row(data.workspace, 'orders', data.idempotencyKey);
      const existing = (await tx.get(orderRef)).data();
      if (existing) {
        if (existing.cashierUid !== operator.uid || existing.requestHash !== hash) fail('already-exists', 'This operation was already used for a different bill.');
        return existing;
      }
      const settingsRef = row(data.workspace, 'config', 'settings');
      const seqRef = row(data.workspace, 'config', 'invoiceSequence');
      const customerRef = data.customerId ? row(data.workspace, 'customers', data.customerId) : null;
      const accountRef = data.customerId ? row(data.workspace, 'customerAccounts', data.customerId) : null;
      const account = accountRef ? (await tx.get(accountRef)).data() : null;
      const tableRef = data.tableId ? row(data.workspace, 'tables', data.tableId) : null;
      const [settingsSnap, seqSnap, customerSnap, tableSnap] = await Promise.all([
        tx.get(settingsRef), tx.get(seqRef), customerRef ? tx.get(customerRef) : null, tableRef ? tx.get(tableRef) : null
      ]);
      const settings = settingsSnap.data(), sequence = seqSnap.data(), customer = customerSnap?.data(), table = tableSnap?.data();
      if (!settings || !sequence) fail('failed-precondition', 'Workspace setup is incomplete.');
      if (customerRef && (!customer || customer.archived)) fail('not-found', 'Customer not found.');
      if (customer && (customer.financialSchema !== 2 || !account || account.status !== 'ready')) fail('failed-precondition', 'This customer requires financial migration.');
      if (tableRef && (!table?.activeOrder || revision(table.activeOrder) !== data.tableRevision)) fail('failed-precondition', 'The table order changed.');
      if (percent && settings.allowCashierDiscounts !== true) fail('permission-denied', 'Cashier discounts are disabled.');
      const snapshots = await Promise.all(requested.map(item => tx.get(row(data.workspace, 'products', item.productId))));
      let subtotal = 0;
      const items = requested.map((item, index) => {
        const product = snapshots[index].data();
        if (!product || product.active === false || product.archived === true) fail('failed-precondition', 'A catalog product is unavailable.');
        const options = product.hasSizes ? (product.sizes ?? []).filter(size => size.name === item.variant) : [];
        if (product.hasSizes ? options.length !== 1 : item.variant !== null) fail('invalid-argument', 'Select a valid catalog variant.');
        let price = cents(product.hasSizes ? options[0].price : product.price);
        for (const name of item.addons) {
          const matches = product.hasAddons === false ? [] : (product.addons ?? []).filter(addon => addon.name === name);
          if (matches.length !== 1) fail('invalid-argument', 'Select valid catalog add-ons.');
          price += cents(matches[0].price);
        }
        const total = price * item.quantity;
        subtotal += total;
        if (!Number.isSafeInteger(subtotal) || subtotal > 1e11) fail('invalid-argument', 'Bill exceeds the permitted amount.');
        return { id: item.productId, name: text(product.name, 100), category: text(product.category, 50), variant: item.variant, addons: item.addons, note: item.note, price: price / 100, quantity: item.quantity, total: total / 100 };
      });
      const discount = Math.round(subtotal * Math.round(percent * 100) / 10000);
      const total = subtotal - discount;
      // This client assertion is a stale-screen guard only; it never supplies a price.
      if (data.expectedTotal != null && cents(data.expectedTotal) !== total) fail('failed-precondition', 'Catalog prices changed. Refresh the bill before taking payment.');
      if (!['Cash', 'UPI', 'Card', 'Account', 'Credit', 'Split'].includes(data.paymentMethod)) fail('invalid-argument', 'Invalid tender.');
      let splitBreakdown = null;
      if (data.paymentMethod === 'Split') {
        object(data.splitBreakdown, ['cash', 'upi']);
        if (cents(data.splitBreakdown.cash) + cents(data.splitBreakdown.upi) !== total) fail('invalid-argument', 'Split tender must equal the bill.');
        splitBreakdown = data.splitBreakdown;
      } else if (data.paymentMethod === 'Cash' ? received < total : received !== total) fail('invalid-argument', 'Tender does not cover the current bill.');
      const credit = ['Account', 'Credit'].includes(data.paymentMethod);
      if (credit && !customer) fail('failed-precondition', 'Choose a customer account.');
      const oldDue = customer ? cents(customer.dueBalance ?? 0, true) : 0;
      const due = oldDue + (credit ? total : 0);
      if (credit && account.creditLimit > 0 && due > cents(account.creditLimit)) fail('failed-precondition', 'The bill exceeds the current credit limit.');
      const number = Math.max(sequence.next, settings.startingNumber);
      if (!Number.isSafeInteger(number) || number >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(sequence.count)) fail('failed-precondition', 'Invoice sequence is invalid.');
      const applyRate = await throttle(tx, operator.uid, 'checkout');
      const now = new Date().toISOString();
      const merchant = Object.fromEntries(['brandName', 'streetAddress', 'city', 'state', 'pincode', 'phone', 'receiptFooterMessage', 'termsAndConditions', 'license'].map(key => [key, text(settings[key], key === 'termsAndConditions' ? 1000 : 300)]));
      const saved = { id: data.idempotencyKey, requestHash: hash, invoiceSequence: number, invoiceNo: text(settings.invoicePrefix, 40) + number, tokenNo: sequence.count % 99 + 101,
        createdAt: now, displayDate: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(now)),
        channel: data.channel, tableId: data.tableId ?? null, table: table?.name ?? '', customerId: data.customerId ?? null, customerName: customer?.name ?? 'Walk-in Guest', customerPhone: customer?.phone ?? '',
        items, itemsCount: items.reduce((sum, item) => sum + item.quantity, 0), itemsSummary: items.map(item => `${item.quantity}x ${item.name}`).join(', '),
        subtotal: subtotal / 100, discount: discount / 100, total: total / 100, discountPercent: percent, fixedDiscount: 0, merchant,
        paymentMethod: data.paymentMethod, amountReceived: received / 100, splitBreakdown, referenceNo, status: 'Completed', cashierUid: operator.uid, cashierName: operator.name || operator.email };
      applyRate();
      tx.create(orderRef, saved);
      tx.update(seqRef, { next: number + 1, count: sequence.count + 1, lastOrderId: saved.id });
      if (customer) {
        const count = (customer.ordersCount ?? 0) + 1;
        const spent = cents(customer.totalSpent ?? 0) + total;
        tx.update(customerRef, { ordersCount: count, totalSpent: spent / 100, avgOrderValue: Math.round(spent / count / 10) / 10, dueBalance: due / 100 });
        if (credit) tx.create(accountRef.collection('ledger').doc(`charge-${saved.id}`), { id: `charge-${saved.id}`, type: 'charge', date: now, amount: total / 100, orderId: saved.id, invoiceNo: saved.invoiceNo, items, method: 'Account', balanceBefore: oldDue / 100, balanceAfter: due / 100, recordedBy: operator.uid });
      }
      if (tableRef) tx.update(tableRef, { activeOrder: null, currentOrderTotal: 0, reserved: false, status: 'Available' });
      return saved;
    });
  }
  async function initializeWorkspace(request) {
    object(request.data, []);
    const workspace = randomUUID();
    return db.runTransaction(async tx => {
      const operator = await access(tx, request, null, ['owner']);
      if (operator.workspace) return { workspace: operator.workspace };
      tx.create(row(workspace, 'config', 'settings'), { ...initialSettings });
      tx.create(row(workspace, 'config', 'invoiceSequence'), { next: 1001, count: 0 });
      tx.create(row(workspace, 'config', 'financialMigration'), { status: 'ready', schemaVersion: 2 });
      tx.set(current, { workspace });
      tx.set(db.doc('posConfig/branding'), { brandName: initialSettings.brandName });
      return { workspace };
    });
  }
  async function saveCustomer(request) {
    const data = request.data;
    object(data, ['workspace', 'customer']);
    object(data.customer, ['id', 'name', 'phone', 'email', 'notes', 'creditLimit', 'openingDue']);
    const input = data.customer;
    if (!id(input.id)) fail('invalid-argument', 'Invalid customer ID.');
    const fields = { id: input.id, name: text(input.name, 100), phone: text(input.phone, 30), email: text(input.email, 120), notes: text(input.notes, 500) };
    if (!fields.name || !/^[+][0-9]{8,15}$/.test(fields.phone)) fail('invalid-argument', 'Enter a valid customer name and phone.');
    return db.runTransaction(async tx => {
      const operator = await access(tx, request, data.workspace, ['owner', 'staff']);
      const ref = row(data.workspace, 'customers', input.id), accountRef = row(data.workspace, 'customerAccounts', input.id);
      const old = (await tx.get(ref)).data(), account = (await tx.get(accountRef)).data();
      const limit = cents(input.creditLimit ?? account?.creditLimit ?? 0), opening = cents(input.openingDue ?? 0);
      if (operator.role !== 'owner' && (old || limit || opening)) fail('permission-denied', 'Only the owner can administer customer accounts.');
      if (old && (old.financialSchema !== 2 || !account || account.status !== 'ready')) fail('failed-precondition', 'Migrate this account first.');
      const key = row(data.workspace, 'identity', `customers-phone-${encodeURIComponent(fields.phone)}`);
      const previousKey = old ? row(data.workspace, 'identity', `customers-phone-${encodeURIComponent(old.phone)}`) : null;
      const identity = (await tx.get(key)).data();
      if (identity && identity.id !== input.id) fail('already-exists', 'A customer already uses this phone.');
      const applyRate = await throttle(tx, operator.uid, 'customer');
      const summary = { ...fields, financialSchema: 2, archived: false, ordersCount: old?.ordersCount ?? 0, totalSpent: old?.totalSpent ?? 0, avgOrderValue: old?.avgOrderValue ?? 0, dueBalance: old?.dueBalance ?? opening / 100 };
      applyRate();
      tx.set(ref, summary);
      tx.set(key, { id: input.id });
      if (previousKey && previousKey.path !== key.path) tx.delete(previousKey);
      if (!old) {
        tx.create(accountRef, { creditLimit: limit / 100, status: 'ready', historyComplete: true, createdBy: operator.uid });
        if (opening) tx.create(accountRef.collection('ledger').doc('opening'), { id: 'opening', type: 'opening', date: new Date().toISOString(), amount: opening / 100, balanceBefore: 0, balanceAfter: opening / 100, recordedBy: operator.uid });
      } else tx.update(accountRef, { creditLimit: limit / 100 });
      return summary;
    });
  }
  async function archiveCustomer(request) {
    object(request.data, ['workspace', 'customerId']);
    if (!id(request.data.customerId)) fail('invalid-argument', 'Invalid customer ID.');
    return db.runTransaction(async tx => {
      await access(tx, request, request.data.workspace, ['owner']);
      const ref = row(request.data.workspace, 'customers', request.data.customerId);
      const customer = (await tx.get(ref)).data();
      if (!customer || cents(customer.dueBalance, true) !== 0) fail('failed-precondition', 'Settle the customer balance before archiving.');
      tx.update(ref, { archived: true });
      return { archived: true };
    });
  }
  return { checkout, initializeWorkspace, saveCustomer, archiveCustomer };
}
