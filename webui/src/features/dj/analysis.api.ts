/**
 * Analyse on demand (api/dj.py `/analyse` and `/progress`, CONTRACTS.md
 * "Analyse on demand"): a track someone needs now jumps the DJ sweep's queue,
 * and each track says where it is in the analysis.
 *
 * - `requestAnalysis(ids)`: asks for tracks, batched (one request at a time,
 *   gathered over a moment, since the server takes one a second a profile)
 *   and remembered for a while so a page drawn again doesn't ask again.
 *   An automatic ask says `reason: "auto"` and a person's (Analyse these,
 *   Analyse now, a pick in the lab) `"asked"`: while an admin's Stop holds
 *   the sweeps the server turns automatic asks away (409 `held`), quietly.
 * - `analysisStore`: one poll for every track any part of the page is
 *   showing progress for, every 1.5 s while one of them is in line or being
 *   worked out (or Activity's sweep row is open and the sweep runs), else
 *   every 20 s; finished tracks are gathered for a few seconds, then the DJ
 *   data, sets and plans that show them are read again.
 */
import type { QueryClient } from '@tanstack/react-query';

import { apiClient } from '@/app/api-client';

declare global {
  interface Window {
    /**
     * The player's Added toast asks for these words (Brief A, 31b):
     * "analysing, 2nd in line", or '' (static/media-player.js). Set by the
     * automix host while Auto mix is on.
     */
    ssAnalysisToastWords?: (ids: (string | number)[]) => Promise<string>;
  }
}

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

/**
 * Why a track that was analysed can't be beat-matched (Brief A, 31a state
 * 9): no beat found, a grid found but not sure enough (`unsure`: Ross's
 * report of 28 October), too short, not in 4/4.
 */
export type AnalysisBeat = 'no_beat' | 'unsure' | 'too_short' | 'not_4_4';

/**
 * Every entry says whether the track is ready to mix (a beat grid at this
 * version) and whether it has BPM and key (Brief A); older answers may lack
 * them, so they're optional here.
 */
interface Readiness {
  ready?: boolean;
  bpm_key?: boolean;
}

export type AnalysisEntry =
  | ({ state: 'done'; beat?: AnalysisBeat } & Readiness)
  | ({
      state: 'working';
      step: AnalysisStep | null;
      percent: number;
      /** full (one decode for everything) or grid (only the beat grid was due) */
      mode?: 'full' | 'grid' | null;
    } & Readiness)
  | ({
      state: 'queued';
      position: number;
      asked_for: boolean;
      /** you asked for it: your Cancel takes it out of line */
      yours?: boolean;
    } & Readiness)
  | ({
      state: 'waiting';
      reason: AnalysisWait;
      position: number | null;
      asked_for: boolean;
      yours?: boolean;
    } & Readiness)
  | ({ state: 'failed'; reason: AnalysisFail; duration?: number | null } & Readiness);

/** Why a track is in the asked-for line (HANDOFF 325). */
export type AnalysisSource = 'asked' | 'set' | 'up_next' | 'mix' | 'lab' | 'dj_now' | 'page';

