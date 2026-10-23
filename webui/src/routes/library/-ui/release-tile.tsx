import { useState } from 'react';

import { StatusTag } from '@/components/primitives';
import { thumb } from '@/platform/artwork-thumb';

import type { LibraryRelease } from '../-library.types';

import { releaseHref, releaseMeta, releaseTag } from '../-library.grid';
import styles from './library.module.css';
import { CheckMark, PlayIcon } from './parts';

/** Art inside a square; nothing (the placeholder wash) when there's none or it fails. */
export function Art({ url, alt = '' }: { url: string | null | undefined; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    <img
      src={thumb(url, 'grid')}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * One album on the flat grid (7a): a square, the title, one meta line and a
 * tag only when the state isn't "you have it". An album you don't have (and
 * that isn't on Wanted) is an empty dashed square. Hover or focus inside shows
 * its one action: Play for yours, Add to Wanted for one you don't have.
 * In selection mode (7c) the whole square is a toggle button with a checkbox.
 */
export function ReleaseTile({
  release,
  selecting,
  checked,
  onToggle,
  onPlay,
  onAdd,
  playPending = false,
  addPending = false,
}: {
  release: LibraryRelease;
  selecting: boolean;
  checked: boolean;
  onToggle: () => void;
  onPlay: () => void;
  onAdd: () => void;
  playPending?: boolean;
  addPending?: boolean;
}) {
  const href = releaseHref(release);
  const tag = releaseTag(release);
  const dashed = release.kind === 'missing' && !release.wanted;
  const square = (
    <span className={styles.square} data-missing={dashed ? 'true' : undefined}>
      {dashed ? null : <Art url={release.art_url} />}
    </span>
  );
  let action = null;
  if (!selecting) {
    if (release.kind === 'library') {
      action = (
        <div className={styles.overlay} data-place="corner">
          <button
            type="button"
            className={styles.play}
            aria-label={`Play ${release.title}`}
            aria-busy={playPending || undefined}
            onClick={onPlay}
          >
            <PlayIcon />
          </button>
        </div>
      );
    } else if (!release.wanted) {
      action = (
        <div className={styles.overlay}>
          <button
            type="button"
            className={styles.overlayButton}
            aria-label={`Add ${release.title} to Wanted`}
            aria-busy={addPending || undefined}
            onClick={onAdd}
          >
            {addPending ? 'Adding…' : 'Add to Wanted'}
          </button>
        </div>
      );
    }
  }
  return (
    <li className={styles.tile} data-release={release.id}>
      <div className={styles.art}>
        {href && !selecting ? (
          <a
            href={href}
            className={styles.squareLink}
            aria-label={`Open ${release.title}`}
            tabIndex={-1}
          >
            {square}
          </a>
        ) : (
          square
        )}
        {action}
        {selecting ? (
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={checked}
            aria-label={`Select ${release.title}`}
            onClick={onToggle}
          >
            <span className={styles.check} aria-hidden="true">
              <CheckMark />
            </span>
          </button>
        ) : null}
      </div>
      <div className={styles.text}>
        <h3 className={styles.tileTitle}>
          {href && !selecting ? <a href={href}>{release.title}</a> : release.title}
        </h3>
        <p className={styles.meta}>{releaseMeta(release)}</p>
      </div>
      {tag ? (
        <StatusTag className={styles.tag} tone={tag.tone}>
          {tag.label}
        </StatusTag>
      ) : null}
    </li>
  );
}
