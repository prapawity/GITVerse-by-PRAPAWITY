import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSchedule,
  beginScheduleRun,
  createSchedule,
  finishScheduleRun,
  recoverSchedule,
  skipMissedSchedule,
  type NewSchedule,
} from './scheduleState';

const start = Date.parse('2026-11-24T01:00:00Z');
const input: NewSchedule = {
  id: 'morning',
  name: 'Morning fetch',
  action: 'fetch',
  timing: { timeZone: 'Asia/Bangkok', hour: 9, minute: 0, weekday: null },
  scope: { kind: 'open' },
};

test('startup coalesces missed occurrences until explicitly run or skipped', () => {
  const first = createSchedule(input, start);
  const now = Date.parse('2026-11-27T03:00:00Z');
  const due = advanceSchedule(first, now, false, 'unused');
  assert.equal(due.shouldRun, false);
  assert.deepEqual(due.schedule.missed, { count: 4, latest: Date.parse('2026-11-27T02:00:00Z') });
  assert.equal(due.schedule.nextDue, Date.parse('2026-11-28T02:00:00Z'));
  assert.deepEqual(advanceSchedule(due.schedule, now, false, 'unused').schedule.missed, due.schedule.missed);
  const skipped = skipMissedSchedule(due.schedule, 'skipped-1', now);
  assert.equal(skipped.missed, null);
  assert.equal(skipped.history[0].status, 'skipped');
  assert.equal(skipped.history[0].missed?.count, 4);
});

test('running a missed schedule consumes only its own pending decision and preserves the next run', () => {
  const first = advanceSchedule(
    createSchedule(input, start),
    Date.parse('2026-11-25T03:00:00Z'),
    false,
    'unused',
  ).schedule;
  const running = beginScheduleRun(first, 'run-1', start, 'missed');
  assert.equal(running.missed, null);
  assert.equal(running.nextDue, first.nextDue);
  assert.throws(() => beginScheduleRun(running, 'run-2', start, 'manual'), /already running/);
  const finished = finishScheduleRun(running, 'run-1', [
    { repo: '/a', status: 'success' },
    { repo: '/b', status: 'failed', detail: 'Network error' },
  ]);
  assert.equal(finished.history[0].status, 'partial');
  assert.equal(finished.running, null);
  assert.throws(() => finishScheduleRun(finished, 'run-1', []), /no longer active/);
});

test('on-time runs do not consume earlier pending decisions; restart marks in-flight work interrupted', () => {
  const first = advanceSchedule(
    createSchedule(input, start),
    Date.parse('2026-11-24T03:00:00Z'),
    false,
    'unused',
  ).schedule;
  const onTime = advanceSchedule(first, Date.parse('2026-11-25T02:00:10Z'), true, 'run-1');
  assert.equal(onTime.shouldRun, true);
  const running = onTime.schedule;
  assert.equal(running.running?.id, 'run-1');
  assert.deepEqual(running.missed, first.missed);
  const recovered = recoverSchedule(running);
  assert.equal(recovered.running, null);
  assert.equal(recovered.history[0].status, 'interrupted');
  assert.deepEqual(recovered.missed, first.missed);
});

test('late, overlapping, and disabled schedules do not automatically run', () => {
  const first = createSchedule(input, start);
  assert.equal(advanceSchedule(first, first.nextDue + 31_000, true, 'unused').shouldRun, false);
  const running = beginScheduleRun(first, 'run-1', start, 'manual');
  const overlapping = advanceSchedule(running, first.nextDue, true, 'unused');
  assert.equal(overlapping.shouldRun, false);
  assert.equal(overlapping.schedule.missed?.count, 1);
  assert.equal(advanceSchedule({ ...first, enabled: false }, first.nextDue, true, 'unused').shouldRun, false);
});

test('empty or wholly skipped runs are not reported as success', () => {
  const first = createSchedule(input, start);
  const run = beginScheduleRun(first, 'run-1', start, 'manual');
  assert.equal(finishScheduleRun(run, 'run-1', []).history[0].status, 'skipped');
  assert.equal(finishScheduleRun(run, 'run-1', [{ repo: '/a', status: 'skipped' }]).history[0].status, 'skipped');
});
