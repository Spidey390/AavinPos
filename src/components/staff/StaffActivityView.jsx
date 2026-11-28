import React from 'react';
import StaffAttendanceView from './StaffAttendanceView';
import DayCalendarPicker from '../reports/DayCalendarPicker';
import { ChevronDown } from 'lucide-react';

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const loginFormat = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const loginTime = value => value && Number.isFinite(Date.parse(value)) ? loginFormat.format(new Date(value)) : 'Not recorded yet';
const updateFormat = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
const updateTime = value => value && Number.isFinite(Date.parse(value)) ? updateFormat.format(new Date(value)) : 'Not recorded yet';
const dateFormat = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const reportDate = value => dateFormat.format(new Date(`${value}T12:00:00+05:30`));
const amount = value => typeof value === 'number' && Number.isFinite(value) ? money.format(value) : '—';

export default function StaffActivityView({ report, loading, error, start, end, rangeMode, expandedStaffId, onStaffToggle, onRangeChange, onStartChange, onEndChange, onApply, onToday }) {
  const unappliedDates = report && (report.period.start !== start || report.period.end !== end);
  const showingDetails = report?.staff.some(person => person.uid === expandedStaffId);
  return (
    <section aria-labelledby="staff-activity-title" className="space-y-4 rounded-xl border border-slate-700 bg-[#171c26] p-4 sm:p-5">
      <div>
        <h2 id="staff-activity-title" className="text-lg font-bold text-white">Staff activity</h2>
        <p className="mt-1 text-sm text-slate-300">Select a staff member to view attendance, working hours, sales and expenses.</p>
      </div>
      <form onSubmit={onApply} className="flex flex-wrap items-end gap-3">
        {!rangeMode && <DayCalendarPicker value={start} onChange={onStartChange} />}
        {rangeMode && <label className="w-full min-w-0 text-sm sm:w-auto sm:max-w-48 sm:flex-1">From
          <input type="date" required value={start} onChange={event => onStartChange(event.target.value)}
            className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-slate-600 bg-[#121620] px-3 py-2 text-white [color-scheme:dark]" />
        </label>}
        {rangeMode && <label className="w-full min-w-0 text-sm sm:w-auto sm:max-w-48 sm:flex-1">To
          <input type="date" required value={end} onChange={event => onEndChange(event.target.value)}
            className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-slate-600 bg-[#121620] px-3 py-2 text-white [color-scheme:dark]" />
        </label>}
        <button type="submit" disabled={loading} className="min-h-11 rounded-lg bg-orange-700 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-60">
          {loading ? 'Loading…' : rangeMode ? 'Apply / Refresh' : 'Refresh'}
        </button>
        {rangeMode && <button type="button" onClick={onToday} disabled={loading} className="min-h-11 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-60">Today</button>}
        <button type="button" onClick={onRangeChange} aria-pressed={Boolean(rangeMode)} disabled={loading} className="min-h-11 rounded-lg px-3 py-2 text-sm text-slate-300 underline underline-offset-4 hover:text-white disabled:opacity-60">{rangeMode ? 'Single day' : 'Date range'}</button>
      </form>
      {loading && <p role="status" className="py-4 text-sm text-slate-300">Loading staff activity…</p>}
      {error && <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/30 p-3 text-sm text-rose-200">{error}</p>}
      {!loading && !error && report && (
        <>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-400">
            <span>{unappliedDates ? `Showing ${reportDate(report.period.start)}${report.period.start === report.period.end ? '' : ` to ${reportDate(report.period.end)}`} · Apply to update` : 'India time'}</span>
            <span title={loginTime(report.generatedAt)}>Updated {updateTime(report.generatedAt)}</span>
          </div>
          {report.cashState === 'migration-required' && <p role="status" className="rounded-lg border border-amber-700/60 bg-amber-950/20 p-3 text-sm text-amber-200">Sales, expenses and recorded login times are available. Cash balances and billing require the reviewed financial migration before they can be used.</p>}
          {report.cashState === 'index-required' && <p role="status" className="rounded-lg border border-amber-700/60 bg-amber-950/20 p-3 text-sm text-amber-200">Sales, expenses and recorded login times are available. Cash reporting is waiting for the payment-history index. Publish the report indexes, wait for them to finish building, then refresh.</p>}
          {report.historyIncomplete && (!report.cashState || report.cashState === 'ready') && <p role="status" className="rounded-lg border border-amber-700/60 bg-amber-950/20 p-3 text-sm text-amber-200">This period includes pre-migration history. Older customer payments may be incomplete; reconcile the report with your records.</p>}
          {report.staff.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">No staff accounts or staff activity found for this period.</p> : (
            <div className="space-y-2">
              {report.staff.map(person => (
                <article key={person.uid} className="min-w-0 rounded-xl border border-[#2b3547] bg-[#121620]">
                  <h3>
                    <button type="button" aria-expanded={person.uid === expandedStaffId}
                      aria-controls={`staff-activity-details-${person.uid}`}
                      onClick={() => onStaffToggle(person.uid)}
                      className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl p-4 text-left hover:bg-slate-800/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-400">
                      <span className="min-w-0">
                        <span className="block break-words font-bold text-white">{person.name}</span>
                        <span className="mt-0.5 block break-all text-xs font-normal text-slate-400">{person.email || person.uid}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-slate-400">
                        <span className="hidden text-xs font-normal sm:inline">{person.uid === expandedStaffId ? 'Hide details' : 'View details'}</span>
                        <ChevronDown aria-hidden="true" className={`size-4 transition-transform ${person.uid === expandedStaffId ? 'rotate-180' : ''}`} />
                      </span>
                    </button>
                  </h3>
                  {person.uid === expandedStaffId && <div id={`staff-activity-details-${person.uid}`} role="region" aria-label={`Activity for ${person.name}`} className="px-4 pb-4">
                    <p className="text-xs text-slate-400">{person.bills} {person.bills === 1 ? 'bill' : 'bills'} in the selected period</p>
                    <StaffAttendanceView attendance={person.attendance} singleDay={report.period.start === report.period.end} />
                    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
                      <div><dt className="text-xs text-slate-400">Total sales</dt><dd className="mt-1 break-words text-lg font-semibold tabular-nums text-white">{money.format(person.totalSales)}</dd></div>
                      <div><dt className="text-xs text-slate-400">Total expenses</dt><dd className="mt-1 break-words text-lg font-semibold tabular-nums text-rose-300">{money.format(person.totalExpenses)}</dd></div>
                      <div><dt className="text-xs text-slate-400">Cash received</dt><dd className="mt-1 break-words text-lg font-semibold tabular-nums text-white">{amount(person.cashReceived)}</dd></div>
                      <div><dt className="text-xs text-slate-400">Cash remaining</dt><dd className={`mt-1 break-words text-lg font-bold tabular-nums ${person.remaining < 0 || person.needsReview || (report.cashState && report.cashState !== 'ready') ? 'text-amber-300' : 'text-emerald-300'}`}>{person.remaining == null ? (report.cashState && report.cashState !== 'ready' ? 'Setup required' : 'Needs review') : amount(person.remaining)}</dd></div>
                    </dl>
                    <p className="mt-4 border-t border-slate-700/70 pt-3 text-xs text-slate-400">Cash refunds {amount(person.cashRefunds)} · Cash expenses {amount(person.cashExpenses)}</p>
                    {person.needsReview && <p className="mt-2 text-xs text-amber-200">Some legacy activity has missing staff or tender details. Verify it before accepting a remaining balance.</p>}
                  </div>}
                </article>
              ))}
            </div>
          )}
          {showingDetails && <>
            <p className="text-xs leading-relaxed text-slate-400">Hours are counted through the last confirmed app contact and refresh every minute. Staff should use Sign out when finishing work. Connection gaps are excluded; overlapping sessions count once. Attendance before this feature was enabled is unavailable.</p>
            <p className="text-xs leading-relaxed text-slate-400">Cash remaining = cash received − cash refunds − cash expenses. Cash received includes cash sales after change and cash customer-account payments. UPI, card and unpaid credit sales are excluded. Opening float and cash handovers are not tracked.</p>
          </>}
        </>
      )}
    </section>
  );
}
