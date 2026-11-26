import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { beginScheduleRun } from '../src/shared/scheduleState';
import { acquireSchedulerLease } from './schedulerLease';
import { loadSchedules, saveSchedules } from './schedulerStorage';

test('only one scheduler owns the shared state and a clean release permits restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitverse-scheduler-lease-'));
  try {
    const release = acquireSchedulerLease(dir);
    assert.throws(() => acquireSchedulerLease(dir), /Another GITVerse scheduler/);
    assert.throws(() => acquireSchedulerLease(dir, true), /Another GITVerse scheduler/);
    release();
    acquireSchedulerLease(dir)();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale locks are recovered only when no run was interrupted', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitverse-scheduler-lease-'));
  const lock = path.join(dir, 'schedules.lock');
  const stale = JSON.stringify({ pid: 2_147_483_647, token: 'old' });
  try {
    writeFileSync(lock, stale);
    acquireSchedulerLease(dir)();
    const fixture = path.resolve(__dirname, '../fixtures/scheduler');
    const [item] = loadSchedules(fixture);
    saveSchedules(dir, [beginScheduleRun(item, 'running', Date.now(), 'manual')]);
    writeFileSync(lock, stale);
    assert.throws(() => acquireSchedulerLease(dir), /previous run was interrupted/);
    assert.equal(readFileSync(lock, 'utf8'), stale);
    acquireSchedulerLease(dir, true)();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
