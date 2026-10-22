/**
 * A show's tracklist after broadcast (4e): "Add the N you don't have to
 * Wanted", and each row's state; rows without an artist say "Can't be
 * matched".
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import type { TracklistRow } from '@/features/radio/radio.types';

import { Button } from '@/components/form';
import { Notice, SkeletonList, StatusTag } from '@/components/primitives';
import { clockTime, heardTag, shortName } from '@/features/radio/radio.format';
import { useReactPageShell } from '@/platform/shell/route-controllers';

import { RADIO_KEY, tracklistQueryOptions, wantMissing, wantTrack } from '../-radio.api';
import styles from './radio.module.css';

const PAGE = 30;

function when(aired: number | null, ended: number | null): string {
  if (!aired) return '';
  const d = new Date(aired * 1000);
  const today = new Date().toDateString() === d.toDateString();
  const day = today
    ? 'Today'
    : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return ended ? `${day} ${clockTime(aired)}–${clockTime(ended)}` : `${day} ${clockTime(aired)}`;
}

function TrackRowView({
  row,
  busy,
  onWant,
}: {
  row: TracklistRow;
  busy: boolean;
  onWant: (row: TracklistRow) => void;
}) {
  const tag = heardTag({ state: row.state, below_target: row.below_target });
  return (
    <div className={`${styles.row} ${styles.trackRow}`} data-testid="track-row">
      <span className={styles.rowTime}>{clockTime(row.time) || `#${row.position}`}</span>
      <span
        className={styles.trackArt}
        data-quiet={row.state === 'cant_match' ? 'true' : undefined}
        aria-hidden="true"
      />
      <span className={styles.rowTrack}>
        <span className={styles.rowTitle}>{row.title || 'Untitled'}</span>
        <span className={styles.rowSub}>
          {row.artist ? (
            <>
              <span className={row.state === 'in_library' ? styles.artist : undefined}>
                {row.artist}
              </span>
              {row.release ? ` · ${row.release}` : ''}
            </>
          ) : (
            'Unknown artist · as listed by the station'
          )}
        </span>
      </span>
      <span className={styles.rowTag}>
        <StatusTag tone={tag.tone} live={row.state === 'on_wanted'}>
          {tag.label}
        </StatusTag>
      </span>
      <span className={styles.rowAction}>
        {row.state === 'cant_match' ? (
          'No artist to search for'
        ) : row.state === 'not_added' || (row.state === 'in_library' && row.below_target) ? (
          <Button size="lg" disabled={busy} focusableWhenDisabled onClick={() => onWant(row)}>
            {row.state === 'not_added'
              ? busy
                ? 'Adding…'
                : 'Add to Wanted'
              : 'Upgrade via Wanted'}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

export function TracklistPage({ showId }: { showId: string }) {
  useReactPageShell('radio');
  const queryClient = useQueryClient();
  const query = useQuery({ ...tracklistQueryOptions(showId), enabled: Boolean(showId) });
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const one = useMutation({
    mutationFn: (row: TracklistRow) => wantTrack(showId, row.position),
    onMutate: (row) => setBusy(row.position),
    onSuccess: (res, row) => {
      window.showToast?.(
        res.skipped
          ? res.message || `${row.title} is already in your library.`
          : `Added ${row.title} to Wanted.`,
        res.skipped ? 'info' : 'success',
      );
      void queryClient.invalidateQueries({ queryKey: [...RADIO_KEY, 'tracklist', showId] });
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
    onSettled: () => setBusy(null),
  });
  const add = useMutation({
    mutationFn: () => wantMissing(showId),
    onSuccess: (res) => {
      window.showToast?.(
        res.added
          ? `Added ${res.added} track${res.added === 1 ? '' : 's'} to Wanted.`
          : 'Nothing new to add: you have the rest or they’re on Wanted.',
        'success',
      );
      void queryClient.invalidateQueries({ queryKey: RADIO_KEY });
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
  });

  if (!showId) {
    return (
      <div className={styles.page}>
        <Notice tone="warning" title="No show was chosen">
          Open a show from “Shows with tracklists” on a station’s page.
        </Notice>
      </div>
    );
  }
  const data = query.data;
  const tracks = data?.tracks ?? [];
  const missing = tracks.filter((t) => t.state === 'not_added').length;
  const owned = tracks.filter((t) => t.state === 'in_library').length;
  const shown = all ? tracks : tracks.slice(0, PAGE);

  return (
    <div className={styles.page} data-testid="tracklist-page">
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/radio">Radio</Link>
        <span aria-hidden="true">›</span>
        {data ? (
          <Link to="/radio/station/$stationId" params={{ stationId: data.show.station_id }}>
            {data.show.station_name}
          </Link>
        ) : (
          <span>Station</span>
        )}
        <span aria-hidden="true">›</span>
        <span aria-current="page">Tracklist</span>
      </nav>
      {query.isPending ? (
        <SkeletonList rows={6} />
      ) : query.isError || !data ? (
        <Notice tone="danger" title="The tracklist couldn’t be read">
          {(query.error as Error | null)?.message ?? ''} The station may not have published it yet.
        </Notice>
      ) : (
        <>
          <header className={styles.headText}>
            <h1 className={styles.title}>{data.show.title}</h1>
            <p className={styles.subtitle}>
              {[
                data.show.station_name,
                when(data.show.aired_at, data.show.ended_at),
                `tracklist published by ${shortName(data.show.station_name)}`,
                `${tracks.length} tracks, ${owned} in your library`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </header>
          <div className={styles.headActions}>
            <Button
              size="lg"
              variant="primary"
              disabled={!missing || add.isPending}
              disabledReason={
                !missing
                  ? 'You have every track that can be matched, or it’s on Wanted.'
                  : undefined
              }
              onClick={() => add.mutate()}
            >
              {add.isPending ? 'Adding…' : `Add the ${missing} you don’t have to Wanted`}
            </Button>
            {data.show.homepage ? (
              <a
                className={styles.tab}
                href={data.show.homepage}
                target="_blank"
                rel="noopener noreferrer"
              >
                Listen again on {shortName(data.show.station_name)}
              </a>
            ) : null}
          </div>
          <section className={styles.panel} aria-label="Tracklist">
            <div className={styles.rows}>
              {shown.map((row) => (
                <TrackRowView
                  key={row.position}
                  row={row}
                  busy={busy === row.position}
                  onWant={(r) => one.mutate(r)}
                />
              ))}
            </div>
            <div className={styles.panelFoot}>
              <span>
                {shown.length} of {tracks.length}
                {tracks.length > PAGE && !all ? (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setAll(true)}
                    >
                      Show all {tracks.length}
                    </button>
                  </>
                ) : null}
              </span>
              <span>
                Library check uses the same match as Search; “Can’t be matched” rows have no artist
                in the station’s list
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
