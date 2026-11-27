import { HttpsError } from 'firebase-functions/v2/https';
import { fingerprint, id, object } from './financial.js';

export const SESSION_GRACE_MS = 125000;
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export const attendanceDate = value => dateFormat.format(new Date(value));
const iso = value => new Date(value).toISOString();
const midnight = date => Date.parse(`${date}T00:00:00+05:30`);
const fail = (code, message) => { throw new HttpsError(code, message); };

export function attendanceDates(period, now) {
  const dates = new Set([attendanceDate(now)]);
  for (let time = midnight(period.start); time < midnight(period.end) + 86400000; time += 86400000) dates.add(attendanceDate(time));
  return [...dates].sort();
}

function unionDuration(intervals) {
  let total = 0, end = -Infinity;
  for (const [from, until] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, until - Math.max(from, end));
    end = Math.max(end, until);
  }
  return total;
}

export function summarizeAttendance(records, period, now) {
  const today = attendanceDate(now), dates = attendanceDates(period, now), days = [];
  for (const date of dates) {
    const from = midnight(date), until = from + 86400000;
    const sessions = records.filter(record => record.day === date).map(record => {
      const start = Date.parse(record.startedAt), seen = Date.parse(record.lastSeenAt);
      const active = record.status === 'open' && now >= seen && now - seen <= SESSION_GRACE_MS;
      // Count verified contact only; a closed browser never adds speculative time.
      const end = Math.min(record.endedAt ? Date.parse(record.endedAt) : seen, until);
      if (![start, seen, end].every(Number.isFinite) || end < start || start < from || start >= until || end > until) fail('failed-precondition', 'An attendance record requires administrator review.');
      return { id: record.sessionId, loginAt: record.loginAt, startedAt: record.startedAt, logoutAt: record.logoutAt ?? null,
        endedAt: record.endedAt ?? (active ? (now >= until ? iso(until) : null) : record.lastSeenAt), lastSeenAt: record.lastSeenAt,
        status: active ? (now >= until ? 'continued' : 'active') : record.status === 'open' ? 'interrupted' : record.status,
        workingMs: Math.max(0, end - start), from: start, until: end };
    }).sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
    days.push({ date, workingMs: unionDuration(sessions.map(session => [session.from, session.until])),
      sessions: sessions.map(({ from, until, ...session }) => session) });
  }
  return { today: days.find(day => day.date === today), days: days.filter(day => day.date >= period.start && day.date <= period.end),
    workingMs: days.filter(day => day.date >= period.start && day.date <= period.end).reduce((total, day) => total + day.workingMs, 0) };
}

// Attendance clocks and identity come only from the trusted runtime and verified
// token. Daily fragments avoid collection-group/composite indexes and split at IST midnight.
export function createAttendanceService(db, { clock = Date.now } = {}) {
  async function record(request, logout) {
    object(request.data, []);
    const uid = request.auth?.uid, authTime = request.auth?.token?.auth_time;
    if (!id(uid) || !Number.isSafeInteger(authTime) || authTime <= 0 || authTime > clock() / 1000 + 300) fail('unauthenticated', 'A verified sign-in timestamp is required.');
    const key = fingerprint([uid, authTime]);
    return db.runTransaction(async tx => {
      const profile = (await tx.get(db.doc(`operators/${uid}`))).data();
      if (!profile?.active || !['owner', 'staff'].includes(profile.role)) fail('permission-denied', 'Operator access denied.');
      if (profile.role === 'owner') return { recorded: false };
      const activityRef = db.doc(`operatorActivity/${uid}`), sessionRef = activityRef.collection('sessions').doc(key);
      const [activity, snapshot] = await Promise.all([tx.get(activityRef), tx.get(sessionRef)]);
      const previous = snapshot.data(), now = clock();
      if (previous?.logoutAt) {
        if (logout) return { recorded: true, closed: true };
        fail('failed-precondition', 'This session has ended. Sign out and sign in again.');
      }
      if (previous && now < Date.parse(previous.lastSeenAt)) fail('unavailable', 'The attendance clock is unavailable. Retry shortly.');
      if (!logout && previous && now - Date.parse(previous.lastSeenAt) < 15000) return { recorded: true, closed: false };
      const stale = previous && now - Date.parse(previous.lastSeenAt) > SESSION_GRACE_MS;
      const resume = !previous || (stale && !logout);
      const sequence = resume ? (previous?.sequence ?? 0) + 1 : previous.sequence;
      const startedAt = resume ? now : Date.parse(previous.startedAt);
      const sessionId = `${key}-${sequence}`;
      const lastSeen = previous ? Date.parse(previous.lastSeenAt) : now;
      const end = logout && stale ? lastSeen : now;
      const updates = new Map();
      const putDay = (time, segmentStart, segmentId, status, seenAt, endedAt = null, logoutAt = null) => {
        const day = attendanceDate(time), dayStart = midnight(day);
        const ref = db.doc(`staffAttendanceDays/${day}/sessions/${segmentId}`);
        updates.set(ref.path, { ref, data: { uid, name: profile.name || profile.email || 'Staff', day, sessionId: segmentId,
          loginAt: iso(segmentStart), startedAt: iso(Math.max(segmentStart, dayStart)), lastSeenAt: iso(seenAt), status,
          endedAt: endedAt === null ? null : iso(endedAt), logoutAt: logoutAt === null ? null : iso(logoutAt) } });
      };
      if (stale && !logout) {
        putDay(lastSeen, Date.parse(previous.startedAt), `${key}-${previous.sequence}`, 'interrupted', lastSeen, lastSeen);
      }
      if (!resume && !stale && attendanceDate(lastSeen) !== attendanceDate(now)) {
        const boundary = midnight(attendanceDate(now));
        putDay(lastSeen, startedAt, sessionId, 'continued', boundary, boundary);
      }
      // An offline sign-out ends counted time at the last verified contact.
      putDay(end, startedAt, sessionId, logout ? (stale ? 'interrupted' : 'signed-out') : 'open', end, logout ? end : null, logout ? now : null);
      if ((activity.data()?.authTime ?? 0) < authTime) tx.set(activityRef, { authTime, lastLoginAt: iso(authTime * 1000), name: profile.name || 'Staff', email: profile.email ?? '', recordedAt: iso(now) }, { merge: true });
      for (const { ref, data } of updates.values()) tx.set(ref, data);
      tx.set(sessionRef, { uid, authTime, sequence, startedAt: iso(startedAt), lastSeenAt: iso(end), logoutAt: logout ? iso(now) : null });
      return { recorded: true, closed: logout };
    });
  }
  return { recordStaffLogin: request => record(request, false), recordStaffLogout: request => record(request, true) };
}
