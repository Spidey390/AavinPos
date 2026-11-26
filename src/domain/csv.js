import { newId } from './ids.js';
import { sanitizeText } from './sanitize.js';
import { isMoney } from './billing.js';

export const MAX_MENU_CSV_SIZE = 2 * 1024 * 1024;

export function escapeCsv(value) {
  let text = String(value ?? '');
  // Spreadsheet applications interpret these prefixes as executable formulas.
  // eslint-disable-next-line no-control-regex -- Ignore leading control bytes before formula detection.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return /[,"\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || !field.trim()) quoted = !quoted;
      else return [];
    } else if (!quoted && (character === ',' || character === '\n' || character === '\r')) {
      row.push(field.trim()); field = '';
      if (character !== ',') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (character === '\r' && text[i + 1] === '\n') i++;
        if (rows.length > 5001) return [];
      }
    } else field += character;
  }
  if (quoted) return [];
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows.length <= 5001 ? rows : [];
}

export function parseMenuCsv(csvText) {
  if (!csvText || typeof csvText !== 'string' || csvText.length > MAX_MENU_CSV_SIZE) return [];
  const rows = csvRows(csvText.replace(/^\uFEFF/, ''));
  if (!rows.length) return [];
  const hasHeader = rows[0][0]?.toLowerCase() === 'category' &&
    ['item', 'name'].includes(rows[0][1]?.toLowerCase());
  const dataLines = hasHeader ? rows.slice(1) : rows;
  if (dataLines.length > 5000) return [];

  const products = [];
  for (let i = 0; i < dataLines.length; i++) {
    const parts = dataLines[i];
    if (parts.length < 3) continue;

    const category = sanitizeText(parts[0], 50);
    const name = sanitizeText(parts[1], 100);
    const price = parts[2] ? Number(parts[2]) : NaN;
    const costPrice = parts[3] ? Number(parts[3]) : 0;
    const dietaryRaw = parts[4] || 'Pure Veg';
    const dietary = ['Non-Veg', 'Vegan', 'Pure Veg'].includes(dietaryRaw) ? dietaryRaw : 'Pure Veg';

    if (!name || !category || !isMoney(price) || !isMoney(costPrice)) continue;

    products.push({
      id: `prod-${newId()}`,
      name,
      sku: `ITEM-${newId().slice(0, 8).toUpperCase()}`,
      category,
      price,
      costPrice: Number.isFinite(costPrice) && costPrice >= 0 ? costPrice : 0,
      dietary,
      hasSizes: false,
      sizes: [],
      hasAddons: false,
      addons: []
    });
  }
  return products;
}
