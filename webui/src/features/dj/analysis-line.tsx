/**
 * The analysis indicator (Brief A, 31a–31g; DESIGN-SYSTEM "Analysis
 * indicator"): one component, `AnalysisLine`, in three sizes:
 *
 * - **line**: a 4px bar on 10% white, filled in accent-light by step (never
 *   by time), over one 14px sentence with an 8px dot and an action link at
 *   the right ("Analysing Canopy · beat grid (5 of 6)", "In line · 3rd ·
 *   Move up"). A set's head, the Mix tab's header and its phone sheet, Up
 *   next's Waiting chips, Tracks' head, Activity's DJ row and (Brief E) DJ
 *   now's incoming lane use it;
 * - **marker**: a dot and two words for rows ("Ready", "In line · 2nd");
 *   only the row being analysed has a bar;
 * - **count**: the topbar's pill ("Analysing · 14 in line", accent while
 *   it runs) with the popover (`AnalysisPanel`): the six-step checklist with
 *   times, the line in order and why each track is in it, the sweep's
 *   progress, Stop (admins) and Open Activity. On a phone the Activity page
 *   shows the same panel (31f).
 *
 * Reduced motion: the bar is six cells, no fill animation, no pulse. A
 * track that becomes ready says "Canopy is ready to mix" once, in the
 * polite live region, and holds it 4 s (state 10).
 *
 * The hooks every place uses are here too: `useAnalysis` (one shared poll,
 * analysis.api.ts), `useAutoAnalyse` (ask for tracks a page needs now) and
 * `useAnalysisSweep` (the sweep's own state).
 */
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import clsx from 'clsx';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import type { ShellContext } from '@/platform/shell/bridge';

import { appURL } from '@/platform/url-base';

import {
  analyseMine,
  analysisStore,
  requestAnalysis,
  requestAnalysisQuietly,
  type AnalyseReason,
  type AnalysisEntry,
  type AnalysisSource,
  type AnalysisSweep,
} from './analysis.api';
import {
  ACTION_WORDS,
  checklist,
  countView,
  currentSubline,
  inLineCount,
  isReady,
  lineView,
  markerView,
  moreWords,
  nextSweepWords,
  pending,
  readyWords,
  stepPhrase,
  sweepProgressWords,
  waitWords,
  whyWords,
  yoursWords,
  type AnalysisAction,
  type AnalysisTone,
  type AnalysisViewer,
} from './analysis.format';
import styles from './analysis.module.css';
import { djStatusQueryOptions, postDjJob } from './dj.api';

/* ── the shared poll ─────────────────────────────────────────────────── */

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

/**
 * The sweep's own state. `fast` (Activity's row open, the popover open)
 * polls every 1.5 s while it runs; otherwise (the topbar's count, a line)
 * it's read at the slow pace; `line` asks for the line in order too.
 */
export function useAnalysisSweep(
  enabled = true,
  { fast = true, line = false }: { fast?: boolean; line?: boolean } = {},
): AnalysisSweep | null {
  useQueryClientForStore();
  useEffect(
    () => (enabled ? analysisStore.watch([], { sweep: fast, summary: !fast, line }) : undefined),
    [enabled, fast, line],
  );
  useStoreVersion();
  return enabled ? analysisStore.sweep() : null;
}

/**
 * The sweep as the last poll said it, asking for no poll of its own: a
 * line reads when the next sweep comes or who stopped it from whatever the
 * page (or the topbar's count) already polls, so a hidden part watches
 * nothing (review M2).
 */
export function useLastSweep(): AnalysisSweep | null {
  useStoreVersion();
  return analysisStore.sweep();
}

/**
 * Ask for these tracks now (they jump the sweep's queue): a page showing
 * tracks someone needs analysed. Each is asked once in a while at most;
 * the server skips tracks already done. `why` says what asked, for the
 * popover's line ("you added it to Sunday Set", "Up next").
 */
