import { useQuery } from '@tanstack/react-query';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import { LoadingState, Notice } from '@/components/primitives';
import { openAddToPlaylist } from '@/features/playlists/add-to-playlist';

import type { DjMatch, DjTrack } from './dj.api';

import { DjMeta } from './dj-meta';
import { djMixesQueryOptions } from './dj.api';
import { bpmRelationWords, bpmWords, keyRelationWords } from './dj.format';
import styles from './dj.module.css';

export interface MixesSeed {
  id: string;
  title: string;
}

/** Queue a library track after the current one (the player says "Playing next"). */
export function playTrackNext(track: DjTrack): void {
  if (!window.playNext) {
    window.showToast?.("The player isn't ready yet. Try again in a moment.", 'error');
    return;
  }
  window.playNext({
    id: track.id,
    title: track.title,
    artist: track.artist_name,
    album: track.album_title,
    file_path: track.file_path,
    artist_id: track.artist_id,
    album_id: track.album_id,
    image_url: track.image_url,
    bitrate: track.bitrate,
    duration: track.duration_ms ? Math.round(track.duration_ms / 1000) : undefined,
  });
}

export function addTrackToPlaylist(track: DjTrack, anchor?: HTMLElement | null): void {
  openAddToPlaylist(
    {
      track_name: track.title,
      artist_name: track.artist_name,
      album_name: track.album_title,
      duration_ms: track.duration_ms ?? 0,
    },
    anchor,
  );
}

function PlayNextIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M5 5v14l10-7z" />
      <path d="M17 5h2v14h-2z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MatchRow({ match }: { match: DjMatch }) {
  const plusRef = useRef<HTMLButtonElement>(null);
  return (
    <li className={styles.match} data-mix-row={match.id}>
      <span className={styles.art} aria-hidden="true">
        {match.image_url ? <img src={match.image_url} alt="" loading="lazy" /> : null}
      </span>
      <span className={styles.matchText}>
        <span className={styles.matchTitle}>{match.title}</span>
        <span className={styles.matchMeta}>
          {match.artist_name || 'Unknown artist'}
          <DjMeta dj={match.dj} lead />
        </span>
        <span className={styles.relation}>
          {keyRelationWords(match.key_relation, match.dj?.key ?? null)} ·{' '}
          {bpmRelationWords(match.bpm_relation, match.bpm_diff_pct)}
        </span>
      </span>
      <span className={styles.matchActions}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`Play ${match.title} next`}
          title="Play next"
          onClick={() => playTrackNext(match)}
        >
          <PlayNextIcon />
        </button>
        <button
          ref={plusRef}
          type="button"
          className={styles.iconButton}
          aria-label={`Add ${match.title} to a playlist`}
          title="Add to playlist"
          onClick={() => addTrackToPlaylist(match, plusRef.current)}
        >
          <PlusIcon />
        </button>
      </span>
    </li>
  );
}

function MixesBody({ seed }: { seed: MixesSeed }) {
  const query = useQuery({ ...djMixesQueryOptions(seed.id), retry: false });
  if (query.isPending) return <LoadingState label="Finding tracks that mix…" />;
  if (query.isError) {
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't look for tracks that mix"
        actions={
          <Button size="lg" variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        SYNCHRO.S didn&apos;t answer. Nothing is lost; this is a display problem.
      </Notice>
    );
  }
  const data = query.data;
  if (data.reason === 'not_analyzed') {
    return (
      <p className={styles.emptyLine}>
        SYNCHRO.S hasn&apos;t worked out this track&apos;s BPM and key yet. It does every track in
        the background; Activity shows how far it&apos;s got.
      </p>
    );
  }
  if (!data.matches.length) {
    return (
      <p className={styles.emptyLine}>
        Nothing in your library mixes with this one yet: no track in a neighbouring key is within 6%
        of its tempo.
      </p>
    );
  }
  return (
    <ul className={styles.matches} aria-label={`Tracks that mix well with ${seed.title}`}>
      {data.matches.map((match) => (
        <MatchRow key={match.id} match={match} />
      ))}
    </ul>
  );
}

function SeedLine({ seed }: { seed: MixesSeed }) {
  const query = useQuery({ ...djMixesQueryOptions(seed.id), retry: false });
  const dj = query.data?.track?.dj;
  if (!dj?.key || !dj.bpm) {
    return (
      <>The same key, one step round the Camelot wheel, or the relative key, at a similar tempo.</>
    );
  }
  return (
    <>
      {dj.key} ({dj.key_long}) at {bpmWords(dj.bpm)}. The same key, one step round the Camelot wheel
      or the relative key, within 6% of the tempo; half and double time count.
    </>
  );
}

/** The "Mixes well with…" dialog for one library track. */
export function MixesDialog({ seed, onClose }: { seed: MixesSeed; onClose: () => void }) {
  const query = useQuery({ ...djMixesQueryOptions(seed.id), retry: false });
  const count = query.data?.matches.length ?? 0;
  return (
    <DialogFrame open onOpenChange={(next) => (next ? null : onClose())} className={styles.dialog}>
      <DialogHeader
        title={`Mixes well with “${seed.title}”`}
        description={<SeedLine seed={seed} />}
      />
      <DialogBody>
        <MixesBody seed={seed} />
      </DialogBody>
      <DialogFooter
        note={
          count
            ? `${count.toLocaleString()} ${count === 1 ? 'track' : 'tracks'} in your library`
            : null
        }
      >
        <Button size="lg" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

/**
 * The "…" menu's "Mixes well with…": `open(track)` shows the dialog,
 * `dialog` is what the page renders (null while it's closed).
 */
export function useMixesWith(): { open: (seed: MixesSeed) => void; dialog: ReactNode } {
  const [seed, setSeed] = useState<MixesSeed | null>(null);
  const open = useCallback((next: MixesSeed) => setSeed(next), []);
  const dialog = seed ? <MixesDialog seed={seed} onClose={() => setSeed(null)} /> : null;
  return { open, dialog };
}
