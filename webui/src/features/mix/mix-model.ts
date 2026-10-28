/**
 * The Mix tab's data, shared by its three places (the tray, the Visuals
 * drawer, the phone sheet): this track's DJ data, the matches in the tab's
 * order (code, or Vibe's), the working set and its view, whether that set
 * is the one playing, the strip, the join, and the actions (Add, Play next,
 * More like this, Analyse it now).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DjInfo } from '@/features/dj/dj.api';
import type { Step, ViewRow } from '@/features/sets/sets.api';

import { useAnalysis, useAutoAnalyse } from '@/features/dj/analysis-line';
import { askForAdded, cancelAnalysis, requestAnalysis } from '@/features/dj/analysis.api';
import { addedAnalysisWords } from '@/features/dj/analysis.format';
import { playTrackNext } from '@/features/dj/dj-actions';
import { DJ_QUERY_KEY, djStatusQueryOptions, djTracksQueryOptions } from '@/features/dj/dj.api';
import {
  MIX_SET_CHANGED,
  SETS_QUERY_KEY,
  postView,
  setQueryOptions,
} from '@/features/sets/sets.api';

import { trackChanged, useMixState, type ChainStep } from './mix-store';
import { readQueue, type MixSubject } from './mix-subject';
import {
  MixError,
  addToWorkingSet,
  aiStatusQueryOptions,
  mixQueryOptions,
  startWorkingSet,
  vibeQueryOptions,
  type MixAnswer,
  type MixMatch,
  type WorkingSet,
  workingSetQueryOptions,
} from './mix.api';
import { addLabel, addedLabel, workingSetName } from './mix.format';

export type TrackSubject = Extract<MixSubject, { kind: 'track' }>;

export interface PlayingInSet {
  /** the playing row's number in the set (as the set's page numbers rows) */
  number: number;
  /** how many numbered rows the set has */
  total: number;
  rowIndex: number;
  next: ViewRow | null;
  /** the step out of the playing row */
  step: Step | null;
  /** the playing row (its transition is the next join's) */
  row: ViewRow;
}

export interface StripCell {
  key: string;
  /** "#4", or "now" */
  pos: string;
  title: string;
  dj: DjInfo | null;
  now: boolean;
}

/** Each row's number, as the set's page numbers them: rows with a library track. */
export function rowNumbers(rows: ViewRow[]): (number | null)[] {
  let n = 0;
  return rows.map((r) => (r.track_id ? ++n : null));
}

/**
 * The set is playing (29b) when the playing track is one of its rows and
 * the queue around it follows the set: the next queued track is the set's
 * next one, or the one before is the set's previous one (the last row
 * counts on the one before).
 */
export function findPlayingInSet(
  rows: ViewRow[],
  steps: (Step | null)[],
  playingId: string,
  queue: { ids: string[]; index: number },
): PlayingInSet | null {
  const numbers = rowNumbers(rows);
  const total = numbers.filter((n) => n !== null).length;
  const playable = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.track_id && r.track);
  for (let k = 0; k < playable.length; k += 1) {
    const { r, i } = playable[k];
    if (String(r.track_id) !== playingId) continue;
    const at = queue.index;
    const nextQueued = at >= 0 ? queue.ids[at + 1] : undefined;
    const prevQueued = at > 0 ? queue.ids[at - 1] : undefined;
    const next = playable[k + 1]?.r ?? null;
    const prev = playable[k - 1]?.r ?? null;
    const follows =
      (next && nextQueued && String(next.track_id) === nextQueued) ||
      (prev && prevQueued && String(prev.track_id) === prevQueued);
    if (!follows) continue;
    return { number: numbers[i] ?? 0, total, rowIndex: i, next, step: steps[i] ?? null, row: r };
  }
  return null;
}

/** The strip (29a): the last three of the set, then the playing track (dashed). */
export function stripCells(
  rows: ViewRow[],
  subject: { id: string; title: string },
  subjectDj: DjInfo | null,
  playing: PlayingInSet | null,
): StripCell[] {
  const numbers = rowNumbers(rows);
  const upTo = playing ? playing.rowIndex : rows.length;
  const before = rows
    .map((r, i) => ({ r, i }))
    .slice(0, upTo)
    .filter(({ r }) => r.track_id)
    .slice(-3)
    .map(({ r, i }) => {
      const t = r.track ?? r.gone_track ?? null;
      return {
        key: `${i}`,
        pos: `#${numbers[i]}`,
        title: t?.title || r.title || '',
        dj: t?.dj ?? null,
        now: false,
      };
    });
  const now: StripCell = {
    key: 'now',
    pos: playing ? `#${playing.number}` : 'now',
    title: subject.title,
    dj: subjectDj,
    now: true,
  };
  return [...before, now];
}