/** One track of the line as the caller may see it (`/progress` with `line`). */
export interface AnalysisLineEntry {
  track_id: string;
  title: string;
  artist: string;
  position: number;
  source: AnalysisSource;
  /** "you", another profile's name (admins), or null */
  by: string | null;
  /** the caller's own set's name, when it's in line for a set */
  set_name: string | null;
  front: boolean;
}

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
  /** every one of yours is ahead of the rest ("yours: 2, both next") */
  yours_first?: boolean;
  /** the sweep's own tracks still to do after the line */
  left?: number;
  /** seconds until the next automatic sweep, or null */
  next_in?: number | null;
  /** who stopped it: a name for admins, null for members ("an admin") */
  held_by?: string | null;
  held_by_you?: boolean;
  /** what the sweep waits for, counted where that's cheap */
  waiting_detail?: { count: number | null; drive: string | null } | null;
  /** with `line`: the line in order as far as you may see it, and the rest counted */
  line?: AnalysisLineEntry[];
  line_more?: number;
  current: {
    step: AnalysisStep | null;
    percent: number | null;
    asked_for: boolean;
    /** only when the track is in your library */
    track_id: string | null;
    title: string | null;
    artist?: string | null;
    mode?: 'full' | 'grid' | null;
    /** each finished step's time in seconds, the step it's on, and how long that has run */
    times?: Partial<Record<AnalysisStep, number>>;
    now?: AnalysisStep | null;
    elapsed?: number | null;
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
  /** where the first of them now is in line, for the Added toast ("2nd in line") */
  position?: number | null;
  /** one of them is being analysed right now */
  working?: boolean;
  /** Analyse mine: how many of yours moved to the front */
  moved?: number;
  /** Cancel: how many of your asks left the line */
  withdrawn?: number;
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

/** A person's ask, or an automatic one (the server turns those away while held). */
export type AnalyseReason = 'asked' | 'auto';

/** Why, and what else, a request says (Brief A). */
export interface AnalyseExtras {
  source?: AnalysisSource;
  set_id?: number;
  /** Try again (admins): failed tracks are asked for again */
  retry?: boolean;
  /** Analyse again (admins): tracks already analysed have their beat grid found again */
  again?: boolean;
  /** Up next's next transition (two tracks at most): ahead of every other ask */
  soon?: boolean;
}

/** One request: the tracks (or a playlist) in the asked-for line. */
export async function postAnalyse(
  body: (
    | { track_ids: string[] }
    | { playlist_id: number }
    | { mine: true }
    | { track_ids: string[]; cancel: true }
  ) & { reason: AnalyseReason } & AnalyseExtras,
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

/** the server reads up to this many ids a request */
const PROGRESS_CHUNK = 500;

/** Where these tracks are: one request per 500, put back together. With
 *  `line`, the sweep also says the line in order (the topbar's popover). */
export async function postProgress(
  ids: string[],
  { line = false }: { line?: boolean } = {},
): Promise<ProgressAnswer> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += PROGRESS_CHUNK)
    chunks.push(ids.slice(i, i + PROGRESS_CHUNK));
  if (!chunks.length) chunks.push([]);
  const tracks: Record<string, AnalysisEntry> = {};
  let last: ProgressAnswer | undefined;
  for (const chunk of chunks) {
    const response = await apiClient.post('library/dj/progress', {
      json: line ? { track_ids: chunk, line: true } : { track_ids: chunk },
    });
    const part = (await response.json()) as ProgressAnswer;
    Object.assign(tracks, part.tracks ?? {});
    last = part;
  }
  return { ...last!, tracks };
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
  reason: AnalyseReason;
  extras: AnalyseExtras;
  resolve: (a: AnalyseAnswer | null) => void;
  reject: (e: unknown) => void;
}

/** Asks gathered together go in one request only when they say the same why. */
function batchKey(w: Waiter): string {
  return `${w.reason}|${w.extras.source ?? ''}|${w.extras.set_id ?? ''}|${w.extras.retry ? 1 : 0}|${w.extras.again ? 1 : 0}|${w.extras.soon ? 1 : 0}`;
}

const asked = new Map<string, number>();
let gathered: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending: Promise<void> | null = null;
let lastSent = -Infinity;

function now(): number {
  return Date.now();
}

