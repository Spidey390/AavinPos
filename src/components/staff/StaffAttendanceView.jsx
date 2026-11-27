import React from 'react';

const time = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
const date = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const dayStamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? time.format(new Date(value)) : 'Not recorded';
export function workingTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Not recorded';
  const minutes = Math.floor(value / 60000);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export default function StaffAttendanceView({ attendance, singleDay }) {
  if (!attendance) return <p className="mt-4 text-sm text-amber-200">Attendance is not available yet. Refresh after the backend is updated.</p>;
  return (
    <div className="mt-4 space-y-4 border-t border-slate-700/70 pt-4">
      <dl className="grid grid-cols-2 gap-4">
        <div><dt className="text-xs text-slate-400">Working hours today</dt><dd className="mt-1 text-xl font-bold tabular-nums text-white">{workingTime(attendance.today.workingMs)}</dd><dd className="mt-1 text-xs text-slate-400">{date.format(new Date(`${attendance.today.date}T12:00:00+05:30`))}</dd></div>
        <div><dt className="text-xs text-slate-400">{singleDay ? 'Selected day’s hours' : 'Selected period’s hours'}</dt><dd className="mt-1 text-xl font-bold tabular-nums text-orange-300">{workingTime(attendance.workingMs)}</dd></div>
      </dl>
      <div className="space-y-4">
        {attendance.days.map(day => (
          <div key={day.date}>
            <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-slate-300">
              <h4 className="font-semibold">{date.format(new Date(`${day.date}T12:00:00+05:30`))}</h4>
              <span>{workingTime(day.workingMs)} total</span>
            </div>
            {!day.sessions.length ? <p className="text-xs text-slate-400">No sessions recorded for this day.</p> : (
              <div className="space-y-2">
                {day.sessions.map(session => (
                  <div key={session.id} className="rounded-lg border border-slate-700/70 bg-slate-900/30 p-3">
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-3">
                      <div><dt className="text-slate-400">Login time</dt><dd className="mt-1 font-medium text-slate-100">{timestamp(session.startedAt)}</dd></div>
                      <div><dt className="text-slate-400">Logout time</dt><dd className="mt-1 font-medium text-slate-100">{session.status === 'active' ? 'Still signed in' : session.logoutAt ? `${dayStamp.format(new Date(session.logoutAt)) === day.date ? '' : `${date.format(new Date(session.logoutAt))}, `}${timestamp(session.logoutAt)}` : session.status === 'continued' ? 'Continues next day' : 'Not recorded'}</dd></div>
                      <div><dt className="text-slate-400">Working hours</dt><dd className="mt-1 font-medium tabular-nums text-slate-100">{workingTime(session.workingMs)}</dd></div>
                    </dl>
                    {session.loginAt < session.startedAt && <p className="mt-2 text-xs text-slate-400">Continued from {date.format(new Date(session.loginAt))}, {timestamp(session.loginAt)}.</p>}
                    {session.status === 'interrupted' && <p className="mt-2 text-xs text-amber-200">Connection interrupted. Hours counted until {timestamp(session.endedAt)}.</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
