import { callFinancial, callFinancialOnce } from '../services/functions';
import {
  collection, doc, getDocFromServer, getDocsFromServer, onSnapshot,
  runTransaction, writeBatch, query, where, orderBy, limit, startAfter
} from 'firebase/firestore';
import { firestore } from '../services/firebase';
import { brandingRef } from '../services/branding';
import { newId } from '../domain/ids';
import { canBillToAccount, normalizePhone } from '../domain/customers';
import { isMoney, validateCheckoutOrder } from '../domain/billing';
import { sanitizeText } from '../domain/sanitize';
import { mergeSavedAddons } from '../domain/addons';
import { mergeSavedCategories } from '../domain/categories';
import { stores, validateBackup } from './backup';
import {
  initialSettings, initialTables, initialProducts,
  initialCustomers, initialOrders, initialSuppliers, initialPurchases,
  initialExpenses, initialStaff, initialAuditLogs
} from '../data/initialData';

const seed = {
  settings: initialSettings, tables: initialTables, products: initialProducts,
  rawMaterials: [], customers: initialCustomers, orders: initialOrders,
  suppliers: initialSuppliers, purchases: initialPurchases, expenses: initialExpenses,
  staff: initialStaff.map(({ pin, ...row }) => row), auditLogs: initialAuditLogs
};

export const workspaceRef = doc(firestore, 'posConfig', 'current');
const store = (workspace, name) => collection(firestore, 'posWorkspaces', workspace, name);
const row = (workspace, name, id) => doc(store(workspace, name), id);
const config = workspace => row(workspace, 'config', 'settings');
const sequence = workspace => row(workspace, 'config', 'invoiceSequence');

export function watchConfig(workspace, next, error) {
  return onSnapshot(config(workspace), { includeMetadataChanges: true }, snapshot => {
    if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
    if (!snapshot.exists()) {
      error(new Error('The active workspace has no settings.'));
      return;
    }
    next({ ...initialSettings, ...snapshot.data() });
  }, error);
}

export function watchRows(workspace, name, next, error, recordedBy, publicOnly = false) {
  const records = store(workspace, name);
  const source = recordedBy ? query(records, where('recordedBy', '==', recordedBy)) : publicOnly ? query(records, where('financialSchema', '==', 2)) : records;
  return onSnapshot(source, { includeMetadataChanges: true }, snapshot => {
    if (!snapshot.metadata.hasPendingWrites && !snapshot.metadata.fromCache) next(snapshot.docs.map(item => ({ ...item.data(), id: item.id })).filter(item => !item.archived));
  }, error);
}

const idKey = value => encodeURIComponent(value.trim().toLowerCase());
const identityFor = {
  products: record => [['sku', record?.sku]],
  customers: record => [['phone', record && normalizePhone(record.phone)]]
};

function identityRefs(workspace, name, record) {
  return (identityFor[name]?.(record) ?? [])
    .filter(([, value]) => value)
    .map(([field, value]) => row(workspace, 'identity', `${name}-${field}-${idKey(value)}`));
}

function sequenceFor(data) {
  const imported = (data.sequences ?? []).map(entry => entry.next);
  const invoices = data.orders.map(order => Number(order.invoiceNo.match(/\d+$/)?.[0] || 0));
  // Match the configured prefix exactly when it ends in a digit.
  if (/\d$/.test(data.settings.invoicePrefix ?? '')) {
    for (const order of data.orders) {
      if (!order.invoiceNo.startsWith(data.settings.invoicePrefix)) continue;
      const suffix = order.invoiceNo.slice(data.settings.invoicePrefix.length);
      if (/^\d+$/.test(suffix)) invoices.push(Number(suffix));
    }
  }
  const next = invoices.filter(Number.isSafeInteger).reduce((highest, value) => Math.max(highest, value + 1), 1);
  return imported.reduce((highest, value) => Math.max(highest, value), next);
}

function cleanStaff({ pin, ...record }) {
  return record;
}

async function stageWorkspace(workspace, data) {
  const writes = [[config(workspace), { ...initialSettings, ...data.settings, id: 'active_settings' }]];
  writes.push([sequence(workspace), { next: sequenceFor(data), count: data.orders.length }]);
  const identities = new Map();

  for (const name of stores) {
    for (const source of data[name]) {
      const record = name === 'staff' ? cleanStaff(source) : source;
      writes.push([row(workspace, name, record.id), record]);
      for (const key of identityRefs(workspace, name, record)) {
        const current = identities.get(key.path);
        identities.set(key.path, [key, { id: current ? '__duplicate__' : record.id }]);
      }
    }
  }
  writes.push(...identities.values());
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = writeBatch(firestore);
    for (const [ref, value] of writes.slice(offset, offset + 400)) batch.set(ref, value);
    await batch.commit();
  }
}

