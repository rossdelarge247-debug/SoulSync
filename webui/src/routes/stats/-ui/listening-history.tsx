/**
 * Library → Listening history (the Stats page's history card) with a Kind
 * filter: Music / Podcasts / Audiobooks, Music by default (HANDOFF 46). Music
 * is the listening history as before (the stats' recent plays); podcasts and
 * audiobooks are this profile's plays of them (GET /api/player/plays), with
 * where each got to. The charts above stay music only.
 */

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

import { OptionButton, OptionButtonGroup } from '@/components/form';
import { playInAppPlayer } from '@/features/playback/app-player';
import { spokenProgressWords } from '@/shell/player-state';

import type { StatsRecentTrack } from '../-stats.types';

import styles from './stats-page.module.css';

export type HistoryKind = 'music' | 'podcast' | 'audiobook';

export const HISTORY_KINDS: { value: HistoryKind; label: string }[] = [
  { value: 'music', label: 'Music' },
  { value: 'podcast', label: 'Podcasts' },
  { value: 'audiobook', label: 'Audiobooks' },
];

export interface SpokenPlay {
  play_id: number;
  kind: 'podcast' | 'audiobook';
  media_id: string;
  title: string;
  subtitle?: string | null;
  image_url?: string | null;
  src?: string | null;
  duration_s?: number | null;
  played_at: string;
  position_s?: number | null;
  finished?: boolean;
}

export async function fetchSpokenPlays(kind: 'podcast' | 'audiobook'): Promise<SpokenPlay[]> {
  const res = await fetch(`/api/player/plays?kind=${kind}&limit=50`, {
    credentials: 'same-origin',
  });
  const body = (await res.json().catch(() => null)) as { items?: SpokenPlay[] } | null;
  if (!res.ok || !body) throw new Error("Couldn't load what you played.");
  return Array.isArray(body.items) ? body.items : [];
}

const EMPTY: Record<'podcast' | 'audiobook', string> = {
  podcast: 'No podcast episodes played yet. Episodes you play in SYNCHRO.S show here.',
  audiobook: 'No audiobooks played yet. What you play from Audiobooks shows here.',
};

export function ListeningHistory({
  music,
  renderMusic,
  formatPlayedAt,
}: {
  music: StatsRecentTrack[];
  renderMusic: (tracks: StatsRecentTrack[]) => ReactNode;
  formatPlayedAt: (playedAt?: string | null) => string;
}) {
  const [kind, setKind] = useState<HistoryKind>('music');
  const spoken = kind === 'music' ? null : kind;
  const query = useQuery({
    queryKey: ['player-plays', spoken],
    queryFn: () => fetchSpokenPlays(spoken!),
    enabled: spoken !== null,
    staleTime: 15_000,
  });

  return (
    <div className={styles.historyBody}>
      <div className={styles.historyKinds} role="group" aria-labelledby="stats-history-kind">
        <span className={styles.historyKindsLabel} id="stats-history-kind">
          Kind
        </span>
        <OptionButtonGroup>
          {HISTORY_KINDS.map((option) => (
            <OptionButton
              key={option.value}
              selected={kind === option.value}
              onClick={() => setKind(option.value)}
            >
              {option.label}
            </OptionButton>
          ))}
        </OptionButtonGroup>
      </div>
      {spoken === null ? (
        renderMusic(music)
      ) : query.isPending ? (
        <p className={styles.historyNote} role="status">
          Loading what you played…
        </p>
      ) : query.isError ? (
        <p className={styles.historyNote} role="alert">
          Couldn&apos;t load what you played.{' '}
          <button
            type="button"
            className={styles.historyRetry}
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </p>
      ) : !query.data?.length ? (
        <p className={styles.historyNote}>{EMPTY[spoken]}</p>
      ) : (
        <div className={styles.statsRecentList} data-history-kind={spoken}>
          {query.data.map((play) => (
            <SpokenRow key={play.play_id} play={play} when={formatPlayedAt(play.played_at)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SpokenRow({ play, when }: { play: SpokenPlay; when: string }) {
  const progress = spokenProgressWords(play);
  const playable = Boolean(play.src);
  return (
    <div className={styles.statsRecentItem}>
      <button
        type="button"
        className={`${styles.statsPlayButton} ${styles.statsPlayButtonSmall}`}
        disabled={!playable}
        aria-label={playable ? `Play ${play.title}` : `${play.title} can't be played from here`}
        title={progress && progress !== 'Finished' ? 'Play from where you left off' : 'Play'}
        onClick={() =>
          playInAppPlayer({
            kind: play.kind,
            id: play.media_id,
            src: play.src!,
            title: play.title,
            subtitle: play.subtitle || undefined,
            artUrl: play.image_url,
            durationHint: play.duration_s ?? null,
          })
        }
      >
        ▶
      </button>
      <span className={styles.statsRecentTitle}>{play.title}</span>
      <span className={styles.statsRecentArtist}>
        {[play.subtitle, progress].filter(Boolean).join(' · ')}
      </span>
      <span className={styles.statsRecentTime}>{when}</span>
    </div>
  );
}
