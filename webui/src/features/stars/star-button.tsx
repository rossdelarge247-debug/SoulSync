/**
 * The star in React rows (Tracks, History, the Artist page, Search, Mixes
 * well with, playlists, a mix set). The same control the shell draws
 * (star-control.ts): the same attributes, stylesheet and store, so a star
 * changed anywhere shows everywhere.
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type MouseEvent } from 'react';

import { STAR_PATH, starAttributes, type StarVariant } from './star-control';
import { showsStar, starStore, type StarState } from './stars-store';

/** One track's star state, kept current; asks for it once if it isn't known. */
export function useStar(id: string | null | undefined): StarState | undefined {
  const store = starStore();
  const key = id ? String(id) : '';
  useEffect(() => {
    if (key) store.want([key]);
  }, [key, store]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(
    subscribe,
    () => (key ? store.get(key) : undefined),
    () => undefined,
  );
}

/** The Starred chip's count (24a), refreshed once when first shown. */
export function useStarCount(): number | null {
  const store = starStore();
  useEffect(() => {
    if (store.count() === null) void store.refreshCount();
  }, [store]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(
    subscribe,
    () => store.count(),
    () => null,
  );
}

export function StarButton({
  id,
  title,
  variant = 'row',
  className,
}: {
  id: string | null | undefined;
  title?: string;
  variant?: StarVariant;
  className?: string;
}) {
  const state = useStar(id);
  const attrs = starAttributes(state, title, variant);
  const shown = showsStar(state);
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (id && shown) void starStore().toggle(String(id), title);
  };
  return (
    <button
      type="button"
      className={['ss-star', className].filter(Boolean).join(' ')}
      data-star={attrs['data-star']}
      data-star-variant={attrs['data-star-variant']}
      aria-pressed={
        attrs['aria-pressed'] === undefined ? undefined : attrs['aria-pressed'] === 'true'
      }
      aria-label={attrs['aria-label']}
      aria-hidden={attrs['aria-hidden'] === 'true' ? true : undefined}
      title={attrs.title}
      tabIndex={shown ? undefined : -1}
      disabled={!shown}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={STAR_PATH} />
      </svg>
    </button>
  );
}

/** Prime the store from rows that already know (browse answers `starred`). */
export function primeStars(
  tracks: { id: string; starred?: boolean; file_missing?: boolean }[],
): void {
  const entries: Record<string, { starred: boolean; can_star: boolean }> = {};
  for (const t of tracks) {
    if (typeof t.starred !== 'boolean') continue;
    entries[t.id] = { starred: t.starred, can_star: !t.file_missing };
  }
  if (Object.keys(entries).length) starStore().prime(entries);
}

/**
 * A playlist's rows (title and artist, no library id) matched to your
 * library tracks once, for their stars: `{"title\u0000artist": id}`. Rows
 * with no match have no star.
 */
export function useSongStarIds(songs: { title: string; artist: string }[]): Record<string, string> {
  const key = songs.map((s) => `${s.title}\u0000${s.artist}`).join('\u0001');
  const [ids, setIds] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    const list = key ? key.split('\u0001').map((k) => k.split('\u0000')) : [];
    if (!list.length) {
      setIds({});
      return;
    }
    starStore()
      .resolveSongs(list.map(([title, artist]) => ({ title: title ?? '', artist: artist ?? '' })))
      .then((found) => {
        if (!live) return;
        const out: Record<string, string> = {};
        list.forEach(([title, artist], i) => {
          const id = found[i];
          if (id) out[`${title}\u0000${artist}`] = id;
        });
        setIds(out);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);
  return ids;
}
