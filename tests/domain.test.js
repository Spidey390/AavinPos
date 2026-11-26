import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBill, validateTender, validateCheckoutOrder } from '../src/domain/billing.js';
import { businessDate, dateRange, inRange } from '../src/domain/dates.js';
import { normalizePhone, canBillToAccount, formatAccountStatement } from '../src/domain/customers.js';
import { canOpen, homeView } from '../src/domain/access.js';
import { isTableOccupied } from '../src/domain/tables.js';
import { stores, validateBackup } from '../src/db/backup.js';
import { sanitizeText, sanitizeNumber } from '../src/domain/sanitize.js';
import { mergeSavedCategories, removeSavedCategory } from '../src/domain/categories.js';
import { mergeSavedAddons, removeSavedAddon } from '../src/domain/addons.js';
import { escapeCsv, MAX_MENU_CSV_SIZE, parseMenuCsv } from '../src/domain/csv.js';
import { matchesProductSearch, getProductPrices, matchesPriceExpression } from '../src/domain/products.js';

test('new bills total menu prices less the rounded discount', () => {
  assert.deepEqual(calculateBill([{ price: 140, quantity: 2 }, { price: 260, quantity: 1 }], 10),
    { subtotal: 540, discount: 54, total: 486 });
  assert.deepEqual(calculateBill([{ price: 19.99, quantity: 2 }], 10),
    { subtotal: 39.98, discount: 4, total: 35.98 });
});

test('custom discounts recalculate in paise and cannot exceed the current subtotal', () => {
  assert.deepEqual(calculateBill([{ price: 310, quantity: 1 }], 12.5),
    { subtotal: 310, discount: 38.75, total: 271.25 });
  assert.deepEqual(calculateBill([{ price: 2.55, quantity: 1 }], 10),
    { subtotal: 2.55, discount: 0.26, total: 2.29 });
  assert.deepEqual(calculateBill([{ price: 180, quantity: 1 }, { price: 130, quantity: 1 }], 0, 42.99),
    { subtotal: 310, discount: 42.99, total: 267.01 });
  assert.deepEqual(calculateBill([{ price: 180, quantity: 1 }], 0, 250),
    { subtotal: 180, discount: 180, total: 0 });
  assert.deepEqual(calculateBill([{ price: 180, quantity: 1 }], 100),
    { subtotal: 180, discount: 180, total: 0 });
});

test('legacy reservations count as available unless they have an active order', () => {
  assert.equal(isTableOccupied({ status: 'Reserved', activeOrder: null }), false);
  assert.equal(isTableOccupied({ status: 'Reserved', activeOrder: { items: [{ quantity: 1 }] } }), true);
  assert.equal(isTableOccupied({ status: 'Occupied' }), true);
});

test('only finite exact cash and split tenders can settle a bill', () => {
  for (const cash of [1, 0, -147, NaN, Infinity, 147.001]) {
    assert.notEqual(validateTender('Cash', 147, cash), '');
  }
  assert.equal(validateTender('Cash', 147, 147), '');
  assert.equal(validateTender('Cash', 147, 200), '');
  assert.notEqual(validateTender('Split', 147, 147, { cash: 999, upi: 0 }), '');
  assert.notEqual(validateTender('Split', 147, 147, { cash: -1, upi: 148 }), '');
  assert.equal(validateTender('Split', 147.01, 147.01, { cash: 100.05, upi: 46.96 }), '');
});

test('checkout rejects tampered totals, invalid lines and discounts disabled after drafting', () => {
  const bill = { items: [{ name: 'Milk', price: 25, quantity: 2 }], subtotal: 50, discount: 0, total: 50,
    discountPercent: 0, fixedDiscount: 0, paymentMethod: 'Cash', amountReceived: 50 };
  assert.equal(validateCheckoutOrder(bill, {}), '');
  for (const changes of [{ subtotal: 1 }, { total: 1 }, { amountReceived: Infinity },
    { items: [{ name: 'Milk', price: -25, quantity: 2 }] },
    { items: [{ name: 'Milk', price: 25, quantity: 0.5 }] },
    { discountPercent: 10, discount: 5, total: 45 }]) {
    assert.notEqual(validateCheckoutOrder({ ...bill, ...changes }, {}), '');
  }
});