export const initializeWorkspace = () => callFinancial('initializeWorkspace', {});

export async function exportDatabaseJSON(workspace) {
  // Keep exports scoped to a single workspace even if it is switched during the read.
  const before = await getDocFromServer(workspaceRef);
  if (before.data()?.workspace !== workspace) throw new Error('Workspace changed. Reopen settings and retry.');
  async function readAll() {
    const [results, settings, next] = await Promise.all([
      Promise.all(stores.map(async name => {
        const snapshot = await getDocsFromServer(store(workspace, name));
        return [name, snapshot.docs.map(item => item.data())];
      })),
      getDocFromServer(config(workspace)), getDocFromServer(sequence(workspace))
    ]);
    const accounts = await getDocsFromServer(store(workspace, 'customerAccounts'));
    const financialRecords = await Promise.all(accounts.docs.map(async account => {
      const [ledger, payments] = await Promise.all(['ledger', 'payments'].map(name => getDocsFromServer(collection(account.ref, name))));
      return { id: account.id, account: account.data(), ledger: ledger.docs.map(item => item.data()), payments: payments.docs.map(item => item.data()) };
    }));
    const proofs = await getDocsFromServer(store(workspace, 'financialInvoices'));
    const financialInvoices = await Promise.all(proofs.docs.map(async invoice => {
      const [payments, refunds] = await Promise.all(['payments', 'refunds'].map(name => getDocsFromServer(collection(invoice.ref, name))));
      return { id: invoice.id, invoice: invoice.data(), payments: payments.docs.map(item => item.data()), refunds: refunds.docs.map(item => item.data()) };
    }));
    const operations = await getDocsFromServer(store(workspace, 'financialOperations'));
    return { rows: Object.fromEntries(results), financialRecords, financialInvoices, financialOperations: operations.docs.map(item => ({ ...item.data(), id: item.id })), settings: settings.data(), next: next.data()?.next ?? 1 };
  }
  const snapshot = await readAll();
  const confirmation = await readAll();
  const after = await getDocFromServer(workspaceRef);
  if (after.data()?.workspace !== workspace || JSON.stringify(snapshot) !== JSON.stringify(confirmation)) {
    throw new Error('Records changed during export. Pause edits briefly and retry.');
  }
  return {
    database: 'BrewBitePOS_DB_v2', version: 2, financialRecords: snapshot.financialRecords, financialInvoices: snapshot.financialInvoices, financialOperations: snapshot.financialOperations, exportedAt: new Date().toISOString(),
    settings: snapshot.settings, ...snapshot.rows,
    sequences: [{ id: 'cloud', next: snapshot.next }]
  };
}

async function replaceWorkspace(workspace, data) {
  const replacement = newId();
  await stageWorkspace(replacement, data);
  await runTransaction(firestore, async transaction => {
    const active = await transaction.get(workspaceRef);
    const oldSequence = await transaction.get(sequence(workspace));
    const newSequence = await transaction.get(sequence(replacement));
    if (active.data()?.workspace !== workspace) throw new Error('Workspace changed during restore. Retry.');
    transaction.update(sequence(replacement), {
      next: Math.max(oldSequence.data()?.next ?? 1, newSequence.data().next)
    });
    transaction.set(workspaceRef, { workspace: replacement });
    transaction.set(brandingRef, { brandName: data.settings.brandName ?? initialSettings.brandName });
  });
}

export const importDatabaseJSON = async () => { throw new Error('Financial backups must be restored with the trusted administrator workflow.'); };
export const resetDatabaseToCleanProduction = async () => { throw new Error('Use an administrator-managed workspace reset to preserve financial history.'); };

export const draftRevision = draft => draft?.revision ?? draft?.updatedAt ?? null;

export function saveTableDraft(workspace, tableId, expectedRevision, draft) {
  const ref = row(workspace, 'tables', tableId);
  return runTransaction(firestore, async transaction => {
    const table = (await transaction.get(ref)).data();
    if (!table || draftRevision(table.activeOrder) !== expectedRevision) {
      throw new Error('This table changed in another window. Review the current order and try again.');
    }
    transaction.update(ref, {
      reserved: false,
      status: draft?.items.length ? 'Occupied' : 'Available',
      currentOrderTotal: draft?.total ?? 0,
      activeOrder: draft
    });
  });
}

