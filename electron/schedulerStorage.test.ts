import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSchedule } from '../src/shared/scheduleState';
import { Scheduler, type SchedulerDependencies } from './scheduler';
import { loadSchedules, saveSchedules } from './schedulerStorage';

test('schedule state is persisted and validated on load', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitverse-schedules-'));
  try {
    assert.deepEqual(loadSchedules(dir), []);
    const item = createSchedule(
      {
        id: 'one',
        name: 'Fetch',
        action: 'fetch',
        timing: { timeZone: 'Asia/Bangkok', hour: 9, minute: 0, weekday: null },
        scope: { kind: 'open' },
      },
      Date.parse('2026-11-24T01:00:00Z'),
    );
    saveSchedules(dir, [item]);
    assert.deepEqual(loadSchedules(dir), [item]);
    const before = readFileSync(path.join(dir, 'schedules.json'), 'utf8');
    assert.throws(() => saveSchedules(dir, [item, item]), /Cannot save invalid schedules/);
    assert.equal(readFileSync(path.join(dir, 'schedules.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt schedule data is not replaced with an empty state', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitverse-schedules-'));
  try {
    const file = path.join(dir, 'schedules.json');
    writeFileSync(file, '{invalid');
    assert.throws(() => loadSchedules(dir), /invalid.*not been overwritten/);
    assert.equal(readFileSync(file, 'utf8'), '{invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missed schedules survive a scheduler restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitverse-schedules-'));
  try {
    let now = Date.parse('2026-11-24T01:00:00Z');
    const deps: SchedulerDependencies = {
      load: () => loadSchedules(dir),
      save: (items) => saveSchedules(dir, items),
      openRepositories: () => [],
      execute: async () => ({ status: 'success' }),
      changed: () => {},
      now: () => now,
    };
    const scheduler = new Scheduler(deps);
    scheduler.add({
      id: 'one',
      name: 'Fetch',
      action: 'fetch',
      timing: { timeZone: 'Asia/Bangkok', hour: 9, minute: 0, weekday: null },
      scope: { kind: 'open' },
    });

    now = Date.parse('2026-11-26T03:00:00Z');
    await scheduler.poll(false);
    const restored = new Scheduler(deps);
    assert.deepEqual(restored.list()[0].missed, { count: 3, latest: Date.parse('2026-11-26T02:00:00Z') });
    await restored.runMissed(['one']);
    const afterRun = new Scheduler(deps).list()[0];
    assert.equal(afterRun.missed, null);
    assert.equal(afterRun.history[0].status, 'skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads the shared Electron and Tauri schedule fixture', () => {
  const dir = path.resolve(__dirname, '../fixtures/scheduler');
  const raw = JSON.parse(readFileSync(path.join(dir, 'schedules.json'), 'utf8'));
  assert.deepEqual(loadSchedules(dir), raw.schedules);
});

test('rejects missing nullable fields, null optional fields and unsafe counts', () => {
  const fixture = path.resolve(__dirname, '../fixtures/scheduler/schedules.json');
  const original = JSON.parse(readFileSync(fixture, 'utf8'));
  const dir = mkdtempSync(path.join(tmpdir(), 'gitverse-schedules-'));
  try {
    for (const field of ['weekday', 'missed', 'running', 'detail', 'runMissed', 'count']) {
      const state = structuredClone(original);
      const item = state.schedules[0];
      if (field === 'weekday') delete item.timing.weekday;
      if (field === 'missed' || field === 'running') delete item[field];
      if (field === 'detail') item.history[0].results[0].detail = null;
      if (field === 'runMissed') item.history[0].missed = null;
      if (field === 'count') item.missed.count = Number.MAX_SAFE_INTEGER + 1;
      writeFileSync(path.join(dir, 'schedules.json'), JSON.stringify(state));
      assert.throws(() => loadSchedules(dir), /invalid.*not been overwritten/, field);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
