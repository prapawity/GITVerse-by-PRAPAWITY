import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectMissedSchedules, nextScheduleTime, type ScheduleTiming } from './scheduleTime';

const bangkok: ScheduleTiming = { timeZone: 'Asia/Bangkok', hour: 9, minute: 0, weekday: null };
const instant = (value: string) => Date.parse(value);

test('daily and weekly schedules use their configured time zone', () => {
  assert.equal(nextScheduleTime(bangkok, instant('2026-11-24T01:00:00Z')), instant('2026-11-24T02:00:00Z'));
  assert.equal(nextScheduleTime(bangkok, instant('2026-11-24T02:00:00Z')), instant('2026-11-25T02:00:00Z'));
  assert.equal(
    nextScheduleTime({ ...bangkok, weekday: 1 }, instant('2026-11-24T02:00:00Z')),
    instant('2026-11-30T02:00:00Z'),
  );
});

test('missed occurrences are counted and coalesced without moving the next regular run', () => {
  assert.deepEqual(collectMissedSchedules(bangkok, instant('2026-11-22T02:00:00Z'), instant('2026-11-24T03:00:00Z')), {
    count: 3,
    latest: instant('2026-11-24T02:00:00Z'),
    next: instant('2026-11-25T02:00:00Z'),
  });
  assert.deepEqual(collectMissedSchedules(bangkok, instant('2026-11-25T02:00:00Z'), instant('2026-11-24T03:00:00Z')), {
    count: 0,
    latest: null,
    next: instant('2026-11-25T02:00:00Z'),
  });
});

test('spring DST gaps are skipped and autumn overlaps run only once', () => {
  const newYork: ScheduleTiming = { timeZone: 'America/New_York', hour: 2, minute: 30, weekday: null };
  assert.equal(nextScheduleTime(newYork, instant('2026-03-08T05:00:00Z')), instant('2026-03-09T06:30:00Z'));
  const overlap = { ...newYork, hour: 1 };
  assert.equal(nextScheduleTime(overlap, instant('2026-11-01T04:00:00Z')), instant('2026-11-01T05:30:00Z'));
  assert.equal(nextScheduleTime(overlap, instant('2026-11-01T05:30:00Z')), instant('2026-11-02T06:30:00Z'));
});

test('invalid schedules and time zones are rejected', () => {
  assert.throws(() => nextScheduleTime({ ...bangkok, hour: 24 }, Date.now()), /Invalid schedule/);
  assert.throws(() => nextScheduleTime({ ...bangkok, weekday: 7 }, Date.now()), /Invalid schedule/);
  assert.throws(() => nextScheduleTime({ ...bangkok, timeZone: 'Not/A_Zone' }, Date.now()), RangeError);
  assert.throws(
    () => collectMissedSchedules({ ...bangkok, timeZone: 'Not/A_Zone' }, Date.now() + 60_000, Date.now()),
    RangeError,
  );
  assert.throws(() => collectMissedSchedules(bangkok, 9e15, Date.now()), /Invalid next schedule time/);
});
