import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { estimate } from '../core/billing.js';
import './style.css';

const rupees = amount => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount ?? 0);
async function call(name, data) {
  const result = await window.counter[name](data);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function Counter() {
  const [view, setView] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [mode, setMode] = useState('online'), [cart, setCart] = useState([]), [amount, setAmount] = useState(''), [channel, setChannel] = useState('Counter');
  const [search, setSearch] = useState(''), [receipt, setReceipt] = useState(null), [intent, setIntent] = useState(() => crypto.randomUUID());
  const [product, setProduct] = useState(null), [variant, setVariant] = useState(''), [addons, setAddons] = useState([]);
  const refresh = () => call('view').then(setView).catch(failure => setError(failure.message));
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const unacknowledged = view?.sales.find(sale => sale.acknowledged === false);
    if (unacknowledged && unacknowledged.id !== receipt?.id) {
      setReceipt(unacknowledged); setCart([]); setAmount(''); setIntent(crypto.randomUUID());
    }
  }, [view]);
  async function action(name, data) {
    setBusy(true); setError('');
    try { const result = await call(name, data); await refresh(); return result; }
    catch (failure) { setError(failure.message); return null; }
    finally { setBusy(false); }
  }
  async function configure(event) { event.preventDefault(); const form = new FormData(event.currentTarget); await action('configure', { origin: form.get('origin').trim() }); }
  async function signIn(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const data = { email: form.get('email'), pin: form.get('pin') };
    if (mode === 'online') data.password = form.get('password');
    if (await action(mode === 'online' ? 'signIn' : 'unlock', data)) event.target.reset();
  }
  function add(product, selectedVariant = null, selectedAddons = []) {
    if (cart.length >= 100) { setError('A bill may have at most 100 lines.'); return; }
    setCart([...cart, { productId: product.id, variant: selectedVariant, addons: selectedAddons, quantity: 1, note: '' }]); setProduct(null);
  }
  async function checkout() {
    const result = await action('checkout', { id: intent, items: cart, channel, amountReceived: Number(amount || bill.total) });
    if (result) { setReceipt(result); setCart([]); setAmount(''); setIntent(crypto.randomUUID()); }
  }
  if (!view) return <main className="access"><h1>Aavin POS</h1><p role="status">Opening encrypted counter data…</p>{error && <p role="alert">{error}</p>}</main>;
  const operator = view.operator;
  const catalog = view.catalog?.products ?? [];
  const products = catalog.filter(product => product.active !== false && !product.archived && `${product.name} ${product.category ?? ''} ${product.sku ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  let bill = { total: 0, items: [] };
  try { if (cart.length) bill = estimate(catalog, cart); } catch { /* Invalid cached choices remain unbillable in the main process. */ }
  const latestReceipt = receipt && (view.sales.find(sale => sale.id === receipt.id) ?? receipt);
  return <>
    <header><div><strong>Aavin POS</strong><span className="sub">Desktop cash counter</span></div><div className="header-actions"><span className="status">{view.connection}</span>{operator && <><span>{operator.name || operator.email}</span><button disabled={busy} onClick={async () => { if (await action('lock')) { setCart([]); setReceipt(null); setIntent(crypto.randomUUID()); } }}>Sign out</button></>}</div></header>
    {error && <div role="alert" className="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {!operator ? <main className="access">
      <h1>{view.backend ? 'Open your counter' : 'Set up this counter'}</h1>
      {!view.backend ? <form onSubmit={configure}><p>Enter the trusted HTTPS address of your POS backend. Do not enter an address sent by someone you do not trust.</p><label>POS backend URL<input name="origin" type="url" placeholder="https://your-pos-backend.example" required /></label><button className="primary" disabled={busy}>Verify backend</button><p className="muted">Setup and first sign-in require internet. No server credentials are installed on this computer.</p></form> : <>
        <div className="tabs"><button className={mode === 'online' ? 'selected' : ''} onClick={() => setMode('online')}>Online sign-in</button><button className={mode === 'offline' ? 'selected' : ''} onClick={() => setMode('offline')}>Offline unlock</button></div>
        <form onSubmit={signIn} key={mode}><label>Email<input type="email" name="email" autoComplete="username" required maxLength={120} /></label>{mode === 'online' && <label>Firebase password<input type="password" name="password" autoComplete="current-password" required maxLength={128} /></label>}<label>{mode === 'online' ? 'Set offline passphrase' : 'Offline passphrase'}<input type="password" name="pin" autoComplete={mode === 'online' ? 'new-password' : 'current-password'} required minLength={8} maxLength={128} /></label><p className="muted">{mode === 'online' ? 'Use a separate passphrase of at least 8 characters for this computer. Online sign-in refreshes the catalog and permits offline cash billing for 24 hours.' : 'Only previously verified staff can unlock offline, within 24 hours of their last online sign-in.'}</p><button className="primary" disabled={busy}>{busy ? 'Checking…' : mode === 'online' ? 'Sign in online' : 'Unlock counter'}</button></form>
        <button className="link" disabled={busy} onClick={() => action('onlineWorkspace')}>Open full online POS</button>
      </>}
    </main> : <main className="workspace">
      <section className="syncbar"><div><strong>{view.counts.pending} pending · {view.counts.review} need review</strong><p>Saved bills sync automatically every 15 seconds while this app is open. Closing the app pauses sync.</p></div><div className="row"><button disabled={busy} onClick={() => action('retry')}>Sync now</button><button disabled={busy} onClick={() => action('onlineWorkspace')}>Full online POS</button>{operator.role === 'owner' && <button disabled={busy} onClick={() => action('backup')}>Back up counter</button>}</div></section>
      {operator.role === 'staff' ? <>
        <p className="notice">Cash, walk-in sales only. Credit, UPI, card, tables, discounts, refunds and expenses use the full online POS. Offline receipts are provisional until accepted by the server.</p>
        {operator.revoked && <p className="alert">Server access was rejected. Sign out and sign in online before taking more payments.</p>}
        <div className="counter-grid"><section className="panel"><div className="row spread"><h1>Products</h1><span className="muted">Catalog from last online sign-in</span></div><input type="search" aria-label="Search products" placeholder="Search name, category or SKU" value={search} onChange={event => setSearch(event.target.value)} />
          {!products.length && <p className="empty">No matching products. Add products in the online owner workspace, then sign in online again.</p>}
          <div className="products">{products.map(product => <button className="product" key={product.id} onClick={() => product.hasSizes || (product.hasAddons !== false && product.addons?.length) ? (setProduct(product), setVariant(product.sizes?.[0]?.name ?? ''), setAddons([])) : add(product)}><span className="muted">{product.category || 'Product'}</span><strong>{product.name}</strong><span className="price">{product.hasSizes ? 'Choose size' : rupees(product.price)}</span></button>)}</div>
        </section><section className="panel cart"><div className="row spread"><h2>Current bill</h2><button disabled={busy || !cart.length} onClick={() => setCart([])}>Clear bill</button></div><div className="tabs">{['Counter', 'Takeaway'].map(value => <button key={value} className={channel === value ? 'selected' : ''} onClick={() => setChannel(value)}>{value}</button>)}</div>
          {!cart.length && <p className="empty">Choose a product to start a bill.</p>}
          {bill.items.map((item, index) => <div className="cart-line" key={index}><div><strong>{item.name}{item.variant ? ` · ${item.variant}` : ''}</strong><small>{item.addons.join(', ')}</small><span>{rupees(item.total)}</span></div><div className="row"><label>Qty<input aria-label={`Quantity for ${item.name}`} type="number" min="1" max="10000" value={item.quantity} onChange={event => setCart(cart.map((row, i) => i === index ? { ...row, quantity: Math.max(1, Math.min(10000, Math.trunc(Number(event.target.value)) || 1)) } : row))} /></label><button aria-label={`Remove ${item.name}`} onClick={() => setCart(cart.filter((row, i) => i !== index))}>Remove</button></div></div>)}
          <div className="total"><span>Total</span><strong>{rupees(bill.total)}</strong></div><label>Cash received<input type="number" min={bill.total} step="0.01" placeholder={bill.total.toFixed(2)} value={amount} onChange={event => setAmount(event.target.value)} /></label><p>Change: <strong>{rupees(Math.max(0, Number(amount || bill.total) - bill.total))}</strong></p><button className="primary" disabled={busy || !cart.length || operator.revoked || bill.items.length !== cart.length} onClick={checkout}>{busy ? 'Saving bill…' : 'Save cash bill'}</button><p className="muted">Offline access until {new Date(operator.offlineUntil).toLocaleString('en-IN')}. Device attendance is not verified working time.</p>
        </section></div>
      </> : <section className="panel"><h1>Owner workspace</h1><p>Use the full online POS for reports, staff attendance, accounts and catalog management. This counter stores only its own cash receipts.</p><form onSubmit={configure}><label>Trusted backend URL<input type="url" name="origin" defaultValue={view.backend} required /></label><button disabled={busy}>Verify and update backend</button></form><p className="muted">Local encrypted backups can be restored only under the same Windows account. Keep the device and Windows recovery keys safe.</p></section>}
      <section className="panel history"><h2>Recent counter receipts</h2><p className="muted">Most recent 100 on this computer. Synced bills are available in the online POS. Server accounting dates use the sync date; the original device time is kept separately and is unverified.</p>{!view.sales.length ? <p className="empty">No saved cash bills on this counter.</p> : view.sales.map(sale => <div key={sale.id} className="sale"><div><strong>{sale.serverInvoice?.invoiceNo ?? sale.localReceiptNo}</strong><small>{new Date(sale.capturedAt).toLocaleString('en-IN')} · {sale.cashierName}</small>{sale.lastError && <p className="review">{sale.lastError}</p>}</div><span className={`badge ${sale.state}`}>{sale.state === 'review' ? 'Needs review' : sale.state}</span><strong>{rupees(sale.total)}</strong><button onClick={() => setReceipt(sale)}>Receipt</button></div>)}</section>
    </main>}
    {product && <div className="overlay"><section role="dialog" aria-modal="true" aria-labelledby="options-title" className="modal"><h2 id="options-title">{product.name}</h2>{product.hasSizes && <label>Size<select value={variant} onChange={event => setVariant(event.target.value)}>{(product.sizes ?? []).map(size => <option key={size.name} value={size.name}>{size.name} · {rupees(size.price)}</option>)}</select></label>}{product.hasAddons !== false && (product.addons ?? []).map(addon => <label className="check" key={addon.name}><input type="checkbox" checked={addons.includes(addon.name)} onChange={event => setAddons(event.target.checked ? [...addons, addon.name] : addons.filter(name => name !== addon.name))} />{addon.name} · {rupees(addon.price)}</label>)}<div className="row"><button onClick={() => setProduct(null)}>Cancel</button><button className="primary" onClick={() => add(product, product.hasSizes ? variant : null, addons)}>Add to bill</button></div></section></div>}
    {latestReceipt && <div className="overlay receipt-overlay"><section role="dialog" aria-modal="true" aria-labelledby="receipt-title" className="modal"><article id="receipt"><h2 id="receipt-title">{latestReceipt.merchant.brandName || 'Aavin POS'}</h2><p>{latestReceipt.serverInvoice ? `Invoice ${latestReceipt.serverInvoice.invoiceNo}` : 'PROVISIONAL CASH RECEIPT · pending server acceptance'}</p><p className="reference">Local reference: {latestReceipt.localReceiptNo}</p><p>{new Date(latestReceipt.capturedAt).toLocaleString('en-IN')} (device time)</p><p>Cashier: {latestReceipt.cashierName}</p>{latestReceipt.items.map((item, index) => <div className="receipt-line" key={index}><span>{item.quantity} × {item.name}{item.variant ? ` (${item.variant})` : ''}{item.addons.length ? ` + ${item.addons.join(', ')}` : ''}</span><span>{rupees(item.total)}</span></div>)}<div className="total"><strong>Total paid</strong><strong>{rupees(latestReceipt.total)}</strong></div><p>Cash received {rupees(latestReceipt.amountReceived)}</p><p>Change returned {rupees(latestReceipt.change)}</p><p>{latestReceipt.merchant.receiptFooterMessage || 'Thank you'}</p></article><div className="row no-print"><button disabled={busy} onClick={async () => { if (await action('acknowledge', { id: latestReceipt.id })) setReceipt(null); }}>Close</button><button className="primary" disabled={busy} onClick={() => action('print')}>Print receipt</button></div></section></div>}
  </>;
}
createRoot(document.getElementById('root')).render(<Counter />);
