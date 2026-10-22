import { useState } from 'react';

import { Button } from '@/components/form';
import { StatusTag } from '@/components/primitives';

import type { ArtistRelease, CardState } from '../-artist.helpers';

import { gapSourceLabel } from '../-artist-detail.gap-fill';
import { canAddToWanted, cardTag, releaseMeta } from '../-artist.helpers';
import { ArtistMenu, type MenuEntry } from './artist-menu';
import styles from './artist-page.module.css';

export interface ReleaseCardActions {
  /** The tracklist, with download and add-to-Wanted per track (the old card click). */
  onOpen: (release: ArtistRelease) => void;
  onPlay: (release: ArtistRelease) => void;
  onAdd: (release: ArtistRelease) => void;
  /** Library artists: the release's tracks on the Tracks tab. */
  onShowInLibrary?: (release: ArtistRelease) => void;
}

function Art({ src, empty }: { src: string; empty: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className={styles.cardArt} data-empty={empty ? 'true' : undefined} aria-hidden="true" />
    );
  }
  return (
    <img
      className={styles.cardArt}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** Why following would skip a missing release, in words (#1550). */
function excludedNote(reason: string): string {
  const what: Record<string, string> = {
    live: 'live releases',
    remix: 'remixes',
    acoustic: 'acoustic releases',
    compilation: 'compilations',
    instrumental: 'instrumentals',
    single: 'singles',
    ep: 'EPs',
    album: 'albums',
  };
  return `Following skips ${what[reason] ?? `${reason} releases`}.`;
}

/**
 * One release: square art, the title (opens its tracks), "2026 · Album · 12
 * tracks · FLAC", and its state in Wanted's words: In your library, Below
 * quality target, a partly complete album with its progress, Wanted ·
 * Searching / not found yet, or Add to Wanted on the quiet card.
 */
export function ArtistReleaseCard({
  release,
  state,
  following,
  adding,
  actions,
}: {
  release: ArtistRelease;
  state: CardState;
  following: boolean;
  /** An add for it is in flight (the card already reads as wanted). */
  adding: boolean;
  actions: ReleaseCardActions;
}) {
  const tag = cardTag(state);
  const shortTag = cardTag(state, true);
  const quiet = state.kind === 'missing';
  const owned = state.kind === 'owned' || state.kind === 'partial';
  const addable = canAddToWanted(state) && !adding;

  const menu: MenuEntry[] = [
    {
      key: 'open',
      label: owned ? 'Tracks…' : 'Tracks and download…',
      onSelect: () => actions.onOpen(release),
    },
    ...(owned
      ? [
          {
            key: 'play',
            label: 'Play',
            onSelect: () => actions.onPlay(release),
          } satisfies MenuEntry,
        ]
      : []),
    ...(owned && actions.onShowInLibrary
      ? [
          {
            key: 'library',
            label: 'Show in your library',
            onSelect: () => actions.onShowInLibrary?.(release),
          } satisfies MenuEntry,
        ]
      : []),
    ...(addable
      ? [
          {
            key: 'add',
            label: 'Add to Wanted',
            onSelect: () => actions.onAdd(release),
          } satisfies MenuEntry,
        ]
      : []),
    ...(release.musicbrainzUrl
      ? [
          {
            key: 'mb',
            label: 'Open on MusicBrainz',
            onSelect: () => window.open(release.musicbrainzUrl ?? '', '_blank', 'noopener'),
          } satisfies MenuEntry,
        ]
      : []),
  ];

  const percent =
    state.kind === 'partial' && state.total > 0
      ? Math.max(4, Math.min(100, Math.round((state.owned / state.total) * 100)))
      : 0;

  return (
    <article
      className={styles.card}
      data-quiet={quiet ? 'true' : undefined}
      data-state={state.kind}
      // gap-fill (#1067): listed only by another source; its tracks open from there
      data-gap-source={release.gapSource ?? undefined}
      aria-label={release.title}
    >
      <Art src={release.image} empty={quiet} />
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>
          <button
            type="button"
            className={styles.titleButton}
            onClick={() => actions.onOpen(release)}
          >
            {release.title}
          </button>
        </h3>
        <ArtistMenu
          label={`More for ${release.title}`}
          entries={menu}
          variant="bare"
          className={styles.cardMenu}
        />
        <p className={styles.cardMeta}>
          <span className={styles.cardMetaLong}>{releaseMeta(release, state)}</span>
          <span className={styles.cardMetaShort} aria-hidden="true">
            {releaseMeta(release, state, true)}
          </span>
        </p>
        {release.gapSource ? (
          <p className={styles.cardNote}>Listed by {gapSourceLabel(release.gapSource)} only</p>
        ) : null}
        {following && quiet && release.watchlistExcluded ? (
          <p className={styles.cardNote}>{excludedNote(release.watchlistExcluded)}</p>
        ) : null}
      </div>
      {state.kind === 'partial' ? (
        <div
          className={styles.progress}
          role="progressbar"
          aria-label={`${release.title}: ${state.owned} of ${state.total} tracks in your library`}
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={state.owned}
        >
          <div className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <div className={styles.cardFoot}>
        {tag && shortTag ? (
          <StatusTag tone={tag.tone} live={state.kind === 'checking'}>
            {tag.text === shortTag.text ? (
              tag.text
            ) : (
              <>
                <span className={styles.cardTagLong}>{tag.text}</span>
                <span className={styles.cardTagShort} aria-hidden="true">
                  {shortTag.text}
                </span>
              </>
            )}
          </StatusTag>
        ) : null}
        {addable ? (
          <Button size="lg" className={styles.addButton} onClick={() => actions.onAdd(release)}>
            Add to Wanted
          </Button>
        ) : null}
      </div>
    </article>
  );
}
