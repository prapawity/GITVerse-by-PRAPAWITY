import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { scheduledGit } from './scheduled';
import { runScheduledCommand, ScheduledCommandError } from './scheduledCommand';

const exec = promisify(execFile);

test('scheduled Git actions fetch and fast-forward, but skip unsafe working trees', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-scheduled-'));
  const source = path.join(dir, 'source');
  const repo = path.join(dir, 'repo');
  const git = async (cwd: string, ...args: string[]) =>
    (await exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim();
  try {
    await git(dir, 'init', '--quiet', '--initial-branch=main', source);
    await git(source, 'config', 'user.name', 'Test User');
    await git(source, 'config', 'user.email', 'test@example.com');
    await writeFile(path.join(source, 'file.txt'), 'one\n');
    await git(source, 'add', 'file.txt');
    await git(source, 'commit', '--quiet', '-m', 'Initial');
    assert.deepEqual(await scheduledGit(source, 'fetch', false), {
      status: 'skipped',
      reason: 'No remotes are configured.',
    });
    await writeFile(path.join(source, '.git', 'MERGE_HEAD'), `${await git(source, 'rev-parse', 'HEAD')}\n`);
    assert.deepEqual(await scheduledGit(source, 'fetch', false), {
      status: 'skipped',
      reason: 'A Git operation is in progress.',
    });
    await rm(path.join(source, '.git', 'MERGE_HEAD'));
    await git(dir, 'clone', '--quiet', source, repo);
    await writeFile(path.join(source, 'file.txt'), 'two\n');
    await git(source, 'commit', '--quiet', '-am', 'Update');

    assert.deepEqual(await scheduledGit(repo, 'fetch', false), { status: 'success' });
    assert.deepEqual(await scheduledGit(repo, 'pull', false), { status: 'success' });
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), await git(source, 'rev-parse', 'HEAD'));

    await writeFile(path.join(repo, 'file.txt'), 'uncommitted\n');
    assert.deepEqual(await scheduledGit(repo, 'pull', false), {
      status: 'skipped',
      reason: 'The working tree has local changes.',
    });
    await git(repo, 'restore', 'file.txt');
    await git(repo, 'checkout', '--quiet', '--detach');
    assert.deepEqual(await scheduledGit(repo, 'pull', false), { status: 'skipped', reason: 'HEAD is detached.' });
    await git(repo, 'checkout', '--quiet', '-b', 'no-upstream');
    assert.deepEqual(await scheduledGit(repo, 'pull', false), {
      status: 'skipped',
      reason: 'The current branch has no upstream.',
    });
    await git(repo, 'checkout', '--quiet', 'main');
    await git(repo, 'config', 'user.name', 'Test User');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await writeFile(path.join(repo, 'local.txt'), 'local\n');
    await git(repo, 'add', 'local.txt');
    await git(repo, 'commit', '--quiet', '-m', 'Local');
    await writeFile(path.join(source, 'remote.txt'), 'remote\n');
    await git(source, 'add', 'remote.txt');
    await git(source, 'commit', '--quiet', '-m', 'Remote');
    const before = await git(repo, 'rev-parse', 'HEAD');
    assert.deepEqual(await scheduledGit(repo, 'pull', false), {
      status: 'skipped',
      reason: 'The current branch cannot be fast-forwarded.',
    });
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), before);
    await git(repo, 'remote', 'set-url', 'origin', path.join(dir, 'sensitive-remote-name'));
    await assert.rejects(scheduledGit(repo, 'fetch', false), {
      message: 'Scheduled fetch failed. Check the repository, network, and credentials.',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled Git errors do not expose Git output', async () => {
  await assert.rejects(scheduledGit('/path/that/does/not/exist', 'fetch', false), {
    message: 'Scheduled fetch failed. Check the repository, network, and credentials.',
  });
});

test(
  'scheduled fetch uses the repository SSH command without prompting',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-scheduled-ssh-'));
    const sshCommand = process.env.GIT_SSH_COMMAND;
    const ssh = path.join(dir, 'ssh-test');
    try {
      delete process.env.GIT_SSH_COMMAND;
      await writeFile(ssh, '#!/bin/sh\nprintf "%s" "$SSH_ASKPASS_REQUIRE" > ssh-invoked\nexit 1\n', { mode: 0o755 });
      await exec('git', ['init', '--quiet', dir]);
      await exec('git', ['config', 'core.sshCommand', `"${ssh}"`], { cwd: dir });
      await exec('git', ['remote', 'add', 'origin', 'ssh://example.invalid/repo'], { cwd: dir });
      await assert.rejects(scheduledGit(dir, 'fetch', false), /Scheduled fetch failed/);
      assert.equal(await readFile(path.join(dir, 'ssh-invoked'), 'utf8'), 'never');
    } finally {
      if (sshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = sshCommand;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('timed out scheduled Git terminates its child process group', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitverse-scheduled-timeout-'));
  const oldPath = process.env.PATH;
  try {
    await writeFile(path.join(dir, 'git'), '#!/bin/sh\n(/bin/sleep 1; echo survived > survived) &\nwait\n', {
      mode: 0o755,
    });
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    await assert.rejects(runScheduledCommand(dir, [], 200), (error) => {
      assert.ok(error instanceof ScheduledCommandError);
      assert.equal(error.timedOut, true);
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await assert.rejects(access(path.join(dir, 'survived')), { code: 'ENOENT' });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});
