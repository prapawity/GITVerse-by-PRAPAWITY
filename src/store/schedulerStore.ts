import { create } from 'zustand';
import { desktopApi } from '../platform/api';
import type { Schedule } from '../shared/scheduleState';

interface SchedulerState {
  schedules: Schedule[];
  ready: boolean;
  error: string | null;
  refresh(): Promise<void>;
  start(repos: string[]): Promise<void>;
  retry(): Promise<void>;
  recover(): Promise<void>;
}

let revision = 0;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useScheduler = create<SchedulerState>((set) => ({
  schedules: [],
  ready: false,
  error: null,
  refresh: async () => {
    const current = ++revision;
    try {
      const state = await desktopApi().scheduler.list();
      if (current === revision) set({ ...state, ready: true });
    } catch (error) {
      if (current === revision) set({ error: message(error) });
    }
  },
  start: async (repos) => {
    const current = ++revision;
    try {
      const state = await desktopApi().scheduler.init(repos);
      if (current === revision) set({ ...state, ready: true });
    } catch (error) {
      if (current === revision) set({ error: message(error), ready: false });
    }
  },
  retry: async () => {
    const current = ++revision;
    try {
      const state = await desktopApi().scheduler.retry();
      if (current === revision) set({ ...state, ready: true });
    } catch (error) {
      if (current === revision) set({ error: message(error) });
    }
  },
  recover: async () => {
    const current = ++revision;
    try {
      const state = await desktopApi().scheduler.recover();
      if (current === revision) set({ ...state, ready: true });
    } catch (error) {
      if (current === revision) set({ error: message(error) });
    }
  },
}));