test('orders roll over at India midnight and the week starts on Monday', () => {
  assert.equal(businessDate('2026-11-15T18:29:59Z'), '2026-11-15');
  assert.equal(businessDate('2026-11-15T18:30:00Z'), '2026-11-16');
  assert.deepEqual(dateRange('This Week', '2026-11-16'), ['2026-11-16', '2026-11-22']);
  assert.deepEqual(dateRange('Yesterday', '2027-01-01'), ['2026-12-31', '2026-12-31']);
  assert.deepEqual(dateRange('Specific Day', '2026-11-16', { date: '2026-11-10' }), ['2026-11-10', '2026-11-10']);
  assert.deepEqual(dateRange('Specific Day', '2026-11-16'), ['2026-11-16', '2026-11-16']);
  assert.equal(inRange('2026-10-07', dateRange('This Month', '2026-11-16')), false);
});

test('contact lookup recognizes equivalent formats and rejects nonphone input', () => {
  for (const input of ['9000000000', '+91 90000-00000', '919000000000']) {
    assert.equal(normalizePhone(input), '+919000000000');
  }
  assert.equal(normalizePhone('call-me'), '');
});

test('owner and staff routes enforce opposite POS vs administration access', () => {
  assert.equal(canOpen('owner', 'pos'), false);
  assert.equal(canOpen('staff', 'pos'), true);
  assert.equal(canOpen('staff', 'dashboard'), false);
  assert.equal(homeView('staff'), 'pos');
  assert.equal(canOpen('staff', 'settings'), false);
  assert.equal(canOpen('owner', 'settings'), true);
  assert.equal(canOpen('staff', 'customers'), true);
  assert.equal(canOpen('owner', 'customers'), true);
  assert.equal(canOpen('staff', 'tables'), false);
  assert.equal(canOpen('owner', 'tables'), false);
  assert.equal(canOpen('staff', 'expenses'), true);
  assert.equal(canOpen('owner', 'expenses'), true);
  assert.equal(canOpen('owner', 'suppliers'), false);
  assert.equal(canOpen('owner', 'inventory'), false);
});

test('restore rejects incomplete backups before replacing a workspace', () => {
  assert.throws(() => validateBackup({ database: 'BrewBitePOS_DB_v2', version: 1, settings: {}, orders: [] }),
    /invalid or duplicate tables/);
});

test('backup validation accepts current and legacy table records', () => {
  const table = { id: 'table-1', name: 'Table 1', seats: 4, activeOrder: null };
  const legacyTable = { ...table, id: 'table-2', name: 'Table 2', floor: 'Main Dining' };
  const backup = {
    ...Object.fromEntries(stores.map(name => [name, []])),
    database: 'BrewBitePOS_DB_v2', version: 1, settings: {}, tables: [table, legacyTable]
  };
  assert.deepEqual(validateBackup(backup).tables, [table, legacyTable]);
});

test('backup validation preserves orders with and without recorded tax', () => {
  const order = {
    id: 'current', invoiceNo: 'BB-12', channel: 'Takeaway', customerName: 'Walk-in',
    createdAt: '2026-11-16T08:00:00Z', subtotal: 100, total: 100, items: []
  };
  const oldOrder = { ...order, id: 'old', invoiceNo: 'BB-11', cgst: 2.5, sgst: 2.5, total: 105 };
  const backup = {
    ...Object.fromEntries(stores.map(name => [name, []])),
    database: 'BrewBitePOS_DB_v2', version: 1, settings: {}, orders: [order, oldOrder]
  };
  assert.deepEqual(validateBackup(backup).orders, [order, oldOrder]);
});

