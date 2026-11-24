const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitverse-smoke-'));
  try {
    const repo = path.join(dir, 'reload-fixture');
    const userData = path.join(dir, 'user-data');
    mkdirSync(repo);
    mkdirSync(userData);
    execFileSync('git', ['init', '-b', 'main', repo]);
    writeFileSync(path.join(repo, 'stash-tracked.txt'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', '--', 'stash-tracked.txt']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Smoke Test',
      '-c',
      'user.email=smoke@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'Reload smoke fixture',
    ]);
    writeFileSync(path.join(repo, 'stash-tracked.txt'), 'saved change\n');
    writeFileSync(path.join(repo, 'stash-new.txt'), 'saved untracked\n');
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Smoke Test',
      '-c',
      'user.email=smoke@example.com',
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'Smoke stash fixture',
    ]);
    writeFileSync(
      path.join(userData, 'gitverse-state.json'),
      JSON.stringify({
        'gitverse.tabs': JSON.stringify({ repos: [repo], active: repo }),
      }),
    );
    const previousMidnight = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
    writeFileSync(
      path.join(userData, 'schedules.json'),
      JSON.stringify({
        version: 1,
        schedules: ['one', 'two'].map((id) => ({
          id,
          name: `Missed ${id}`,
          action: 'refresh',
          timing: { timeZone: 'UTC', hour: 0, minute: 0, weekday: null },
          scope: { kind: 'open' },
          enabled: true,
          nextDue: previousMidnight,
          missed: null,
          running: null,
          history: [],
        })),
      }),
    );
    const env = { ...process.env, GITVERSE_SMOKE_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(require('electron'), [__filename], {
        env,
        stdio: 'inherit',
        timeout: 60000,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Electron smoke run ${run + 1} failed`);
    }
    console.log(
      'Electron smoke passed: bridge, folder dialog, repository restoration, reload, restart, missing-bridge feedback, and development update isolation.',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, ipcMain, Menu } = require('electron');
  const dir = process.env.GITVERSE_SMOKE_DIR;
  assert.ok(dir, 'Run this script through npm run test:electron');
  app.setPath('userData', path.join(dir, 'user-data'));
  const repo = path.join(dir, 'reload-fixture');
  let releaseChecks = 0;
  const originalFetch = global.fetch;
  global.fetch = (...args) => {
    if (String(args[0]) === 'https://api.github.com/repos/prapawity/GITVerse-by-PRAPAWITY/releases/latest') {
      releaseChecks++;
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return originalFetch(...args);
  };
  const timeout = setTimeout(() => {
    console.error('Electron smoke timed out');
    app.exit(1);
  }, 45000);
  app.once('browser-window-created', (_event, win) => {
    win.webContents.on('preload-error', (_event, file, error) => console.error('Preload failed:', file, error));
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.error('Renderer:', event.message);
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const checkRestored = async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (
              await win.webContents.executeJavaScript(
                `document.body.textContent.includes(${JSON.stringify(repo)}) &&
                document.body.textContent.includes('main') && !!document.querySelector('canvas') &&
                !document.querySelector('[aria-label="GITVerse by PRAPAWITY launch screen"]')`,
              )
            )
              return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.fail(
            `Saved repository history was not restored: ${await win.webContents.executeJavaScript(
              'document.body.textContent',
            )}`,
          );
        };
        await checkRestored();
        const waitFor = async (script, description) => {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (await win.webContents.executeJavaScript(script)) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.fail(description);
        };
        await waitFor(
          `window.gitApi.scheduler.list().then(state => state.schedules.length >= 2).catch(() => false)`,
          'Scheduler did not initialize',
        );
        const schedulerState = await win.webContents.executeJavaScript('window.gitApi.scheduler.list()');
        if (schedulerState.schedules.some((schedule) => schedule.missed)) {
          const due = schedulerState.schedules.map((schedule) => schedule.nextDue);
          await waitFor(
            `!!document.querySelector('dialog[open] [id="missed-schedules-title"]')`,
            'Missed tasks dialog did not open',
          );
          assert.equal(
            await win.webContents.executeJavaScript(`document.querySelectorAll('dialog[open] input:checked').length`),
            0,
          );
          await win.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('dialog[open] button')).find(button => button.textContent.trim() === 'Later').click()`,
          );
          await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="Preferences"]').click()`);
          await waitFor(
            `!!document.querySelector('button[aria-label="Scheduled tasks"]')`,
            'Scheduler settings navigation missing',
          );
          await win.webContents.executeJavaScript(
            `document.querySelector('button[aria-label="Scheduled tasks"]').click()`,
          );
          await waitFor(
            `Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === 'Review missed tasks')`,
            'Missed tasks could not be reopened',
          );
          await win.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Review missed tasks').click()`,
          );
          await waitFor(`!!document.querySelector('dialog[open] input')`, 'Missed tasks dialog did not reopen');
          await win.webContents.executeJavaScript(
            `document.querySelector('dialog[open] input').click(); Array.from(document.querySelectorAll('dialog[open] button')).find(button => button.textContent.trim() === 'Run selected').click()`,
          );
          await waitFor(
            `window.gitApi.scheduler.list().then(state => state.schedules[0].history.length > 0)`,
            'Selected missed task did not finish',
          );
          await waitFor(
            `Array.from(document.querySelectorAll('dialog[open] button')).some(button => button.textContent.trim() === 'Skip all' && !button.disabled)`,
            'Remaining missed task was not shown',
          );
          const afterRun = await win.webContents.executeJavaScript('window.gitApi.scheduler.list()');
          assert.equal(afterRun.schedules[0].history[0].status, 'success');
          assert.equal(afterRun.schedules[0].history[0].results[0].repo, repo);
          assert.equal(afterRun.schedules[0].nextDue, due[0]);
          assert.ok(afterRun.schedules[1].missed);
          await win.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('dialog[open] button')).find(button => button.textContent.trim() === 'Skip all').click()`,
          );
          await waitFor(
            `window.gitApi.scheduler.list().then(state => state.schedules.every(item => !item.missed))`,
            'Skipping remaining missed task failed',
          );
          await win.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'New scheduled task').click()`,
          );
          await win.webContents.executeJavaScript(`(() => {
            const label = Array.from(document.querySelectorAll('form label')).find(item => item.textContent.trim() === 'Name');
            const input = label.querySelector('input');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Smoke schedule');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.form.requestSubmit();
          })()`);
          await waitFor(
            `window.gitApi.scheduler.list().then(state => state.schedules.some(item => item.name === 'Smoke schedule'))`,
            'Creating a scheduled task from settings failed',
          );
          await waitFor(
            `Array.from(document.querySelectorAll('section')).some(section => section.textContent.includes('Smoke schedule'))`,
            'Created task did not appear',
          );
          await win.webContents.executeJavaScript(`(() => {
            const section = Array.from(document.querySelectorAll('section')).find(item => item.textContent.includes('Smoke schedule'));
            Array.from(section.querySelectorAll('button')).find(button => button.textContent.trim() === 'Disable').click();
          })()`);
          await waitFor(
            `window.gitApi.scheduler.list().then(state => state.schedules.some(item => item.name === 'Smoke schedule' && !item.enabled))`,
            'Disabling the task failed',
          );
          await win.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Back to workspace').click()`,
          );
        } else {
          assert.equal(
            schedulerState.schedules[0].history[0].status,
            'success',
            'Schedule history must survive restart',
          );
          assert.equal(
            schedulerState.schedules[1].history[0].status,
            'skipped',
            'Skipped decision must survive restart',
          );
          assert.ok(
            schedulerState.schedules.some((item) => item.name === 'Smoke schedule' && !item.enabled),
            'Created task must survive restart',
          );
        }
        const panelLayout = await win.webContents.executeJavaScript(`(() => {
          const group = document.querySelector('[data-group]');
          const panels = group && Array.from(group.children).filter((element) => element.hasAttribute('data-panel'));
          return panels?.map((panel) => panel.getBoundingClientRect().width / group.getBoundingClientRect().width);
        })()`);
        assert.ok(
          panelLayout?.length >= 3 && panelLayout.every((width) => width > 0.1),
          'Panels should retain their percentage-based sizes',
        );
        assert.equal(app.isPackaged, false);
        const updateItem = Menu.getApplicationMenu().getMenuItemById('check-for-updates');
        assert.ok(updateItem, 'Update menu item should exist');
        assert.equal(updateItem.enabled, false, 'Development update menu should be disabled');
        updateItem.click(updateItem, win, {});
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(releaseChecks, 0, 'Development must not request automatic or manual release checks');
        assert.equal(
          await win.webContents.executeJavaScript('window.gitApi.updates.environment().then(value => value.enabled)'),
          false,
        );
        assert.equal(
          await win.webContents.executeJavaScript('window.gitApi.updates.startup().then(value => value.kind)'),
          'development',
        );
        assert.equal(
          await win.webContents.executeJavaScript('window.gitApi.updates.check().then(value => value.kind)'),
          'development',
        );
        assert.equal(releaseChecks, 0, 'Renderer update IPC must stay offline in development');
        const commits = await win.webContents.executeJavaScript(`window.gitApi.log(${JSON.stringify(repo)}, 10, 0)`);
        assert.equal(commits[0].subject, 'Reload smoke fixture');
        assert.equal(
          await win.webContents.executeJavaScript(
            `document.querySelector('footer [aria-label^="App version "]')?.textContent.trim()`,
          ),
          `v${require('../package.json').version}`,
          'Footer version must match package metadata',
        );
        assert.equal(await win.webContents.executeJavaScript(`typeof window.gitApi.openRepoDialog`), 'function');
        assert.equal(await win.webContents.executeJavaScript(`typeof window.gitApi.discardWorkingFiles`), 'function');
        assert.equal(await win.webContents.executeJavaScript(`typeof window.gitApi.discardWorkingHunk`), 'function');
        assert.deepEqual(
          await win.webContents.executeJavaScript(`window.gitApi.fileChangeCounts(${JSON.stringify(repo)})`),
          [],
        );
        await assert.rejects(
          win.webContents.executeJavaScript(`window.gitApi.discardWorkingFiles(${JSON.stringify(repo)}, [])`),
          /Select files to discard/,
        );
        const stashes = await win.webContents.executeJavaScript(
          `window.gitApi.refs(${JSON.stringify(repo)}).then(value => value.stashes)`,
        );
        assert.equal(stashes.length, 1);
        const stash = await win.webContents.executeJavaScript(
          `window.gitApi.stashDetail(${JSON.stringify(repo)}, ${JSON.stringify(stashes[0].hash)})`,
        );
        assert.equal(stash.author, 'Smoke Test');
        assert.deepEqual(stash.files.map((file) => file.path).sort(), ['stash-new.txt', 'stash-tracked.txt']);
        assert.equal(
          await win.webContents.executeJavaScript(
            `window.gitApi.stashFileAt(${JSON.stringify(repo)}, ${JSON.stringify(stash.hash)}, 'stash-new.txt')`,
          ),
          'saved untracked\n',
        );
        assert.equal(
          await win.webContents.executeJavaScript(
            `!!document.querySelector('button[aria-label="Stash: main, Smoke stash fixture"]')`,
          ),
          true,
          'Stash node should appear in the graph',
        );
        await win.webContents.executeJavaScript(
          `document.querySelector('button[aria-label="Stash: main, Smoke stash fixture"]').click()`,
        );
        for (let attempt = 0; attempt < 50; attempt++) {
          if (await win.webContents.executeJavaScript(`!!document.querySelector('button[title="stash-new.txt"]')`))
            break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(
          await win.webContents.executeJavaScript(
            `!!document.querySelector('button[title="stash-new.txt"]') && !!document.querySelector('canvas') && document.body.textContent.includes('Smoke Test')`,
          ),
          true,
          'Stash selection should keep graph visible and show metadata/files',
        );
        ipcMain.removeHandler('repo:open');
        ipcMain.handle('repo:open', () => repo);
        assert.equal(await win.webContents.executeJavaScript('window.gitApi.openRepoDialog()'), repo);
        const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
        win.webContents.reload();
        await loaded;
        await checkRestored();
        win.webContents.setBackgroundThrottling(false);
        const graphSelection = await win.webContents.executeJavaScript(`(async () => {
          const canvas = document.querySelector('canvas');
          const graph = canvas.parentElement;
          const rect = graph.getBoundingClientRect();
          const original = CanvasRenderingContext2D.prototype.stroke;
          const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
          let renders = 0;
          let segments = 0;
          let glows = 0;
          Object.defineProperty(canvas, 'width', {
            configurable: true,
            get() { return width.get.call(this); },
            set(value) {
              width.set.call(this, value);
              renders++;
              segments = 0;
              glows = 0;
            },
          });
          CanvasRenderingContext2D.prototype.stroke = function (...args) {
            if (this.canvas === canvas && args[0] instanceof Path2D) {
              segments++;
              if (this.shadowBlur === 8) glows++;
            }
            return original.apply(this, args);
          };
          const waitFor = async (condition, attempts) => {
            for (let attempt = 0; attempt < attempts; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 20));
              if (condition()) return true;
            }
            return false;
          };
          let found = false;
          let hitX = rect.left;
          let hitY = rect.top;
          for (const x of [170, 186, 202, 218]) {
            for (const y of [4, 10, 24, 30, 34, 38, 52, 58, 62, 66, 80, 86, 90, 94]) {
              const previousRender = renders;
              const options = {bubbles: true, clientX: rect.left + x, clientY: rect.top + y};
              graph.dispatchEvent(new MouseEvent('mousemove', options));
              if (await waitFor(() => renders > previousRender && segments > 0 && glows > 0, 10)) {
                found = true;
                hitX = options.clientX;
                hitY = options.clientY;
                break;
              }
            }
            if (found) break;
          }
          const previousRender = renders;
          graph.dispatchEvent(new MouseEvent('mouseout', {
            bubbles: true,
            clientX: hitX,
            clientY: hitY,
            relatedTarget: document.body,
          }));
          const cleared = await waitFor(() => renders > previousRender && segments > 0 && glows === 0, 100);
          delete canvas.width;
          CanvasRenderingContext2D.prototype.stroke = original;
          return {found, cleared, previousRender, renders, segments, glows};
        })()`);
        assert.equal(
          graphSelection.found,
          true,
          `Graph line hover did not highlight: ${JSON.stringify(graphSelection)}`,
        );
        assert.equal(graphSelection.cleared, true, `Graph line hover did not clear: ${JSON.stringify(graphSelection)}`);
        const tabs = await win.webContents.executeJavaScript(
          `JSON.parse(window.gitApi.stateStorage.getItem('gitverse.tabs'))`,
        );
        assert.deepEqual(tabs, { repos: [repo], active: repo });
        if (process.platform !== 'win32') {
          const queueRepo = path.join(dir, `queue-${process.pid}`);
          const ready = path.join(dir, `queue-ready-${process.pid}`);
          const release = path.join(dir, `queue-release-${process.pid}`);
          mkdirSync(queueRepo);
          const git = (...args) => execFileSync('git', ['-C', queueRepo, ...args]);
          git('init', '-b', 'main');
          git('config', 'user.name', 'Smoke Test');
          git('config', 'user.email', 'smoke@example.com');
          writeFileSync(path.join(queueRepo, 'commit.txt'), 'commit\n');
          writeFileSync(path.join(queueRepo, 'stage.txt'), 'stage\n');
          git('add', 'commit.txt');
          writeFileSync(
            path.join(queueRepo, '.git', 'hooks', 'pre-commit'),
            `#!/bin/sh
touch "$GITVERSE_SMOKE_DIR/queue-ready-${process.pid}"
while [ ! -f "$GITVERSE_SMOKE_DIR/queue-release-${process.pid}" ]; do sleep 0.05; done
`,
            { mode: 0o755 },
          );
          const commit = win.webContents.executeJavaScript(
            `window.gitApi.commit(${JSON.stringify(queueRepo)}, 'Queue smoke', '')`,
          );
          try {
            for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt++)
              await new Promise((resolve) => setTimeout(resolve, 50));
            assert.ok(existsSync(ready), 'Commit hook did not start');
            let stageFinished = false;
            const stage = win.webContents
              .executeJavaScript(`window.gitApi.stage(${JSON.stringify(queueRepo)}, ['stage.txt'])`)
              .then(() => (stageFinished = true));
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.equal(stageFinished, false, 'Stage must wait for the in-flight commit');
            writeFileSync(release, '');
            await Promise.all([commit, stage]);
            assert.equal(git('diff', '--cached', '--name-only').toString().trim(), 'stage.txt');
          } finally {
            writeFileSync(release, '');
          }
        }
        const unbridged = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
        await unbridged.loadFile(path.join(__dirname, '../dist/index.html'));
        assert.equal(
          await unbridged.webContents.executeJavaScript(`document.querySelector('h1')?.textContent`),
          'GITVerse by PRAPAWITY could not start',
        );
        console.log('Electron smoke run passed: repository restore, graph hover highlight/clear, and bridge.');
        clearTimeout(timeout);
        app.exit(0);
      } catch (error) {
        console.error(error);
        clearTimeout(timeout);
        app.exit(1);
      }
    });
  });
  require('../dist-electron/main/main.js');
}
