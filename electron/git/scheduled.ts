import type { ScheduledGitAction, ScheduledGitResult } from '../../src/shared/scheduledGit';
import { opState } from './git';
import { runScheduledCommand, ScheduledCleanupError, ScheduledCommandError } from './scheduledCommand';

const TIMEOUT_MS = 120_000;

async function run(cwd: string, args: string[]): Promise<string> {
  return runScheduledCommand(cwd, args, TIMEOUT_MS);
}

/**
 * The caller must serialize this operation with other Git operations for the same repository.
 * Returned errors deliberately omit Git output, which can contain remote URLs or credentials.
 */
export async function scheduledGit(
  cwd: string,
  action: ScheduledGitAction,
  prune: boolean,
): Promise<ScheduledGitResult> {
  if (action !== 'fetch' && action !== 'pull' && action !== 'refresh') throw new Error('Invalid scheduled action.');
  try {
    if (action === 'refresh') {
      await run(cwd, ['status', '--porcelain=v1']);
      return { status: 'success' };
    }

    if (await opState(cwd)) return { status: 'skipped', reason: 'A Git operation is in progress.' };
    if (action === 'fetch') {
      if (!(await run(cwd, ['remote'])).trim()) return { status: 'skipped', reason: 'No remotes are configured.' };
      await run(cwd, ['fetch', '--all', ...(prune ? ['--prune'] : [])]);
    } else {
      const state = await run(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
      const fields = state.split('\0').filter(Boolean);
      if (fields.some((field) => !field.startsWith('# ')))
        return { status: 'skipped', reason: 'The working tree has local changes.' };
      const head = fields.find((field) => field.startsWith('# branch.head '))?.slice('# branch.head '.length);
      if (!head || head === '(detached)') return { status: 'skipped', reason: 'HEAD is detached.' };
      if (!fields.some((field) => field.startsWith('# branch.upstream ')))
        return { status: 'skipped', reason: 'The current branch has no upstream.' };
      try {
        await run(cwd, ['pull', '--ff-only']);
      } catch (error) {
        if (
          error instanceof ScheduledCommandError &&
          /^fatal: Not possible to fast-forward, aborting\.$/m.test(error.stderr)
        )
          return { status: 'skipped', reason: 'The current branch cannot be fast-forwarded.' };
        throw error;
      }
    }
    return { status: 'success' };
  } catch (error) {
    if (error instanceof ScheduledCleanupError) throw error;
    const timedOut = error instanceof ScheduledCommandError && error.timedOut;
    throw new Error(
      timedOut
        ? `Scheduled ${action} timed out. Check the network and credentials.`
        : `Scheduled ${action} failed. Check the repository, network, and credentials.`,
      { cause: error },
    );
  }
}
