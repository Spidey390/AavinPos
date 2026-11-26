export function normalizePhone(value = '') {
  const input = value.trim();
  if (/[^\d+().\s-]/.test(input)) return '';
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10 && !input.startsWith('+')) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (input.startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  return '';
}

export function canBillToAccount(customer, amount) {
  if (!customer) {
    return { allowed: false, reason: 'Select a customer account first.' };
  }
  const currentDue = Number(customer.dueBalance) || 0;
  const billAmount = Number(amount) || 0;
  const newDue = Number((currentDue + billAmount).toFixed(2));
  const creditLimit = Number(customer.creditLimit) || 0;

  if (creditLimit > 0 && newDue > creditLimit) {
    return {
      allowed: false,
      reason: `Exceeds credit limit of ₹${creditLimit.toFixed(2)}. Current due: ₹${currentDue.toFixed(2)}, new total: ₹${newDue.toFixed(2)}.`,
      currentDue,
      newDue,
      creditLimit
    };
  }

  return {
    allowed: true,
    currentDue,
    newDue,
    creditLimit
  };
}

export function formatAccountStatement(customer, isOwner = false) {
  if (!customer) return '';
  const due = (Number(customer.dueBalance) || 0).toFixed(2);
  const limit = customer.creditLimit ? `₹${Number(customer.creditLimit).toFixed(2)}` : 'No limit';
  const recent = Array.isArray(customer.accountTransactions)
    ? customer.accountTransactions.slice(-5).reverse()
    : [];

  let text = `*Aavin POS - Customer Account Summary*\n`;
  text += `Customer: ${customer.name}\n`;
  text += `Mobile: ${customer.phone}\n`;
  text += `Outstanding Balance: ₹${due}\n`;
  text += `Credit Limit: ${limit}\n`;

  if (recent.length > 0) {
    text += `\n*Recent Transactions:*\n`;
    for (const tx of recent) {
      const d = tx.date ? tx.date.slice(0, 10) : '';
      const sign = tx.type === 'charge' ? '+' : '-';
      const typeLabel = tx.type === 'charge' ? 'Bill' : 'Payment';
      text += `• ${d}: ${typeLabel} ${sign}₹${Number(tx.amount || 0).toFixed(2)} (${tx.referenceNo || tx.method || 'Account'})\n`;
      if (isOwner && Array.isArray(tx.items) && tx.items.length > 0) {
        for (const item of tx.items) {
          text += `    └ ${item.name} × ${item.quantity} (₹${Number(item.subtotal || item.price * item.quantity).toFixed(2)})\n`;
        }
      }
    }
  }

  text += `\nThank you for choosing Aavin!`;
  return text;
}

