import { useState } from 'react';

import { Button } from '@/components/form';

import type { GenreTile } from '../-library.types';

import styles from './library.module.css';
import { CheckMark, plural } from './parts';
import { Art } from './release-tile';

const FIRST = 12;

function tileLines(tile: GenreTile): [string, string] {
  const first = `${plural(tile.albums, 'album')} · ${tile.library.toLocaleString()} in your library`;
  if (!tile.missing && !tile.below) return [first, 'All of it in your library'];
  const second = [
    tile.missing ? `${tile.missing.toLocaleString()} you don't have` : '',
    tile.below ? `${tile.below.toLocaleString()} below quality target` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return [first, second];
}

/**
 * The Genres tab (7e): a 2×2 mosaic of the genre's most-played covers, the
 * name, what you have and what you don't. Hover gives the genre's bulk action
 * at the foot of the mosaic; the tile opens Albums with that chip picked.
 * Select picks genres for "Add N missing across 3 genres".
 */
export function GenresGrid({
  tiles,
  selecting,
  picked,
  onToggle,
  onOpen,
  onAdd,
}: {
  tiles: GenreTile[];
  selecting: boolean;
  picked: ReadonlyMap<string, number>;
  onToggle: (tile: GenreTile) => void;
  onOpen: (tile: GenreTile) => void;
  onAdd: (tile: GenreTile) => void;
}) {
  const [all, setAll] = useState(false);
  if (!tiles.length) {
    return (
      <div className={styles.empty}>
        <h2>No genres to show</h2>
        <p>
          Genres come from your files' tags and from the metadata services SYNCHRO.S matched your
          albums on.
        </p>
      </div>
    );
  }
  const shown = all ? tiles : tiles.slice(0, FIRST);
  return (
    <>
      <ul className={styles.grid} data-cols="4" aria-label="Genres">
        {shown.map((tile) => {
          const [line1, line2] = tileLines(tile);
          const covers = [0, 1, 2, 3].map((i) => tile.covers[i] ?? null);
          return (
            <li key={tile.key} className={styles.tile}>
              <div className={styles.art}>
                <a
                  href={`?view=albums&genre=${encodeURIComponent(tile.key)}`}
                  className={styles.mosaic}
                  aria-label={`Open ${tile.name}`}
                  tabIndex={selecting ? -1 : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    if (!selecting) onOpen(tile);
                  }}
                >
                  {covers.map((url, i) => (
                    <span key={i}>{url ? <Art url={url} /> : null}</span>
                  ))}
                </a>
                {!selecting && tile.wantable ? (
                  <div className={styles.overlay} data-place="foot">
                    <button
                      type="button"
                      className={styles.overlayButton}
                      onClick={() => onAdd(tile)}
                    >
                      Add {tile.wantable.toLocaleString()} missing to Wanted
                    </button>
                  </div>
                ) : null}
                {selecting ? (
                  <button
                    type="button"
                    className={styles.toggle}
                    aria-pressed={picked.has(tile.key)}
                    aria-label={`Select ${tile.name}`}
                    onClick={() => onToggle(tile)}
                  >
                    <span className={styles.check} aria-hidden="true">
                      <CheckMark />
                    </span>
                  </button>
                ) : null}
              </div>
              <div className={styles.text}>
                <h3 className={styles.genreTitle}>
                  <a
                    href={`?view=albums&genre=${encodeURIComponent(tile.key)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpen(tile);
                    }}
                  >
                    {tile.name}
                  </a>
                </h3>
                <p className={styles.metaPlain}>{line1}</p>
                <p className={styles.metaPlain}>{line2}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <div className={styles.footer}>
        <span>
          {shown.length.toLocaleString()} of {tiles.length.toLocaleString()}
        </span>
        {tiles.length > shown.length ? (
          <Button size="lg" variant="secondary" onClick={() => setAll(true)}>
            Show all {tiles.length.toLocaleString()}
          </Button>
        ) : null}
      </div>
    </>
  );
}
