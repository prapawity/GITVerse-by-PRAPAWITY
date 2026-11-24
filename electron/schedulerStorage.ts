import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { nextScheduleTime } from '../src/shared/scheduleTime';
import type { Schedule } from '../src/shared/scheduleState';

const nonempty = z.string().min(1);
const instant = z
  .number()
  .int()
  .refine((value) => Number.isFinite(new Date(value).getTime()));
const missed = z.object({ count: z.number().int().positive(), latest: instant }).strict();
const result = z
  .object({
    repo: nonempty,
    status: z.enum(['success', 'skipped', 'failed']),
    detail: z.string().optional(),
  })
  .strict();
const run = z
  .object({
    id: nonempty,
    startedAt: instant,
    trigger: z.enum(['scheduled', 'missed', 'manual']),
    status: z.enum(['running', 'success', 'partial', 'failed', 'skipped', 'interrupted']),
    results: z.array(result),
    missed: missed.optional(),
  })
  .strict();
const schedule = z
  .object({
    id: nonempty,
    name: nonempty,
    action: z.enum(['fetch', 'pull', 'refresh']),
    timing: z
      .object({
        timeZone: nonempty,
        hour: z.number().int().min(0).max(23),
        minute: z.number().int().min(0).max(59),
        weekday: z.number().int().min(0).max(6).nullable(),
      })
      .strict(),
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('open') }).strict(),
      z.object({ kind: z.literal('selected'), repos: z.array(nonempty).min(1) }).strict(),
    ]),
    enabled: z.boolean(),
    nextDue: instant,
    missed: missed.nullable(),
    running: run.nullable(),
    history: z.array(run).max(20),
  })
  .strict();
const state = z.object({ version: z.literal(1), schedules: z.array(schedule) }).strict();

function validateState(value: unknown): Schedule[] {
  const parsed = state.parse(value);
  if (new Set(parsed.schedules.map((item) => item.id)).size !== parsed.schedules.length)
    throw new Error('Duplicate schedule IDs.');
  for (const item of parsed.schedules) {
    nextScheduleTime(item.timing, item.nextDue);
    if (item.running && item.running.status !== 'running') throw new Error('Invalid active run status.');
    if (item.history.some((entry) => entry.status === 'running')) throw new Error('Invalid run history status.');
  }
  return parsed.schedules;
}

export function loadSchedules(dir: string): Schedule[] {
  let contents: string;
  try {
    contents = readFileSync(path.join(dir, 'schedules.json'), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw new Error('Could not read saved schedules.', { cause: error });
  }
  try {
    return validateState(JSON.parse(contents));
  } catch (error) {
    throw new Error('Saved schedules are invalid. They have not been overwritten.', { cause: error });
  }
}

export function saveSchedules(dir: string, schedules: Schedule[]): void {
  try {
    validateState({ version: 1, schedules });
  } catch (error) {
    throw new Error('Cannot save invalid schedules.', { cause: error });
  }
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'schedules.json');
  const temp = path.join(dir, `schedules-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, schedules }), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    });
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch (cleanupError) {
      if (
        !cleanupError ||
        typeof cleanupError !== 'object' ||
        !('code' in cleanupError) ||
        cleanupError.code !== 'ENOENT'
      )
        throw new AggregateError([error, cleanupError], 'Could not save schedules or remove the temporary file.', {
          cause: cleanupError,
        });
    }
    throw new Error('Could not save schedules.', { cause: error });
  }
}
