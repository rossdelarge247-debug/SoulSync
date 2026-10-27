/**
 * Analyse on demand (api/dj.py `/analyse` and `/progress`, CONTRACTS.md
 * "Analyse on demand"): a track someone needs now jumps the DJ sweep's queue,
 * and each track says where it is in the analysis.
 *
 * - `requestAnalysis(ids)`: asks for tracks, batched (one request at a time,
 *   gathered over a moment, since the server takes one a second a profile)
 *   and remembered for a while so a page drawn again doesn't ask again.
 * - `analysisStore`: one poll for every track any part of the page is
 *   showing progress for, every 1.5 s while something is in line or being
 *   worked out, else every 20 s; when a track finishes, the DJ data, sets
 *   and plans are read again so rows and chips update on their own.
 */
import type { QueryClient } from '@tanstack/react-query';

import { apiClient } from '@/app/api-client';

export type AnalysisStep = 'read' | 'tempo' | 'key' | 'energy' | 'tags' | 'grid' | 'phrases';

export type AnalysisWait =
  | 'drive_away'
  | 'download'
  | 'import'
  | 'drive_move'
  | 'tag_write'
  | 'held'
  | 'off'
  | 'not_queued';

export type AnalysisFail = 'too_long' | 'unreachable' | 'error' | 'no_grid';

export type AnalysisEntry =
  | { state: 'done' }
  | { state: 'working'; step: AnalysisStep | null; percent: number }
  | { state: 'queued'; position: number; asked_for: boolean }
  | { state: 'waiting'; reason: AnalysisWait; position: number | null; asked_for: boolean }
  | { state: 'failed'; reason: AnalysisFail };

export interface AnalysisSweep {
  running: boolean;
  held: boolean;
  analyze: boolean;
  id: number | null;
  total: number;
  done: number;
  percent: number | null;
  waiting: AnalysisWait | null;
  /** tracks in the asked-for line, and how many of them are yours */
  in_line: number;
  yours: number;
  current: {
    step: AnalysisStep | null;
    percent: number | null;
    asked_for: boolean;
    /** only when the track is in your library */
    track_id: string | null;
    title: string | null;
  } | null;
}

export interface ProgressAnswer {
  success?: boolean;
  error?: string;
  tracks: Record<string, AnalysisEntry>;
  sweep: AnalysisSweep;
}

export interface AnalyseAnswer {
  success?: boolean;
  error?: string;
  code?: string;
  /** your library's tracks among those asked for */
  asked: number;
  queued: number;
  already_queued: number;
  already_done: number;
  /** couldn't be analysed before, and wouldn't be now */
  cant: number;
  over_limit: number;
  limit: number;
  yours: number;
  started: boolean;
}

export class AnalyseError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