export function deleteTable(workspace, id) {
  const ref = row(workspace, 'tables', id);
  return runTransaction(firestore, async transaction => {
    const table = (await transaction.get(ref)).data();
    if (table?.activeOrder?.items.length) throw new Error('Clear or settle this table’s order first.');
    transaction.delete(ref);
  });
}

export function createTable(workspace, fields) {
  const table = { ...fields, id: newId() };
  const ref = row(workspace, 'tables', table.id);
  return runTransaction(firestore, async transaction => {
    const current = await transaction.get(ref);
    if (current.exists()) throw new Error('Could not create the table. Try again.');
    transaction.set(ref, table);
  });
}

export function syncPublicBrand(workspace) {
  return runTransaction(firestore, async transaction => {
    const active = await transaction.get(workspaceRef);
    if (active.data()?.workspace !== workspace) return;
    const settings = await transaction.get(config(workspace));
    const branding = await transaction.get(brandingRef);
    const brandName = settings.data()?.brandName;
    if (typeof brandName === 'string' && branding.data()?.brandName !== brandName) {
      transaction.set(brandingRef, { brandName });
    }
  });
}

export function updateSettings(workspace, changes) {
  const ref = config(workspace);
  return runTransaction(firestore, async transaction => {
    if (!Object.hasOwn(changes, 'brandName')) {
      await transaction.get(ref);
      transaction.update(ref, changes);
      return;
    }

    const active = await transaction.get(workspaceRef);
    if (active.data()?.workspace !== workspace) {
      throw new Error('Workspace changed. Review settings and try again.');
    }
    const brandName = changes.brandName.trim();
    transaction.update(ref, { ...changes, brandName });
    transaction.set(brandingRef, { brandName });
  });
}

export function createExpense(workspace, expense) {
  if (!isMoney(expense.amount) || expense.amount <= 0) {
    throw new Error('Enter a positive expense amount with up to two decimal places.');
  }
  return runTransaction(firestore, async transaction => {
    transaction.set(row(workspace, 'expenses', expense.id), expense);
  });
}

export function deleteRecord(workspace, name, id) {
  const ref = row(workspace, name, id);
  return runTransaction(firestore, async transaction => {
    await transaction.get(ref);
    transaction.delete(ref);
  });
}

export function saveUniqueRecord(workspace, name, record) {
  if (name === 'customers') return callFinancial('saveCustomer', { workspace, customer: { id: record.id, name: record.name, phone: record.phone, email: record.email ?? '', notes: record.notes ?? '', ...(record.creditLimit !== undefined ? { creditLimit: record.creditLimit } : {}), openingDue: record.dueBalance ?? 0 } });
  const ref = row(workspace, name, record.id);
  return runTransaction(firestore, async transaction => {
    const old = (await transaction.get(ref)).data();
    const previous = identityRefs(workspace, name, old);
    const keys = identityRefs(workspace, name, record);
    const added = keys.filter(key => !previous.some(item => item.path === key.path));
    const removed = previous.filter(key => !keys.some(item => item.path === key.path));
    const checks = await Promise.all([...added, ...removed].map(key => transaction.get(key)));
    if (checks.slice(0, added.length).some(key => key.exists() && key.data().id !== record.id)) {
      throw new Error(name === 'products' ? 'Another product uses this item code.' : 'A customer already uses this number.');
    }

    const cleanCat = (name === 'products' && typeof record.category === 'string') ? record.category.trim() : '';
    const hasAddonUpdates = (name === 'products' && record.hasAddons && record.addons?.length);
    const settingsRef = (hasAddonUpdates || cleanCat) ? config(workspace) : null;
    const settingsSnap = settingsRef ? await transaction.get(settingsRef) : null;
    const settingsData = settingsSnap?.data();

    const settingsUpdates = {};
    if (hasAddonUpdates) {
      const saved = mergeSavedAddons(settingsData?.commonAddons);
      const merged = mergeSavedAddons(saved, record.addons);
      if (merged.length > saved.length) settingsUpdates.commonAddons = merged;
    }

    if (cleanCat) {
      const saved = mergeSavedCategories(settingsData?.commonCategories || settingsData?.categories);
      const merged = mergeSavedCategories(saved, [cleanCat]);
      if (merged.length > saved.length) {
        settingsUpdates.commonCategories = merged;
        settingsUpdates.categories = merged;
      }
    }

    if (settingsRef && Object.keys(settingsUpdates).length > 0) {
      transaction.update(settingsRef, settingsUpdates);
    }

    const defaults = name === 'customers' ? { ordersCount: 0, totalSpent: 0, avgOrderValue: 0, dueBalance: 0, creditLimit: 0, accountTransactions: [] } : {};
    // Profile edits must not replay stale financial balances over a live sale.
    const fields = { ...record };
    if (name === 'customers' && old) {
      for (const field of ['ordersCount', 'totalSpent', 'avgOrderValue', 'dueBalance', 'accountTransactions', 'lastPaymentAt', 'lastPaymentAmount']) {
        fields[field] = old[field] ?? defaults[field];
      }
    }
    transaction.set(ref, { ...defaults, ...old, ...fields });
    added.forEach(key => transaction.set(key, { id: record.id }));
    removed.forEach((key, index) => {
      if (checks[added.length + index].data()?.id === record.id) transaction.delete(key);
    });
  });
}

