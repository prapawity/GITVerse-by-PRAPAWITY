import { collectMissedSchedules, nextScheduleTime, type ScheduleTiming } from './scheduleTime';
import type { ScheduledGitAction } from './scheduledGit';

export interface MissedSchedule {
  count: number;
  latest: number;
}

export interface ScheduledRepositoryResult {
  repo: string;
  status: 'success' | 'skipped' | 'failed';
  detail?: string;
}

export interface ScheduledRun {
  id: string;
  startedAt: number;
  trigger: 'scheduled' | 'missed' | 'manual';
  status: 'running' | 'success' | 'partial' | 'failed' | 'skipped' | 'interrupted';
  results: ScheduledRepositoryResult[];
  missed?: MissedSchedule;
}

export interface Schedule {
  id: string;
  name: string;
  action: ScheduledGitAction;
  timing: ScheduleTiming;
  scope: { kind: 'open' } | { kind: 'selected'; repos: string[] };
  enabled: boolean;
  nextDue: number;
  missed: MissedSchedule | null;
  running: ScheduledRun | null;
  history: ScheduledRun[];
}

export type NewSchedule = Pick<Schedule, 'id' | 'name' | 'action' | 'timing' | 'scope'>;

export function createSchedule(input: NewSchedule, now: number): Schedule {
  if (!input.id.trim() || !input.name.trim()) throw new Error('A schedule requires an ID and name.');
  if (!['fetch', 'pull', 'refresh'].includes(input.action)) throw new Error('Invalid scheduled action.');
  if (
    input.scope.kind !== 'open' &&
    (input.scope.kind !== 'selected' || !input.scope.repos.length || input.scope.repos.some((repo) => !repo.trim()))
  )
    throw new Error('Select at least one repository.');
  return {
    ...input,
    name: input.name.trim(),
    timing: { ...input.timing },
    scope:
      input.scope.kind === 'open' ? { kind: 'open' } : { kind: 'selected', repos: [...new Set(input.scope.repos)] },
    enabled: true,
    nextDue: nextScheduleTime(input.timing, now),
    missed: null,
    running: null,
    history: [],
  };
}

/**
 * `canRunOnTime` must be false after startup or resume. An occurrence outside the grace window,
 * or any batch containing multiple occurrences, is always held for the user's decision.
 */
export function advanceSchedule(
  schedule: Schedule,
  now: number,
  canRunOnTime: boolean,
  runId: string,
  graceMs = 30_000,
) {
  if (!schedule.enabled) return { schedule, shouldRun: false };
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('Invalid scheduling grace period.');
  const due = collectMissedSchedules(schedule.timing, schedule.nextDue, now);
  if (!due.count || due.latest === null) return { schedule, shouldRun: false };
  const shouldRun = canRunOnTime && !schedule.running && due.count === 1 && now - due.latest <= graceMs;
  const advanced = {
    ...schedule,
    nextDue: due.next,
    missed: shouldRun ? schedule.missed : { count: (schedule.missed?.count ?? 0) + due.count, latest: due.latest },
  };
  return { schedule: shouldRun ? beginScheduleRun(advanced, runId, now, 'scheduled') : advanced, shouldRun };
}

export function beginScheduleRun(
  schedule: Schedule,
  runId: string,
  now: number,
  trigger: ScheduledRun['trigger'],
): Schedule {
  if (schedule.running) throw new Error('This schedule is already running.');
  if (!runId.trim() || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid schedule run.');
  if (trigger === 'missed' && !schedule.missed) throw new Error('There is no missed schedule to run.');
  return {
    ...schedule,
    missed: trigger === 'missed' ? null : schedule.missed,
    running: {
      id: runId,
      startedAt: now,
      trigger,
      status: 'running',
      results: [],
      ...(trigger === 'missed' && schedule.missed ? { missed: schedule.missed } : {}),
    },
  };
}

export function finishScheduleRun(schedule: Schedule, runId: string, results: ScheduledRepositoryResult[]): Schedule {
  if (!schedule.running || schedule.running.id !== runId) throw new Error('The schedule run is no longer active.');
  const successes = results.filter((result) => result.status === 'success').length;
  const failures = results.filter((result) => result.status === 'failed').length;
  const status =
    successes === results.length && successes > 0
      ? 'success'
      : successes > 0
        ? 'partial'
        : failures > 0
          ? 'failed'
          : 'skipped';
  const completed: ScheduledRun = { ...schedule.running, status, results: [...results] };
  return { ...schedule, running: null, history: [completed, ...schedule.history].slice(0, 20) };
}

export function recordScheduleResult(schedule: Schedule, runId: string, result: ScheduledRepositoryResult): Schedule {
  if (!schedule.running || schedule.running.id !== runId) throw new Error('The schedule run is no longer active.');
  if (schedule.running.results.some((item) => item.repo === result.repo))
    throw new Error('A result for this repository was already recorded.');
  return {
    ...schedule,
    running: { ...schedule.running, results: [...schedule.running.results, result] },
  };
}

export function recoverSchedule(schedule: Schedule): Schedule {
  if (!schedule.running) return schedule;
  const interrupted: ScheduledRun = { ...schedule.running, status: 'interrupted' };
  return { ...schedule, running: null, history: [interrupted, ...schedule.history].slice(0, 20) };
}

export function skipMissedSchedule(schedule: Schedule, runId: string, now: number): Schedule {
  const skipped = beginScheduleRun(schedule, runId, now, 'missed');
  return finishScheduleRun(skipped, runId, []);
}
