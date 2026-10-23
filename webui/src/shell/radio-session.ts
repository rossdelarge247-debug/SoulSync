/**
 * The player's radio session (build e; boards 4a, 4i, 4j): which station is
 * playing, through which path, and what's on it now. It lives in the shell so
 * a station keeps playing (and keeps being identified) while you move between
 * pages, and both the Radio page and the player read it from
 * `window.SoulSyncRadio`, with an `ss:radio` event on every change.
 *
 * - Play: `POST /api/radio/play` decides the path. A direct stream is tried
 *   first when the server offers one; if the browser can't play it, the same
 *   station is asked for again through the relay (`force_relay`).
 * - While it plays, `GET /api/radio/now-playing` every 10 seconds (30 while
 *   the tab is hidden): what's on, and the heartbeat that keeps a direct
 *   session alive on the server.
 * - Stop: `POST /api/radio/stop` and the player stops. Playing anything else
 *   ends the session too.
 * - Scan now: `POST /api/radio/scan`, then `GET /api/radio/scan/<id>` every
 *   second while it listens (about ten seconds on the server, then the
 *   identification services). There's no Done (HANDOFF 58): the answer
 *   lives as long as a track the station named, until the station names the
 *   next one, the next scan, Stop or another station. The per-minute limit
 *   keeps the last answer and says when Scan now can run again.
 */

import type {
  NowPlaying,
  PlayResponse,
  RadioSessionApi,
  RadioSessionState,
  ScanResult,
  Station,
} from '@/features/radio/radio.types';

import { barMeta } from '@/features/radio/radio.format';
import { RADIO_EVENT } from '@/features/radio/radio.types';
import { appURL } from '@/platform/url-base';

const POLL_MS = 10_000;
const POLL_HIDDEN_MS = 30_000;
const SCAN_POLL_MS = 1_000;

interface Engine {
  playRadio?: (item: Record<string, unknown>) => Promise<{ status: string; error?: string }>;
  updateRadio?: (info: Record<string, unknown>) => void;
  stop?: () => Promise<void> | void;
  state?: () => {
    track: { kind?: string; radio?: { session_id?: string } } | null;
    playing: boolean;
  };
}

export interface RadioSessionDeps {
  fetch: typeof fetch;
  engine: () => Engine | undefined;
  win: Window;
  now?: () => number;
}

function idle(): RadioSessionState {
  return {
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
    scanWaitUntil: null,
  };
}

async function json<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