/** The set's last playing row: what "End of set" follows and the join leads from. */
export function lastPlayable(rows: ViewRow[]): ViewRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].track) return rows[i];
  return null;
}

const ADDED_MS = 4_000;

export function useMixModel(
  subject: TrackSubject | null,
  profileId: number | null,
  { shown = true }: { shown?: boolean } = {},
) {
  const qc = useQueryClient();
  const state = useMixState();
  const subjectId = subject?.id ?? null;
  const subjectTitle = subject?.title ?? null;

  // a new playing track: More like this and Widen start over
  const lastSubject = useRef(subjectId);
  useEffect(() => {
    if (lastSubject.current !== subjectId) trackChanged();
    lastSubject.current = subjectId;
  }, [subjectId]);

  // the player's queue, for "while a set plays"
  const [queue, setQueue] = useState(() => readQueue());
  useEffect(() => {
    const update = () =>
      setQueue((prev) => {
        const next = readQueue();
        return prev.index === next.index && prev.ids.join(',') === next.ids.join(',') ? prev : next;
      });
    window.addEventListener('ss:player', update);
    return () => window.removeEventListener('ss:player', update);
  }, []);

  // this track's BPM, key and energy (the left column, 29a)
  const djQuery = useQuery({
    ...djTracksQueryOptions(subjectId ? [subjectId] : []),
    retry: false,
  });
  const dj: DjInfo | null = subjectId ? (djQuery.data?.[subjectId] ?? null) : null;

  // read only while something plays that the tab works for
  const working = useQuery({
    ...workingSetQueryOptions(profileId),
    retry: false,
    enabled: Boolean(subjectId),
  });
  const workingSet: WorkingSet | null = working.data ?? null;
  const setView = useQuery({
    ...setQueryOptions(profileId ?? 0, workingSet?.id ?? 0),
    enabled: Boolean(workingSet),
    retry: false,
  });
  const rows = useMemo(() => setView.data?.rows ?? [], [setView.data]);
  const steps = useMemo(() => setView.data?.steps ?? [], [setView.data]);

  // a set changed elsewhere (the picker added to it): read it again
  useEffect(() => {
    const again = () => {
      void qc.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'working'] });
      void qc.invalidateQueries({ queryKey: [...SETS_QUERY_KEY, 'set'] });
      void qc.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'mix'] });
    };
    window.addEventListener(MIX_SET_CHANGED, again);
    return () => window.removeEventListener(MIX_SET_CHANGED, again);
  }, [qc]);

  const playing = useMemo(
    () => (subjectId && rows.length ? findPlayingInSet(rows, steps, subjectId, queue) : null),
    [rows, steps, subjectId, queue],
  );

  // what the matches follow: More like this, End of set, or the playing track
  const endRow = state.from === 'end' ? lastPlayable(rows) : null;
  const chainTop: ChainStep | null = state.chain[state.chain.length - 1] ?? null;
  const seed: ChainStep | null = chainTop
    ? chainTop
    : endRow?.track
      ? { id: String(endRow.track.id), title: endRow.track.title }
      : subject
        ? { id: subject.id, title: subject.title }
        : null;
  const mixQ = {
    setId: workingSet?.id ?? null,
    wide: state.wide,
    // following another track: the playing one isn't a match to play next
    exclude: seed && subjectId && seed.id !== subjectId ? subjectId : null,
    // while the set plays, its direction is read up to where Add puts tracks
    setAt: playing ? playing.number : null,
  };
  const [waiting, setWaiting] = useState(false);
  useEffect(() => setWaiting(false), [seed?.id]);
  const mix = useQuery({
    ...mixQueryOptions(seed?.id ?? '', mixQ),
    enabled: Boolean(seed),
    retry: false,
    refetchInterval: (q) =>
      waiting && (q.state.data as MixAnswer | undefined)?.reason === 'not_analyzed' ? 4_000 : false,
  });

  const ai = useQuery({ ...aiStatusQueryOptions(), retry: false, enabled: Boolean(subject) });
  const aiReason = ai.data && !ai.data.can_use ? ai.data.reason : null;
  const vibeWanted = state.vibe && Boolean(seed) && !aiReason;
  const vibe = useQuery({
    ...vibeQueryOptions(seed?.id ?? '', mixQ),
    enabled: vibeWanted && Boolean(mix.data?.matches.length),
  });
  const vibeError = vibe.error instanceof MixError ? vibe.error : null;
  const matches: MixMatch[] =
    vibeWanted && vibe.data ? vibe.data.matches : (mix.data?.matches ?? []);

  // the join (29a): the set's last track into the playing one, in code's words
  const last = lastPlayable(rows);
  const joinIds =
    !playing && last?.track_id && subjectId && String(last.track_id) !== subjectId
      ? [String(last.track_id), subjectId]
      : null;
  const join = useQuery({
    queryKey: [...SETS_QUERY_KEY, 'join', ...(joinIds ?? [])] as const,
    queryFn: () =>
      postView(joinIds!.map((id) => ({ track_id: id, artist: null, title: null, state: 'owned' }))),
    enabled: Boolean(joinIds),
    staleTime: 60_000,
    retry: false,
  });
  const joinStep = joinIds ? (join.data?.steps?.[0] ?? null) : null;

  const strip = useMemo(
    () => (subject ? stripCells(rows, subject, dj, playing) : []),
    [rows, subject, dj, playing],
  );
  const inSet = useMemo(() => {
    if (!subjectId) return [] as number[];
    const numbers = rowNumbers(rows);
    return rows.flatMap((r, i) =>
      String(r.track_id ?? '') === subjectId && numbers[i] ? [numbers[i] as number] : [],
    );
  }, [rows, subjectId]);

  // the primary's "✓ Added · #7", for 4 s
  const [added, setAdded] = useState<{ id: string; number: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!added) return;
    const t = window.setTimeout(() => setAdded(null), ADDED_MS);
    return () => window.clearTimeout(t);
  }, [added]);
  useEffect(() => setAdded(null), [subjectId]);

  const refreshSet = useCallback(() => {
    void qc.invalidateQueries({ queryKey: [...SETS_QUERY_KEY] });
    void qc.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'mix'] });
    window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: {} }));
  }, [qc]);

  /** Add a track to the working set (or start one with it); its number, or null. */
  const addTrack = useCallback(
    async (track: { id: string; title: string }, opts: { again?: boolean } = {}) => {
      setBusy(true);
      try {
        // analyse on demand: a track going into the working set jumps the
        // queue, and the toast says where it is in line, once (31b)
        const asking = askForAdded([track.id], { source: 'set', setId: workingSet?.id ?? null });
        const said = async () => {
          const words = addedAnalysisWords(await asking);
          return words ? ` · ${words}` : '';
        };
        if (!workingSet) {
          const name = workingSetName();
          await startWorkingSet(name, [track.id]);
          refreshSet();
          window.showToast?.(
            `Started ${name} with ${track.title || 'the track'} · #1${await said()}`,
            'success',
          );
          return 1;
        }
        // while the set plays, a match goes in straight after the playing track (29b)
        const after =
          playing && subjectId && track.id !== subjectId
            ? { track_id: subjectId, number: playing.number }
            : null;
        const done = await addToWorkingSet(workingSet.id, [track.id], {
          again: opts.again,
          after,
        });
        refreshSet();
        const number = done.added[0]?.number ?? null;
        if (number === null) {
          window.showToast?.(`${track.title || 'It'} is in ${done.name} already.`, 'info');
          return null;
        }
        window.showToast?.(
          `Added ${track.title || 'the track'} to ${done.name} · #${number}${await said()}`,
          'success',
        );
        return number;
      } catch (err) {
        window.showToast?.(err instanceof Error ? err.message : "It wasn't added.", 'error');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [workingSet, playing, subjectId, refreshSet],
  );

  /** The primary (and A): the playing track into the working set. */
  const addPlaying = useCallback(async () => {
    if (!subject || busy) return null;
    const number = await addTrack(
      { id: subject.id, title: subject.title },
      { again: inSet.length > 0 && !playing },
    );
    if (number !== null) setAdded({ id: subject.id, number });
    return number;
  }, [subject, busy, addTrack, inSet.length, playing]);

  let primaryLabel = '';
  let primaryDisabled = false;
  if (added && added.id === subjectId) primaryLabel = addedLabel(added.number);
  else if (subject && playing && workingSet) {
    // it's playing from the set: it's there already
    primaryLabel = `${subject.title || 'This track'} is #${playing.number} in ${workingSet.name}`;
    primaryDisabled = true;
  } else if (subject && workingSet && inSet.length)
    primaryLabel = `Add ${subject.title || 'it'} again · it's #${inSet[0]}`;
  else if (subject && workingSet) primaryLabel = addLabel(subject.title, workingSet.name);
  else if (subject) primaryLabel = `Add ${subject.title || 'this track'} to a new set`;

  const status = useQuery({ ...djStatusQueryOptions(), retry: false, enabled: Boolean(subject) });
  // analyse on demand: a track opened in the Mix tab jumps the queue (any
  // profile; the server skips one that's done), and its progress shows;
  // only while the tab is shown, so a track merely playing asks nothing
  useAutoAnalyse([subjectId], shown, 'auto', { source: 'mix' });
  const progressOf = useAnalysis([subjectId, seed?.id], shown);
  const [analysing, setAnalysing] = useState(false);
  const analyse = useCallback(async () => {
    if (!subjectId) return;
    setAnalysing(true);
    try {
      await requestAnalysis([subjectId], { force: true, source: 'mix' });
      setWaiting(true);
      void qc.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'tracks'] });
    } catch (err) {
      setAnalysing(false);
      window.showToast?.(err instanceof Error ? err.message : "That didn't work.", 'error');
    }
  }, [subjectId, qc]);

  // once it's worked out, the left column reads it again
  const reason = mix.data?.reason ?? null;
  useEffect(() => {
    if (waiting && reason !== 'not_analyzed') {
      setWaiting(false);
      setAnalysing(false);
      void qc.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'tracks'] });
    }
  }, [waiting, reason, qc]);

  /** Cancel (31c): this profile's ask for the track leaves the line. */
  const cancelAnalyse = useCallback(() => {
    if (!subjectId) return;
    cancelAnalysis([subjectId])
      .then((answer) => {
        // it started, or the ask wasn't yours after all (review L4)
        if (!answer.withdrawn)
          window.showToast?.(
            `Nothing to cancel: ${subjectTitle || 'it'} isn't in line on your ask any more.`,
            'info',
          );
      })
      .catch((err: unknown) =>
        window.showToast?.(err instanceof Error ? err.message : "That didn't work.", 'error'),
      );
  }, [subjectId, subjectTitle]);

  const playNext = useCallback((match: MixMatch) => {
    playTrackNext(match);
  }, []);

  return {
    profileId,
    state,
    subject,
    dj,
    djLoading: djQuery.isPending && Boolean(subjectId),
    workingSet,
    workingLoading: working.isPending,
    setView: setView.data ?? null,
    rows,
    playing,
    seed,
    following: chainTop ? 'chain' : endRow ? 'end' : 'now',
    mix,
    matches,
    vibe: {
      on: state.vibe,
      reason: aiReason,
      thinking: vibeWanted && vibe.isFetching,
      error: vibeWanted ? vibeError : null,
      line: vibeWanted ? (vibe.data?.vibe?.line ?? null) : null,
    },
    strip,
    joinStep,
    last,
    inSet,
    busy,
    primaryLabel,
    primaryDisabled,
    addPlaying,
    addTrack,
    playNext,
    // anyone can ask for their own tracks now (analyse on demand)
    canAnalyse: Boolean(status.data) && status.data?.settings.analyze !== false,
    pending: status.data?.counts.pending ?? null,
    /** where the playing track and the matches' seed are in the analysis */
    progress: subjectId ? (progressOf[subjectId] ?? null) : null,
    seedProgress: seed?.id ? (progressOf[seed.id] ?? null) : null,
    analysing: analysing || waiting,
    cancelAnalyse,
    analyse,
  };
}

export type MixModel = ReturnType<typeof useMixModel>;
