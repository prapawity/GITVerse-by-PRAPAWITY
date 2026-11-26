import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scheduler, type SchedulerDependencies } from './scheduler';
import type { NewSchedule, Schedule } from '../src/shared/scheduleState';
import { ScheduledCleanupError } from './git/scheduledCommand';

const start = Date.parse('2026-11-24T01:00:00Z');
const timing = { timeZone: 'Asia/Bangkok', hour: 9, minute: 0, weekday: null };
const input = (id: string): NewSchedule => ({
  id,
  name: id,
  action: 'fetch',
  timing,
  scope: { kind: 'open' },
});

function harness(initial: Schedule[] = []) {
  let state = structuredClone(initial);
  let now = start;
  const calls: string[] = [];
  const deps: SchedulerDependencies = {
    load: () => structuredClone(state),
    save: (next) => {
      state = structuredClone(next);
    },
    openRepositories: () => ['/one', '/two'],
    execute: async (repo) => {
      calls.push(repo);
      if (repo === '/two') throw new Error('sensitive remote URL');
      return { status: 'success' };
    },
    changed: () => {},
    now: () => now,
  };
  return {
    deps,
    calls,
    setTime: (value: number) => (now = value),
    state: () => structuredClone(state),
  };
}

test('multiple missed schedules are retained until selected or skipped', async () => {
  const h = harness();
  const scheduler = new Scheduler(h.deps);
  scheduler.add(input('one'));
  scheduler.add(input('two'));
  h.setTime(Date.parse('2026-11-26T03:00:00Z'));
  await scheduler.poll(false);
  assert.deepEqual(
    scheduler.list().map((schedule) => schedule.missed?.count),
    [3, 3],
  );
  assert.deepEqual(h.calls, []);
  await scheduler.runMissed(['one']);
  const [one, two] = scheduler.list();
  assert.equal(one.missed, null);
  assert.equal(one.history[0].status, 'partial');
  assert.equal(one.history[0].results[1].detail, 'Git operation failed. Check the repository and credentials.');
  assert.equal(two.missed?.count, 3);
  scheduler.skipMissed(['two']);
  assert.equal(scheduler.list()[1].missed, null);
  assert.equal(scheduler.list()[1].history[0].status, 'skipped');
  assert.equal(scheduler.list()[1].history[0].missed?.count, 3);
});

test('an on-time run is persisted before Git and unfinished work is recovered as interrupted', async () => {
  const h = harness();
  const scheduler = new Scheduler(h.deps);
  scheduler.add(input('one'));
  h.setTime(Date.parse('2026-11-24T02:00:10Z'));
  h.deps.execute = async (repo) => {
    assert.equal(h.state()[0].running?.status, 'running');
    return repo === '/one' ? { status: 'success' } : { status: 'skipped', reason: 'No remote' };
  };
  await scheduler.poll(true);
  assert.equal(scheduler.list()[0].history[0].status, 'partial');
  const now = h.state()[0].nextDue;
  h.setTime(now);
  let release: (() => void) | undefined;
  h.deps.execute = () => new Promise((resolve) => (release = () => resolve({ status: 'success' })));
  const running = scheduler.poll(true);
  assert.equal(h.state()[0].running?.status, 'running');
  const restarted = new Scheduler(h.deps);
  assert.equal(restarted.list()[0].history[0].status, 'interrupted');
  assert.equal(restarted.list()[0].running, null);
  assert.ok(release);
  release();
  // The original process would have stopped at restart; do not run the remaining repository.
  h.deps.openRepositories = () => [];
  h.deps.execute = async () => ({ status: 'success' });
  await running;
});

test('a storage failure prevents scheduled Git from starting', async () => {
  const h = harness();
  const scheduler = new Scheduler(h.deps);
  scheduler.add(input('one'));
  h.setTime(Date.parse('2026-11-24T02:00:01Z'));
  h.deps.save = () => {
    throw new Error('disk full');
  };
  await assert.rejects(scheduler.poll(true), /disk full/);
  assert.deepEqual(h.calls, []);
  assert.equal(scheduler.list()[0].running, null);
});

test('editing requires resolving missed work and re-enabling does not replay disabled time', async () => {
  const h = harness();
  const scheduler = new Scheduler(h.deps);
  scheduler.add(input('one'));
  scheduler.setEnabled('one', false);
  h.setTime(Date.parse('2026-11-26T03:00:00Z'));
  await scheduler.poll(false);
  scheduler.setEnabled('one', true);
  assert.equal(scheduler.list()[0].nextDue, Date.parse('2026-11-27T02:00:00Z'));
  assert.equal(scheduler.list()[0].missed, null);
  h.setTime(Date.parse('2026-11-27T03:00:00Z'));
  await scheduler.poll(false);
  assert.throws(() => scheduler.update({ ...input('one'), name: 'Changed' }), /Run or skip/);
  scheduler.skipMissed(['one']);
  scheduler.update({ ...input('one'), name: 'Changed' });
  assert.equal(scheduler.list()[0].name, 'Changed');
  assert.equal(scheduler.list()[0].history[0].status, 'skipped');
  scheduler.remove('one');
  assert.deepEqual(scheduler.list(), []);
});

test('retry failed runs only failed repositories from the selected history entry', async () => {
  const h = harness();
  const scheduler = new Scheduler(h.deps);
  scheduler.add(input('one'));
  await scheduler.runNow('one');
  const previous = scheduler.list()[0].history[0];
  assert.equal(previous.status, 'partial');
  h.calls.length = 0;
  h.deps.openRepositories = () => ['/different'];
  await scheduler.retryFailed('one', previous.id);
  assert.deepEqual(h.calls, ['/two']);
  assert.equal(scheduler.list()[0].history[0].status, 'failed');
  await assert.rejects(scheduler.retryFailed('one', 'missing'), /not found/);
});

test('uncertain cleanup retains the running state for explicit recovery', async () => {
  const h = harness();
  const scheduler = new Scheduler(h.deps);
  scheduler.add(input('one'));
  h.deps.execute = async () => {
    throw new ScheduledCleanupError();
  };
  await assert.rejects(scheduler.runNow('one'), ScheduledCleanupError);
  assert.equal(h.state()[0].running?.status, 'running');
  assert.equal(h.state()[0].history.length, 0);
});
