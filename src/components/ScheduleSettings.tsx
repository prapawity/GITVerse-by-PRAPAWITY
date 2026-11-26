import { useState } from 'react';
import { desktopApi } from '../platform/api';
import type { NewSchedule, Schedule } from '../shared/scheduleState';
import type { ScheduledGitAction } from '../shared/scheduledGit';
import { useRepo } from '../store/repoStore';
import { useScheduler } from '../store/schedulerStore';
import { askConfirm } from './Dialogs';

const field = 'w-full rounded-md border border-surface bg-crust px-3 py-2 text-sm focus:border-accent';
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ScheduleForm({ initial, repos, onDone }: { initial?: Schedule; repos: string[]; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [action, setAction] = useState<ScheduledGitAction>(initial?.action ?? 'fetch');
  const [time, setTime] = useState(
    initial
      ? `${String(initial.timing.hour).padStart(2, '0')}:${String(initial.timing.minute).padStart(2, '0')}`
      : '09:00',
  );
  const [zone, setZone] = useState(initial?.timing.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [weekday, setWeekday] = useState(
    initial?.timing.weekday === null || !initial ? 'daily' : String(initial.timing.weekday),
  );
  const [scope, setScope] = useState<'open' | 'selected'>(initial?.scope.kind ?? 'open');
  const [selected, setSelected] = useState<string[]>(initial?.scope.kind === 'selected' ? initial.scope.repos : []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = [...new Set([...repos, ...selected])];
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!name.trim() || !time || !zone.trim() || (scope === 'selected' && !selected.length)) {
      setError(
        'Enter a name, time and time zone, and select at least one repository when using selected repositories.',
      );
      return;
    }
    const [hour, minute] = time.split(':').map(Number);
    const input: NewSchedule = {
      id: initial?.id ?? crypto.randomUUID(),
      name,
      action,
      timing: { hour, minute, timeZone: zone.trim(), weekday: weekday === 'daily' ? null : Number(weekday) },
      scope: scope === 'open' ? { kind: 'open' } : { kind: 'selected', repos: selected },
    };
    setBusy(true);
    try {
      if (initial) await desktopApi().scheduler.update(input);
      else await desktopApi().scheduler.add(input);
      await useScheduler.getState().refresh();
      onDone();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      await useScheduler.getState().refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => void save(event)}
      className="mt-5 space-y-4 rounded-lg border border-surface bg-mantle p-4"
    >
      <h2 className="font-semibold">{initial ? 'Edit scheduled task' : 'New scheduled task'}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="block">Name</span>
          <input className={field} value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block">Action</span>
          <select
            className={field}
            value={action}
            onChange={(event) => setAction(event.target.value as ScheduledGitAction)}
          >
            <option value="fetch">Fetch</option>
            <option value="pull">Pull (fast-forward only)</option>
            <option value="refresh">Refresh status</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block">Time</span>
          <input
            className={field}
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            required
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block">Time zone</span>
          <input
            className={field}
            value={zone}
            onChange={(event) => setZone(event.target.value)}
            required
            placeholder="Asia/Bangkok"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block">Repeat</span>
          <select className={field} value={weekday} onChange={(event) => setWeekday(event.target.value)}>
            <option value="daily">Every day</option>
            {days.map((day, index) => (
              <option key={day} value={index}>
                Every {day}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block">Repositories</span>
          <select
            className={field}
            value={scope}
            onChange={(event) => setScope(event.target.value === 'open' ? 'open' : 'selected')}
          >
            <option value="open">Open tabs when run starts</option>
            <option value="selected">Selected repositories</option>
          </select>
        </label>
      </div>
      {scope === 'selected' && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Select repositories</legend>
          {choices.length ? (
            choices.map((repo) => (
              <label key={repo} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.includes(repo)}
                  onChange={(event) =>
                    setSelected((value) =>
                      event.target.checked ? [...value, repo] : value.filter((item) => item !== repo),
                    )
                  }
                />
                <span className="break-all">{repo}</span>
              </label>
            ))
          ) : (
            <p className="text-sm text-sub">Open repositories first to select them.</p>
          )}
        </fieldset>
      )}
      <p className="text-sm text-sub">
        Tasks run only while the app is running and the computer is awake. Pull skips dirty or non-fast-forward
        repositories.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary min-h-[40px] px-4" disabled={busy}>
          {busy ? 'Saving…' : 'Save task'}
        </button>
        <button type="button" className="btn-ghost min-h-[40px] px-4" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ScheduleSettings() {
  const { schedules, ready, error, retry, recover } = useScheduler();
  const repos = useRepo((state) => state.recentRepos);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const run = async (id: string, operation: () => Promise<void>) => {
    setBusy(id);
    setActionError('');
    try {
      await operation();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      await useScheduler.getState().refresh();
      setBusy(null);
    }
  };
  return (
    <>
      <h1 className="text-2xl font-semibold">Scheduled tasks</h1>
      <p className="mt-1 text-sm text-sub">
        Fetch, fast-forward pull, or refresh repositories on a daily or weekly schedule.
      </p>
      {error && (
        <div role="alert" className="mt-4 rounded border border-danger/60 p-3 text-sm">
          <p>Scheduler paused: {error}</p>
          <button className="btn-secondary mt-2 px-3 py-2" onClick={() => void retry()}>
            Retry scheduler
          </button>
          {error.includes('previous run was interrupted') && (
            <button
              className="btn-secondary ml-2 mt-2 px-3 py-2"
              onClick={() =>
                void (async () => {
                  if (
                    await askConfirm(
                      'Recover interrupted scheduler',
                      'First ensure all other GITVerse instances and any Git processes they started have stopped. Continuing while they are still running can cause conflicting Git operations.',
                      { danger: true, label: 'I verified, recover' },
                    )
                  )
                    await recover();
                })()
              }
            >
              Recover interrupted scheduler…
            </button>
          )}
        </div>
      )}
      {schedules.some((item) => item.missed && !item.running) && (
        <button
          className="btn-secondary mt-4 min-h-[40px] px-4"
          onClick={() => window.dispatchEvent(new Event('gitverse:review-missed-schedules'))}
        >
          Review missed tasks
        </button>
      )}
      {!ready && !error && (
        <p className="mt-4 text-sm text-sub" role="status">
          Loading scheduled tasks…
        </p>
      )}
      {ready && !error && !editing && (
        <button className="btn-primary mt-5 min-h-[40px] px-4" onClick={() => setEditing('new')}>
          New scheduled task
        </button>
      )}
      {editing && (
        <ScheduleForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? undefined : editing}
          repos={repos}
          onDone={() => setEditing(null)}
        />
      )}
      {actionError && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {actionError}
        </p>
      )}
      {ready && !schedules.length && !editing && <p className="mt-6 text-sm text-sub">No scheduled tasks yet.</p>}
      <div className="mt-5 space-y-4">
        {schedules.map((item) => (
          <section key={item.id} className="rounded-lg border border-surface bg-mantle p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="break-words font-semibold">{item.name}</h2>
                <p className="mt-1 text-sm text-sub">
                  {item.action} · {item.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                  {item.running ? 'Running' : `Next (local time): ${new Date(item.nextDue).toLocaleString()}`} ·
                  Schedule zone: {item.timing.timeZone}
                </p>
                {item.missed && (
                  <p className="mt-1 text-sm text-warning">{item.missed.count} missed; awaiting a decision.</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-secondary px-3 py-2"
                  disabled={!!busy || !!item.running || !!error}
                  onClick={() => void run(item.id, () => desktopApi().scheduler.run(item.id))}
                >
                  Run now
                </button>
                <button
                  className="btn-secondary px-3 py-2"
                  disabled={!!busy || !!item.running || !!item.missed || !!error}
                  onClick={() => setEditing(item)}
                >
                  Edit
                </button>
                <button
                  className="btn-secondary px-3 py-2"
                  disabled={!!busy || !!item.running || !!error}
                  onClick={() => void run(item.id, () => desktopApi().scheduler.enable(item.id, !item.enabled))}
                >
                  {item.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className="btn-ghost px-3 py-2 text-danger"
                  disabled={!!busy || !!item.running || !!error}
                  onClick={() =>
                    void (async () => {
                      if (
                        await askConfirm('Delete scheduled task', `Delete "${item.name}" and its history?`, {
                          danger: true,
                          label: 'Delete',
                        })
                      )
                        await run(item.id, () => desktopApi().scheduler.remove(item.id));
                    })()
                  }
                >
                  Delete
                </button>
              </div>
            </div>
            {item.running && (
              <p className="mt-3 text-sm text-sub" role="status">
                Running: {item.running.results.length} repositories completed
              </p>
            )}
            {!!item.history.length && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer">Run history ({item.history.length})</summary>
                <div className="mt-2 space-y-3">
                  {item.history.map((entry) => (
                    <div key={entry.id} className="border-t border-surface pt-2">
                      <p className="font-medium">
                        {entry.status} · {entry.trigger} · {new Date(entry.startedAt).toLocaleString()}
                      </p>
                      {entry.results.length ? (
                        <ul className="mt-1 space-y-1 text-sub">
                          {entry.results.map((result) => (
                            <li key={result.repo} className="break-all">
                              {result.repo}: {result.status}
                              {result.detail ? ` — ${result.detail}` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sub">No repositories were run.</p>
                      )}
                      {entry.results.some((result) => result.status === 'failed') && (
                        <button
                          className="btn-secondary mt-2 px-3 py-2"
                          disabled={!!busy || !!item.running || !!error}
                          onClick={() => void run(item.id, () => desktopApi().scheduler.retryFailed(item.id, entry.id))}
                        >
                          Retry failed repositories
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