test('form input sanitization cleans control characters and enforces length bounds', () => {
  assert.equal(sanitizeText('  Cafe \u0000Latte\u202E  ', 20), 'Cafe Latte');
  assert.equal(sanitizeText('A very long product name that exceeds limit', 10), 'A very lon');
  assert.equal(sanitizeNumber('150.50', 0, 1000), 150.5);
  assert.equal(sanitizeNumber('-50', 0, 1000, 0), 0);
  assert.equal(sanitizeNumber('invalid', 0, 100, 10), 10);
});

test('categories are deduplicated case-insensitively and merged without defaults', () => {
  assert.deepEqual(mergeSavedCategories([]), []);
  assert.deepEqual(mergeSavedCategories(['Coffee', 'Tea'], ['coffee', 'Snacks', '  Tea  ']), ['Coffee', 'Tea', 'Snacks']);
  assert.deepEqual(mergeSavedCategories(null, 'Bakery'), ['Bakery']);
});

test('categories and addons can be removed cleanly', () => {
  assert.deepEqual(removeSavedCategory(['Coffee', 'Tea', 'Snacks'], 'tea'), ['Coffee', 'Snacks']);
  assert.deepEqual(removeSavedCategory(['Coffee', 'Tea'], 'Unknown'), ['Coffee', 'Tea']);
  assert.deepEqual(removeSavedAddon([{ name: 'Extra Cheese', price: 30 }, { name: 'Dip', price: 15 }], 'extra cheese'), [{ name: 'Dip', price: 15 }]);
  assert.deepEqual(removeSavedAddon([{ name: 'Dip', price: 15 }], 'Sauce'), [{ name: 'Dip', price: 15 }]);
});

test('menu CSV parser extracts valid products and ignores invalid rows', () => {
  const csv = 'Category,Item,Selling Price,Cost Price,Dietary Type\nBurger,Veg Burger,80,0,Pure Veg\nSnacks,French Fries,70,0,Pure Veg\ninvalid,row\n';
  const parsed = parseMenuCsv(csv);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'Veg Burger');
  assert.equal(parsed[0].category, 'Burger');
  assert.equal(parsed[0].price, 80);
  assert.equal(parsed[1].name, 'French Fries');
});

test('CSV import handles quoted fields and rejects malformed prices and oversized input', () => {
  const parsed = parseMenuCsv('Category,Item,Price,Cost\nDairy,"Milk, ""Premium""",25,10\nDairy,Bad,25xyz,0\nDairy,Bad2,1.001,0');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'Milk, "Premium"');
  assert.equal(parseMenuCsv('Dairy,"unclosed,25').length, 0);
  assert.equal(parseMenuCsv('x'.repeat(MAX_MENU_CSV_SIZE + 1)).length, 0);
  assert.equal(sanitizeNumber('25xyz', 0, 100, 0), 0);
});

