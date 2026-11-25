/**
 * Quarantine, explained (design boards 10 and 11).
 *
 * The overview groups what's held by what we suggest doing (right song,
 * longer version, shorter, cut off, broken, another song, other), each with
 * its count, why, an example and its bulk action. Opening a group lists its
 * songs; each song shows every try with its verdict, a plain sentence, its
 * length next to Spotify's, quality and uploader, and the best try marked.
 * The reason is always on the page, never only in a hover title.
 *
 * Everything here reads api/quarantine_explained.py (admin only). A profile
 * that isn't allowed gets `fallback`: the plain list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog/dialog';

import type { AdlQuarantineEntry, QxKind } from '../-adl.types';
import type { QxBulkAction, QxGroup, QxOverview, QxRecheck, QxSong } from '../-qx.api';
import type { ReviewActionHandlers } from './adl-review';

import { formatBytes, quarantineSourceLabel } from '../-adl.helpers';
import { quarantineApproveEntry, quarantineDeleteGroup } from '../-adl.verif-actions';
import { relTime } from '../-dl.format';
import {
  QxForbidden,
  approveOnlyThis,
  cancelQxKeepBest,
  confirmQxBulk,
  fetchQxOverview,
  fetchQxSong,
  fetchQxSongs,
  previewQxBulk,
  qxRecheck,
} from '../-qx.api';
import { DlIcon } from './dl-parts';
import styles from './qx.module.css';

const toast = (message: string, type: string) => window.showToast?.(message, type);
const n = (value: number) => value.toLocaleString('en-GB');
const plural = (count: number, one: string, many = `${one}s`) =>
  `${n(count)} ${count === 1 ? one : many}`;

type Tone = 'good' | 'info' | 'warn' | 'bad' | 'neutral';

interface GroupCopy {
  title: string;
  why: string;
  tone: Tone;
  bulk: QxBulkAction | null;
}

/** What each group says (board 10). */
export const QX_GROUPS: Record<QxKind, GroupCopy> = {
  right_song: {
    title: 'Probably the right song, a slightly different edit',
    why: 'Within 20% of the length Spotify lists. Usually a different master, fade or intro.',
    tone: 'good',
    bulk: 'keep_best',
  },
  longer_version: {
    title: 'A longer version, probably an extended or original mix',
    why: "Over 20% longer than Spotify's length. Common when Spotify lists the radio edit.",
    tone: 'info',
    bulk: 'keep_best',
  },
  shorter_or_cut: {
    title: 'Shorter: a radio edit, or cut off',
    why: "Half to four-fifths of Spotify's length. Listen to the end to tell which.",
    tone: 'warn',
    bulk: null,
  },
  cut_off: {
    title: 'Cut off or a preview clip',
    why: 'Less than half the length Spotify lists, or it stops early. Almost never the whole song.',
    tone: 'bad',
    bulk: 'delete',
  },
  broken: {
    title: 'Broken or empty files',
    why: 'A few KB at most, or unreadable: nothing playable.',
    tone: 'bad',
    bulk: 'delete',
  },
  different_song: {
    title: 'Another song',
    why: 'AcoustID listened and heard a different recording.',
    tone: 'bad',
    bulk: null,
  },
  other: {
    title: 'Other',
    why: 'Held back for another reason, such as a damaged lossless file or one shorter than your library copy.',
    tone: 'neutral',
    bulk: null,
  },
};

const VERDICT_TONE: Record<string, Tone> = {
  best: 'good',
  right_song: 'good',
  longer_version: 'info',
  shorter_or_cut: 'warn',
  cut_off: 'bad',
  broken: 'bad',
  different_song: 'bad',
  other: 'neutral',
};

function toneClass(tone: Tone): string {
  return styles[`tone_${tone}`] ?? '';
}

