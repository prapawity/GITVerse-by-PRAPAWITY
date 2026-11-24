import { execFile, spawn } from 'node:child_process';

const MAX_OUTPUT = 8 * 1024 * 1024;

export class ScheduledCommandError extends Error {
  constructor(
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(timedOut ? 'Scheduled command timed out.' : 'Scheduled command failed.');
  }
}

export class ScheduledCleanupError extends Error {
  constructor() {
    super(
      'Could not stop the scheduled Git process tree. Close the app only after ensuring its Git processes have stopped.',
    );
  }
}

/** Run Git without a terminal, keeping the process group alive until timeout cleanup completes. */
export function runScheduledCommand(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'false',
        GCM_INTERACTIVE: 'never',
        SSH_ASKPASS_REQUIRE: 'never',
        LC_ALL: 'C',
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let tooLarge = false;
    let spawnError: Error | undefined;
    let cleanup: Promise<void> = Promise.resolve();
    let terminating = false;

    const terminate = () => {
      if (terminating || !child.pid) return;
      terminating = true;
      if (process.platform === 'win32') {
        cleanup = new Promise((done) => {
          execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], (error) => {
            if (error) {
              console.error('[scheduler] Could not terminate the scheduled Git process tree:', error.message);
              reject(new ScheduledCleanupError());
            }
            done();
          });
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            console.error('[scheduler] Could not terminate the scheduled Git process group:', error);
            reject(new ScheduledCleanupError());
          }
        }
      }
    };
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        spawnError = error;
        terminate();
      }
    });
    child.stdin.end();
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        tooLarge = true;
        terminate();
      } else target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => {
      spawnError = error;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      void cleanup.then(() => {
        if (spawnError) reject(spawnError);
        else if (timedOut || tooLarge || code !== 0)
          reject(new ScheduledCommandError(Buffer.concat(stderr).toString('utf8'), timedOut));
        else resolve(Buffer.concat(stdout).toString('utf8'));
      });
    });
  });
}