export function useAutoAnalyse(
  ids: (string | number | null | undefined)[],
  enabled = true,
  reason: AnalyseReason = 'auto',
  why: { source?: AnalysisSource; setId?: number | null } = {},
): void {
  const key = enabled ? idKey(ids) : '';
  const { source, setId } = why;
  useEffect(() => {
    if (key) requestAnalysisQuietly(key.split(','), reason, { source, setId });
  }, [key, reason, source, setId]);
}

/** Who is looking, where a page knows better than the router (a mount of its own, a test). */
export const AnalysisViewerContext = createContext<AnalysisViewer | null>(null);

/** Admins get Analyse now, Analyse all and Resume; members Analyse mine. */
export function useAnalysisViewer(): AnalysisViewer {
  const given = useContext(AnalysisViewerContext);
  // outside the router (a mount of its own) there's no profile: a member's view
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  const root = router?.state?.matches?.[0]?.context as { shell?: ShellContext } | undefined;
  const admin = given ? given.admin : Boolean(root?.shell?.profile?.isAdmin);
  return useMemo(() => ({ admin }), [admin]);
}

/* ── done, said once ─────────────────────────────────────────────────── */

let liveRegion: HTMLElement | null = null;
const saidAt = new Map<string, number>();

/** Say it once in the polite live region (the same thing within 10 s isn't said again). */
export function announceAnalysis(text: string, key = text): void {
  if (typeof document === 'undefined') return;
  const t = Date.now();
  if (t - (saidAt.get(key) ?? -Infinity) < 10_000) return;
  saidAt.set(key, t);
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = document.createElement('div');
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('data-analysis-live', '');
    liveRegion.className = styles.srOnly;
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = text;
}

/** For tests: forget what was said. */
export function resetAnalysisAnnouncements(): void {
  saidAt.clear();
  liveRegion?.remove();
  liveRegion = null;
}

const READY_HOLD_MS = 4_000;

/** True for 4 s after a track that was in line or being analysed became ready. */
function useJustReady(
  id: string | null | undefined,
  entry: AnalysisEntry | null | undefined,
  title: string | null | undefined,
): boolean {
  // what this track was last time: another track (the Mix tab moved on to
  // one that's ready already) starts over and says nothing (review L1)
  const before = useRef<{ id: string | null | undefined; entry: AnalysisEntry | null | undefined }>(
    { id, entry },
  );
  const timer = useRef<number | null>(null);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const last = before.current;
    before.current = { id, entry };
    if (last.id !== id) {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      setHeld(false);
      return;
    }
    const was = last.entry;
    if (!was || !pending(was) || !isReady(entry)) return;
    if (was.state === 'waiting' && was.position === null) return;
    setHeld(true);
    announceAnalysis(readyWords(title), `ready:${id ?? title ?? ''}`);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHeld(false);
    }, READY_HOLD_MS);
  }, [entry, id, title]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return held;
}

/* ── the pieces: the bar, the dot ───────────────────────────────────── */

/** The 4px bar: filled by step, n of 6 (six cells with reduced motion). */
export function AnalysisBar({ step, tone }: { step: number | null; tone: AnalysisTone }) {
  const n = Math.max(0, Math.min(6, step ?? 0));
  return (
    <span className={styles.bar} data-tone={tone} aria-hidden="true" data-step={n || undefined}>
      <span className={styles.fill} style={{ width: `${(100 * n) / 6}%` }} />
      <span className={styles.cells}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} data-on={i <= n ? '' : undefined} />
        ))}
      </span>
    </span>
  );
}

function Dot({ tone }: { tone: AnalysisTone }) {
  return <span className={styles.dot} data-tone={tone} aria-hidden="true" />;
}

