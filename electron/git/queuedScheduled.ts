import { RepositoryBusyError, RepositoryQueue } from './repositoryQueue';
import { scheduledGit } from './scheduled';
import type { ScheduledGitAction, ScheduledGitResult } from '../../src/shared/scheduledGit';

export async function queuedScheduledGit(
  queue: RepositoryQueue,
  repo: string,
  action: ScheduledGitAction,
  prune: boolean,
  waitMs = 30_000,
): Promise<ScheduledGitResult> {
  try {
    return await queue.run(repo, () => scheduledGit(repo, action, prune), waitMs);
  } catch (error) {
    if (error instanceof RepositoryBusyError) return { status: 'skipped', reason: error.message };
    throw error;
  }
}
