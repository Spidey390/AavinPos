import assert from 'node:assert/strict';
import test from 'node:test';
import { attendanceDates, summarizeAttendance } from '../src/attendance.js';
import { reportPeriod } from '../src/staff.js';

const at = time => Date.parse(`2026-11-27T${time}:00Z`);
const record = (id, from, until, extra = {}) => ({ day: '2026-11-27', sessionId: id, loginAt: from, startedAt: from, lastSeenAt: until, endedAt: until, logoutAt: until, status: 'signed-out', ...extra });

test('attendance unions overlapping devices and repeated tabs instead of inflating working hours', () => {
  const records = [record('a', new Date(at('09:00')).toISOString(), new Date(at('11:00')).toISOString()), record('b', new Date(at('10:00')).toISOString(), new Date(at('12:00')).toISOString()), record('c', new Date(at('13:00')).toISOString(), new Date(at('14:00')).toISOString())];
  const result = summarizeAttendance(records, reportPeriod('2026-11-27', '2026-11-27'), at('15:00'));
  assert.equal(result.workingMs, 4 * 3600000);
  assert.equal(result.today.workingMs, result.workingMs);
  assert.equal(result.days[0].sessions.length, 3);
});

test('today and selected historical day have independent totals and use India midnight', () => {
  const records = [record('previous', '2026-11-26T17:30:00Z', '2026-11-26T18:30:00Z', { day: '2026-11-26', status: 'continued', logoutAt: null }), record('today', '2026-11-26T18:30:00Z', '2026-11-26T19:00:00Z')];
  const result = summarizeAttendance(records, reportPeriod('2026-11-26', '2026-11-26'), at('09:00'));
  assert.equal(result.workingMs, 3600000);
  assert.equal(result.today.workingMs, 1800000);
  assert.deepEqual(attendanceDates(reportPeriod('2026-11-26', '2026-11-26'), at('09:00')), ['2026-11-26', '2026-11-27']);
});

test('active and disconnected sessions count only through verified contact, never through an absent logout', () => {
  const open = record('open', '2026-11-27T09:00:00Z', '2026-11-27T09:01:00Z', { status: 'open', endedAt: null, logoutAt: null });
  const active = summarizeAttendance([open], reportPeriod('2026-11-27', '2026-11-27'), at('09:02'));
  const stale = summarizeAttendance([open], reportPeriod('2026-11-27', '2026-11-27'), at('18:00'));
  assert.equal(active.workingMs, 60000); assert.equal(active.days[0].sessions[0].status, 'active');
  assert.equal(stale.workingMs, 60000); assert.equal(stale.days[0].sessions[0].status, 'interrupted');
  assert.equal(stale.days[0].sessions[0].logoutAt, null);
});

test('attendance rejects malformed or reversed records and keeps absent historical days empty', () => {
  assert.throws(() => summarizeAttendance([record('bad', 'invalid', 'invalid')], reportPeriod('2026-11-27', '2026-11-27'), at('12:00')));
  assert.throws(() => summarizeAttendance([record('bad', '2026-11-27T12:00:00Z', '2026-11-27T11:00:00Z')], reportPeriod('2026-11-27', '2026-11-27'), at('12:00')));
  const empty = summarizeAttendance([], reportPeriod('2026-11-26', '2026-11-26'), at('12:00'));
  assert.equal(empty.workingMs, 0); assert.deepEqual(empty.days[0].sessions, []);
});
