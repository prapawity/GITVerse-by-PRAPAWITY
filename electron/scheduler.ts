import { randomUUID } from 'node:crypto';
import {
  advanceSchedule,
  beginScheduleRun,
  createSchedule,
  finishScheduleRun,
  recordScheduleResult,
  recoverSchedule,
  skipMissedSchedule,
  type NewSchedule,
  type Schedule,
  type ScheduledRepositoryResult,
} from '../src/shared/scheduleState';
import type { ScheduledGitAction, ScheduledGitResult } from '../src/shared/scheduledGit';
import { ScheduledCleanupError } from './git/scheduledCommand';

export interface SchedulerDependencies {
  load(): Schedule[];
  save(schedules: Schedule[]): void;
  openRepositories(): string[];
  execute(repo: string, action: ScheduledGitAction): Promise<ScheduledGitResult>;
  changed(): void;
  now(): number;
}

/**
 * All state transitions are saved before executing Git. The injected executor must coordinate
 * with interactive Git operations for the same repository.
 */
export class Scheduler {
  private schedules: Schedule[];
  private polling = false;

  constructor(private readonly deps: SchedulerDependencies) {
    const stored = structuredClone(deps.load());
    this.schedules = stored.map(recoverSchedule);
    if (stored.some((schedule) => schedule.running)) deps.save(this.schedules);
  }

  list(): Schedule[] {
    return structuredClone(this.schedules);
  }

  private save(schedules: Schedule[]) {
    this.deps.save(structuredClone(schedules));
    this.schedules = schedules;
    this.deps.changed();
  }

  private replace(id: string, transform: (schedule: Schedule) => Schedule) {
    let found = false;
    const next = this.schedules.map((schedule) => {
      if (schedule.id !== id) return schedule;
      found = true;
      return transform(schedule);
    });
    if (!found) throw new Error('Schedule not found.');
    this.save(next);
  }

  add(input: NewSchedule): Schedule {
    if (this.schedules.some((schedule) => schedule.id === input.id)) throw new Error('Schedule ID already exists.');
    const schedule = createSchedule(input, this.deps.now());
    this.save([...this.schedules, schedule]);
    return structuredClone(schedule);
  }

  update(input: NewSchedule) {
    this.replace(input.id, (schedule) => {
      if (schedule.running) throw new Error('Cannot edit a running schedule.');
      if (schedule.missed) throw new Error('Run or skip missed occurrences before editing this schedule.');
      const updated = createSchedule(input, this.deps.now());
      return { ...updated, enabled: schedule.enabled, history: schedule.history };
    });
  }

  setEnabled(id: string, enabled: boolean) {
    this.replace(id, (schedule) => {
      if (schedule.running) throw new Error('Cannot change a running schedule.');
      if (schedule.enabled === enabled) return schedule;
      return {
        ...schedule,
        enabled,
        nextDue: enabled ? createSchedule(schedule, this.deps.now()).nextDue : schedule.nextDue,
      };
    });
  }

  remove(id: string) {
    const schedule = this.schedules.find((item) => item.id === id);
    if (!schedule) throw new Error('Schedule not found.');
    if (schedule.running) throw new Error('Cannot delete a running schedule.');
    this.save(this.schedules.filter((item) => item.id !== id));
  }

  skipMissed(ids: string[]) {
    const wanted = new Set(ids);
    if (!wanted.size || wanted.size !== ids.length) throw new Error('Select one or more distinct schedules.');
    const selected = this.schedules.filter((schedule) => wanted.has(schedule.id));
    if (selected.length !== wanted.size || selected.some((schedule) => !schedule.missed || schedule.running))
      throw new Error('A selected schedule no longer has a missed run.');
    const now = this.deps.now();
    this.save(
      this.schedules.map((schedule) =>
        wanted.has(schedule.id) ? skipMissedSchedule(schedule, randomUUID(), now) : schedule,
      ),
    );
  }

  async runNow(id: string) {
    const runId = randomUUID();
    this.replace(id, (schedule) => beginScheduleRun(schedule, runId, this.deps.now(), 'manual'));
    await this.runBatch([{ id, runId }]);
  }