test('CSV report cells neutralize formulas, including whitespace-prefixed formulas', () => {
  for (const input of ['=HYPERLINK("https://example.test")', '+1', '-1', '@SUM(A1)', ' \t=1', '\r=1']) {
    assert.ok(escapeCsv(input).replace(/^"/, '').startsWith("'"));
  }
  assert.equal(escapeCsv('Milk, "Premium"'), '"Milk, ""Premium"""');
});

test('product search matches by name, code, SKU, and exact or variant price', () => {
  const milk = { name: 'Aavin Standardized Milk 500ml', sku: 'AAV-001', category: 'Milk', price: 25 };
  const curd = {
    name: 'Aavin Curd', sku: 'AAV-002', category: 'Dairy', price: 15,
    sizes: [{ name: '500g', price: 35 }, { name: '1kg', price: 65 }]
  };
  const ghee = { name: 'Aavin Pure Ghee 1L', sku: 'GHEE-1', category: 'Ghee', price: 650 };

  // Name and SKU searches
  assert.equal(matchesProductSearch(milk, 'milk'), true);
  assert.equal(matchesProductSearch(milk, 'AAV-001'), true);
  assert.equal(matchesProductSearch(milk, 'cheese'), false);

  // Price search: exact numbers
  assert.equal(matchesProductSearch(milk, '25'), true);
  assert.equal(matchesProductSearch(milk, '25.00'), true);
  assert.equal(matchesProductSearch(ghee, '650'), true);
  assert.equal(matchesProductSearch(ghee, '25'), false);

  // Price search: variant sizes
  assert.equal(matchesProductSearch(curd, '15'), true);
  assert.equal(matchesProductSearch(curd, '35'), true);
  assert.equal(matchesProductSearch(curd, '65'), true);
  assert.equal(matchesProductSearch(curd, '100'), false);

  // Price search: with currency symbols
  assert.equal(matchesProductSearch(milk, '₹25'), true);
  assert.equal(matchesProductSearch(milk, 'Rs 25'), true);
  assert.equal(matchesProductSearch(milk, 'Rs. 25'), true);
  assert.equal(matchesProductSearch(curd, '₹35'), true);

  // Price search: comparisons and ranges
  assert.equal(matchesProductSearch(milk, '< 30'), true);
  assert.equal(matchesProductSearch(milk, 'under 30'), true);
  assert.equal(matchesProductSearch(milk, '> 50'), false);
  assert.equal(matchesProductSearch(milk, '20 - 30'), true);
  assert.equal(matchesProductSearch(milk, '10 to 20'), false);
  assert.equal(matchesProductSearch(ghee, '> 500'), true);
  assert.equal(matchesProductSearch(ghee, 'above 500'), true);

  // Multi-term: name + price
  assert.equal(matchesProductSearch(curd, 'curd 35'), true);
  assert.equal(matchesProductSearch(curd, 'curd 999'), false);
  assert.equal(matchesProductSearch(milk, 'milk 25'), true);

  // Explicit prefix
  assert.equal(matchesProductSearch(milk, 'price: 25'), true);
  assert.equal(matchesProductSearch(milk, 'p: < 30'), true);
  assert.equal(matchesProductSearch(milk, 'price: 100'), false);
});

test('customer accounts system validates tender, credit limits and statement summaries', () => {
  // Tender validation for Account and Credit
  assert.equal(validateTender('Account', 150), '');
  assert.equal(validateTender('Credit', 250), '');

  // Account credit limit checks
  const customerWithoutLimit = { id: 'c1', name: 'Ramesh', phone: '+919876543210', dueBalance: 200, creditLimit: 0 };
  const check1 = canBillToAccount(customerWithoutLimit, 100);
  assert.equal(check1.allowed, true);
  assert.equal(check1.newDue, 300);

  const customerWithLimit = { id: 'c2', name: 'Suresh', phone: '+919876543211', dueBalance: 400, creditLimit: 500 };
  const checkPass = canBillToAccount(customerWithLimit, 50);
  assert.equal(checkPass.allowed, true);
  assert.equal(checkPass.newDue, 450);

  const checkExceed = canBillToAccount(customerWithLimit, 150);
  assert.equal(checkExceed.allowed, false);
  assert.match(checkExceed.reason, /Exceeds credit limit/);

  const noCustomerCheck = canBillToAccount(null, 50);
  assert.equal(noCustomerCheck.allowed, false);

  // Statement formatting
  const statement = formatAccountStatement({
    name: 'Ramesh Kumar',
    phone: '+919876543210',
    dueBalance: 350,
    creditLimit: 1000,
    accountTransactions: [
      { id: '1', date: '2026-11-20T10:00:00Z', type: 'charge', amount: 350, referenceNo: 'AP-1001' }
    ]
  });
  assert.match(statement, /Aavin POS/);
  assert.match(statement, /Ramesh Kumar/);
  assert.match(statement, /350\.00/);

  // Customer accounts permissions: staff cannot delete customer or view statement ledgers
  const canDeleteCustomer = (role) => role === 'owner';
  const canViewCustomerLedger = (role) => role === 'owner';
  assert.equal(canDeleteCustomer('staff'), false);
  assert.equal(canDeleteCustomer('owner'), true);
  assert.equal(canViewCustomerLedger('staff'), false);
  assert.equal(canViewCustomerLedger('owner'), true);
});


