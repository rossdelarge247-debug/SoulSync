/**
 * The drives' state, shared by every place that shows "Your library's drive
 * isn't connected" (the library pages, Home's alert band, Activity). One poll
 * for the page, as often as the server looks (every 30 s), started by the
 * first component that asks and stopped when the last one goes.
 */

import { useEffect } from 'react';
import { create } from 'zustand';

import type { DriveStatus } from './drives.api';

import { drivesApi } from './drives.api';

interface DriveStatusStore {
  status: DriveStatus | null;
  checking: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  checkNow: () => Promise<void>;
}

export const useDriveStatusStore = create<DriveStatusStore>((set) => ({
  status: null,
  checking: false,
  error: false,
  refresh: async () => {
    try {
      const status = await drivesApi.status();
      set({ status, error: false });
    } catch {
      set({ error: true });
    }
  },
  checkNow: async () => {
    set({ checking: true });
    try {
      const status = await drivesApi.checkNow();
      set({ status, error: false });
    } catch {
      set({ error: true });
    } finally {
      set({ checking: false });
    }
  },
}));

let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function startPolling(): void {
  watchers += 1;
  if (watchers > 1) return;
  const store = useDriveStatusStore.getState();
  void store.refresh();
  const every = (useDriveStatusStore.getState().status?.interval ?? 30) * 1000;
  timer = setInterval(() => void useDriveStatusStore.getState().refresh(), every);
}

function stopPolling(): void {
  watchers = Math.max(0, watchers - 1);
  if (watchers === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** The drives' state, polled while mounted. */
export function useDriveStatus(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    startPolling();
    return stopPolling;
  }, [enabled]);
  return useDriveStatusStore();
}

/** For tests: forget the state and the poll. */
export function resetDriveStatus(): void {
  if (timer) clearInterval(timer);
  timer = null;
  watchers = 0;
  useDriveStatusStore.setState({ status: null, checking: false, error: false });
}