/** One request: the tracks (or a playlist) in the asked-for line. */
export async function postAnalyse(
  body: { track_ids: string[] } | { playlist_id: number },
): Promise<AnalyseAnswer> {
  const response = await apiClient.post('library/dj/analyse', {
    json: body,
    throwHttpErrors: false,
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<AnalyseAnswer>;
  if (!response.ok || payload.success === false) {
    const after = Number(response.headers.get('Retry-After'));
    throw new AnalyseError(
      payload.error || "That didn't work. Try again in a moment.",
      payload.code ?? null,
      response.status,
      Number.isFinite(after) && after > 0 ? after : null,
    );
  }
  return payload as AnalyseAnswer;
}

export async function postProgress(ids: string[]): Promise<ProgressAnswer> {
  const response = await apiClient.post('library/dj/progress', {
    json: { track_ids: ids.slice(0, 500) },
  });
  return (await response.json()) as ProgressAnswer;
}

/* ── asking: one request at a time, gathered and remembered ──────────── */

/** a track asked for isn't asked for again by an automatic trigger this soon */
const REMEMBER_MS = 10 * 60_000;
/** ids gathered for this long go in one request */
const GATHER_MS = 250;
const MAX_TRIES = 6;
/** the server takes one request a second a profile: the next waits that long */
const SPACING_MS = 1_050;

interface Waiter {
  ids: string[];
  resolve: (a: AnalyseAnswer) => void;
  reject: (e: unknown) => void;
}

const asked = new Map<string, number>();
let gathered: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending: Promise<void> | null = null;
let lastSent = -Infinity;

function now(): number {
  return Date.now();
}

async function send(batch: Waiter[]): Promise<void> {
  const ids = [...new Set(batch.flatMap((w) => w.ids))].slice(0, 500);
  let tries = 0;
  for (;;) {
    try {
      const answer = await postAnalyse({ track_ids: ids });
      const t = now();
      for (const id of ids) asked.set(id, t);
      for (const w of batch) w.resolve(answer);
      analysisStore.pollSoon();
      return;
    } catch (error) {
      tries += 1;
      if (error instanceof AnalyseError && error.status === 429 && tries < MAX_TRIES) {
        await new Promise((r) => setTimeout(r, (error.retryAfter ?? 1) * 1000 + 50));
        continue;
      }
      for (const id of ids) asked.delete(id);
      for (const w of batch) w.reject(error);
      return;
    }
  }
}

function flush(): void {
  timer = null;
  if (sending) {
    // one request at a time: the next goes when this one is answered
    void sending.then(() => {
      if (!timer && gathered.length) timer = setTimeout(flush, 0);
    });
    return;
  }
  const wait = lastSent + SPACING_MS - now();
  if (wait > 0) {
    timer = setTimeout(flush, wait);
    return;
  }
  const batch = gathered;
  gathered = [];
  if (!batch.length) return;
  lastSent = now();
  sending = send(batch).finally(() => {
    sending = null;
  });
}

/**
 * Ask for tracks to be analysed now. `force` (Analyse these) asks even for
 * tracks asked for a moment ago; otherwise (an automatic trigger: a set
 * opened, Up next with DJ mix) a track asked for in the last ten minutes
 * isn't asked again, and with nothing left the answer is null.
 */
export function requestAnalysis(
  ids: (string | number | null | undefined)[],
  { force = false }: { force?: boolean } = {},
): Promise<AnalyseAnswer | null> {
  const t = now();
  const wanted = [
    ...new Set(
      ids
        .filter((id): id is string | number => id !== null && id !== undefined && id !== '')
        .map(String),
    ),
  ].filter((id) => force || t - (asked.get(id) ?? -Infinity) > REMEMBER_MS);
  if (!wanted.length) return Promise.resolve(null);
  // marked at once, so a page drawn twice in a moment asks once
  for (const id of wanted) asked.set(id, t);
  return new Promise<AnalyseAnswer>((resolve, reject) => {
    gathered.push({ ids: wanted, resolve, reject });
    if (!timer) timer = setTimeout(flush, GATHER_MS);
  });
}

/** Ask, saying nothing on a failure: an automatic trigger. */
export function requestAnalysisQuietly(ids: (string | number | null | undefined)[]): void {
  requestAnalysis(ids).catch(() => {
    /* the sweep reaches them anyway; a page shows Not analysed yet */
  });
}

/* ── progress: one poll for the whole page ──────────────────────────── */

const ACTIVE_MS = 1_500;
const IDLE_MS = 20_000;
export const DJ_ANALYSED_EVENT = 'soulsync:dj-analysed';

function active(e: AnalysisEntry | undefined): boolean {
  if (!e) return false;
  if (e.state === 'working' || e.state === 'queued') return true;
  return e.state === 'waiting' && e.position !== null;
}

class AnalysisStore {
  private watched = new Map<string, number>();
  private sweepWatchers = 0;
  private entries = new Map<string, AnalysisEntry>();
  private sweepState: AnalysisSweep | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private again = false;
  private qc: QueryClient | null = null;

  setQueryClient(qc: QueryClient): void {
    this.qc = qc;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  entry(id: string): AnalysisEntry | undefined {
    return this.entries.get(id);
  }

  sweep(): AnalysisSweep | null {
    return this.sweepState;
  }

  /** Show progress for these tracks (and, with `sweep`, the sweep's own). */
  watch(ids: string[], { sweep = false }: { sweep?: boolean } = {}): () => void {
    let fresh = false;
    for (const id of ids) {
      const n = this.watched.get(id) ?? 0;
      if (!n && !this.entries.has(id)) fresh = true;
      this.watched.set(id, n + 1);
    }
    if (sweep) {
      if (!this.sweepWatchers) fresh = true;
      this.sweepWatchers += 1;
    }
    if (fresh) this.pollSoon();
    else if (!this.timer && !this.inFlight) this.schedule(ACTIVE_MS);
    return () => {
      for (const id of ids) {
        const n = (this.watched.get(id) ?? 1) - 1;
        if (n > 0) this.watched.set(id, n);
        else this.watched.delete(id);
      }
      if (sweep) this.sweepWatchers = Math.max(0, this.sweepWatchers - 1);
      if (!this.watched.size && !this.sweepWatchers && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  pollSoon(): void {
    this.schedule(60);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, ms);
  }

  private emit(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  async poll(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (!this.watched.size && !this.sweepWatchers) return;
    if (typeof document === 'object' && document.hidden) {
      this.schedule(IDLE_MS);
      return;
    }
    this.inFlight = true;
    const ids = [...this.watched.keys()];
    let next = IDLE_MS;
    try {
      const answer = await postProgress(ids);
      const finished: string[] = [];
      for (const id of ids) {
        const was = this.entries.get(id);
        const is = answer.tracks?.[id];
        if (is) this.entries.set(id, is);
        else this.entries.delete(id);
        if (
          was &&
          was.state !== 'done' &&
          was.state !== 'failed' &&
          is &&
          (is.state === 'done' || is.state === 'failed')
        )
          finished.push(id);
      }
      const sweepWas = this.sweepState;
      this.sweepState = answer.sweep ?? null;
      if (finished.length) this.finished(finished);
      else if (sweepWas?.running && sweepWas.done !== this.sweepState?.done && this.sweepWatchers)
        void this.qc?.invalidateQueries({ queryKey: ['dj', 'status'] });
      if (ids.some((id) => active(this.entries.get(id))) || this.sweepState?.running)
        next = ACTIVE_MS;
      this.emit();
    } catch {
      next = IDLE_MS;
    } finally {
      this.inFlight = false;
    }
    if (this.again) {
      this.again = false;
      next = 60;
    }
    if (this.watched.size || this.sweepWatchers) this.schedule(next);
  }

  /** Tracks finished: their BPM, key, energy and chips are read again. */
  private finished(ids: string[]): void {
    const qc = this.qc;
    if (qc) {
      // the DJ data (rows, the Mix tab, browse), sets' rows and steps, and
      // the auto-mix plans; never Vibe, which would spend AI usage again
      void qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return (k[0] === 'dj' && k[1] !== 'mix-vibe') || k[0] === 'sets' || k[0] === 'automix';
        },
      });
    }
    if (typeof window === 'object')
      window.dispatchEvent(new CustomEvent(DJ_ANALYSED_EVENT, { detail: { ids } }));
  }

  /** For tests: forget everything. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watched.clear();
    this.entries.clear();
    this.sweepWatchers = 0;
    this.sweepState = null;
    this.inFlight = false;
    this.again = false;
    this.version += 1;
  }
}

export const analysisStore = new AnalysisStore();

/** For tests: forget what was asked and gathered. */
export function resetAnalysisRequests(): void {
  asked.clear();
  gathered = [];
  if (timer) clearTimeout(timer);
  timer = null;
  sending = null;
  lastSent = -Infinity;
}