/** What an action link does by default, for one track. */
function useRunAction(trackId: string | null | undefined): (a: AnalysisAction) => void {
  return useCallback(
    (action: AnalysisAction) => {
      const said = (p: Promise<unknown>) =>
        p.catch((error: unknown) =>
          window.showToast?.(error instanceof Error ? error.message : "That didn't work.", 'error'),
        );
      switch (action) {
        case 'analyse':
        case 'analyse_now':
        case 'analyse_mine':
          if (trackId) void said(requestAnalysis([trackId], { force: true, reason: 'asked' }));
          return;
        case 'try_again':
          if (trackId)
            void said(requestAnalysis([trackId], { force: true, reason: 'asked', retry: true }));
          return;
        case 'analyse_again':
          if (trackId)
            void said(requestAnalysis([trackId], { force: true, reason: 'asked', again: true }));
          return;
        case 'move_up':
          if (trackId) void said(postDjJob('start', trackId).then(() => analysisStore.pollSoon()));
          return;
        case 'resume':
        case 'start_now':
          void said(postDjJob('start').then(() => analysisStore.pollSoon()));
          return;
        case 'drives':
          window.location.assign(appURL('/settings?tab=downloads'));
          return;
        case 'open_move':
          window.openDriveMove?.();
          return;
      }
    },
    [trackId],
  );
}

