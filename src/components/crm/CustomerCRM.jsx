import React, { useState, useMemo, useEffect } from 'react';
import { 
  Plus, Search, Eye, Edit, Trash2, X, Wallet, IndianRupee, 
  FileText, Copy, Check, ArrowDownLeft, ArrowUpRight, CheckCircle2,
  AlertCircle, Users, Share2, Package, Calendar
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import Dialog from '../layout/Dialog';
import { loadCustomerLedger } from '../../db/db';
import { newId } from '../../domain/ids';
import { sanitizeText, sanitizeNumber } from '../../domain/sanitize';
import { formatAccountStatement, orderBelongsToCustomer } from '../../domain/customers';
import { businessDate, shiftDate } from '../../domain/dates';

export default function CustomerCRM() {
  const { workspaceId, customers, orders = [], isOwner, saveCustomer, deleteCustomer, recordCustomerPayment, showToast } = useApp();

  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'due' | 'clear'
  const [showModal, setShowModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [detailsCustomerId, setDetailsCustomerId] = useState(null);
  const [paymentCustomer, setPaymentCustomer] = useState(null);
  const [statementCustomer, setStatementCustomer] = useState(null);
  const [ledgerPage, setLedgerPage] = useState({ customerId: null, rows: [], loading: false, hasMore: false });
  const ledgerRows = ledgerPage.customerId === statementCustomer?.id ? ledgerPage.rows : [];
  useEffect(() => {
    if (!isOwner || !statementCustomer) return;
    let active = true;
    setLedgerPage({ customerId: statementCustomer.id, rows: [], loading: true, hasMore: false });
    loadCustomerLedger(workspaceId, statementCustomer.id).then(page => { if (active) setLedgerPage({ customerId: statementCustomer.id, ...page, loading: false }); })
      .catch(() => { if (active) setLedgerPage({ customerId: statementCustomer.id, rows: [], loading: false, error: true }); });
    return () => { active = false; };
  }, [workspaceId, isOwner, statementCustomer?.id]);
  async function loadOlderLedger() {
    if (ledgerPage.loading) return;
    setLedgerPage(previous => ({ ...previous, loading: true }));
    try { const page = await loadCustomerLedger(workspaceId, statementCustomer.id, ledgerPage.cursor); setLedgerPage(previous => ({ ...previous, ...page, rows: [...previous.rows, ...page.rows], loading: false })); }
    catch { setLedgerPage(previous => ({ ...previous, loading: false, error: true })); }
  }
  const [statementTab, setStatementTab] = useState('ledger'); // 'ledger' | 'items'
  const [isBusy, setIsBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Form states for Add/Edit customer
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [initialDue, setInitialDue] = useState('');

  // Payment collection form states
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('Cash');
  const [payRef, setPayRef] = useState('');
  const [payNote, setPayNote] = useState('');

  const detailsCustomer = customers.find(c => c.id === detailsCustomerId);

  // Group all purchases for the active statement customer by Date
  const dateWiseItems = useMemo(() => {
    if (!statementCustomer) return [];

    const dateMap = new Map();
    const txs = ledgerRows;

    // 1. Process accountTransactions
    for (const tx of txs) {
      if (tx.type !== 'charge') continue;
      const matchedOrder = orders.find(o => 
        (tx.invoiceNo && o.invoiceNo === tx.invoiceNo) || 
        (tx.orderId && o.id === tx.orderId)
      );
      const items = Array.isArray(tx.items) && tx.items.length > 0 
        ? tx.items 
        : Array.isArray(matchedOrder?.items) 
          ? matchedOrder.items 
          : [];

      if (!items.length) continue;

      const dateObj = tx.date ? new Date(tx.date) : new Date();
      const dateKey = businessDate(dateObj);
      if (!dateKey) continue;

      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, {
          dateKey,
          dateObj,
          totalQty: 0,
          totalAmount: 0,
          bills: []
        });
      }

      const group = dateMap.get(dateKey);
      const billQty = items.reduce((sum, it) => sum + (Number(it.quantity) || 1), 0);
      const billAmount = Number(tx.amount || items.reduce((sum, it) => sum + (Number(it.subtotal || it.price * it.quantity) || 0), 0));

      group.totalQty += billQty;
      group.totalAmount += billAmount;
      group.bills.push({
        invoiceNo: tx.invoiceNo || 'Bill',
        timeStr: dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        amount: billAmount,
        items
      });
    }

    // 2. Also check customer orders from the orders store
    const customerOrders = orders.filter(order => orderBelongsToCustomer(order, statementCustomer));

    for (const ord of customerOrders) {
      const alreadyIncluded = txs.some(tx => 
        (tx.invoiceNo && tx.invoiceNo === ord.invoiceNo) || 
        (tx.orderId && tx.orderId === ord.id)
      );
      if (alreadyIncluded || !Array.isArray(ord.items) || ord.items.length === 0) continue;

      const dateObj = ord.createdAt ? new Date(ord.createdAt) : new Date();
      const dateKey = businessDate(dateObj);
      if (!dateKey) continue;

      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, {
          dateKey,
          dateObj,
          totalQty: 0,
          totalAmount: 0,
          bills: []
        });
      }

      const group = dateMap.get(dateKey);
      const billQty = ord.items.reduce((sum, it) => sum + (Number(it.quantity) || 1), 0);
      const billAmount = Number(ord.total || 0);

      group.totalQty += billQty;
      group.totalAmount += billAmount;
      group.bills.push({
        invoiceNo: ord.invoiceNo || 'Order',
        timeStr: dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        amount: billAmount,
        items: ord.items
      });
    }

    // Sort dates newest first
    return Array.from(dateMap.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  }, [statementCustomer, orders, ledgerRows]);

  const totalPurchasedUnits = useMemo(() => {
    return dateWiseItems.reduce((acc, g) => acc + g.totalQty, 0);
  }, [dateWiseItems]);

  const totalBilledValue = useMemo(() => {
    return dateWiseItems.reduce((acc, g) => acc + g.totalAmount, 0);
  }, [dateWiseItems]);

  const formatDateHeading = (dateKey) => {
    try {
      const [y, m, d] = dateKey.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      const today = new Date();
      const todayKey = businessDate(today);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayKey = shiftDate(todayKey, -1);

      const formatted = date.toLocaleDateString('en-GB', {
        weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
      });

      if (dateKey === todayKey) return `Today · ${formatted}`;
      if (dateKey === yesterdayKey) return `Yesterday · ${formatted}`;
      return formatted;
    } catch {
      return dateKey;
    }
  };

  // Metrics
  const { totalDue, accountsWithDue, clearAccounts } = useMemo(() => {
    let dueSum = 0;
    let dueCount = 0;
    let clearCount = 0;
    for (const c of customers) {
      const bal = Number(c.dueBalance) || 0;
      if (bal > 0) {
        dueSum += bal;
        dueCount++;
      } else {
        clearCount++;
      }
    }
    return {
      totalDue: dueSum,
      accountsWithDue: dueCount,
      clearAccounts: clearCount
    };
  }, [customers]);

  const filtered = useMemo(() => {
    return customers.filter(c => {
      const bal = Number(c.dueBalance) || 0;
      if (filterMode === 'due' && bal <= 0) return false;
      if (filterMode === 'clear' && bal > 0) return false;

      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.notes && c.notes.toLowerCase().includes(q))
      );
    });
  }, [customers, search, filterMode]);

  const handleOpenAdd = () => {
    setEditingCustomer(null);
    setName('');
    setPhone('');
    setEmail('');
    setNotes('');
    setCreditLimit('');
    setInitialDue('');
    setShowModal(true);
  };

  const handleOpenEdit = (c) => {
    if (!isOwner) return;
    setEditingCustomer(c);
    setName(c.name);
    setPhone(c.phone);
    setEmail(c.email || '');
    setNotes(c.notes || '');
    setCreditLimit(c.creditLimit ? String(c.creditLimit) : '');
    setInitialDue(c.dueBalance ? String(c.dueBalance) : '0');
    setShowModal(true);
  };

  const closeEditor = () => {
    if (!isBusy) setShowModal(false);
  };

  const handleSubmit = async event => {
    event.preventDefault();
    const cleanName = sanitizeText(name, 100);
    const cleanPhone = sanitizeText(phone, 30);
    if (isBusy || !cleanName || !cleanPhone) return;
    setIsBusy(true);
    try {
      const limitNum = parseFloat(creditLimit) || 0;
      const dueNum = parseFloat(initialDue) || 0;
      const saved = await saveCustomer({
        id: editingCustomer?.id || `cust-${newId()}`,
        name: cleanName,
        phone: cleanPhone,
        email: sanitizeText(email, 120),
        notes: sanitizeText(notes, 500),
        creditLimit: isOwner && limitNum > 0 ? limitNum : 0,
        dueBalance: isOwner ? (editingCustomer ? (Number(editingCustomer.dueBalance) || 0) : dueNum) : 0
      });
      if (saved) setShowModal(false);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!isOwner || isBusy || !editingCustomer) return;
    if (!window.confirm('Remove this customer profile? Existing invoices and history will be retained.')) return;
    setIsBusy(true);
    try {
      if (await deleteCustomer(editingCustomer.id)) setShowModal(false);
    } finally {
      setIsBusy(false);
    }
  };

  const openPaymentModal = (c) => {
    setPaymentCustomer(c);
    setPayAmount(String(Math.max(0, Number(c.dueBalance) || 0)));
    setPayMethod('Cash');
    setPayRef('');
    setPayNote('');
  };

  const handleRecordPayment = async (e) => {
    e.preventDefault();
    if (!paymentCustomer || isBusy) return;
    const amount = parseFloat(payAmount);
    if (!amount || amount <= 0) {
      showToast('Enter a valid positive payment amount.', 'warning');
      return;
    }

    setIsBusy(true);
    try {
      const ok = await recordCustomerPayment(paymentCustomer.id, {
        amount,
        method: payMethod,
        referenceNo: payRef,
        notes: payNote
      });
      if (ok) {
        setPaymentCustomer(null);
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleCopyStatement = (c) => {
    const text = formatAccountStatement(c, isOwner);
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      showToast('Account statement copied to clipboard for WhatsApp sharing.');
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {
      showToast('Failed to copy to clipboard.', 'error');
    });
  };

  const handleCopyDateWiseItems = (customer, dateGroups) => {
    if (!customer) return;
    let text = `*Aavin POS - Customer Purchase History (Date-Wise)*\n`;
    text += `Customer: ${customer.name}\n`;
    text += `Mobile: ${customer.phone}\n`;
    text += `Total Outstanding: ₹${(Number(customer.dueBalance) || 0).toFixed(2)}\n\n`;

    if (!dateGroups || dateGroups.length === 0) {
      text += `No purchase records found.\n`;
    } else {
      for (const group of dateGroups) {
        const formattedDate = formatDateHeading(group.dateKey);
        text += `📅 *${formattedDate}* (Total Qty: ${group.totalQty} · ₹${group.totalAmount.toFixed(2)}):\n`;
        for (const bill of group.bills) {
          text += `  Invoice ${bill.invoiceNo}:\n`;
          for (const it of bill.items) {
            const price = Number(it.price || 0);
            const qty = Number(it.quantity || 1);
            const subtotal = Number(it.subtotal || price * qty);
            text += `    • ${it.name}${it.variant ? ` (${it.variant})` : ''} × ${qty} = ₹${subtotal.toFixed(2)}\n`;
          }
        }
        text += `\n`;
      }
    }

    text += `Thank you for choosing Aavin!`;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      showToast('Date-wise purchase history copied to clipboard for WhatsApp sharing.');
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {
      showToast('Failed to copy to clipboard.', 'error');
    });
  };

  return (
    <div className="w-full max-w-7xl mx-auto min-w-0 app-gutters py-4 sm:py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-extrabold text-white">Customer Accounts & Khata</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Manage customer credit, record due payments, and view transaction ledgers.
          </p>
        </div>
        <button
          onClick={handleOpenAdd}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-600 text-white font-bold text-xs shadow-lg shadow-orange-500/25 transition-all self-start sm:self-auto"
        >
          <Plus className="w-4 h-4 stroke-[2.5]" />
          <span>New Customer Account</span>
        </button>
      </div>

      {/* Top Account Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 sm:p-4">
          <span className="block text-xs font-semibold text-amber-300">Total Outstanding Due</span>
          <span className="mt-1 block font-mono text-xl sm:text-2xl font-black text-white">
            ₹{totalDue.toFixed(2)}
          </span>
          <span className="mt-0.5 block text-[11px] text-amber-200/80">Pending customer balance</span>
        </div>

        <div className="rounded-2xl border border-[#232b3a] bg-[#141923] p-3 sm:p-4">
          <span className="block text-xs font-semibold text-slate-400">Accounts with Due</span>
          <span className="mt-1 block font-mono text-xl sm:text-2xl font-black text-rose-400">
            {accountsWithDue}
          </span>
          <span className="mt-0.5 block text-[11px] text-slate-500">Need collection</span>
        </div>

        <div className="rounded-2xl border border-[#232b3a] bg-[#141923] p-3 sm:p-4">
          <span className="block text-xs font-semibold text-slate-400">Settled / Clear Accounts</span>
          <span className="mt-1 block font-mono text-xl sm:text-2xl font-black text-emerald-400">
            {clearAccounts}
          </span>
          <span className="mt-0.5 block text-[11px] text-slate-500">Zero due balance</span>
        </div>

        <div className="rounded-2xl border border-[#232b3a] bg-[#141923] p-3 sm:p-4">
          <span className="block text-xs font-semibold text-slate-400">Total Registered</span>
          <span className="mt-1 block font-mono text-xl sm:text-2xl font-black text-white">
            {customers.length}
          </span>
          <span className="mt-0.5 block text-[11px] text-slate-500">All customer profiles</span>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="bg-[#141923] p-4 rounded-2xl border border-[#232b3a] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts by name, phone or email..."
            className="w-full bg-[#1b2230] text-xs text-white placeholder-slate-500 pl-8 pr-3 py-2 rounded-xl border border-[#293345] focus:outline-none focus:border-orange-500 transition-colors"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {[
            { id: 'all', label: 'All Accounts' },
            { id: 'due', label: 'Has Dues' },
            { id: 'clear', label: 'Clear' }
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterMode(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                filterMode === tab.id
                  ? 'bg-orange-500 text-white shadow-sm'
                  : 'bg-[#1b2230] text-slate-300 hover:bg-[#252f42]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Customer Accounts Ledger Table */}
      <div className="bg-[#141923] rounded-2xl border border-[#232b3a] overflow-hidden">
        <div className="xl:overflow-x-auto">
          <table role="table" aria-label="Customer accounts" className="responsive-records customer-records w-full text-left text-xs border-collapse min-w-[760px]">
            <thead role="rowgroup">
              <tr role="row" className="bg-[#121620] text-slate-400 text-[10px] font-bold uppercase tracking-wider border-b border-[#232b3a]">
                <th role="columnheader" scope="col" className="py-3 px-4">Customer Name</th>
                <th role="columnheader" scope="col" className="py-3 px-4">Mobile Phone</th>
                <th role="columnheader" scope="col" className="py-3 px-4">Account Due Balance</th>
                <th role="columnheader" scope="col" className="py-3 px-4">Credit Limit</th>
                <th role="columnheader" scope="col" className="py-3 px-4">Total Orders</th>
                <th role="columnheader" scope="col" className="py-3 px-4">Total Spend (₹)</th>
                <th role="columnheader" scope="col" className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="divide-y divide-[#1e2636]">
              {!filtered.length && (
                <tr role="row">
                  <td role="cell" colSpan={7} className="record-empty px-4 py-8 text-center text-sm text-slate-400">
                    {search ? 'No accounts match this search.' : 'No customer accounts found.'}
                  </td>
                </tr>
              )}
              {filtered.map((c) => {
                const bal = Number(c.dueBalance) || 0;
                const limit = Number(c.creditLimit) || 0;
                return (
                  <tr role="row" key={c.id} className="hover:bg-[#18202d] transition-colors group">
                    <td role="cell" className="py-3 px-4 font-bold text-white record-title">
                      <div>{c.name}</div>
                      {c.notes && <div className="text-[10px] text-slate-400 line-clamp-1 font-normal">{c.notes}</div>}
                    </td>
                    <td role="cell" className="py-3 px-4 font-mono text-emerald-400 font-medium customer-record-phone">
                      <span className="record-label" aria-hidden="true">Phone</span>
                      {c.phone}
                    </td>
                    <td role="cell" className="py-3 px-4 font-mono">
                      <span className="record-label" aria-hidden="true">Balance</span>
                      {bal > 0 ? (
                        <div className="inline-flex items-center gap-1.5">
                          <span className="font-extrabold text-rose-400 text-sm">₹{bal.toFixed(2)}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 font-bold">
                            DUE
                          </span>
                        </div>
                      ) : bal < 0 ? (
                        <div className="inline-flex items-center gap-1.5">
                          <span className="font-bold text-blue-400">₹{Math.abs(bal).toFixed(2)}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 font-bold">
                            ADVANCE
                          </span>
                        </div>
                      ) : (
                        <span className="text-emerald-400 font-semibold text-xs">₹0.00 (Clear)</span>
                      )}
                    </td>
                    <td role="cell" className="py-3 px-4 font-mono text-slate-300">
                      <span className="record-label" aria-hidden="true">Limit</span>
                      {limit > 0 ? `₹${limit.toFixed(2)}` : '—'}
                    </td>
                    <td role="cell" className="py-3 px-4 font-bold text-orange-400 font-mono">
                      <span className="record-label" aria-hidden="true">Orders</span>
                      {c.ordersCount || 0}
                    </td>
                    <td role="cell" className="py-3 px-4 font-mono text-slate-200">
                      <span className="record-label" aria-hidden="true">Gross spend</span>
                      ₹{(Number(c.totalSpent) || 0).toFixed(2)}
                    </td>
                    <td role="cell" className="py-3 px-4 text-right record-actions">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openPaymentModal(c)}
                          title="Get Amount / Record Payment"
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                            bal > 0 
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm' 
                              : 'bg-[#1b2332] hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 hover:text-white'
                          }`}
                        >
                          <IndianRupee className="w-3 h-3" />
                          <span>Get Amount</span>
                        </button>
                        {isOwner && (
                          <button
                            type="button"
                            onClick={() => {
                              setStatementTab('items');
                              setStatementCustomer(c);
                            }}
                            title="View Date-wise Items & Quantities"
                            aria-label={`View date-wise items for ${c.name}`}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-orange-500/15 hover:bg-orange-500/30 border border-orange-500/30 text-orange-300 hover:text-white transition-all text-xs font-semibold"
                          >
                            <Package className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Items</span>
                          </button>
                        )}
                        {isOwner && (
                          <button
                            type="button"
                            onClick={() => {
                              setStatementTab('ledger');
                              setStatementCustomer(c);
                            }}
                            title="View Customer Account & Ledger"
                            aria-label={`View account ledger for ${c.name}`}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/15 hover:bg-blue-500/30 border border-blue-500/30 text-blue-300 hover:text-white transition-all text-xs font-semibold"
                          >
                            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Accounts</span>
                          </button>
                        )}
                        {isOwner && <button
                          type="button"
                          onClick={() => handleOpenEdit(c)}
                          title="Edit Customer"
                          aria-label={`Edit ${c.name}`}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-orange-400 hover:bg-[#252f42] transition-colors"
                        >
                          <Edit className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Collect Due Payment Modal */}
      {paymentCustomer && (
        <Dialog label="Collect Due Payment" onClose={() => setPaymentCustomer(null)}>
          <div className="bg-[#181e28] border border-[#2b3547] rounded-2xl w-full max-w-md shadow-2xl p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#232b3a]">
              <div>
                <h3 className="text-sm font-bold text-white">Record Account Payment</h3>
                <p className="text-xs text-slate-400">{paymentCustomer.name} · {paymentCustomer.phone}</p>
              </div>
              <button type="button" onClick={() => setPaymentCustomer(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleRecordPayment} className="mt-4 space-y-3.5 text-xs">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 flex items-center justify-between">
                <div>
                  <span className="block text-[11px] text-amber-200">Current Outstanding Due</span>
                  <span className="text-lg font-black font-mono text-white">
                    ₹{(Number(paymentCustomer.dueBalance) || 0).toFixed(2)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPayAmount(String(Math.max(0, Number(paymentCustomer.dueBalance) || 0)))}
                  className="px-2.5 py-1 rounded-lg bg-orange-600 hover:bg-orange-700 text-white font-bold text-[11px]"
                >
                  Pay Full
                </button>
              </div>

              <div>
                <label className="text-slate-300 block mb-1 font-semibold">Payment Amount Received (₹) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="Enter amount paid"
                  required
                  autoFocus
                  className="w-full bg-[#121620] text-white px-3 py-2 text-base font-bold font-mono rounded-xl border border-[#263143] focus:outline-none focus:border-orange-500"
                />
              </div>

              <div>
                <label className="text-slate-300 block mb-1 font-semibold">Payment Mode</label>
                <div className="grid grid-cols-2 gap-2">
                  {['Cash', 'UPI'].map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setPayMethod(m)}
                      className={`py-2 rounded-xl border font-bold text-xs transition-all ${
                        payMethod === m
                          ? 'border-orange-500 bg-orange-500/10 text-orange-200'
                          : 'border-[#263143] bg-[#121620] text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Transaction / Reference ID (optional)</label>
                <input
                  type="text"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="e.g. UPI Ref / Cash receipt"
                  className="w-full bg-[#121620] text-white px-3 py-2 rounded-xl border border-[#263143] focus:outline-none"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="e.g. Settle last week milk"
                  className="w-full bg-[#121620] text-white px-3 py-2 rounded-xl border border-[#263143] focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#232b3a]">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setPaymentCustomer(null)}
                  className="px-3 py-2 rounded-lg text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isBusy}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold text-white shadow-md disabled:opacity-50"
                >
                  {isBusy ? 'Recording…' : 'Record Payment'}
                </button>
              </div>
            </form>
          </div>
        </Dialog>
      )}

      {/* Account Statement / Ledger Modal */}
      {statementCustomer && (
        <Dialog label="Customer Account Ledger" onClose={() => setStatementCustomer(null)}>
          <div className="bg-[#181e28] border border-[#2b3547] rounded-2xl w-full max-w-xl shadow-2xl p-5 flex flex-col max-h-[88vh]">
            {/* Header */}
            <div className="flex items-start justify-between pb-3 border-b border-[#232b3a] shrink-0">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <span>{statementCustomer.name}</span>
                  <span className="text-xs font-normal text-slate-400">
                    · {statementTab === 'items' ? 'Items & Quantities' : 'Accounts Ledger'}
                  </span>
                </h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">{statementCustomer.phone}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (statementTab === 'items') {
                      handleCopyDateWiseItems(statementCustomer, dateWiseItems);
                    } else {
                      handleCopyStatement({ ...statementCustomer, accountTransactions: [...ledgerRows].sort((a, b) => a.date.localeCompare(b.date)) });
                    }
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#202838] hover:bg-[#2c374d] text-slate-200 text-xs font-semibold"
                  title={statementTab === 'items' ? "Copy Date-Wise Items" : "Copy Statement"}
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? 'Copied!' : statementTab === 'items' ? 'Copy Items' : 'Copy Summary'}</span>
                </button>
                <button type="button" onClick={() => setStatementCustomer(null)} className="text-slate-400 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {statementCustomer.historyComplete === false && <p role="status" className="text-sm text-amber-300">History before migration may be incomplete. The cutover balance was preserved.</p>}
            {ledgerPage.loading && <p role="status">Loading account history…</p>}
            {ledgerPage.error && <p role="alert">Account history could not be loaded. Reopen the account to retry.</p>}
            {ledgerPage.hasMore && <button type="button" disabled={ledgerPage.loading} onClick={loadOlderLedger}>Load older entries</button>}
            {/* TAB 1: ACCOUNT LEDGER */}
            {(!isOwner || statementTab === 'ledger') && (
              <div className="flex-1 flex flex-col min-h-0 pt-4">
                {/* Account Summary Banner */}
                <div className="mb-3 p-3 rounded-xl bg-[#121620] border border-[#232a39] grid grid-cols-3 gap-2 text-center text-xs shrink-0">
                  <div>
                    <span className="block text-[10px] text-slate-400">Due Balance</span>
                    <span className="font-mono font-bold text-rose-400 text-sm">
                      ₹{(Number(statementCustomer.dueBalance) || 0).toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Credit Limit</span>
                    <span className="font-mono font-semibold text-slate-200">
                      {statementCustomer.creditLimit ? `₹${Number(statementCustomer.creditLimit).toFixed(2)}` : 'None'}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Total Spend</span>
                    <span className="font-mono font-semibold text-slate-200">
                      ₹{(Number(statementCustomer.totalSpent) || 0).toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Quick Action: Get Amount Button */}
                <div className="mb-3 flex items-center justify-between shrink-0 bg-[#141924] p-2.5 rounded-xl border border-[#222b3a]">
                  <span className="text-xs font-semibold text-slate-300">
                    {Number(statementCustomer.dueBalance) > 0 ? 'Collect Pending Balance:' : 'Collect Advance / Settlement:'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const cust = statementCustomer;
                      setStatementCustomer(null);
                      openPaymentModal(cust);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow"
                  >
                    <IndianRupee className="w-3.5 h-3.5" />
                    <span>Get Amount</span>
                  </button>
                </div>

                {/* Ledger Transactions */}
                <h4 className="text-xs font-bold text-slate-300 mb-2 shrink-0">Recent Account Transactions</h4>
                <div className="flex-1 overflow-y-auto min-h-0 space-y-2 pr-1">
                  {(!ledgerRows || ledgerRows.length === 0) ? (
                    <p className="text-xs text-slate-500 py-6 text-center">
                      No account transactions recorded yet. When bills are charged to account or payments are recorded, they will appear here.
                    </p>
                  ) : (
                    [...ledgerRows].map(tx => {
                      const isCharge = ['charge', 'opening'].includes(tx.type);
                      return (
                        <div key={tx.id || tx.date} className="p-3 rounded-xl bg-[#141924] border border-[#232b3b] flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2.5">
                            <span className={`p-1.5 rounded-lg ${isCharge ? 'bg-orange-500/10 text-orange-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                              {isCharge ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                            </span>
                            <div>
                              <div className="font-bold text-slate-200">
                                {tx.type === 'refund' ? 'Refund recorded' : tx.type === 'opening' ? 'Opening balance' : isCharge ? 'Bill on Account' : 'Payment Received'}
                                {tx.invoiceNo && <span className="ml-1 text-[10px] text-slate-400 font-normal">({tx.invoiceNo})</span>}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {tx.date ? new Date(tx.date).toLocaleDateString('en-GB') : ''}
                                {tx.method && ` · ${tx.method}`}
                                {tx.referenceNo && ` · ${tx.referenceNo}`}
                              </div>
                            </div>
                          </div>

                          <div className="text-right flex items-center gap-3">
                            <div>
                              <div className={`font-mono font-bold ${isCharge ? 'text-orange-400' : 'text-emerald-400'}`}>
                                {tx.balanceDelta === 0 ? '' : isCharge ? '+' : '-'}₹{Number(tx.amount || 0).toFixed(2)}
                              </div>
                              {tx.balanceAfter != null && (
                                <div className="text-[10px] font-mono text-slate-500">
                                  Bal: ₹{Number(tx.balanceAfter).toFixed(2)}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: ITEMS & QUANTITIES (DATE-WISE) - FOR OWNER */}
            {isOwner && statementTab === 'items' && (
              <div className="flex-1 flex flex-col min-h-0 pt-4">
                {/* Items Summary Banner */}
                <div className="mb-3 p-3 rounded-xl bg-[#121620] border border-[#232a39] grid grid-cols-3 gap-2 text-center text-xs shrink-0">
                  <div>
                    <span className="block text-[10px] text-slate-400">Total Units</span>
                    <span className="font-mono font-black text-orange-400 text-sm">
                      {totalPurchasedUnits} items
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Purchase Dates</span>
                    <span className="font-mono font-semibold text-slate-200">
                      {dateWiseItems.length} days
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Total Billed</span>
                    <span className="font-mono font-semibold text-slate-200">
                      ₹{totalBilledValue.toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Date-wise items list */}
                <div className="flex-1 overflow-y-auto min-h-0 space-y-3 pr-1">
                  {dateWiseItems.length === 0 ? (
                    <div className="text-center py-8 text-slate-500 space-y-2">
                      <Package className="w-8 h-8 mx-auto text-slate-600" />
                      <p className="text-xs">No item purchase records found for this customer yet.</p>
                    </div>
                  ) : (
                    dateWiseItems.map(group => (
                      <div key={group.dateKey} className="rounded-xl border border-[#232b3c] bg-[#141924] overflow-hidden shadow-sm">
                        {/* Date Group Header */}
                        <div className="px-3 py-2 bg-[#1b2232] border-b border-[#232b3c] flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Calendar className="w-3.5 h-3.5 text-orange-400" />
                            <span className="font-bold text-slate-100 text-xs">
                              {formatDateHeading(group.dateKey)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded-full bg-orange-500/15 border border-orange-500/30 text-orange-300 font-bold text-[10px]">
                              Total: {group.totalQty} items
                            </span>
                            <span className="font-mono font-bold text-slate-200 text-xs">
                              ₹{group.totalAmount.toFixed(2)}
                            </span>
                          </div>
                        </div>

                        {/* Bills and Items on this date */}
                        <div className="p-2.5 space-y-2">
                          {group.bills.map((bill, bIdx) => (
                            <div key={bIdx} className="space-y-1.5">
                              <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono px-1">
                                <span className="font-semibold text-slate-300">
                                  Bill No: <span className="text-orange-300">{bill.invoiceNo}</span>
                                  {bill.timeStr && ` · ${bill.timeStr}`}
                                </span>
                                <span>₹{bill.amount.toFixed(2)}</span>
                              </div>
                              <div className="space-y-1">
                                {bill.items.map((it, iIdx) => (
                                  <div key={iIdx} className="flex items-center justify-between text-xs bg-[#0d121a] px-3 py-2 rounded-lg border border-[#1d2636]">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0"></span>
                                      <span className="font-semibold text-slate-200 truncate">{it.name}</span>
                                      {it.variant && (
                                        <span className="text-[10px] text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
                                          {it.variant}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-3 font-mono shrink-0">
                                      <span className="px-2 py-0.5 rounded bg-orange-500/20 text-orange-300 font-black text-xs border border-orange-500/30">
                                        Qty: {it.quantity}
                                      </span>
                                      <div className="text-right min-w-[65px]">
                                        {Number(it.quantity) > 1 && Number(it.price) > 0 && (
                                          <span className="block text-[10px] text-slate-400 font-normal">
                                            ₹{Number(it.price).toFixed(2)} ea
                                          </span>
                                        )}
                                        <span className="text-slate-300 font-bold text-xs">
                                          ₹{Number(it.subtotal || (Number(it.price || 0) * Number(it.quantity || 1))).toFixed(2)}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </Dialog>
      )}

      {/* Add / Edit Customer Modal */}
      {showModal && (
        <Dialog label="Customer profile" onClose={closeEditor}>
          <div className="bg-[#181e28] border border-[#2b3547] rounded-2xl w-full max-w-md max-h-full overflow-y-auto shadow-2xl p-5">
            <div className="flex items-center justify-between pb-3 border-b border-[#232b3a]">
              <h3 className="text-sm font-bold text-white">
                {editingCustomer ? 'Edit Customer Account' : 'New Customer Account'}
              </h3>
              <button type="button" aria-label="Close" disabled={isBusy} onClick={closeEditor} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="text-slate-400 block mb-1">Customer Full Name *</label>
                <input
                  aria-label="Customer Full Name"
                  type="text"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Ramesh Kumar"
                  required
                  className="w-full bg-[#121620] text-white px-3 py-2 rounded-xl border border-[#263143] focus:outline-none focus:border-orange-500"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Mobile Phone *</label>
                <input
                  aria-label="Mobile Phone"
                  type="text"
                  maxLength={30}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 9876543210"
                  required
                  className="w-full bg-[#121620] text-white px-3 py-2 rounded-xl border border-[#263143] focus:outline-none font-mono"
                />
              </div>

              {isOwner && <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-slate-400 block mb-1">Credit Limit (₹)</label>
                  <input
                    type="number"
                    min="0"
                    step="100"
                    value={creditLimit}
                    onChange={(e) => setCreditLimit(e.target.value)}
                    placeholder="0 = Unlimited"
                    className="w-full bg-[#121620] text-white px-3 py-2 rounded-xl border border-[#263143] focus:outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="text-slate-400 block mb-1">Opening Due (₹)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    disabled={Boolean(editingCustomer)}
                    value={initialDue}
                    onChange={(e) => setInitialDue(e.target.value)}
                    placeholder="0"
                    className="w-full bg-[#121620] text-white px-3 py-2 rounded-xl border border-[#263143] focus:outline-none font-mono disabled:opacity-50"
                  />
                </div>
              </div>}

              <div>
                <label className="text-slate-400 block mb-1">Email Address</label>
                <input
                  aria-label="Email Address"
                  type="email"
                  maxLength={120}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Optional"
                  className="w-full bg-[#121620] text-white px-3 py-2 rounded-xl border border-[#263143] focus:outline-none"
                />
              </div>

              <div>
                <label className="text-slate-400 block mb-1">Preferences & Notes</label>
                <textarea
                  aria-label="Preferences & Notes"
                  maxLength={500}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Daily 1L milk morning subscriber, nearby resident"
                  rows={2}
                  className="w-full bg-[#121620] text-white px-3 py-2 rounded-xl border border-[#263143] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-[#232b3a] pt-3">
                {isOwner && editingCustomer && (
                  <button type="button" aria-label="Delete customer" disabled={isBusy} onClick={handleDelete}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 font-semibold text-rose-300 hover:bg-rose-950/50 disabled:opacity-50">
                    <Trash2 className="size-4" aria-hidden="true" /> Delete
                  </button>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" disabled={isBusy} onClick={closeEditor}
                    className="min-h-11 rounded-lg px-2 text-slate-400 hover:text-white disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="submit" disabled={isBusy}
                    className="min-h-11 rounded-lg bg-orange-500 px-3 font-bold text-white hover:bg-orange-600 disabled:opacity-50">
                    Save Account
                  </button>
                </div>
              </div>
            </form>
          </div>
        </Dialog>
      )}
    </div>
  );
}
