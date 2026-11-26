import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import type { NewSchedule } from '../src/shared/scheduleState';
import { RepositoryQueue } from './git/repositoryQueue';
import { queuedScheduledGit } from './git/queuedScheduled';
import { Scheduler } from './scheduler';
import { SchedulerClock } from './schedulerClock';
import { loadSchedules, saveSchedules } from './schedulerStorage';
import { acquireSchedulerLease } from './schedulerLease';
import { ScheduledCleanupError } from './git/scheduledCommand';

export function registerScheduler(win: BrowserWindow, queue: RepositoryQueue): void {
  let repositories: string[] = [];
  let scheduler: Scheduler | null = null;
  let clock: SchedulerClock | null = null;
  let started = false;
  let starting: Promise<void> | null = null;
  let rendererReady = false;
  let failure: string | null = null;
  let releaseLease: (() => void) | null = null;
  let unsafeCleanup = false;
  const notify = () => {
    if (!win.isDestroyed()) win.webContents.send('scheduler:changed');
  };
  const fail = (error: unknown) => {
    if (error instanceof ScheduledCleanupError) unsafeCleanup = true;
    failure = error instanceof Error ? error.message : 'The scheduler stopped unexpectedly.';
    console.error('[scheduler]', error);
    notify();
  };
  const get = () => {
    if (!scheduler) throw new Error(failure ?? 'The scheduler is not ready.');
    if (failure) throw new Error(`The scheduler is paused: ${failure}`);
    return scheduler;
  };
  const create = () =>
    new Scheduler({
      load: () => loadSchedules(app.getPath('userData')),
      save: (items) => {
        try {
          saveSchedules(app.getPath('userData'), items);
        } catch (error) {
          clock?.stop();
          fail(error);
          throw error;
        }
      },
      openRepositories: () => repositories,
      execute: (repo, action) => queuedScheduledGit(queue, repo, action, false),
      changed: notify,
      now: Date.now,
    });
  const updateRepositories = (repos: string[]) => {
    if (!Array.isArray(repos) || repos.some((repo) => typeof repo !== 'string' || !repo))
      throw new Error('Invalid open repository list.');
    repositories = [...new Set(repos)];
  };
  const start = (recoverInterrupted = false) => {
    if (unsafeCleanup) throw new ScheduledCleanupError();
    if (started && !failure) return;
    if (starting) return starting;
    starting = (async () => {
      clock?.stop();
      scheduler = null;
      failure = null;
      try {
        releaseLease ??= acquireSchedulerLease(app.getPath('userData'), recoverInterrupted);
        scheduler = create();
        clock = new SchedulerClock({
          poll: (canRunOnTime) => get().poll(canRunOnTime),
          onError: fail,
          setInterval: (callback, ms) => {
            const timer = setInterval(callback, ms);
            return () => clearInterval(timer);
          },
        });
        await clock.start();
        started = true;
        if (!rendererReady) clock.suspend();
        notify();
      } catch (error) {
        if (!failure) fail(error);
        throw error;
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  };
  ipcMain.handle('scheduler:init', async (_event, repos: string[]) => {
    updateRepositories(repos);
    rendererReady = true;
    if (!started || failure) await start();
    else clock?.resume();
    return { schedules: get().list(), error: failure };
  });
  ipcMain.handle('scheduler:repos', (_event, repos: string[]) => updateRepositories(repos));
  ipcMain.handle('scheduler:list', () => {
    if (!scheduler) throw new Error(failure ?? 'The scheduler is not ready.');
    return { schedules: scheduler.list(), error: failure };
  });
  ipcMain.handle('scheduler:retry', async () => {
    await start();
    return { schedules: get().list(), error: failure };
  });
  ipcMain.handle('scheduler:recover', async () => {
    await start(true);
    return { schedules: get().list(), error: failure };
  });
  ipcMain.handle('scheduler:add', (_event, input: NewSchedule) => get().add(input));
  ipcMain.handle('scheduler:update', (_event, input: NewSchedule) => get().update(input));
  ipcMain.handle('scheduler:enable', (_event, id: string, enabled: boolean) => get().setEnabled(id, enabled));
  ipcMain.handle('scheduler:remove', (_event, id: string) => get().remove(id));
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      if (error instanceof ScheduledCleanupError) fail(error);
      throw error;
    }
  };
  ipcMain.handle('scheduler:run', (_event, id: string) => run(() => get().runNow(id)));
  ipcMain.handle('scheduler:retryFailed', (_event, id: string, previousRunId: string) =>
    run(() => get().retryFailed(id, previousRunId)),
  );
  ipcMain.handle('scheduler:runMissed', (_event, ids: string[]) => run(() => get().runMissed(ids)));
  ipcMain.handle('scheduler:skipMissed', (_event, ids: string[]) => get().skipMissed(ids));
  const suspend = () => clock?.suspend();
  const resume = () => {
    if (rendererReady) clock?.resume();
  };
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('resume', resume);
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
    suspend();
  });
  win.webContents.on('render-process-gone', () => {
    rendererReady = false;
    suspend();
  });
  win.on('closed', () => {
    clock?.stop();
    powerMonitor.removeListener('suspend', suspend);
    powerMonitor.removeListener('resume', resume);
  });
  app.on('will-quit', () => {
    clock?.stop();
    if (releaseLease && scheduler && !scheduler.list().some((item) => item.running)) {
      try {
        releaseLease();
      } catch (error) {
        console.error('[scheduler] Could not release the scheduler lock:', error);
      }
    }
  });
}