/** A page's own action instead of the line's (a set's "Analyse all 12", the Mix tab's Cancel). */
export interface LineActionOverride {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface LineProps {
  size: 'line';
  entry: AnalysisEntry | null | undefined;
  /** the track's title: "Analysing Canopy", "Canopy is ready to mix" */
  title?: string | null;
  trackId?: string | null;
  /** more words after the sentence: "11 more in this set" */
  extra?: string | null;
  /** the page's own sentence (a set's "3 tracks aren't ready to mix") */
  sentence?: string | null;
  tone?: AnalysisTone;
  /** a page's own action, or false for none */
  action?: LineActionOverride | false | null;
  /** quiet words at the right instead of an action (the phone sheet's "2 in line") */
  meta?: string | null;
  /** say nothing once the track is ready (after "is ready to mix") */
  hideWhenReady?: boolean;
  className?: string;
}

interface MarkerProps {
  size: 'marker';
  entry: AnalysisEntry | null | undefined;
  /** names the track while it's analysed ("Analysing Canopy · beat grid (5 of 6)") */
  title?: string | null;
  /** show "Ready" too (only where readiness is asked for, 31c) */
  showReady?: boolean;
  /** an admin's Move up beside a queued track (the lab's pickers, 31c) */
  trackId?: string | null;
  moveUp?: boolean;
  className?: string;
}

interface CountProps {
  size: 'count';
  className?: string;
}

/** One component in three sizes (31a): the line, the row marker, the topbar count. */
export function AnalysisLine(props: LineProps | MarkerProps | CountProps) {
  if (props.size === 'marker') return <Marker {...props} />;
  if (props.size === 'count') return <AnalysisCount className={props.className} />;
  return <Line {...props} />;
}

function Line({
  entry,
  title,
  trackId,
  extra,
  sentence,
  tone,
  action,
  meta,
  hideWhenReady = false,
  className,
}: LineProps) {
  const viewer = useAnalysisViewer();
  const sweep = useLastSweep();
  const justReady = useJustReady(trackId, entry, title);
  const run = useRunAction(trackId);
  const view = lineView(entry, { title, viewer, sweep });
  if (!view && !sentence) return null;
  if (!justReady && hideWhenReady && isReady(entry) && !sentence) return null;
  const shownTone: AnalysisTone = justReady ? 'ready' : (tone ?? view?.tone ?? 'neutral');
  const words = justReady ? readyWords(title) : (sentence ?? view?.sentence ?? '');
  const step = justReady ? 6 : (view?.step ?? null);
  let link: ReactNode = null;
  if (action === false || justReady) link = null;
  else if (action)
    link = (
      <button
        type="button"
        className={styles.action}
        onClick={action.onClick}
        disabled={action.disabled}
      >
        {action.label}
      </button>
    );
  else if (view?.action) {
    const which = view.action;
    link = (
      <button
        type="button"
        className={styles.action}
        aria-disabled={view.actionDisabled ? 'true' : undefined}
        title={view.actionDisabled ? 'An admin resumes analysis' : undefined}
        onClick={view.actionDisabled ? undefined : () => run(which)}
      >
        {ACTION_WORDS[which]}
      </button>
    );
  }
  return (
    <div
      className={clsx(styles.line, className)}
      data-tone={shownTone}
      data-state={justReady ? 'ready' : entry?.state}
      data-analysis-line=""
    >
      <AnalysisBar step={step} tone={shownTone} />
      <span className={styles.row}>
        <Dot tone={shownTone} />
        <span className={styles.sentence}>
          {words}
          {extra && !justReady ? ` · ${extra}` : null}
        </span>
        {link ?? (meta ? <span className={styles.meta}>{meta}</span> : null)}
      </span>
    </div>
  );
}

function Marker({
  entry,
  title = null,
  showReady = false,
  trackId = null,
  moveUp = false,
  className,
}: MarkerProps) {
  const viewer = useAnalysisViewer();
  const run = useRunAction(trackId);
  const view = markerView(entry, viewer, title);
  if (!view || (view.tone === 'ready' && !showReady)) return null;
  const up = moveUp && viewer.admin && trackId && entry?.state === 'queued' && entry.position > 1;
  return (
    <span className={clsx(styles.marker, className)} data-tone={view.tone} data-analysis-marker="">
      {view.step ? <AnalysisBar step={view.step} tone={view.tone} /> : null}
      <span className={styles.markerWords}>
        <Dot tone={view.tone} />
        <span className={styles.markerText}>{view.words}</span>
        {up ? (
          <button type="button" className={styles.action} onClick={() => run('move_up')}>
            {ACTION_WORDS.move_up}
          </button>
        ) : null}
      </span>
    </span>
  );
}

/** The sweep as a line's entry (Tracks' head, Activity's DJ row). */
export function sweepEntry(sweep: AnalysisSweep | null | undefined): AnalysisEntry | null {
  if (!sweep?.running) return null;
  if (sweep.waiting)
    return { state: 'waiting', reason: sweep.waiting, position: null, asked_for: false };
  return { state: 'working', step: sweep.current?.step ?? null, percent: 0 };
}

/**
 * The sweep's line: "Analysing Canopy · key (3 of 6)" with the page's own
 * words after it (Tracks' "2,140 of 4,980 ready to mix", Activity's
 * "1,240 of 4,980").
 */
export function SweepLine({
  sweep,
  extra,
  idle,
  action,
  className,
}: {
  sweep: AnalysisSweep | null;
  extra?: string | null;
  /** what to say when nothing runs (or nothing) */
  idle?: string | null;
  action?: LineActionOverride | false | null;
  className?: string;
}) {
  const viewer = useAnalysisViewer();
  const entry = sweepEntry(sweep);
  if (entry?.state === 'working' && !sweep?.current) {
    // resting between tracks: what's left, no step to show
    const n = inLineCount(sweep);
    return (
      <Line
        size="line"
        entry={null}
        sentence={n ? `Analysing · ${n.toLocaleString('en-GB')} in line` : 'Analysing'}
        tone="running"
        extra={extra}
        action={action ?? false}
        className={className}
      />
    );
  }
  if (!entry) {
    if (!idle) return null;
    return (
      <Line
        size="line"
        entry={null}
        sentence={idle}
        tone={sweep?.held ? 'warning' : 'neutral'}
        extra={extra}
        action={action}
        className={className}
      />
    );
  }
  return (
    <Line
      size="line"
      entry={entry}
      title={sweep?.current?.title ?? null}
      sentence={entry.state === 'waiting' ? waitWords(entry.reason, sweep, viewer) : null}
      tone={entry.state === 'waiting' ? 'warning' : 'running'}
      extra={extra}
      action={action ?? false}
      className={className}
    />
  );
}

/* ── the topbar's count and its popover ─────────────────────────────── */

/** The popover's (and the phone Activity sheet's) contents (31b, 31f). */
export function AnalysisPanel({
  variant = 'popover',
  onOpenActivity,
}: {
  variant?: 'popover' | 'sheet';
  onOpenActivity?: () => void;
}) {
  const viewer = useAnalysisViewer();
  const sweep = useAnalysisSweep(true, { fast: true, line: true });
  const status = useQuery({
    ...djStatusQueryOptions(),
    retry: false,
    enabled: Boolean(sweep && !sweep.running),
  });
  const [busy, setBusy] = useState(false);
  if (!sweep) return null;
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(() => analysisStore.pollSoon())
      .catch((error: unknown) =>
        window.showToast?.(error instanceof Error ? error.message : "That didn't work.", 'error'),
      )
      .finally(() => setBusy(false));
  };
  const c = sweep.current;
  const sheet = variant === 'sheet';
  const counts = status.data;
  const readyLine =
    counts?.grids && counts.counts.tracks
      ? `${(counts.grids.ready ?? counts.grids.done).toLocaleString('en-GB')} of ${counts.counts.tracks.toLocaleString('en-GB')} ready to mix`
      : '';
  const n = inLineCount(sweep).toLocaleString('en-GB');
  let heading: string;
  let sub: string;
  if (sweep.running && sweep.waiting) {
    heading = waitWords(sweep.waiting, sweep, viewer);
    sub = `${n} in line`;
  } else if (sweep.running) {
    heading = c?.title ? `Analysing ${c.title}` : 'Analysing';
    sub = sheet
      ? [c ? stepPhrase(c.step) : '', `${n} in line`].filter(Boolean).join(' · ')
      : currentSubline(sweep);
  } else if (sweep.held) {
    heading = waitWords('held', sweep, viewer);
    sub = readyLine;
  } else {
    heading = 'Analysis idle';
    sub = [nextSweepWords(sweep.next_in), readyLine].filter(Boolean).join(' · ');
  }
  if (!viewer.admin) {
    const yours = yoursWords(sweep);
    if (yours) sub = [sub, yours].filter(Boolean).join(' · ');
  }
  const steps = sweep.running && !sweep.waiting && c ? checklist(sweep) : [];
  const at = steps.findIndex((s) => s.state === 'now') + 1;
  const line = sweep.line ?? [];
  const more = moreWords(sweep, viewer);
  const progress = sweepProgressWords(sweep);
  const mineFirst = !viewer.admin && (sweep.yours ?? 0) > 0 && !sweep.yours_first;
  const activity = () => {
    onOpenActivity?.();
    window.location.assign(appURL('/activity'));
  };
  return (
    <div className={styles.panel} data-variant={variant} data-analysis-panel="">
      <div className={styles.panelHead} data-running={sweep.running ? '' : undefined}>
        <span className={styles.panelTitle}>{heading}</span>
        {sheet && at ? <AnalysisBar step={at} tone="running" /> : null}
        {sub ? <span className={styles.panelSub}>{sub}</span> : null}
      </div>
      {steps.length ? (
        <ol className={styles.checklist} aria-label="Steps">
          {steps.map((s) => (
            <li key={s.step} data-state={s.state}>
              <span className={styles.ring} aria-hidden="true" />
              <span>
                {s.name}
                <span className={styles.srOnly}>
                  {s.state === 'done' ? ', done' : s.state === 'now' ? ', now' : ', to come'}
                </span>
              </span>
              <span className={styles.stepTime}>{s.state === 'now' ? 'now' : s.time}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {line.length || more ? (
        <div className={styles.queue}>
          <span className={styles.queueLabel}>In line</span>
          {line.length ? (
            <ol className={styles.queueList}>
              {line.map((e) => (
                <li key={e.track_id}>
                  <span className={styles.queueN}>{e.position.toLocaleString('en-GB')}</span>
                  <span className={styles.queueTitle}>
                    {e.title}
                    {e.artist ? ` · ${e.artist}` : ''}
                  </span>
                  <span className={styles.queueWhy}>{whyWords(e)}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {more || progress ? (
            <span className={styles.queueMore}>
              {more}
              {more && progress ? ' · ' : null}
              {progress ? (
                <a href={appURL('/activity')} className={styles.link}>
                  {progress}
                </a>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {sheet ? (
        mineFirst ? (
          <button
            type="button"
            className={styles.sheetButton}
            disabled={busy}
            onClick={() => act(analyseMine())}
          >
            Analyse mine first
          </button>
        ) : null
      ) : (
        <div className={styles.panelFoot}>
          {viewer.admin && sweep.running ? (
            <button
              type="button"
              className={styles.ghostButton}
              disabled={busy}
              onClick={() => act(postDjJob('stop'))}
            >
              Stop the sweep
            </button>
          ) : viewer.admin && sweep.held ? (
            <button
              type="button"
              className={styles.ghostButton}
              disabled={busy}
              onClick={() => act(postDjJob('start'))}
            >
              Resume
            </button>
          ) : viewer.admin && !sweep.running && (counts?.counts.pending ?? 0) > 0 ? (
            <button
              type="button"
              className={styles.ghostButton}
              disabled={busy}
              onClick={() => act(postDjJob('start'))}
            >
              Start now
            </button>
          ) : mineFirst ? (
            <button
              type="button"
              className={styles.ghostButton}
              disabled={busy}
              onClick={() => act(analyseMine())}
            >
              Analyse mine first
            </button>
          ) : null}
          <span className={styles.spacer} />
          <button type="button" className={styles.link} onClick={activity}>
            Open Activity
          </button>
        </div>
      )}
    </div>
  );
}

/** The topbar's pill and its popover (31b). */
export function AnalysisCount({ className }: { className?: string }) {
  const viewer = useAnalysisViewer();
  const sweep = useAnalysisSweep(true, { fast: false });
  const view = countView(sweep, viewer);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);
  if (!view) return null;
  return (
    <span className={clsx(styles.countWrap, className)} ref={wrap}>
      <button
        type="button"
        ref={button}
        className={styles.count}
        data-tone={view.tone}
        data-running={view.running ? '' : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((o) => !o)}
        data-analysis-count=""
      >
        <Dot tone={view.tone} />
        <span className={styles.countWords}>{view.words}</span>
      </button>
      {open ? (
        <div className={styles.popover} role="dialog" aria-label="Analysis" id={dialogId}>
          <AnalysisPanel variant="popover" onOpenActivity={() => setOpen(false)} />
        </div>
      ) : null}
    </span>
  );
}

const COUNT_HOST = 'ss-analysis-count';

/**
 * The count in the shell's top bar, before Activity's link (desktop; on a
 * phone the Activity page shows the panel, 31f). Mounted once in the
 * router's root.
 */
export function AnalysisCountHost() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const end = document.querySelector('#ss-topbar .ss-topbar-end');
    if (!end) return;
    let el = document.getElementById(COUNT_HOST);
    if (!el) {
      el = document.createElement('span');
      el.id = COUNT_HOST;
      el.className = 'ss-desktop-only';
      end.insertBefore(el, end.firstChild);
    }
    setHost(el);
    return () => {
      el?.remove();
    };
  }, []);
  return host ? createPortal(<AnalysisCount />, host) : null;
}

/** The phone's Activity page: the panel at its head while something is analysed (31f). */
export function AnalysisSheet() {
  const sweep = useAnalysisSweep(true, { fast: false });
  if (!sweep || !sweep.analyze) return null;
  if (!sweep.running && !sweep.held && !(sweep.in_line ?? 0)) return null;
  return <AnalysisPanel variant="sheet" />;
}

/**
 * The hook for DJ now (Brief E, 35a; 31c's last board): the incoming lane's
 * line while its track is analysed, "Analysing Static Bloom · energy (4 of
 * 6) · the lane fills in when the grid is there", then "… is ready to mix"
 * for 4 s and nothing. DJ now isn't built yet; its panel mounts this over
 * the incoming lane and asks for the track with `source: 'dj_now'` (the
 * server already takes it, and the popover says "DJ now").
 */
export function IncomingLaneAnalysis({
  entry,
  title,
  trackId,
}: {
  entry: AnalysisEntry | null | undefined;
  title: string | null;
  trackId: string | null;
}) {
  return (
    <AnalysisLine
      size="line"
      entry={entry}
      title={title}
      trackId={trackId}
      extra={entry?.state === 'working' ? 'the lane fills in when the grid is there' : null}
      hideWhenReady
    />
  );
}
