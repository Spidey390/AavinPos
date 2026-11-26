export const roundMoney = value => Number(value.toFixed(2));
export const isMoney = value => Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 && roundMoney(value) === value;

export function validateCheckoutOrder(order, settings) {
  if (!Array.isArray(order.items) || !order.items.length || order.items.length > 500 ||
      order.items.some(item => !item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 ||
        !isMoney(item.price) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        !isMoney(roundMoney(item.price * item.quantity)))) return 'The bill contains invalid items or prices.';
  if (!Number.isFinite(order.discountPercent) || order.discountPercent < 0 || order.discountPercent > 100 ||
      !isMoney(order.fixedDiscount)) return 'The bill discount is invalid.';
  if (!settings.allowCashierDiscounts && (order.discountPercent || order.fixedDiscount || order.discount)) {
    return 'Cashier discounts were disabled. Clear the discount before settling.';
  }
  const bill = calculateBill(order.items, order.discountPercent, order.fixedDiscount);
  if (Object.entries(bill).some(([key, value]) => !isMoney(value) || order[key] !== value)) {
    return 'The bill totals changed. Review the current items before settling.';
  }
  if (!isMoney(order.amountReceived)) return 'The amount received is invalid.';
  return validateTender(order.paymentMethod, bill.total, order.amountReceived, order.splitBreakdown);
}

export function calculateBill(items, discountPercent = 0, fixedDiscount = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const subtotalPaise = Math.round(roundMoney(subtotal) * 100);
  const rateBasisPoints = Math.round(discountPercent * 100);
  const requestedPaise = fixedDiscount > 0
    ? Math.round(fixedDiscount * 100)
    : Math.round(subtotalPaise * rateBasisPoints / 10_000);
  const discountPaise = Math.max(0, Math.min(subtotalPaise, requestedPaise));
  return {
    subtotal: subtotalPaise / 100,
    discount: discountPaise / 100,
    total: Math.max(0, subtotalPaise - discountPaise) / 100
  };
}

export function validateTender(method, total, received, split) {
  const toPaise = amount => Number.isFinite(amount) && amount >= 0 && roundMoney(amount) === amount
    ? Math.round(amount * 100)
    : NaN;
  const due = toPaise(total);
  if (!Number.isSafeInteger(due)) return 'The payable total is invalid.';
  if (method === 'Cash') {
    const cash = toPaise(received);
    if (!Number.isSafeInteger(cash) || cash < due) {
      return 'Enter cash received at least equal to the total, with up to two decimal places.';
    }
  } else if (method === 'Split') {
    const cash = toPaise(split?.cash);
    const upi = toPaise(split?.upi);
    if (!Number.isSafeInteger(cash) || !Number.isSafeInteger(upi) || cash + upi !== due) {
      return 'Cash and UPI must be nonnegative and add up to the total.';
    }
  } else if (method === 'Account' || method === 'Credit') {
    return '';
  } else if (method !== 'UPI' && method !== 'Card') {
    return 'Choose a valid payment method.';
  }
  return '';
}
