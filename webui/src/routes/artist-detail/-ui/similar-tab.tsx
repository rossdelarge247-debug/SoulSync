import type { UseQueryResult } from '@tanstack/react-query';

import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { Button } from '@/components/form';
import { EmptyState, LoadingState, Notice, Skeleton } from '@/components/primitives';

import type { SimilarArtist, SimilarArtistsResponse } from '../-artist.api';

import styles from './artist-page.module.css';

function Avatar({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className={styles.avatar} aria-hidden="true" />;
  return (
    <img
      className={styles.avatar}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function SimilarCard({ artist }: { artist: SimilarArtist }) {
  const id = artist.id == null ? '' : String(artist.id).trim();
  const genres = (artist.genres ?? []).slice(0, 2).join(', ');
  const body = (
    <>
      <Avatar src={artist.image_url ?? ''} />
      <span className={styles.similarName}>{artist.name}</span>
      {genres ? <span className={styles.similarMeta}>{genres}</span> : null}
    </>
  );
  // no id on any of your sources: shown, but there is no page to open
  if (!id) return <div className={styles.similarCard}>{body}</div>;
  return (
    <Link
      className={styles.similarCard}
      to="/artist-detail/$source/$id"
      params={{ source: (artist.source || 'library').toLowerCase(), id }}
      search={{ name: artist.name }}
    >
      {body}
    </Link>
  );
}

/** Similar artists (MusicMap), each opening its own artist page. */
export function SimilarTab({
  artistName,
  query,
}: {
  artistName: string;
  query: UseQueryResult<SimilarArtistsResponse>;
}) {
  const artists = query.data?.similar_artists ?? [];
  if (query.isPending) {
    return (
      <LoadingState label={`Finding artists like ${artistName}…`}>
        <ul className={styles.similarGrid} aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className={styles.similarCard}>
              <Skeleton className={styles.avatar} />
              <Skeleton className={styles.skeletonLine} />
            </li>
          ))}
        </ul>
      </LoadingState>
    );
  }
  if (query.isError || query.data?.success === false) {
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't find similar artists"
        actions={
          <Button size="lg" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        MusicMap or your metadata sources didn&apos;t answer. Nothing else on this page is affected.
      </Notice>
    );
  }
  if (artists.length === 0) {
    return (
      <EmptyState
        variant="panel"
        title={`No similar artists found for ${artistName}`}
        description="MusicMap doesn't list anyone close to them, or none of its suggestions matched your metadata sources."
      />
    );
  }
  return (
    <ul className={styles.similarGrid} aria-label={`Artists similar to ${artistName}`}>
      {artists.map((artist, index) => (
        <li key={`${artist.id ?? ''}-${artist.name}-${index}`}>
          <SimilarCard artist={artist} />
        </li>
      ))}
    </ul>
  );
}
