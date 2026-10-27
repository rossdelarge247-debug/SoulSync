/**
 * What the engine asks the server for: a pair's plan and the two grids
 * (auto-mix stage A's routes), and each deck's window of audio
 * (`GET /api/library/dj/window/<id>`, stage B; CONTRACTS "Auto-mix stage B"),
 * one at a time in a tab and patient with a busy server.
 */

import { apiClient, readJson } from '@/app/api-client';
import { appURL } from '@/platform/url-base';

import type { PlanLike } from './executor';
import type { ApiGrid } from './grid';

import { prepareDeck, type DeckData } from './engine';

export interface Plan extends PlanLike {
  requested?: string;
  chosen_by?: string;
  pair?: string;
  note?: string | null;
  confidence?: number;
  styles?: { style: string; label: string; available: boolean; why: string | null }[];
  waiting_for?: string;
  reason?: string;
}

/** The server's window cap (core/dj/window.py MAX_SECONDS). */
export const MAX_WINDOW_S = 180;

export async function fetchPlan(
  from: string,
  to: string,
  style = 'auto',
  bars?: number,
): Promise<Plan> {
  const searchParams: Record<string, string> = { from, to, style };
  if (bars) searchParams.bars = String(bars);
  return (await readJson<{ plan: Plan }>(apiClient.get('library/dj/plan', { searchParams }))).plan;
}

export async function fetchGrids(ids: string[]): Promise<Record<string, ApiGrid>> {
  const body = await readJson<{ grids: Record<string, ApiGrid> }>(
    apiClient.post('library/dj/grids', { json: { track_ids: ids, beats: true } }),
  );
  return body.grids;
}

/** The URL of a track's window. */
export function windowUrl(trackId: string, start: number, dur: number, rate: number): string {
  const q = new URLSearchParams({
    start: Math.max(0, start).toFixed(3),
    dur: Math.min(MAX_WINDOW_S, Math.max(0.5, dur)).toFixed(3),
    rate: rate === 44100 ? '44100' : '48000',
  });
  return appURL(`/api/library/dj/window/${encodeURIComponent(trackId)}?${q.toString()}`);
}

/** How long a window may wait on a busy server, in all (milliseconds). */
export const BUSY_BUDGET_MS = 10_000;

/**
 * How long one window's request may take, answer and body (milliseconds).
 * A hung request would hold this tab's line (below) for good, and every
 * window after it would wait behind it; the server's own deadline is 60 s
 * a decode, so past 90 s nothing is coming.
 */
export const FETCH_TIMEOUT_MS = 90_000;

/** An abort signal that fires after `ms` (AbortSignal.timeout where the browser has it). */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException('The request timed out', 'TimeoutError')), ms);
  return c.signal;
}

/**
 * Windows are fetched one at a time in this tab: the server decodes one a
 * profile (core/dj/window.py), so two decks asked for together would have
 * the second refused. Each job starts when the one before has finished,
 * whether it worked or not.
 */
let line: Promise<unknown> = Promise.resolve();
export function inLine<T>(job: () => Promise<T>): Promise<T> {
  const run = line.then(job, job);
  line = run.catch(() => undefined);
  return run;
}

/** How long to wait before asking again after a 429: its Retry-After, else a backoff. */
export function busyDelayMs(res: Pick<Response, 'headers'>, attempt: number): number {
  const said = Number(res.headers.get('Retry-After'));
  const backoff = Math.min(4000, 250 * 2 ** attempt);
  return Number.isFinite(said) && said > 0 ? Math.max(said * 1000, backoff) : backoff;
}

export interface FetchWindowOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** each request's deadline (FETCH_TIMEOUT_MS) */
  timeoutMs?: number;
}

/** One window's bytes, asking again while the server is busy (another tab, another deck), for up to 10 s. */
async function fetchBytes(
  url: string,
  o: Required<FetchWindowOptions>,
): Promise<{ bytes: ArrayBuffer; res: Response }> {
  const started = o.now();
  for (let attempt = 0; ; attempt++) {
    // its own deadline each time it's asked, the body's reading included
    const signal = timeoutSignal(o.timeoutMs);
    let res: Response;
    try {
      res = await o.fetchImpl(url, { credentials: 'same-origin', signal });
    } catch (e) {
      throw signal.aborted ? new Error(TIMED_OUT) : e;
    }
    if (res.status === 429) {
      const wait = busyDelayMs(res, attempt);
      if (o.now() - started + wait > BUSY_BUDGET_MS) {
        throw new Error('The server is busy loading other tracks: try again in a moment.');
      }
      await o.sleep(wait);
      continue;
    }
    if (!res.ok) {
      let words = `couldn't load the audio (${res.status})`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) words = body.error;
      } catch {
        /* not JSON */
      }
      throw new Error(words);
    }
    try {
      return { bytes: await res.arrayBuffer(), res };
    } catch (e) {
      throw signal.aborted ? new Error(TIMED_OUT) : e;
    }
  }
}

const TIMED_OUT = 'The server took too long to send the track: try again in a moment.';

/**
 * Fetch and decode a window, in this tab's line (above). The browser
 * decodes at the context's rate, so the server is asked for that rate where
 * it can (44.1 or 48 kHz).
 */
export async function fetchWindow(
  ctx: BaseAudioContext,
  trackId: string,
  start: number,
  dur: number,
  options: FetchWindowOptions | typeof fetch = {},
): Promise<DeckData> {
  const o = typeof options === 'function' ? { fetchImpl: options } : options;
  const opts: Required<FetchWindowOptions> = {
    fetchImpl: o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
    sleep: o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    now: o.now ?? (() => Date.now()),
    timeoutMs: o.timeoutMs ?? FETCH_TIMEOUT_MS,
  };
  const s = Math.max(0, start);
  const url = windowUrl(trackId, s, dur, ctx.sampleRate);
  const { bytes, res } = await inLine(() => fetchBytes(url, opts));
  const buffer = await ctx.decodeAudioData(bytes);
  const offset = Number(res.headers.get('X-Window-Start') ?? s);
  return prepareDeck(buffer, Number.isFinite(offset) ? offset : s);
}