export function deleteUniqueRecord(workspace, name, id) {
  if (name === 'customers') return callFinancial('archiveCustomer', { workspace, customerId: id });
  const ref = row(workspace, name, id);
  return runTransaction(firestore, async transaction => {
    const old = (await transaction.get(ref)).data();
    const keys = identityRefs(workspace, name, old);
    const checks = await Promise.all(keys.map(key => transaction.get(key)));
    keys.forEach((key, index) => {
      if (checks[index].data()?.id === id) transaction.delete(key);
    });
    transaction.delete(ref);
  });
}

export async function importProductsBatch(workspace, productList) {
  if (!Array.isArray(productList) || !productList.length) return;

  const newCategories = productList.map(p => p.category).filter(Boolean);
  const settingsRef = config(workspace);
  const settingsSnap = await getDocFromServer(settingsRef);
  const settingsData = settingsSnap.data();
  const mergedCategories = mergeSavedCategories(
    settingsData?.commonCategories || settingsData?.categories,
    newCategories
  );

  await updateSettings(workspace, {
    commonCategories: mergedCategories,
    categories: mergedCategories
  });

  const ops = [];
  for (const product of productList) {
    const prodRef = row(workspace, 'products', product.id);
    ops.push([prodRef, product]);
    for (const key of identityRefs(workspace, 'products', product)) {
      ops.push([key, { id: product.id }]);
    }
  }

  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(firestore);
    for (const [ref, data] of ops.slice(i, i + 400)) {
      batch.set(ref, data);
    }
    await batch.commit();
  }
}

export function executeOrderTransaction(workspace, { order, tableRevision, customerId }) {
  return callFinancial('checkout', {
    workspace, idempotencyKey: order.id, customerId: customerId ?? null,
    tableId: order.tableId ?? null, tableRevision: tableRevision ?? null, channel: order.channel,
    items: order.items.map(item => ({ productId: item.id, variant: item.variant ?? null, addons: item.addons ?? [], quantity: item.quantity, note: item.note ?? '' })),
    discountPercent: order.discountPercent ?? 0, paymentMethod: order.paymentMethod,
    amountReceived: order.amountReceived, splitBreakdown: order.splitBreakdown ?? null,
    referenceNo: order.referenceNo ?? '', expectedTotal: order.total
  });
}

export function recordCustomerAccountPayment(workspace, customerId, payment) {
  return callFinancialOnce('recordPayment', { workspace, customerId, amount: payment.amount, method: payment.method ?? 'Cash', referenceNo: payment.referenceNo ?? '', notes: payment.notes ?? '' });
}

export const refundOrder = (workspace, order, refund) => callFinancialOnce('refund', { workspace, orderId: order.id, reason: refund.reason });


export async function loadCustomerLedger(workspace, customerId, cursor = null) {
  const ledger = collection(firestore, 'posWorkspaces', workspace, 'customerAccounts', customerId, 'ledger');
  const ordered = query(ledger, orderBy('date', 'desc'), limit(101), ...(cursor ? [startAfter(cursor)] : []));
  const page = await getDocsFromServer(ordered);
  return { rows: page.docs.slice(0, 100).map(item => ({ ...item.data(), id: item.id })), cursor: page.docs[99] ?? null, hasMore: page.size > 100 };
}
