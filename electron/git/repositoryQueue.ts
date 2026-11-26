import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ScheduledCleanupError } from './scheduledCommand';

const exec = promisify(execFile);

export class RepositoryBusyError extends Error {
  constructor() {
    super('Another Git operation is in progress.');
  }
}

interface Waiter {
  acquire: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Queue {
  waiters: Waiter[];
}

export async function repositoryKey(repo: string): Promise<string> {
  if (typeof repo !== 'string' || !repo) throw new Error('A repository path is required.');
  const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], {
    cwd: repo,
    timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const gitDir = stdout.replace(/\r?\n$/, '');
  if (!gitDir) throw new Error('Could not determine the repository Git directory.');
  return realpath(path.resolve(repo, gitDir));
}

/** Coordinates only operations that enter this queue, not external Git processes. */
export class RepositoryQueue {
  private readonly queues = new Map<string, Queue>();
  private readonly poisoned = new Set<string>();

  constructor(private readonly resolveKey: (repo: string) => Promise<string> = repositoryKey) {}

  async run<T>(repo: string, operation: () => Promise<T>, waitMs?: number): Promise<T> {
    if (waitMs !== undefined && (!Number.isFinite(waitMs) || waitMs < 0))
      throw new Error('Invalid repository wait timeout.');
    const key = await this.resolveKey(repo);
    await this.acquire(key, waitMs);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ScheduledCleanupError) this.poisoned.add(key);
      throw error;
    } finally {
      this.release(key);
    }
  }

  private acquire(key: string, waitMs?: number): Promise<void> {
    if (this.poisoned.has(key)) return Promise.reject(new ScheduledCleanupError());
    const existing = this.queues.get(key);
    if (!existing) {
      this.queues.set(key, { waiters: [] });
      return Promise.resolve();
    }
    if (waitMs === 0) return Promise.reject(new RepositoryBusyError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { acquire: resolve, reject };
      if (waitMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = existing.waiters.indexOf(waiter);
          if (index >= 0) existing.waiters.splice(index, 1);
          reject(new RepositoryBusyError());
        }, waitMs);
      }
      existing.waiters.push(waiter);
    });
  }

  private release(key: string) {
    const queue = this.queues.get(key);
    if (!queue) throw new Error('Repository queue is not held.');
    if (this.poisoned.has(key)) {
      for (const waiter of queue.waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new ScheduledCleanupError());
      }
      this.queues.delete(key);
      return;
    }
    const next = queue.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.acquire();
    } else {
      this.queues.delete(key);
    }
  }
}
