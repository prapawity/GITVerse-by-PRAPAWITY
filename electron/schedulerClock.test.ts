import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SchedulerClock } from './schedulerClock';

test('startup and resume poll without automatically executing missed work', async () => {
  const calls: boolean[] = [];
  let tick = () => {};
  const clock = new SchedulerClock({
    poll: async (canRunOnTime) => {
      calls.push(canRunOnTime);
    },
    onError: (error) => {
      throw error;
    },
    setInterval: (callback) => {
      tick = callback;
      return () => {};
    },
  });
  await clock.start();
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  clock.suspend();
  tick();
  clock.resume();
  await new Promise((resolve) => setImmediate(resolve));
  clock.stop();
  assert.deepEqual(calls, [false, true, false]);
});

test('a resume is not lost while an earlier poll is running', async () => {
  const calls: boolean[] = [];
  let release: (() => void) | undefined;
  let tick = () => {};
  const clock = new SchedulerClock({
    poll: async (canRunOnTime) => {
      calls.push(canRunOnTime);
      if (calls.length === 2) await new Promise<void>((resolve) => (release = resolve));
    },
    onError: (error) => {
      throw error;
    },
    setInterval: (callback) => {
      tick = callback;
      return () => {};
    },
  });
  await clock.start();
  tick();
  clock.suspend();
  clock.resume();
  tick();
  assert.ok(release);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  clock.stop();
  assert.deepEqual(calls, [false, true, false]);
});

test('a poll failure stops timer execution and is reported', async () => {
  let tick = () => {};
  let stopped = false;
  const errors: unknown[] = [];
  const failure = new Error('disk error');
  let calls = 0;
  const clock = new SchedulerClock({
    poll: async () => {
      calls++;
      if (calls === 2) throw failure;
    },
    onError: (error) => errors.push(error),
    setInterval: (callback) => {
      tick = callback;
      return () => {
        stopped = true;
      };
    },
  });
  await clock.start();
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
  assert.equal(calls, 2);
  assert.deepEqual(errors, [failure]);
});

test('a tick arriving as a poll settles is not lost', async () => {
  const calls: boolean[] = [];
  let release: (() => void) | undefined;
  let tick = () => {};
  const clock = new SchedulerClock({
    poll: async (canRunOnTime) => {
      calls.push(canRunOnTime);
      if (calls.length === 2) await new Promise<void>((resolve) => (release = resolve));
    },
    onError: (error) => {
      throw error;
    },
    setInterval: (callback) => {
      tick = callback;
      return () => {};
    },
  });
  await clock.start();
  tick();
  assert.ok(release);
  release();
  queueMicrotask(tick);
  await new Promise((resolve) => setImmediate(resolve));
  clock.stop();
  assert.deepEqual(calls, [false, true, true]);
});
