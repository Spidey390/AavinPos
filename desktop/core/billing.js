// Local estimates are provisional. checkout recomputes every price from Firestore.
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new Error('Enter a valid amount with at most two decimal places.');
  return Math.round(value * 100);
}
export function estimate(products, selections) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 100) throw new Error('Choose 1 to 100 products.');
  let total = 0;
  const items = selections.map(selection => {
    if (!selection || Object.keys(selection).some(key => !['productId', 'variant', 'addons', 'quantity', 'note'].includes(key)) || !identifier(selection.productId) || !Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 10000) throw new Error('Invalid product or quantity.');
    const product = products.find(product => product.id === selection.productId);
    if (!product || product.active === false || product.archived) throw new Error('A product is unavailable. Refresh the catalog online.');
    const variant = selection.variant ?? null;
    const options = product.hasSizes ? (product.sizes ?? []).filter(size => size.name === variant) : [];
    if (product.hasSizes ? options.length !== 1 : variant !== null) throw new Error('Select a valid size.');
    let price = money(product.hasSizes ? options[0].price : product.price);
    const addons = selection.addons ?? [];
    if (!Array.isArray(addons) || addons.length > 25 || new Set(addons).size !== addons.length) throw new Error('Invalid add-ons.');
    for (const name of addons) {
      const matches = product.hasAddons === false ? [] : (product.addons ?? []).filter(addon => addon.name === name);
      if (matches.length !== 1) throw new Error('Select valid add-ons.');
      price += money(matches[0].price);
    }
    if (typeof (selection.note ?? '') !== 'string' || (selection.note ?? '').length > 300) throw new Error('Notes may contain up to 300 characters.');
    total += price * selection.quantity;
    if (!Number.isSafeInteger(total) || total > 1e11) throw new Error('Bill exceeds the permitted amount.');
    return { ...selection, variant, addons, note: selection.note ?? '', name: product.name, price: price / 100, total: price * selection.quantity / 100 };
  });
  return { items, total: total / 100 };
}
export function validateSale(input) {
  if (!input || Object.keys(input).some(key => !['id', 'items', 'amountReceived', 'channel'].includes(key)) || !identifier(input.id) || !['Counter', 'Takeaway'].includes(input.channel)) throw new Error('Only walk-in cash sales are available in the desktop counter.');
}