export function createRadioSession(deps: RadioSessionDeps): RadioSessionApi & { dispose(): void } {
  let st: RadioSessionState = idle();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let scanGeneration = 0;
  let generation = 0;
  let lastPlay: { stationId: string; streamId?: string; station?: Station } | null = null;
  const now = deps.now ?? (() => Date.now());

  const emit = () => deps.win.dispatchEvent(new CustomEvent(RADIO_EVENT, { detail: st }));
  const set = (patch: Partial<RadioSessionState>) => {
    st = { ...st, ...patch };
    emit();
  };

  const api = (path: string, init?: RequestInit) =>
    deps.fetch(appURL(`/api/radio/${path}`), {
      credentials: 'same-origin',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });

  function schedule() {
    if (timer) clearTimeout(timer);
    if (st.status !== 'playing') return;
    const hidden = deps.win.document?.visibilityState === 'hidden';
    timer = setTimeout(() => void refresh(), hidden ? POLL_HIDDEN_MS : POLL_MS);
  }

  function pushToPlayer() {
    const station = st.station;
    if (!station) return;
    deps.engine()?.updateRadio?.({
      title: station.name,
      subtitle: barMeta(st.stream, station),
      radio: { station_id: station.id, session_id: st.sessionId, mode: st.mode },
    });
  }

  async function refresh(): Promise<void> {
    const station = st.station;
    if (!station || st.status !== 'playing') return;
    const gen = generation;
    try {
      const q = new URLSearchParams({ station_id: station.id });
      if (st.sessionId) q.set('session_id', st.sessionId);
      const res = await api(`now-playing?${q.toString()}`);
      const body = await json<NowPlaying & { success?: boolean }>(res);
      if (gen !== generation) return;
      if (res.ok && body.success !== false) {
        const skew = body.now ? now() / 1000 - body.now : st.skew;
        set({
          nowPlaying: body,
          skew,
          ...(stationNamedNext(body) ? { scan: null, scanError: null } : {}),
        });
        pushToPlayer();
      }
    } catch {
      // a missed poll is retried on the next one
    } finally {
      if (gen === generation) schedule();
    }
  }

  async function start(
    stationId: string,
    options: { streamId?: string; station?: Station; forceRelay?: boolean },
  ): Promise<void> {
    const gen = ++generation;
    clearScanTimer();
    lastPlay = { stationId, streamId: options.streamId, station: options.station };
    set({
      ...idle(),
      status: 'starting',
      station: options.station ?? (st.station?.id === stationId ? st.station : null),
    });
    let body: PlayResponse;
    try {
      const res = await api('play', {
        method: 'POST',
        body: JSON.stringify({
          station_id: stationId,
          stream_id: options.streamId,
          force_relay: options.forceRelay || undefined,
        }),
      });
      body = await json<PlayResponse>(res);
      if (gen !== generation) return;
      if (!res.ok || !body.success) {
        set({
          status: 'error',
          error: {
            code: body.error || 'play_failed',
            message: body.message || 'The station couldn’t be started. Try again.',
          },
        });
        return;
      }
    } catch {
      if (gen === generation) {
        set({
          status: 'error',
          error: { code: 'offline', message: 'SYNCHRO.S didn’t answer. Try again.' },
        });
      }
      return;
    }
    set({
      station: body.station,
      sessionId: body.session_id,
      mode: body.mode,
      stream: body.stream,
    });
    const engine = deps.engine();
    if (!engine?.playRadio) {
      set({
        status: 'error',
        error: { code: 'no_player', message: 'The player isn’t ready yet.' },
      });
      return;
    }
    const direct = body.mode === 'direct';
    const src = direct ? body.play_url : appURL(body.play_url);
    const result = await engine.playRadio({
      id: `radio:${body.station.id}`,
      src,
      title: body.station.name,
      subtitle: barMeta(body.stream, body.station),
      artUrl: body.station.logo_url || null,
      radio: { station_id: body.station.id, session_id: body.session_id, mode: body.mode },
      crossOrigin: direct,
      quiet: direct,
    });
    if (gen !== generation) return;
    if (result?.status === 'played') {
      set({ status: 'playing', error: null });
      void refresh();
      return;
    }
    if (result?.status === 'superseded') return;
    // tell the server this session is over, whichever way it went
    void api('stop', { method: 'POST', body: JSON.stringify({ session_id: body.session_id }) });
    if (direct && !options.forceRelay) {
      await start(stationId, { ...options, station: body.station, forceRelay: true });
      return;
    }
    set({
      status: 'error',
      sessionId: null,
      error: {
        code: 'stream_failed',
        message: `${body.station.name} isn’t playing right now. The ${body.stream.label.replace(' (best offered)', '')} stream didn’t start. Stations drop out for a few minutes at a time.`,
      },
    });
  }

  // ── Scan now ─────────────────────────────────────────────────────────────
  /** The station named a track after the scan finished: the answer has had its turn. */
  function stationNamedNext(np: NowPlaying): boolean {
    const scan = st.scan;
    const done = scan && scan.state !== 'listening' ? (scan.finished_at ?? scan.now) : null;
    if (done == null && !st.scanError) return false;
    if (np.state !== 'identified' || !np.source || np.source.startsWith('scan_')) return false;
    // a refusal has no server time: any track named after it replaces it
    if (done == null)
      return np.identified_at != null && np.identified_at > (st.nowPlaying?.identified_at ?? 0);
    return (np.identified_at ?? 0) > done;
  }

  function waitUntil(ms: number | null) {
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = null;
    if (ms) waitTimer = setTimeout(() => set({ scanWaitUntil: null }), Math.max(0, ms - now()));
    set({ scanWaitUntil: ms });
  }

  function clearScanTimer() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    scanGeneration += 1;
  }

  async function pollScan(scanId: string, gen: number): Promise<void> {
    if (gen !== scanGeneration) return;
    try {
      const res = await api(`scan/${encodeURIComponent(scanId)}`);
      const body = await json<ScanResult & { success?: boolean; message?: string }>(res);
      if (gen !== scanGeneration) return;
      if (!res.ok || body.success === false) {
        set({
          scan: null,
          scanError: body.message || 'The scan’s answer couldn’t be read. Try again.',
        });
        return;
      }
      set({ scan: body });
      if (body.state === 'listening') {
        scanTimer = setTimeout(() => void pollScan(scanId, gen), SCAN_POLL_MS);
      } else if (body.state === 'identified') {
        void refresh();
      }
    } catch {
      if (gen === scanGeneration)
        scanTimer = setTimeout(() => void pollScan(scanId, gen), SCAN_POLL_MS * 2);
    }
  }

  async function scanNow(): Promise<void> {
    if (st.status !== 'playing' || !st.sessionId) return;
    if (st.scanStarting || st.scan?.state === 'listening') return;
    if (st.scanWaitUntil && st.scanWaitUntil > now()) return;
    clearScanTimer();
    const gen = scanGeneration;
    // the last answer stays until this one is under way (or the limit says no)
    set({ scanStarting: true });
    try {
      const res = await api('scan', {
        method: 'POST',
        body: JSON.stringify({ session_id: st.sessionId }),
      });
      const body = await json<
        ScanResult & { success?: boolean; message?: string; error?: string; retry_after?: number }
      >(res);
      if (gen !== scanGeneration) return;
      if (!res.ok || body.success === false) {
        if (body.error === 'rate_limited' && body.retry_after) {
          set({ scanStarting: false });
          waitUntil(now() + body.retry_after * 1000);
          return;
        }
        set({
          scanStarting: false,
          scan: null,
          scanError: body.message || 'The scan couldn’t start. Try again.',
        });
        return;
      }
      set({ scanStarting: false, scan: body, scanError: null });
      if (body.state === 'listening') {
        scanTimer = setTimeout(() => void pollScan(body.scan_id, gen), SCAN_POLL_MS);
      } else if (body.state === 'identified') {
        void refresh();
      }
    } catch {
      if (gen === scanGeneration)
        set({ scanStarting: false, scanError: 'SYNCHRO.S didn’t answer. Try again.' });
    }
  }

  async function addScanToWanted(): Promise<boolean> {
    const scan = st.scan;
    if (!scan?.heard_id || st.adding) return false;
    set({ adding: true });
    try {
      const res = await api(`heard/${scan.heard_id}/want`, { method: 'POST' });
      const body = await json<{ success?: boolean; message?: string }>(res);
      if (!res.ok || body.success === false) {
        (deps.win as Window & { showToast?: (m: string, t: string) => void }).showToast?.(
          body.message || 'It couldn’t be added to Wanted. Try again.',
          'error',
        );
        return false;
      }
      if (st.scan?.scan_id === scan.scan_id) set({ scan: { ...scan, on_wanted: true } });
      return true;
    } catch {
      return false;
    } finally {
      set({ adding: false });
      void refresh();
    }
  }

  async function stop(): Promise<void> {
    generation += 1;
    clearScanTimer();
    if (timer) clearTimeout(timer);
    const sid = st.sessionId;
    set(idle());
    if (sid) {
      try {
        await api('stop', { method: 'POST', body: JSON.stringify({ session_id: sid }) });
      } catch {
        // the server drops an unused session on its own
      }
    }
    const engine = deps.engine();
    const track = engine?.state?.().track;
    if (track?.kind === 'radio') await engine?.stop?.();
  }

  async function addToWanted(): Promise<boolean> {
    const np = st.nowPlaying;
    if (!np?.heard_id || st.adding) return false;
    set({ adding: true });
    try {
      const res = await api(`heard/${np.heard_id}/want`, { method: 'POST' });
      const body = await json<{ success?: boolean; message?: string }>(res);
      if (!res.ok || body.success === false) {
        (deps.win as Window & { showToast?: (m: string, t: string) => void }).showToast?.(
          body.message || 'It couldn’t be added to Wanted. Try again.',
          'error',
        );
        return false;
      }
      set({ nowPlaying: { ...np, on_wanted: true } });
      return true;
    } catch {
      return false;
    } finally {
      set({ adding: false });
      void refresh();
    }
  }

  // playing anything else ends the session; a stream that ends says so
  const onPlayer = () => {
    if (st.status !== 'playing' && st.status !== 'starting') return;
    const track = deps.engine()?.state?.().track;
    if (st.status === 'playing' && track && track.kind !== 'radio') {
      const sid = st.sessionId;
      generation += 1;
      clearScanTimer();
      set(idle());
      if (sid) void api('stop', { method: 'POST', body: JSON.stringify({ session_id: sid }) });
    } else if (st.status === 'playing' && !track) {
      const sid = st.sessionId;
      generation += 1;
      clearScanTimer();
      set(idle());
      if (sid) void api('stop', { method: 'POST', body: JSON.stringify({ session_id: sid }) });
    }
  };
  const onEnded = () => {
    if (st.status !== 'playing' || !st.station) return;
    set({
      status: 'error',
      error: {
        code: 'stream_ended',
        message: `${st.station.name} stopped sending audio. Stations drop out for a few minutes at a time.`,
      },
    });
  };
  const onVisibility = () => schedule();
  deps.win.addEventListener('ss:player', onPlayer);
  deps.win.addEventListener('ss:radio-stream-ended', onEnded);
  deps.win.document?.addEventListener('visibilitychange', onVisibility);

  return {
    state: () => st,
    play: (stationId, options = {}) => start(stationId, options),
    stop,
    retry: async () => {
      if (lastPlay)
        await start(lastPlay.stationId, { streamId: lastPlay.streamId, station: lastPlay.station });
    },
    addToWanted,
    refresh,
    scanNow,
    addScanToWanted,
    dispose() {
      if (timer) clearTimeout(timer);
      if (waitTimer) clearTimeout(waitTimer);
      clearScanTimer();
      deps.win.removeEventListener('ss:player', onPlayer);
      deps.win.removeEventListener('ss:radio-stream-ended', onEnded);
      deps.win.document?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

let instance: (RadioSessionApi & { dispose(): void }) | null = null;

/** Boot once with the page; the API goes on window.SoulSyncRadio. */
export function bootRadioSession(win: Window = window): RadioSessionApi {
  if (instance) return instance;
  instance = createRadioSession({
    fetch: (...args) => win.fetch(...args),
    engine: () => (win as Window & { SoulSyncPlayer?: Engine }).SoulSyncPlayer,
    win,
  });
  (win as Window & { SoulSyncRadio?: RadioSessionApi }).SoulSyncRadio = instance;
  return instance;
}
