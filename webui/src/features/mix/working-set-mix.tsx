/**
 * The working set as a mix, in the Mix tab (Ross's report of 28 October:
 * "i've constructed a working set of 4 tracks in the panel, and it didn't
 * mix any of the tracks, and just stopped after the first track ended").
 *
 * The working set collects tracks; it isn't Up next. So the column says
 * how ready its tracks are to mix, with the line's action (Analyse them
 * now, Analyse again for a grid an older rule judged, Analyse mine for a
 * member), and offers **Play as a mix**: from the playing track when it's
 * one of the set's rows (the rest go straight after it, the playing track
 * goes on), else from the set's start. While the set plays as a mix the
 * button isn't shown. Add asked for each track's analysis as it went in.
 */
import { useState } from 'react';

import { playSetFromPlaying } from '@/features/automix/set-play';
import { AnalysisLine, useAnalysis, useAnalysisViewer } from '@/features/dj/analysis-line';
import { requestAnalysis, type AnalysisEntry } from '@/features/dj/analysis.api';
import { isReady } from '@/features/dj/analysis.format';

import type { MixModel } from './mix-model';

import styles from './mix.module.css';

/** What an ask can move on (the set page's rule): an admin's also finds a judged grid again. */
export function askableIds(
  ids: string[],
  progressOf: Record<string, AnalysisEntry>,
  admin: boolean,
): string[] {
  return ids.filter((id) => {
    const e = progressOf[id];
    if (!e || isReady(e) || e.state === 'working') return false;
    if (e.state === 'done') return admin && e.beat !== 'too_short';
    if (e.state === 'failed') return admin && e.reason !== 'too_long';
    return true;
  });
}

/** The action's words: "Analyse again" (only judged grids), "Try again", "Analyse them now", "Analyse mine". */
export function askLabel(
  askable: string[],
  progressOf: Record<string, AnalysisEntry>,
  admin: boolean,
): string {
  if (!admin) return 'Analyse mine';
  if (askable.every((id) => progressOf[id]?.state === 'done')) return 'Analyse again';
  if (askable.every((id) => progressOf[id]?.state === 'failed')) return 'Try again';
  return 'Analyse them now';
}

export function WorkingSetMix({ model }: { model: MixModel }) {
  const ws = model.workingSet;
  const ids = model.rows
    .filter((r) => r.track_id && r.track?.file_path)
    .map((r) => String(r.track_id))
    .slice(0, 500);
  const viewer = useAnalysisViewer();
  const [busy, setBusy] = useState(false);
  // watched only while the tab is shown (review M1, M2); Add asked for each
  // track as it went in (askForAdded), and the sweep reaches the rest
  const progressOf = useAnalysis(ids, Boolean(ws) && model.shown);
  if (!ws || !ids.length) return null;
  const known = ids.filter((id) => progressOf[id]);
  const ready = known.filter((id) => isReady(progressOf[id]));
  const askable = askableIds(ids, progressOf, viewer.admin);
  const ask = () => {
    void requestAnalysis(askable, {
      force: true,
      reason: 'asked',
      source: 'set',
      setId: ws.id,
      retry: viewer.admin && askable.some((id) => progressOf[id]?.state === 'failed'),
      again: viewer.admin && askable.some((id) => progressOf[id]?.state === 'done'),
    }).catch((error: unknown) =>
      window.showToast?.(error instanceof Error ? error.message : "That didn't work.", 'error'),
    );
  };
  const all = known.length && ready.length === known.length;
  const sentence = all
    ? `Ready to mix · all ${known.length} ${known.length === 1 ? 'track' : 'tracks'}`
    : `${ready.length} of ${ids.length} ready to mix`;
  const play = async () => {
    setBusy(true);
    try {
      await playSetFromPlaying({ id: ws.id, name: ws.name }, model.rows);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.workingMix} data-working-set-mix="">
      {known.length ? (
        <AnalysisLine
          size="line"
          entry={null}
          sentence={sentence}
          tone={all ? 'ready' : 'neutral'}
          action={
            askable.length
              ? { label: askLabel(askable, progressOf, viewer.admin), onClick: ask }
              : false
          }
        />
      ) : null}
      {ids.length > 1 && !model.playing ? (
        <button
          type="button"
          className={styles.stateAction}
          disabled={busy}
          title="The working set isn't Up next: this plays it, with Auto mix for this play"
          onClick={() => void play()}
          data-working-set-play=""
        >
          Play {ws.name} as a mix
        </button>
      ) : null}
    </div>
  );
}