  async retryFailed(id: string, previousRunId: string) {
    const runId = randomUUID();
    let repos: string[] = [];
    this.replace(id, (schedule) => {
      const previous = schedule.history.find((entry) => entry.id === previousRunId);
      if (!previous) throw new Error('The previous schedule run was not found.');
      repos = previous.results.filter((result) => result.status === 'failed').map((result) => result.repo);
      if (!repos.length) throw new Error('The previous run has no failed repositories.');
      return beginScheduleRun(schedule, runId, this.deps.now(), 'manual');
    });
    await this.runBatch([{ id, runId, repos }]);
  }

  async runMissed(ids: string[]) {
    const wanted = new Set(ids);
    if (!wanted.size || wanted.size !== ids.length) throw new Error('Select one or more distinct schedules.');
    const selected = this.schedules.filter((schedule) => wanted.has(schedule.id));
    if (selected.length !== wanted.size || selected.some((schedule) => !schedule.missed || schedule.running))
      throw new Error('A selected schedule cannot be run.');
    const runs = selected.map((schedule) => ({ id: schedule.id, runId: randomUUID() }));
    const now = this.deps.now();
    this.save(
      this.schedules.map((schedule) => {
        const run = runs.find((item) => item.id === schedule.id);
        return run ? beginScheduleRun(schedule, run.runId, now, 'missed') : schedule;
      }),
    );
    await this.runBatch(runs);
  }

  async poll(canRunOnTime: boolean) {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = this.deps.now();
      const runs: { id: string; runId: string }[] = [];
      let changed = false;
      const schedules = this.schedules.map((schedule) => {
        const runId = randomUUID();
        const advanced = advanceSchedule(schedule, now, canRunOnTime, runId);
        if (advanced.schedule !== schedule) changed = true;
        if (advanced.shouldRun) runs.push({ id: schedule.id, runId });
        return advanced.schedule;
      });
      if (changed) this.save(schedules);
      await this.runBatch(runs);
    } finally {
      this.polling = false;
    }
  }

  private async runBatch(runs: { id: string; runId: string; repos?: string[] }[]) {
    try {
      for (const run of runs) await this.run(run.id, run.runId, run.repos);
    } catch (error) {
      if (error instanceof ScheduledCleanupError) throw error;
      const unfinished = new Set(runs.map((run) => run.runId));
      const schedules = this.schedules.map((schedule) =>
        schedule.running && unfinished.has(schedule.running.id) ? recoverSchedule(schedule) : schedule,
      );
      this.save(schedules);
      throw error;
    }
  }

  private async run(id: string, runId: string, overrideRepos?: string[]) {
    const schedule = this.schedules.find((item) => item.id === id);
    if (!schedule || schedule.running?.id !== runId) throw new Error('The schedule run is no longer active.');
    const repositories = [
      ...new Set(
        overrideRepos ?? (schedule.scope.kind === 'open' ? this.deps.openRepositories() : schedule.scope.repos),
      ),
    ];
    for (const repo of repositories) {
      let result: ScheduledRepositoryResult;
      try {
        const outcome = await this.deps.execute(repo, schedule.action);
        result =
          outcome.status === 'success'
            ? { repo, status: 'success' }
            : { repo, status: 'skipped', detail: outcome.reason };
      } catch (error) {
        if (error instanceof ScheduledCleanupError) throw error;
        const safeMessages = [
          `Scheduled ${schedule.action} failed. Check the repository, network, and credentials.`,
          `Scheduled ${schedule.action} timed out. Check the network and credentials.`,
        ];
        const detail =
          error instanceof Error && safeMessages.includes(error.message)
            ? error.message
            : 'Git operation failed. Check the repository and credentials.';
        result = { repo, status: 'failed', detail };
      }
      this.replace(id, (current) => recordScheduleResult(current, runId, result));
    }
    this.replace(id, (current) => {
      if (!current.running || current.running.id !== runId) throw new Error('The schedule run is no longer active.');
      return finishScheduleRun(current, runId, current.running.results);
    });
  }
}
