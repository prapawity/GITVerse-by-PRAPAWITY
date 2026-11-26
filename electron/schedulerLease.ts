import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { loadSchedules } from './schedulerStorage';

const message =
  'Another GITVerse scheduler may be running, or its previous run was interrupted. Close other instances and ensure their Git processes have stopped before resolving the scheduler lock.';

export function acquireSchedulerLease(dir: string, recoverInterrupted = false): () => void {
  mkdirSync(dir, { recursive: true });
  const guard = path.join(dir, 'schedules.lock.guard');
  const lock = path.join(dir, 'schedules.lock');
  try {
    mkdirSync(guard);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  const token = randomUUID();
  try {
    if (existsSync(lock)) {
      let owner: { pid?: unknown; token?: unknown };
      try {
        owner = JSON.parse(readFileSync(lock, 'utf8'));
      } catch (error) {
        throw new Error(message, { cause: error });
      }
      if (
        !owner ||
        !Number.isSafeInteger(owner.pid) ||
        typeof owner.pid !== 'number' ||
        owner.pid <= 0 ||
        owner.pid > 2_147_483_647 ||
        typeof owner.token !== 'string' ||
        !owner.token
      )
        throw new Error(message);
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') alive = false;
        else throw new Error(message, { cause: error });
      }
      if (alive) throw new Error(message);
      const interrupted = loadSchedules(dir).some((item) => item.running);
      if (!recoverInterrupted && interrupted) throw new Error(message);
      unlinkSync(lock);
    }
    const fd = openSync(lock, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }), { flush: true });
    } finally {
      closeSync(fd);
    }
  } finally {
    rmdirSync(guard);
  }
  return () => {
    mkdirSync(guard);
    try {
      const owner: { token?: unknown } = JSON.parse(readFileSync(lock, 'utf8'));
      if (owner.token !== token) throw new Error('Scheduler lock ownership changed.');
      unlinkSync(lock);
    } finally {
      rmdirSync(guard);
    }
  };
}