function bulkLabel(group: QxGroup): string | null {
  const copy = QX_GROUPS[group.kind];
  if (copy.bulk === 'keep_best') return 'Keep the best of each';
  if (copy.bulk === 'delete') return `Delete all ${n(group.files)}`;
  return null;
}

function exampleLine(group: QxGroup): string {
  const ex = group.example;
  if (!ex) return '';
  if (ex.length && ex.spotify_length)
    return `${ex.title} · ${ex.length}, Spotify lists ${ex.spotify_length}`;
  if (group.kind === 'broken')
    return `${ex.title} · ${formatBytes(ex.size_bytes || 0) || '0 bytes'}`;
  return ex.title;
}

// ── the bulk actions ─────────────────────────────────────────────────────

/** Preview, ask, then run exactly the plan that was shown. */
export async function runQxBulk(
  kind: QxKind,
  action: QxBulkAction,
  onDone: () => void,
): Promise<void> {
  try {
    const plan = await previewQxBulk(kind, action);
    if (!plan.plan_id) {
      toast('Nothing to do in this group any more.', 'info');
      onDone();
      return;
    }
    const message =
      action === 'delete'
        ? `Delete ${plural(plan.files ?? 0, 'file')} (${plural(plan.songs, 'song')}, ${formatBytes(plan.bytes) || '0 bytes'}) for good? Songs still on Wanted stay wanted and will be searched again. Anything held after this preview, or moved to another group since, stays.`
        : `Keep the best try of ${plural(plan.songs, 'song')} and delete their other ${plural(plan.delete ?? 0, 'try', 'tries')}? Each kept file is imported as if it had passed. It runs in the background, one song at a time.`;
    const confirmed = await window.showConfirmDialog?.({
      title: action === 'delete' ? 'Delete these files?' : 'Keep the best of each?',
      message,
      confirmText: action === 'delete' ? `Delete ${n(plan.files ?? 0)}` : `Keep ${n(plan.songs)}`,
      cancelText: 'Cancel',
      // both delete files for good (keep-best deletes each song's other tries)
      destructive: true,
    });
    if (!confirmed) return;
    const result = await confirmQxBulk(plan.plan_id, action);
    if (!result.success) {
      toast(result.error || "Couldn't do that.", 'error');
    } else if (action === 'delete') {
      toast(result.message || `Deleted ${plural(result.files_removed ?? 0, 'file')}.`, 'success');
    } else {
      toast(`Keeping the best of ${plural(result.songs ?? plan.songs, 'song')}…`, 'success');
    }
    onDone();
  } catch (error) {
    toast(`Couldn't do that: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

// ── the AcoustID banner ──────────────────────────────────────────────────

function RecheckProgress({
  recheck,
  onAction,
}: {
  recheck: QxRecheck;
  onAction: (action: 'pause' | 'resume' | 'cancel') => void;
}) {
  const running = recheck.status === 'running';
  const pct = recheck.total ? Math.round((recheck.done / recheck.total) * 100) : 0;
  return (
    <section aria-label="AcoustID re-check" className={`${styles.banner} ${styles.banner_info}`}>
      <div className={styles.bannerText}>
        <p>
          <strong>
            {running ? 'Re-checking with AcoustID' : 'Re-check paused'}: {n(recheck.done)} of{' '}
            {n(recheck.total)}.
          </strong>{' '}
          {n(recheck.confirmed)} confirmed, {n(recheck.different)} another song,{' '}
          {n(recheck.no_match)} with no match.
        </p>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="Re-check progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btn}
          onClick={() => onAction(running ? 'pause' : 'resume')}
        >
          {running ? 'Pause' : 'Resume'}
        </button>
        <button type="button" className={styles.btn} onClick={() => onAction('cancel')}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function AcoustidBanner({
  overview,
  onRecheck,
}: {
  overview: QxOverview;
  onRecheck: (action: 'start' | 'pause' | 'resume' | 'cancel') => void;
}) {
  const acoustid = overview.acoustid;
  const recheck = overview.recheck;
  if (!acoustid || !recheck) return null;
  if (recheck.status === 'running' || recheck.status === 'paused') {
    return <RecheckProgress recheck={recheck} onAction={onRecheck} />;
  }
  if (!acoustid.working) {
    return (
      <section aria-label="AcoustID" className={`${styles.banner} ${styles.banner_warn}`}>
        <p className={styles.bannerText}>
          <strong>
            {acoustid.refused ? 'AcoustID refused the key.' : "AcoustID isn't working."}
          </strong>{' '}
          With a working key, SYNCHRO.S can listen to each file and confirm whether it's the right
          song, which would sort most of these for you.
        </p>
        <a className={styles.btn} href={acoustid.settings_url}>
          Fix AcoustID
        </a>
      </section>
    );
  }
  const pending = recheck.pending ?? 0;
  if (!pending) return null;
  const interrupted = recheck.status === 'interrupted';
  return (
    <section aria-label="AcoustID" className={`${styles.banner} ${styles.banner_info}`}>
      <p className={styles.bannerText}>
        <strong>
          {interrupted
            ? 'The AcoustID re-check stopped when the server restarted.'
            : 'AcoustID is working.'}
        </strong>{' '}
        It can listen to the {plural(pending, 'file')} it hasn't checked yet and confirm which are
        the right song. It runs in the background, about three files a second at most, and never
        imports anything by itself.
      </p>
      <button
        type="button"
        className={`${styles.btn} ${styles.primary}`}
        onClick={() => onRecheck(interrupted ? 'resume' : 'start')}
      >
        {interrupted ? 'Resume the re-check' : `Re-check ${n(pending)} with AcoustID`}
      </button>
    </section>
  );
}

// ── one song ─────────────────────────────────────────────────────────────

function tryWhen(entry: AdlQuarantineEntry): string {
  const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(ms) ? relTime(ms, Date.now()) : '';
}

export function QxTryRow({
  entry,
  best,
  handlers,
  onKeep,
}: {
  entry: AdlQuarantineEntry;
  best: boolean;
  handlers: ReviewActionHandlers;
  /** Keep, when the song has other tries: asks what to do with them first. */
  onKeep?: () => void;
}) {
  const ex = entry.explained;
  const file = entry.original_filename || entry.filename || 'Unknown file';
  const verdict = ex?.verdict ?? ex?.kind ?? 'other';
  const label = ex?.verdict_label ?? ex?.label ?? 'Other';
  const source = quarantineSourceLabel(entry);
  const who = entry.source_username && source === 'Soulseek' ? entry.source_username : source;
  const when = tryWhen(entry);
  const lengths = ex?.length
    ? `${ex.length}${ex.spotify_length ? ` · Spotify ${ex.spotify_length}` : ''}`
    : ex?.spotify_length
      ? `Spotify ${ex.spotify_length}`
      : '';
  const quality = ex?.quality || entry.quality || '';
  const legacy = !entry.has_full_context;
  return (
    <li
      className={`${styles.try}${best ? ` ${styles.tryBest}` : ''}`}
      data-quarantine-id={entry.id}
    >
      <div className={styles.tryMain}>
        <p className={styles.tryFile}>{file}</p>
        <p className={styles.tryWhy}>
          <span className={`${styles.tag} ${toneClass(VERDICT_TONE[verdict] ?? 'neutral')}`}>
            {label}
          </span>
          <span>{ex?.text || entry.reason}</span>
        </p>
        <p className={styles.tryFrom}>
          {[who ? `from ${who}` : '', when].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className={styles.tryFacts}>
        {lengths ? <span>{lengths}</span> : null}
        {quality ? <span className={styles.muted}>{quality}</span> : null}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.icon}`}
          aria-label={`Play ${file}`}
          title="Play it"
          onClick={handlers.onPlay}
        >
          {DlIcon.play}
        </button>
        <button
          type="button"
          className={`${styles.btn}${best ? ` ${styles.primary}` : ''}`}
          aria-label={`${legacy ? 'Recover' : 'Keep'} ${file}`}
          title={
            legacy
              ? 'Recover to Staging for a manual import (an older entry without its import context)'
              : 'Import this file as if it had passed'
          }
          onClick={legacy || !onKeep ? handlers.onApprove : onKeep}
        >
          {legacy ? 'Recover' : 'Keep'}
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.danger}`}
          aria-label={`Delete ${file}`}
          onClick={handlers.onDelete}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

export function QxSongCard({
  song,
  handlersFor,
  onChanged,
}: {
  song: QxSong;
  handlersFor: (entry: AdlQuarantineEntry) => ReviewActionHandlers;
  onChanged: () => void;
}) {
  const best = song.tries.find((t) => t.id === song.best) ?? null;
  const first = song.tries[0];
  const count = song.tries.length;
  const headingId = `qx-song-${song.key.replace(/[^a-z0-9]+/gi, '-')}`;
  const [choosing, setChoosing] = useState<AdlQuarantineEntry | null>(null);
  const fileOf = (entry: AdlQuarantineEntry) =>
    entry.original_filename || entry.filename || 'this file';

  const keepBest = async () => {
    if (!best) return;
    const confirmed = await window.showConfirmDialog?.({
      title: 'Keep the best, delete the rest?',
      message: `Keep “${fileOf(best)}” and delete the other ${plural(count - 1, 'try', 'tries')} at this song for good? The kept file is imported as if it had passed.`,
      confirmText: `Keep it, delete ${n(count - 1)}`,
      cancelText: 'Cancel',
      destructive: true,
    });
    if (confirmed) await quarantineApproveEntry(best, onChanged);
  };

  const keepOnly = async (entry: AdlQuarantineEntry) => {
    setChoosing(null);
    try {
      const result = await approveOnlyThis(entry.id);
      if (result.success) {
        toast('Kept: importing it now. The other tries are still here.', 'success');
        onChanged();
      } else toast(result.error || "Couldn't keep it.", 'error');
    } catch (e) {
      toast(`Couldn't keep it: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  return (
    <article className={styles.song} aria-labelledby={headingId}>
      <header className={styles.songHead}>
        <div>
          <h3 id={headingId} className={styles.songTitle}>
            {song.title || 'Unknown song'}
          </h3>
          {song.artist ? <p className={styles.muted}>{song.artist}</p> : null}
          <p className={styles.songSummary}>{song.summary}</p>
        </div>
        <div className={styles.actions}>
          {best && count > 1 && best.has_full_context ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              onClick={() => void keepBest()}
            >
              Keep the best, delete the rest
            </button>
          ) : null}
          {first ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.danger}`}
              onClick={() => void quarantineDeleteGroup(first, count, onChanged)}
            >
              {count === 1 ? 'Delete it' : `Delete all ${count}`}
            </button>
          ) : null}
        </div>
      </header>
      <ul className={styles.tries} aria-label={`Tries at ${song.title || 'this song'}`}>
        {song.tries.map((entry) => (
          <QxTryRow
            key={entry.id}
            entry={entry}
            best={entry.id === song.best}
            handlers={handlersFor(entry)}
            onKeep={count > 1 ? () => setChoosing(entry) : undefined}
          />
        ))}
      </ul>
      <DialogFrame
        open={choosing !== null}
        onOpenChange={(open) => {
          if (!open) setChoosing(null);
        }}
      >
        <DialogHeader
          title="Keep this try?"
          description={
            choosing
              ? `“${fileOf(choosing)}” is imported as if it had passed. This song has ${plural(count - 1, 'other try', 'other tries')}.`
              : ''
          }
        />
        <DialogBody>
          <p className={styles.muted}>
            Keep this and delete the others removes {plural(count - 1, 'file')} for good:{' '}
            {song.tries
              .filter((t) => t.id !== choosing?.id)
              .map(fileOf)
              .join(', ')}
            .
          </p>
        </DialogBody>
        <DialogFooter>
          <button type="button" className={styles.btn} onClick={() => setChoosing(null)}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={() => choosing && void keepOnly(choosing)}
          >
            Keep only this, leave the others
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.danger}`}
            onClick={() => {
              const entry = choosing;
              setChoosing(null);
              if (entry) void quarantineApproveEntry(entry, onChanged);
            }}
          >
            Keep this, delete {n(count - 1)}
          </button>
        </DialogFooter>
      </DialogFrame>
    </article>
  );
}

