import React from 'react';

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const loginFormat = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const loginTime = value => value && Number.isFinite(Date.parse(value)) ? loginFormat.format(new Date(value)) : 'Not recorded yet';

export default function StaffActivityView({ report, loading, error, start, end, onStartChange, onEndChange, onApply }) {
  return (
    <section aria-labelledby="staff-activity-title" className="space-y-4 rounded-xl border border-slate-700 bg-[#171c26] p-4 sm:p-5">
      <div>
        <h2 id="staff-activity-title" className="text-lg font-bold text-white">Staff activity</h2>
        <p className="mt-1 text-sm text-slate-300">Compare each staff member’s sales, expenses and cash remaining.</p>
      </div>
      <form onSubmit={onApply} className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-sm sm:max-w-48">From
          <input type="date" required value={start} onChange={event => onStartChange(event.target.value)}
            className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-slate-600 bg-[#121620] px-3 py-2 text-white" />
        </label>
        <label className="min-w-0 flex-1 text-sm sm:max-w-48">To
          <input type="date" required value={end} onChange={event => onEndChange(event.target.value)}
            className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-slate-600 bg-[#121620] px-3 py-2 text-white" />
        </label>
        <button type="submit" disabled={loading} className="min-h-11 rounded-lg bg-orange-700 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60">
          {loading ? 'Loading…' : 'Apply / Refresh'}
        </button>
      </form>
      <p className="text-xs leading-relaxed text-slate-400">Cash remaining = cash received − cash refunds − cash expenses. Cash received includes cash sales after change and cash customer-account payments. UPI, card and unpaid credit sales are excluded. Opening float and cash handovers are not tracked.</p>
      {loading && <p role="status" className="py-4 text-sm text-slate-300">Loading staff activity…</p>}
      {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
      {!loading && !error && report && (
        <>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-400">
            <span>{report.period.start} to {report.period.end} · India time</span>
            <span>Updated {loginTime(report.generatedAt)}</span>
          </div>
          {report.historyIncomplete && <p role="status" className="rounded-lg border border-amber-700/60 bg-amber-950/20 p-3 text-sm text-amber-200">This period includes pre-migration history. Older customer payments may be incomplete; reconcile the report with your records.</p>}
          {report.staff.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">No staff accounts or staff activity found for this period.</p> : (
            <div className="grid gap-3 xl:grid-cols-2">
              {report.staff.map(person => (
                <article key={person.uid} className="min-w-0 rounded-xl border border-[#2b3547] bg-[#121620] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="break-words font-bold text-white">{person.name}</h3>
                      {person.email && <p className="mt-0.5 break-all text-xs text-slate-400">{person.email}</p>}
                    </div>
                    <span className="text-xs text-slate-400">{person.bills} {person.bills === 1 ? 'bill' : 'bills'}</span>
                  </div>
                  <p className="mt-3 text-xs text-slate-300">Last login: <span className="font-medium text-slate-100">{loginTime(person.lastLoginAt)}</span></p>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
                    <div><dt className="text-xs text-slate-400">Total sales</dt><dd className="mt-1 break-words text-lg font-semibold tabular-nums text-white">{money.format(person.totalSales)}</dd></div>
                    <div><dt className="text-xs text-slate-400">Total expenses</dt><dd className="mt-1 break-words text-lg font-semibold tabular-nums text-rose-300">{money.format(person.totalExpenses)}</dd></div>
                    <div><dt className="text-xs text-slate-400">Cash received</dt><dd className="mt-1 break-words text-lg font-semibold tabular-nums text-white">{money.format(person.cashReceived)}</dd></div>
                    <div><dt className="text-xs text-slate-400">Cash remaining</dt><dd className={`mt-1 break-words text-lg font-bold tabular-nums ${person.remaining < 0 || person.needsReview ? 'text-amber-300' : 'text-emerald-300'}`}>{person.remaining == null ? 'Needs review' : money.format(person.remaining)}</dd></div>
                  </dl>
                  <p className="mt-4 border-t border-slate-700/70 pt-3 text-xs text-slate-400">Cash refunds {money.format(person.cashRefunds)} · Cash expenses {money.format(person.cashExpenses)}</p>
                  {person.needsReview && <p className="mt-2 text-xs text-amber-200">Some legacy activity has missing staff or tender details. Verify it before accepting a remaining balance.</p>}
                </article>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-400">Last login is the latest recorded sign-in, not an online-status indicator. Historical sign-ins were not recorded before this feature.</p>
        </>
      )}
    </section>
  );
}
