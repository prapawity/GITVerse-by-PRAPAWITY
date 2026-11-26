import { useEffect, useRef, useState } from 'react';
import { desktopApi, platformApi } from '../platform/api';
import { useRepo } from '../store/repoStore';
import { useScheduler } from '../store/schedulerStore';

export function ScheduleHost() {
  const { schedules, error, ready } = useScheduler();
  const [dismissed, setDismissed] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const seenRuns = useRef<Set<string> | null>(null);
  const missed = schedules.filter((item) => item.missed && !item.running);
  const signature = missed.map((item) => `${item.id}:${item.missed?.count}:${item.missed?.latest}`).join('|');

  useEffect(() => {
    const api = platformApi();
    if (!api) {
      useScheduler.setState({ error: 'Scheduled tasks require the desktop application.' });
      return;
    }
    let active = true;
    const stopEvents = api.scheduler.onChanged(() => void useScheduler.getState().refresh());
    let chain = useScheduler.getState().start(useRepo.getState().recentRepos);
    const stopRepos = useRepo.subscribe((state, previous) => {
      if (state.recentRepos === previous.recentRepos) return;
      const repos = state.recentRepos;
      chain = chain
        .then(async () => {
          if (active) await api.scheduler.repos(repos);
        })
        .catch((failure: unknown) => {
          if (active) useRepo.getState().notify('error', 'Could not update scheduler repositories', String(failure));
        });
    });
    return () => {
      active = false;
      stopEvents();
      stopRepos();
    };
  }, []);

  useEffect(() => {
    if (signature && signature !== dismissed && ready) {
      if (!dialog.current?.open) dialog.current?.showModal();
    } else if (dialog.current?.open) dialog.current.close();
  }, [signature, dismissed, ready]);

  useEffect(() => {
    if (error) useRepo.getState().notify('error', 'Scheduler is unavailable', error);
  }, [error]);

  useEffect(() => {
    const show = () => setDismissed('');
    window.addEventListener('gitverse:review-missed-schedules', show);
    return () => window.removeEventListener('gitverse:review-missed-schedules', show);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const current = new Set(schedules.flatMap((schedule) => schedule.history.map((run) => run.id)));
    if (seenRuns.current) {
      for (const schedule of schedules) {
        for (const run of schedule.history) {
          if (seenRuns.current.has(run.id)) continue;
          const kind =
            run.status === 'success'
              ? 'success'
              : run.status === 'failed' || run.status === 'interrupted'
                ? 'error'
                : 'warning';
          useRepo
            .getState()
            .notify(
              kind,
              `Scheduled task ${run.status}: ${schedule.name}`,
              `${run.results.length} repositories processed. See Scheduled tasks for details.`,
            );
          const active = useRepo.getState().repoPath;
          if (active && run.results.some((result) => result.repo === active)) void useRepo.getState().refresh(true);
        }
      }
    }
    seenRuns.current = current;
  }, [ready, schedules]);

  const later = () => {
    setDismissed(signature);
    setSelected([]);
    setActionError('');
  };
  const decide = async (run: boolean) => {
    setBusy(true);
    setActionError('');
    try {
      if (run) await desktopApi().scheduler.runMissed(selected);
      else await desktopApi().scheduler.skipMissed(missed.map((item) => item.id));
      setSelected([]);
      await useScheduler.getState().refresh();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
      await useScheduler.getState().refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="missed-schedules-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) later();
      }}
      className="w-[560px] max-w-[92vw] rounded-lg border border-surface bg-mantle p-5 text-text shadow-2xl backdrop:bg-black/55"
    >
      <h2 id="missed-schedules-title" className="text-lg font-semibold">
        Missed scheduled tasks
      </h2>
      <p className="mt-2 text-sm text-sub">
        Nothing has run automatically. Select tasks to run once, skip all, or decide later.
      </p>
      <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
        {missed.map((item) => (
          <label key={item.id} className="flex items-start gap-3 rounded border border-surface p-3">
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={(event) =>
                setSelected((value) =>
                  event.target.checked ? [...value, item.id] : value.filter((id) => id !== item.id),
                )
              }
              disabled={busy}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="block break-words font-medium">{item.name}</span>
              <span className="block text-sm text-sub">
                {item.action} · {item.missed?.count} missed · latest {new Date(item.missed!.latest).toLocaleString()}
              </span>
            </span>
          </label>
        ))}
      </div>
      {actionError && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {actionError}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button className="btn-ghost min-h-[40px] px-4" disabled={busy} onClick={later}>
          Later
        </button>
        <button
          className="btn-secondary min-h-[40px] px-4"
          disabled={busy || !missed.length}
          onClick={() => void decide(false)}
        >
          Skip all
        </button>
        <button
          className="btn-primary min-h-[40px] px-4"
          disabled={busy || !selected.length}
          onClick={() => void decide(true)}
        >
          {busy ? 'Running…' : 'Run selected'}
        </button>
      </div>
    </dialog>
  );
}