// ── a group's songs ──────────────────────────────────────────────────────

function GroupSongs({
  group,
  handlersFor,
  onBack,
  onChanged,
  refreshKey,
}: {
  group: QxGroup;
  handlersFor: (entry: AdlQuarantineEntry) => ReviewActionHandlers;
  onBack: () => void;
  onChanged: () => void;
  refreshKey: number;
}) {
  const [songs, setSongs] = useState<QxSong[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const copy = QX_GROUPS[group.kind];
  const shown = songs?.length ?? 0;

  const load = useCallback(
    async (offset: number) => {
      try {
        const page = await fetchQxSongs(group.kind, offset);
        setTotal(page.total ?? 0);
        setSongs((prev) =>
          offset === 0 ? (page.songs ?? []) : [...(prev ?? []), ...(page.songs ?? [])],
        );
        setError(
          page.ready === false
            ? 'The quarantine is still being read. Try again in a moment.'
            : null,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [group.kind],
  );

  useEffect(() => {
    void load(0);
  }, [load, refreshKey]);

  const bulk = bulkLabel(group);
  return (
    <section aria-labelledby="qx-group-title" className={styles.stack}>
      <div>
        <button type="button" className={styles.link} onClick={onBack}>
          ← All groups
        </button>
      </div>
      <header className={styles.groupHead}>
        <div>
          <h2 id="qx-group-title" className={styles.h2}>
            <span className={`${styles.dot} ${toneClass(copy.tone)}`} aria-hidden="true" />
            {copy.title}
          </h2>
          <p className={styles.muted}>
            {copy.why} {plural(group.files, 'file')}, {plural(group.songs, 'song')}.
          </p>
        </div>
        {bulk && copy.bulk ? (
          <button
            type="button"
            className={`${styles.btn} ${copy.bulk === 'delete' ? styles.danger : styles.primary}`}
            onClick={() => void runQxBulk(group.kind, copy.bulk as QxBulkAction, onChanged)}
          >
            {bulk}
          </button>
        ) : null}
      </header>
      {error ? (
        <p role="alert" className={styles.error}>
          Couldn't load these songs: {error}
        </p>
      ) : null}
      {songs === null && !error ? (
        <p role="status" className={styles.muted}>
          Loading these songs…
        </p>
      ) : null}
      {songs && songs.length === 0 && !error ? (
        <p className={styles.muted}>Nothing left in this group.</p>
      ) : null}
      {songs?.map((song) => (
        <QxSongCard key={song.key} song={song} handlersFor={handlersFor} onChanged={onChanged} />
      ))}
      {songs && shown < total ? (
        <div>
          <button type="button" className={styles.btn} onClick={() => void load(shown)}>
            Show more ({n(shown)} of {n(total)} songs)
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ── the whole view ───────────────────────────────────────────────────────

const POLL_BUSY_MS = 4000;

export function QuarantineExplained({
  handlersFor,
  fallback,
  refreshKey = 0,
  onChanged,
}: {
  handlersFor: (entry: AdlQuarantineEntry) => ReviewActionHandlers;
  /** what a profile that may not use this view sees (the plain list) */
  fallback: React.ReactNode;
  /** bump to read everything again (the page's own refreshes) */
  refreshKey?: number;
  /** after a change here (the page refreshes its counts) */
  onChanged?: () => void;
}) {
  const [overview, setOverview] = useState<QxOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [plain, setPlain] = useState(false);
  const [open, setOpen] = useState<QxKind | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchQxOverview();
      if (!alive.current) return;
      setOverview(data);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof QxForbidden) setForbidden(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey, tick]);

  const busy =
    overview?.recheck?.status === 'running' ||
    overview?.keep_best?.status === 'running' ||
    overview?.ready === false;
  useEffect(() => {
    if (!busy) return undefined;
    const timer = window.setInterval(() => void load(), POLL_BUSY_MS);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  const changed = useCallback(() => {
    setTick((t) => t + 1);
    onChanged?.();
  }, [onChanged]);

  const onRecheck = useCallback(
    async (action: 'start' | 'pause' | 'resume' | 'cancel') => {
      try {
        const result = await qxRecheck(action);
        if (!result.success) toast(result.error || "Couldn't do that.", 'error');
      } catch (e) {
        toast(
          `Couldn't ${action} the re-check: ${e instanceof Error ? e.message : String(e)}`,
          'error',
        );
      }
      void load();
    },
    [load],
  );

  if (forbidden || plain) {
    return (
      <>
        {plain ? (
          <div className={styles.switch}>
            <button type="button" className={styles.link} onClick={() => setPlain(false)}>
              Group by what to do
            </button>
          </div>
        ) : null}
        {fallback}
      </>
    );
  }
  if (error && !overview) {
    return (
      <>
        <p role="alert" className={styles.error}>
          Couldn't group the quarantine: {error}. Here's every file instead.
        </p>
        {fallback}
      </>
    );
  }
  if (!overview) {
    return (
      <p role="status" className={styles.muted}>
        Loading quarantine…
      </p>
    );
  }
  if (!overview.ready) {
    return (
      <p role="status" className={styles.muted}>
        Reading the quarantine folder… this takes a moment the first time.
      </p>
    );
  }

  const groups = overview.groups ?? [];
  const openGroup = open ? groups.find((g) => g.kind === open) : null;
  if (openGroup) {
    return (
      <div className={`${styles.stack} ${styles.page}`}>
        <GroupSongs
          group={openGroup}
          handlersFor={handlersFor}
          onBack={() => setOpen(null)}
          onChanged={changed}
          refreshKey={refreshKey + tick}
        />
      </div>
    );
  }

  const files = overview.files ?? 0;
  const lengthOnly = groups
    .filter(
      (g) => g.kind === 'right_song' || g.kind === 'longer_version' || g.kind === 'shorter_or_cut',
    )
    .reduce((sum, g) => sum + g.files, 0);
  const keepBest = overview.keep_best;
  return (
    <div className={`${styles.stack} ${styles.page}`} data-testid="quarantine-explained">
      <header>
        <h2 className={styles.h1}>Quarantine</h2>
        {files ? (
          <p className={styles.lead}>
            {plural(files, 'download')} {files === 1 ? 'was' : 'were'} held back instead of going
            into your library
            {lengthOnly * 2 > files
              ? ". Most aren't broken: their length just didn't match what Spotify lists"
              : ''}
            . They're grouped by what we suggest.
          </p>
        ) : null}
      </header>

      <AcoustidBanner overview={overview} onRecheck={(a) => void onRecheck(a)} />

      {keepBest?.status === 'running' ? (
        <section aria-label="Keeping the best" className={`${styles.banner} ${styles.banner_info}`}>
          <p className={styles.bannerText} role="status">
            <strong>
              Keeping the best of each: {n(keepBest.done ?? 0)} of {n(keepBest.songs ?? 0)} songs.
            </strong>{' '}
            {n(keepBest.kept ?? 0)} kept, {n(keepBest.deleted ?? 0)} other tries deleted.
          </p>
          <button
            type="button"
            className={styles.btn}
            onClick={() => void cancelQxKeepBest().then(() => load())}
          >
            Stop
          </button>
        </section>
      ) : null}

      {files === 0 ? (
        <p className={styles.muted}>Nothing in quarantine. Every download passed its checks.</p>
      ) : (
        <section aria-labelledby="qx-groups" className={styles.groups}>
          <div className={styles.groupsHead}>
            <h3 id="qx-groups" className={styles.label}>
              What we suggest
            </h3>
            <span className={styles.muted}>Open a group to listen and decide song by song</span>
          </div>
          <ul className={styles.groupList}>
            {groups.map((group) => {
              const copy = QX_GROUPS[group.kind];
              const bulk = bulkLabel(group);
              const example = exampleLine(group);
              return (
                <li key={group.kind} className={styles.group} data-kind={group.kind}>
                  <span className={`${styles.count} ${toneClass(copy.tone)}`}>
                    {n(group.files)}
                  </span>
                  <div className={styles.groupMain}>
                    <p className={styles.groupTitle}>
                      <span
                        className={`${styles.dot} ${toneClass(copy.tone)}`}
                        aria-hidden="true"
                      />
                      {copy.title}
                    </p>
                    <p className={styles.groupWhy}>
                      {copy.why}{' '}
                      <span className={styles.muted}>{plural(group.songs, 'song')}.</span>
                    </p>
                    {example ? <p className={styles.muted}>e.g. {example}</p> : null}
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.btn}
                      aria-label={`Open ${copy.title}`}
                      onClick={() => setOpen(group.kind)}
                    >
                      Open
                    </button>
                    {bulk && copy.bulk ? (
                      <button
                        type="button"
                        className={`${styles.btn} ${copy.bulk === 'delete' ? styles.danger : styles.primary}`}
                        disabled={copy.bulk === 'keep_best' && keepBest?.status === 'running'}
                        onClick={() =>
                          void runQxBulk(group.kind, copy.bulk as QxBulkAction, changed)
                        }
                      >
                        {bulk}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className={styles.muted}>
        "Keep" imports the file as if it had passed. Bulk delete asks first and says how many files
        and songs it covers; songs still on Wanted stay wanted and will be searched again.{' '}
        <button type="button" className={styles.link} onClick={() => setPlain(true)}>
          List every file instead
        </button>
      </p>
    </div>
  );
}

/** One song, opened from a link (?review=quarantine&entry=): Wanted's Review. */
export function QxSongFocus({
  entryId,
  handlersFor,
  onShowAll,
  fallback,
  refreshKey = 0,
  onChanged,
}: {
  entryId: string;
  handlersFor: (entry: AdlQuarantineEntry) => ReviewActionHandlers;
  onShowAll: () => void;
  fallback: React.ReactNode;
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const [song, setSong] = useState<QxSong | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    fetchQxSong(entryId)
      .then((data) => {
        if (live) {
          setSong(data.song);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof QxForbidden) setForbidden(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [entryId, refreshKey, tick]);

  // not allowed, or the new read failed: the plain one-song view
  if (forbidden || error) return <>{fallback}</>;
  const changed = () => {
    setTick((t) => t + 1);
    onChanged?.();
  };
  return (
    <div className={`${styles.stack} ${styles.page}`} data-testid="quarantine-focus">
      <p role="status" className={styles.muted}>
        {song === undefined
          ? 'Loading this song’s tries…'
          : song === null
            ? 'Nothing left to decide for this song: its tries were kept or deleted.'
            : `Every try at “${song.title}”. Keep the right one, or delete them.`}{' '}
        <button type="button" className={styles.link} onClick={onShowAll}>
          Show everything in quarantine
        </button>
      </p>
      {song ? <QxSongCard song={song} handlersFor={handlersFor} onChanged={changed} /> : null}
    </div>
  );
}