async function send(batch: Waiter[], reason: AnalyseReason): Promise<void> {
  const ids = [...new Set(batch.flatMap((w) => w.ids))].slice(0, 500);
  const extras = batch[0]?.extras ?? {};
  let tries = 0;
  for (;;) {
    try {
      const answer = await postAnalyse({ track_ids: ids, reason, ...extras });
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
      if (error instanceof AnalyseError && error.status === 409 && error.code === 'held') {
        // an admin's Stop holds the sweeps: nothing to say. They're
        // forgotten, so a person's ask for them later (a lab pick) goes
        // (re-review 7); a page asks once per showing anyway
        for (const id of ids) asked.delete(id);
        for (const w of batch) w.resolve(null);
        return;
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
  if (!gathered.length) return;
  // a person's asks and automatic ones go in separate requests, and so do
  // asks with a different why (a set, Up next, the Mix tab)
  const key = batchKey(gathered[0]!);
  const reason = gathered[0]!.reason;
  const batch = gathered.filter((w) => batchKey(w) === key);
  gathered = gathered.filter((w) => batchKey(w) !== key);
  lastSent = now();
  sending = send(batch, reason).finally(() => {
    sending = null;
    if (!timer && gathered.length) timer = setTimeout(flush, 0);
  });
}

/**
 * Ask for tracks to be analysed now. `force` (Analyse these) asks even for
 * tracks asked for a moment ago; otherwise (an automatic trigger: a set
 * opened, Up next with DJ mix) a track asked for in the last ten minutes
 * isn't asked again, and with nothing left the answer is null. `reason`
 * says whether a person asked (the default with `force`) or a page did;
 * an automatic ask turned away while the sweeps are held answers null.
 */
export function requestAnalysis(
  ids: (string | number | null | undefined)[],
  {
    force = false,
    reason,
    source,
    setId,
    retry = false,
    again = false,
    soon = false,
  }: {
    force?: boolean;
    reason?: AnalyseReason;
    /** why it's asked for, for the line's words (HANDOFF 325) */
    source?: AnalysisSource;
    setId?: number | null;
    /** Try again (admins) */
    retry?: boolean;
    /** Analyse again (admins): a track already analysed has its grid found again */
    again?: boolean;
    /** Up next's next transition: goes ahead of other asks (Brief A review, L10) */
    soon?: boolean;
  } = {},
): Promise<AnalyseAnswer | null> {
  const why: AnalyseReason = reason ?? (force ? 'asked' : 'auto');
  const extras: AnalyseExtras = {
    source: source ?? (why === 'asked' ? 'asked' : undefined),
    ...(setId ? { set_id: setId } : {}),
    ...(retry ? { retry: true } : {}),
    ...(again ? { again: true } : {}),
    ...(soon ? { soon: true } : {}),
  };
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
  return new Promise<AnalyseAnswer | null>((resolve, reject) => {
    gathered.push({ ids: wanted, reason: why, extras, resolve, reject });
    if (!timer) timer = setTimeout(flush, GATHER_MS);
  });
}

/** Ask, saying nothing on a failure: an automatic trigger (or a lab pick, `asked`). */
export function requestAnalysisQuietly(
  ids: (string | number | null | undefined)[],
  reason: AnalyseReason = 'auto',
  why: { source?: AnalysisSource; setId?: number | null } = {},
): void {
  requestAnalysis(ids, { reason, ...why }).catch(() => {
    /* the sweep reaches them anyway; a page shows Not analysed yet */
  });
}

/**
 * Ask for tracks just added somewhere they'll be mixed (a set, the working
 * set), for the Added toast's "analysing, 2nd in line" (31b, 31d): the
 * answer, or null when it didn't come within a couple of seconds (the
 * toast then says only where they went).
 */
export function askForAdded(
  ids: (string | number | null | undefined)[],
  why: { source?: AnalysisSource; setId?: number | null } = {},
): Promise<AnalyseAnswer | null> {
  const asking = requestAnalysis(ids, { reason: 'auto', ...why }).catch(() => null);
  const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500));
  return Promise.race([asking, late]);
}

/**
 * A person's request that isn't an ask for tracks: Analyse mine (their
 * tracks in line go first) or Cancel (their asks leave the line). It waits
 * its turn behind the asks (one request a second a profile).
 */
async function sendNow(body: Parameters<typeof postAnalyse>[0]): Promise<AnalyseAnswer> {
  for (let tries = 0; ; tries += 1) {
    const wait = lastSent + SPACING_MS - now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (sending) await sending.catch(() => undefined);
    lastSent = now();
    try {
      const answer = await postAnalyse(body);
      analysisStore.pollSoon();
      return answer;
    } catch (error) {
      if (error instanceof AnalyseError && error.status === 429 && tries < MAX_TRIES) {
        await new Promise((r) => setTimeout(r, (error.retryAfter ?? 1) * 1000 + 50));
        continue;
      }
      throw error;
    }
  }
}

/** Analyse mine: this profile's tracks in line go to the front. */
export function analyseMine(): Promise<AnalyseAnswer> {
  return sendNow({ mine: true, reason: 'asked' });
}

/** Cancel: this profile's asks for these tracks leave the line. */
export function cancelAnalysis(ids: string[]): Promise<AnalyseAnswer> {
  for (const id of ids) asked.delete(id);
  return sendNow({ track_ids: ids.slice(0, 500), cancel: true, reason: 'asked' });
}

/* ── progress: one poll for the whole page ──────────────────────────── */

const ACTIVE_MS = 1_500;
const IDLE_MS = 20_000;
/** finished tracks are gathered this long before the data is read again */
const FINISH_GATHER_MS = 3_000;
export const DJ_ANALYSED_EVENT = 'soulsync:dj-analysed';

/** Lists that show analysed tracks without naming them in their keys. */
function listKey(k: readonly unknown[]): boolean {
  if (k[0] === 'dj') return k[1] === 'status' || k[1] === 'browse';
  if (k[0] === 'sets')
    return k[1] === 'set' || k[1] === 'view' || k[1] === 'list' || k[1] === 'working';
  return false;
}

/** a key part that's an id (a string or a number), else '' */
function idPart(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

/** Queries that name one of these tracks in their key. */
function namesOne(k: readonly unknown[], ids: Set<string>): boolean {
  if (k[0] === 'dj') {
    // never Vibe, which would spend AI usage again
    if (k[1] === 'tracks')
      return idPart(k[2])
        .split(',')
        .some((id) => ids.has(id));
    if (k[1] === 'mix' || k[1] === 'mixes') return ids.has(idPart(k[2]));
    return false;
  }
  if (k[0] === 'automix' && k[1] === 'plan') return ids.has(idPart(k[2])) || ids.has(idPart(k[3]));
  // the Mix tab's join step: the set's last track into the playing one
  if (k[0] === 'sets' && k[1] === 'join') return k.slice(2).some((v) => ids.has(idPart(v)));
  return false;
}

/** within this place in line, a track the sweep reaches on its own is close */
const NEAR = 5;

/**
 * A track worth the fast poll: being worked out, or in line because someone
 * asked for it, or near the front. The sweep's own order (thousands of rows
 * mid-sweep, waiting for downloads for hours) polls slowly (re-review 1).
 */
function active(e: AnalysisEntry | undefined): boolean {
  if (!e) return false;
  if (e.state === 'working') return true;
  if (e.state === 'queued') return e.asked_for || e.position <= NEAR;
  if (e.state === 'waiting' && e.position !== null) return e.asked_for || e.position <= NEAR;
  return false;
}

class AnalysisStore {
  private watched = new Map<string, number>();
  private sweepWatchers = 0;
  /** the topbar's count: read every 20 s, never fast on its own */
  private summaryWatchers = 0;
  /** the popover or Activity's sheet: the line in order is wanted */
  private lineWatchers = 0;
  private entries = new Map<string, AnalysisEntry>();
  private sweepState: AnalysisSweep | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private again = false;
  private qc: QueryClient | null = null;
  private done = new Set<string>();
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRefresh = -Infinity;

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

  /**
   * Show progress for these tracks; with `sweep`, the sweep's own, polled
   * fast while it runs (Activity's row open, the popover open); with
   * `summary`, the sweep's state at the slow pace (the topbar's count, on
   * every page); with `line`, the line in order too.
   */
  watch(
    ids: string[],
    {
      sweep = false,
      summary = false,
      line = false,
    }: { sweep?: boolean; summary?: boolean; line?: boolean } = {},
  ): () => void {
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
    if (summary) {
      if (!this.summaryWatchers && !this.sweepState) fresh = true;
      this.summaryWatchers += 1;
    }
    if (line) {
      if (!this.lineWatchers) fresh = true;
      this.lineWatchers += 1;
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
      if (summary) this.summaryWatchers = Math.max(0, this.summaryWatchers - 1);
      if (line) this.lineWatchers = Math.max(0, this.lineWatchers - 1);
      if (!this.anyone() && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  private anyone(): boolean {
    return Boolean(
      this.watched.size || this.sweepWatchers || this.summaryWatchers || this.lineWatchers,
    );
  }

  /** Whether a poll is waiting to run (for tests). */
  get scheduled(): boolean {
    return this.timer !== null;
  }

  /** How long the waiting poll was set to wait, in ms (for tests). */
  get delay(): number | null {
    return this.timer !== null ? this.lastDelay : null;
  }

  private lastDelay = 0;

  pollSoon(): void {
    this.schedule(60);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.lastDelay = ms;
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
    if (!this.anyone()) return;
    if (typeof document === 'object' && document.hidden) {
      this.schedule(IDLE_MS);
      return;
    }
    this.inFlight = true;
    const ids = [...this.watched.keys()];
    let next = IDLE_MS;
    try {
      const answer = await postProgress(ids, { line: this.lineWatchers > 0 });
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
      // fast only while a watched track moves, or Activity's sweep row is
      // open while the sweep runs; a sweep elsewhere doesn't speed up pages
      // (the topbar's count alone never speeds the poll up: review M2)
      if (
        ids.some((id) => active(this.entries.get(id))) ||
        ((this.sweepWatchers > 0 || this.lineWatchers > 0) && this.sweepState?.running)
      )
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
    if (this.anyone()) this.schedule(next);
  }

  /**
   * Tracks finished: their BPM, key, energy and chips are read again, once
   * for every few seconds of finishes (a sweep finishes one every few).
   */
  private finished(ids: string[]): void {
    for (const id of ids) this.done.add(id);
    if (this.doneTimer) return;
    const wait = this.lastRefresh + FINISH_GATHER_MS - now();
    if (wait <= 0) this.refresh();
    else
      this.doneTimer = setTimeout(() => {
        this.doneTimer = null;
        this.refresh();
      }, wait);
  }

  private refresh(): void {
    const ids = new Set(this.done);
    this.done.clear();
    if (!ids.size) return;
    this.lastRefresh = now();
    const qc = this.qc;
    if (qc) {
      // the rows, Mix tab and plans that name a finished track, and the
      // lists that show them (browse, the sweep's status, sets' rows)
      void qc.invalidateQueries({
        predicate: (q) => namesOne(q.queryKey, ids) || listKey(q.queryKey),
      });
    }
    if (typeof window === 'object')
      window.dispatchEvent(new CustomEvent(DJ_ANALYSED_EVENT, { detail: { ids: [...ids] } }));
  }

  /** For tests: forget everything. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.doneTimer = null;
    this.done.clear();
    this.lastRefresh = -Infinity;
    this.watched.clear();
    this.entries.clear();
    this.sweepWatchers = 0;
    this.summaryWatchers = 0;
    this.lineWatchers = 0;
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
