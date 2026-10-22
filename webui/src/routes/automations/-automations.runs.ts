/**
 * The Runs panel's numbers and rows, worked out from the run history
 * (GET /api/automations/<id>/history). The history keeps the newest 100
 * rows per automation, so a busy automation's 30 days can be longer than
 * what's kept; the panel then says which runs its numbers cover instead of
 * pretending to know the rest.
 */

import type { RunEntry } from './-automations.types';

import { parseServerTime } from './-automations.format';
import { dayAndTime } from './-automations.steps';

export const RUN_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export function runTime(run: RunEntry): number {
  const ts = run.finished_at || run.started_at;
  if (!ts) return 0;
  const ms = parseServerTime(ts);
  return Number.isFinite(ms) ? ms : 0;
}

/** Newest first, by when each run finished (ids follow time, but a restored
 *  database needn't keep them in order). */
export function sortRuns(history: RunEntry[]): RunEntry[] {
  return [...history].sort((a, b) => runTime(b) - runTime(a) || b.id - a.id);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "38 s", "4 min", "1 h 5 min"; '' when unknown. */
export function durationWords(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return 'under a second';
  // non-breaking spaces, so "2 s" never wraps apart at the end of a line
  if (seconds < 60) return `${Math.round(seconds)}\u00a0s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}\u00a0min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}\u00a0h\u00a0${m}\u00a0min` : `${h}\u00a0h`;
}

export interface RunsWindow {
  /** The runs the numbers cover, newest first. */
  runs: RunEntry[];
  /** "61 in 30 days", or "Last 100, since 19 Oct" when the 30 days aren't all kept. */
  label: string;
  /** False when the history's cap cut the 30 days short. */
  complete: boolean;
}

/**
 * The runs of the last 30 days. When the history holds every run it has
 * (fewer than it keeps), or reaches back past 30 days, the 30 days are
 * complete; otherwise the numbers cover the kept runs and say since when.
 */
export function runsWindow(
  history: RunEntry[],
  total: number | undefined,
  now: number = Date.now(),
  kept = 100,
): RunsWindow {
  const cutoff = now - RUN_WINDOW_DAYS * DAY_MS;
  const all = history.length;
  const oldest = all ? runTime(history[all - 1]) : now;
  const everything = (total ?? all) <= all && all < kept;
  const complete = everything || oldest < cutoff;
  if (complete) {
    const runs = history.filter((r) => runTime(r) >= cutoff);
    return { runs, label: `${runs.length.toLocaleString()} in ${RUN_WINDOW_DAYS} days`, complete };
  }
  const since = new Date(oldest).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return { runs: history, label: `Last ${all.toLocaleString()}, since ${since}`, complete };
}

function resultOf(run: RunEntry): Record<string, unknown> {
  const raw = run.result_json;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function num(value: unknown): number {
  const n =
    typeof value === 'number' ? value : Number.parseFloat(typeof value === 'string' ? value : '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * What a Wanted search found: the tracks its batches turned up, which the
 * server writes onto the run once the batches finish (result.found). Null
 * for runs from before that, or whose batches haven't finished.
 */
export function foundOf(run: RunEntry): number | null {
  const found = resultOf(run).found;
  if (!found || typeof found !== 'object') return null;
  return num((found as Record<string, unknown>).tracks);
}

/**
 * The one outcome a run's own record counts, per action, from keys the
 * handlers really return. A Wanted search counts what it found, once its
 * runs carry that (runs from before it don't).
 */
const OUTCOMES: Record<string, { key: string; label: string }> = {
  apply_quality_upgrades: { key: 'applied', label: 'Upgrades queued' },
  scan_watchlist: { key: 'tracks_added_to_wishlist', label: 'Added to Wanted' },
  scan_watchlist_podcasts: { key: 'episodes_queued', label: 'Episodes queued' },
  run_duplicate_cleaner: { key: 'files_deleted', label: 'Moved to the bin' },
  clear_quarantine: { key: 'removed', label: 'Deleted' },
  library_cleanup: { key: 'removed', label: 'Deleted' },
  refresh_mirrored: { key: 'refreshed', label: 'Playlists refreshed' },
};

export interface RunNumber {
  label: string;
  value: string;
}

export function isRealRun(run: RunEntry): boolean {
  return run.status !== 'preview';
}

/**
 * Three numbers the history really holds: what the runs produced (when the
 * action records it) or how many finished, how many failed, and how long a
 * run typically takes (the median).
 */
export function runNumbers(runs: RunEntry[], actionType: string | null | undefined): RunNumber[] {
  const real = runs.filter(isRealRun);
  const done = real.filter((r) => r.status === 'completed');
  const failed = real.filter((r) => r.status === 'error' || r.status === 'timeout').length;
  const outcome = OUTCOMES[actionType ?? ''];
  const founds = done.map(foundOf).filter((n): n is number => n != null);
  const first: RunNumber = founds.length
    ? { label: 'Found', value: founds.reduce((a, b) => a + b, 0).toLocaleString() }
    : outcome
      ? {
          label: outcome.label,
          value: done
            .filter((r) => resultOf(r).mode !== 'plan')
            .reduce((sum, r) => sum + num(resultOf(r)[outcome.key]), 0)
            .toLocaleString(),
        }
      : { label: 'Done', value: done.length.toLocaleString() };
  const durations = done
    .map((r) => r.duration_seconds)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
    .sort((a, b) => a - b);
  let typical = '—';
  if (durations.length) {
    const mid = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
    typical = durationWords(median) || '—';
  }
  return [
    first,
    { label: 'Failed runs', value: failed.toLocaleString() },
    { label: 'Typical', value: typical },
  ];
}

export type RunTone = 'success' | 'danger' | 'neutral' | 'info' | 'warning';

export interface RunRow {
  id: number;
  when: string;
  summary: string;
  tag: string;
  tone: RunTone;
  preview: boolean;
  log: { type?: string; text?: string }[];
}

/**
 * The Wanted search records that it started its batches ("Started: 2 album
 * batch(es), 4 per-track for cycle albums"); what they found is added to the
 * run when they finish (see foundOf). Say that in words.
 */
function wantedSummary(text: string): string | null {
  const m = /^Started: (.+) for cycle (\w+)$/.exec(text);
  if (!m) return null;
  const albums = /(\d+) album batch/.exec(m[1]);
  const tracks = /(\d+) per-track/.exec(m[1]);
  const a = albums ? Number(albums[1]) : 0;
  const t = tracks ? Number(tracks[1]) : 0;
  const turn = `${m[2]} turn`;
  if (!a && !t) return `Nothing was due · ${turn}`;
  const what =
    a && t
      ? `${a} album and ${t} track searches`
      : a
        ? plural(a, 'album search', 'album searches')
        : plural(t, 'track search', 'track searches');
  return `Started ${what} · ${turn}`;
}

function clean(text: string | null | undefined): string {
  const said = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .replace(/^Error: /, '')
    .replace(/\b(on|to) (?:the )?wishlist\b/gi, '$1 Wanted');
  return wantedSummary(said) ?? said;
}

/** One row: when, what the run said, and a tag with a word. */
export function runRow(run: RunEntry, now: number = Date.now()): RunRow {
  const status = run.status ?? 'completed';
  const took = durationWords(run.duration_seconds);
  const found = foundOf(run);
  const said = [clean(run.summary), found != null ? `${found.toLocaleString()} found` : '']
    .filter(Boolean)
    .join(' · ');
  let tag = 'Done';
  let tone: RunTone = 'success';
  let summary: string;
  switch (status) {
    case 'error':
    case 'timeout':
      tag = 'Failed';
      tone = 'danger';
      summary = said || (status === 'timeout' ? 'It ran out of time' : 'It stopped with an error');
      break;
    case 'preview':
      tag = 'Preview';
      tone = 'neutral';
      summary = said ? `Preview · ${said}` : 'Preview · nothing changed';
      break;
    case 'skipped':
      tag = 'Skipped';
      tone = 'neutral';
      summary = said ? `Skipped · ${said}` : 'Skipped';
      break;
    case 'completed':
      summary = [said, took].filter(Boolean).join(' · ') || 'Finished';
      break;
    default:
      tag = status.charAt(0).toUpperCase() + status.slice(1);
      tone = 'neutral';
      summary = said || tag;
  }
  return {
    id: run.id,
    when: run.finished_at || run.started_at ? dayAndTime(runTime(run), now, true) : 'Unknown time',
    summary,
    tag,
    tone,
    preview: status === 'preview',
    log: run.log_lines ?? [],
  };
}

/**
 * The selected card's phone line: "61 runs · last failed Tue 21:15". Counts
 * the same runs as the Runs panel's header (previews are runs too).
 */
export function runsLine(runs: RunEntry[], now: number = Date.now()): string {
  if (!runs.length) return 'No runs yet';
  const lastFailed = runs.find((r) => r.status === 'error' || r.status === 'timeout');
  const head = `${plural(runs.length, 'run')} in ${RUN_WINDOW_DAYS} days`;
  return lastFailed ? `${head} · last failed ${dayAndTime(runTime(lastFailed), now)}` : head;
}

/** The newest real run, for the card's duration. */
export function latestRun(runs: RunEntry[]): RunEntry | undefined {
  return runs.find(isRealRun);
}
