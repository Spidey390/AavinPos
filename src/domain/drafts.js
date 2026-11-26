import { isMoney } from './billing.js';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';

export function parseCounterDrafts(serialized) {
  try {
    const saved = JSON.parse(serialized);
    if (!record(saved)) return {};
    const result = {};
    for (const channel of ['Counter', 'Dine-In', 'Takeaway', 'Delivery']) {
      const draft = saved[channel];
      if (!record(draft) || !text(draft.id) || !Array.isArray(draft.items) || draft.items.length > 500 ||
          draft.items.some(item => !record(item) || !text(item.id) || !text(item.productId) || !text(item.name) ||
            !isMoney(item.price) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
            (item.addons != null && (!Array.isArray(item.addons) || item.addons.some(addon => !text(addon))))) ||
          !Number.isFinite(draft.discountPercent) || draft.discountPercent < 0 || draft.discountPercent > 100 ||
          !isMoney(draft.fixedDiscount) ||
          (draft.customer != null && (!record(draft.customer) || !text(draft.customer.id) ||
            !text(draft.customer.name) || !text(draft.customer.phone)))) continue;
      result[channel] = draft;
    }
    return result;
  } catch { return {}; }
}

export function clearCounterDrafts(storage, uid) {
  const prefix = `brew-bite-counter-drafts:${uid}:`;
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) storage.removeItem(key);
  }
}
