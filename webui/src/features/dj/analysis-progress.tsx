/**
 * The interim analysis indicator (DESIGN-SYSTEM "Analysis progress"): a
 * small bar and a status line for one track ("Finding the beat grid ·
 * 60%", "2nd in line", "Waiting for downloads"), and the hooks every place
 * that shows it uses: `useAnalysis` (one shared poll, analysis.api.ts),
 * `useAutoAnalyse` (ask for tracks a page needs now) and `useAnalysisSweep`
 * (Activity's DJ row). Claude Design explores the final version; this one
 * stays small on purpose.
 */
import { QueryClientContext } from '@tanstack/react-query';
import clsx from 'clsx';
import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

import {
  analysisStore,
  requestAnalysisQuietly,
  type AnalyseReason,
  type AnalysisEntry,
  type AnalysisSweep,
} from './analysis.api';
import { entryPercent, entryWords, sweepWords } from './analysis.format';
import styles from './analysis.module.css';

function useStoreVersion(): number {
  return useSyncExternalStore(
    analysisStore.subscribe,
    analysisStore.getVersion,
    analysisStore.getVersion,
  );
}

/** The app's query client, so a finished track's queries are read again
 *  (none in a page rendered on its own: then nothing is refreshed). */
function useQueryClientForStore(): void {
  const qc = useContext(QueryClientContext);
  useEffect(() => {
    if (qc) analysisStore.setQueryClient(qc);
  }, [qc]);
}

function idKey(ids: (string | number | null | undefined)[]): string {
  return [
    ...new Set(
      ids
        .filter((id): id is string | number => id !== null && id !== undefined && id !== '')
        .map(String),
    ),
  ]
    .sort()
    .join(',');
}

/** Where each of these tracks is in the analysis (one poll for the page). */
export function useAnalysis(
  ids: (string | number | null | undefined)[],
  enabled = true,
): Record<string, AnalysisEntry> {
  useQueryClientForStore();
  const key = enabled ? idKey(ids) : '';
  useEffect(() => (key ? analysisStore.watch(key.split(',')) : undefined), [key]);
  const version = useStoreVersion();
  return useMemo(() => {
    const out: Record<string, AnalysisEntry> = {};
    if (!key) return out;
    for (const id of key.split(',')) {
      const e = analysisStore.entry(id);
      if (e) out[id] = e;
    }
    return out;
    // `version` moves whenever the store does: the entries are read again
  }, [key, version]);
}

/** The sweep's own state (Activity's DJ row). */
export function useAnalysisSweep(enabled = true): AnalysisSweep | null {
  useQueryClientForStore();
  useEffect(() => (enabled ? analysisStore.watch([], { sweep: true }) : undefined), [enabled]);
  useStoreVersion();
  return enabled ? analysisStore.sweep() : null;
}

/**
 * Ask for these tracks now (they jump the sweep's queue): a page showing
 * tracks someone needs analysed. Each is asked once in a while at most;
 * the server skips tracks already done.
 */
export function useAutoAnalyse(
  ids: (string | number | null | undefined)[],
  enabled = true,
  reason: AnalyseReason = 'auto',
): void {
  const key = enabled ? idKey(ids) : '';
  useEffect(() => {
    if (key) requestAnalysisQuietly(key.split(','), reason);
  }, [key, reason]);
}

/** The bar and the words for one track; nothing once it's done. */
export function AnalysisProgress({
  entry,
  compact = false,
  block = false,
  className,
  label = 'Analysis',
}: {
  entry: AnalysisEntry | null | undefined;
  /** a narrower bar (Up next's chips, a phone's rows) */
  compact?: boolean;
  /** on a line of its own */
  block?: boolean;
  className?: string;
  /** what the bar is of, for a screen reader ("Analysis of Static Bloom") */
  label?: string;
}) {
  if (!entry || entry.state === 'done') return null;
  const words = entryWords(entry);
  const working = entry.state === 'working';
  return (
    <span
      className={clsx(styles.progress, block && styles.block, className)}
      data-state={entry.state}
      data-compact={compact ? '' : undefined}
      data-analysis-progress=""
    >
      {entry.state === 'failed' ? null : working ? (
        <span
          className={styles.bar}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={entryPercent(entry)}
          aria-valuetext={words}
        >
          <span style={{ width: `${entryPercent(entry)}%` }} />
        </span>
      ) : (
        <span className={styles.bar} aria-hidden="true">
          <span style={{ width: '0%' }} />
        </span>
      )}
      <span className={styles.words}>{words}</span>
    </span>
  );
}

/** Activity's DJ row: the sweep's bar, and the track it's on with its step. */
export function SweepProgress({
  sweep,
  className,
}: {
  sweep: AnalysisSweep | null;
  className?: string;
}) {
  if (!sweep?.running) return null;
  const words = sweepWords(sweep);
  const pct = sweep.percent ?? 0;
  return (
    <span
      className={clsx(styles.progress, styles.block, className)}
      data-state="working"
      data-analysis-progress=""
    >
      <span
        className={styles.bar}
        role="progressbar"
        aria-label="Working out BPM, key and energy"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={words}
      >
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className={styles.words}>{words}</span>
    </span>
  );
}
