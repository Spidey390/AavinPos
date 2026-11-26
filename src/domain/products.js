/**
 * Product search and filtering domain logic.
 */

export function getProductPrices(product) {
  if (!product) return [];
  const prices = [];
  if (typeof product.price === 'number' && Number.isFinite(product.price)) {
    prices.push(product.price);
  }
  if (Array.isArray(product.sizes)) {
    for (const size of product.sizes) {
      if (typeof size?.price === 'number' && Number.isFinite(size.price)) {
        prices.push(size.price);
      }
    }
  }
  return prices;
}

export function matchesPriceExpression(prices, rawExpression) {
  if (!Array.isArray(prices) || prices.length === 0 || !rawExpression) return false;

  let expr = String(rawExpression).trim();
  if (!expr) return false;

  // Strip explicit 'price:' or 'p:' prefix
  expr = expr.replace(/^(?:price|p)\s*[:=]?\s*/i, '');

  // Strip currency prefixes and suffixes (₹, Rs, Rs., INR)
  expr = expr
    .replace(/^(?:₹|rs\.?|inr)\s*/i, '')
    .replace(/\s*(?:₹|rs\.?|inr)$/i, '')
    .trim();

  // Natural language conversions
  expr = expr
    .replace(/\b(?:under|below|less than)\b/i, '<')
    .replace(/\b(?:above|over|more than)\b/i, '>')
    .replace(/\bbetween\s+(\d+(?:\.\d+)?)\s+(?:and|to)\s+(\d+(?:\.\d+)?)\b/i, '$1-$2')
    .trim();

  // 1. Range match: "20-50", "20 to 50"
  const rangeMatch = expr.match(/^(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)$/i);
  if (rangeMatch) {
    const a = parseFloat(rangeMatch[1]);
    const b = parseFloat(rangeMatch[2]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      return prices.some(p => p >= min && p <= max);
    }
  }

  // 2. Comparison operator match: "<50", "<= 50", "> 100", ">= 100", "= 25"
  const compMatch = expr.match(/^(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)$/);
  if (compMatch) {
    const op = compMatch[1];
    const val = parseFloat(compMatch[2]);
    if (!Number.isNaN(val)) {
      if (op === '<=') return prices.some(p => p <= val);
      if (op === '>=') return prices.some(p => p >= val);
      if (op === '<') return prices.some(p => p < val);
      if (op === '>') return prices.some(p => p > val);
      if (op === '=') return prices.some(p => Math.abs(p - val) < 0.001);
    }
  }

  // 3. Exact or partial numeric match: "25", "25.5", "25.00"
  const numericMatch = expr.match(/^(\d+(?:\.\d+)?)$/);
  if (numericMatch) {
    const val = parseFloat(numericMatch[1]);
    if (!Number.isNaN(val)) {
      if (prices.some(p => Math.abs(p - val) < 0.001)) {
        return true;
      }
    }
    // Substring match on price string representation (e.g. searching '25' matches 25, 250, 125, 25.50)
    return prices.some(p => String(p).includes(expr) || p.toFixed(2).includes(expr));
  }

  return false;
}

export function matchesProductSearch(product, searchQuery) {
  if (!product) return false;
  if (!searchQuery) return true;

  const trimmed = String(searchQuery).trim();
  if (!trimmed) return true;

  const prices = getProductPrices(product);

  // Check if the query itself is a dedicated price expression (e.g. "price: 25", "< 50", "20-50", "₹25")
  const isExplicitPrice = /^(?:price|p)\s*[:=]?/i.test(trimmed) ||
    /^(?:₹|rs\.?|inr)/i.test(trimmed) ||
    /^(?:<=|>=|<|>|=)/.test(trimmed) ||
    /^(?:under|below|less than|above|over|more than|between)\b/i.test(trimmed) ||
    /^\d+(?:\.\d+)?\s*(?:-|to)\s*\d+(?:\.\d+)?$/i.test(trimmed);

  if (isExplicitPrice) {
    return matchesPriceExpression(prices, trimmed);
  }

  // Standard phrase search
  const q = trimmed.toLowerCase();
  const nameMatch = product.name?.toLowerCase().includes(q);
  const skuMatch = Boolean(product.sku && product.sku.toLowerCase().includes(q));
  const categoryMatch = Boolean(product.category && product.category.toLowerCase().includes(q));

  if (nameMatch || skuMatch || categoryMatch) return true;

  // Single term price check (e.g. typing "25" matches price 25)
  if (matchesPriceExpression(prices, trimmed)) return true;

  // Multi-term search (e.g. "milk 25" -> matches products named Milk with price 25)
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const allTokensMatch = tokens.every(token => {
      const t = token.toLowerCase();
      return (
        product.name?.toLowerCase().includes(t) ||
        Boolean(product.sku && product.sku.toLowerCase().includes(t)) ||
        Boolean(product.category && product.category.toLowerCase().includes(t)) ||
        matchesPriceExpression(prices, token)
      );
    });
    if (allTokensMatch) return true;
  }

  return false;
}
