import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { RepositoryBusyError, RepositoryQueue, repositoryKey } from './repositoryQueue';
import { queuedScheduledGit } from './queuedScheduled';
import { ScheduledCleanupError } from './scheduledCommand';

const exec = promisify(execFile);

test('operations in the same repository are serialized and timeouts do not enter the queue', async () => {
  const queue = new RepositoryQueue(async (repo) => repo);
  const events: string[] = [];
  let release: (() => void) | undefined;
  const first = queue.run('one', async () => {
    events.push('first');
    await new Promise<void>((resolve) => (release = resolve));
    events.push('first-done');
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = queue.run('one', async () => {
    events.push('second');
  });
  await assert.rejects(
    queue.run('one', async () => events.push('timed-out'), 5),
    RepositoryBusyError,
  );
  await queue.run('other', async () => events.push('other'));
  assert.ok(release);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'other', 'first-done', 'second']);
});

test('failed operations release their lock', async () => {
  const queue = new RepositoryQueue(async (repo) => repo);
  await assert.rejects(
    queue.run('one', async () => Promise.reject(new Error('failed'))),
    /failed/,
  );
  assert.equal(await queue.run('one', async () => 42, 0), 42);
});

test('uncertain process cleanup blocks waiting and subsequent operations for the repository', async () => {
  const queue = new RepositoryQueue(async (repo) => repo);
  let release: (() => void) | undefined;
  const first = queue.run('one', async () => {
    await new Promise<void>((resolve) => (release = resolve));
    throw new ScheduledCleanupError();
  });
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = queue.run('one', async () => 1);
  const firstRejected = assert.rejects(first, ScheduledCleanupError);
  const waitingRejected = assert.rejects(waiting, ScheduledCleanupError);
  assert.ok(release);
  release();
  await Promise.all([firstRejected, waitingRejected]);
  await assert.rejects(
    queue.run('one', async () => 2),
    ScheduledCleanupError,
  );
  assert.equal(await queue.run('other', async () => 3), 3);
});

test('repository subdirectories and linked worktrees use the same common Git directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-queue-'));
  try {
    const repo = path.join(dir, 'repo');
    const linked = path.join(dir, 'linked');
    await mkdir(repo);
    const git = (...args: string[]) =>
      exec('git', args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
    await git('init', '--quiet', '--initial-branch=main');
    await git('commit', '--quiet', '--allow-empty', '-m', 'Initial');
    await git('worktree', 'add', '--quiet', '-b', 'linked', linked);
    await mkdir(path.join(repo, 'subdir'));
    assert.equal(await repositoryKey(repo), await repositoryKey(path.join(repo, 'subdir')));
    assert.equal(await repositoryKey(repo), await repositoryKey(linked));
    const queue = new RepositoryQueue();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const inProgress = queue.run(repo, () => {
      entered?.();
      return new Promise<void>((resolve) => (release = resolve));
    });
    await Promise.race([ready, inProgress]);
    assert.deepEqual(await queuedScheduledGit(queue, linked, 'pull', false, 10), {
      status: 'skipped',
      reason: 'Another Git operation is in progress.',
    });
    assert.ok(release);
    release();
    await inProgress;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
