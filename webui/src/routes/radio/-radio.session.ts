/**
 * The player's radio session (src/shell/radio-session.ts, window.SoulSyncRadio)
 * as React state, kept current by its `ss:radio` event.
 */

import { useEffect, useState } from 'react';

import type { RadioSessionApi, RadioSessionState } from '@/features/radio/radio.types';

import { RADIO_EVENT } from '@/features/radio/radio.types';

export function radioSession(): RadioSessionApi | undefined {
  return window.SoulSyncRadio;
}

const IDLE: RadioSessionState = {
  status: 'idle',
  station: null,
  sessionId: null,
  mode: null,
  stream: null,
  nowPlaying: null,
  error: null,
  skew: 0,
  adding: false,
  scan: null,
  scanError: null,
  scanStarting: false,
};

export function useRadioSession(): RadioSessionState {
  const [state, setState] = useState<RadioSessionState>(() => radioSession()?.state() ?? IDLE);
  useEffect(() => {
    const sync = () => setState(radioSession()?.state() ?? IDLE);
    sync();
    window.addEventListener(RADIO_EVENT, sync);
    return () => window.removeEventListener(RADIO_EVENT, sync);
  }, []);
  return state;
}

/** Ticks every few seconds, so "identified 40 s ago" keeps counting. */
export function useTick(ms = 5000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

export function playStation(
  stationId: string,
  options?: Parameters<RadioSessionApi['play']>[1],
): void {
  const api = radioSession();
  if (!api) {
    window.showToast?.('The player isn’t ready yet. Try again in a moment.', 'error');
    return;
  }
  void api.play(stationId, options);
}
