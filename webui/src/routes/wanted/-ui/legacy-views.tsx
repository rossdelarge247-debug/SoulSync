import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { clearAudiobookWishlist } from '@/routes/audiobooks/-audiobooks.api';

import type {
  ParsedWishlistTrack,
  WishlistAlbumGroup,
  WishlistArtistGroup,
  WishlistBulkAction,
} from '../../wishlist/-wishlist.types';

import { WatchlistAudiobooksTab } from '../../watchlist/-ui/watchlist-audiobooks-tab';
import { WatchlistLabelsTab } from '../../watchlist/-ui/watchlist-labels-tab';
import { WatchlistPodcastsTab } from '../../watchlist/-ui/watchlist-podcasts-tab';
import { WishlistAudiobooks } from '../../wishlist/-ui/wishlist-audiobooks';
import { WishlistList } from '../../wishlist/-ui/wishlist-list';
import { WishlistOrb } from '../../wishlist/-ui/wishlist-orb';
import {
  bulkWishlistActionChunked,
  removeWishlistAlbum,
  removeWishlistTrack,
  wishlistArtistPhotosQueryOptions,
  wishlistTracksQueryOptions,
} from '../../wishlist/-wishlist.api';
import {
  buildArtistImageMap,
  filterWishlistGroups,
  groupWishlistArtists,
  parseWishlistTrack,
  trackCountLabel,
} from '../../wishlist/-wishlist.helpers';

/*
 * The views the Wanted and Followed artists boards don't draw, kept so nothing
 * the Wishlist and Watchlist pages did is lost: the artist nebula, the
 * audiobook wishlist, and followed labels, podcasts and audiobook authors.
 * They are today's components as they are, reached from the page's "…" menu
 * (see HANDOFF.md, "Dev, Wanted page").
 */

function groupIds(group: WishlistArtistGroup): string[] {
  return [...group.albums.flatMap((album) => album.tracks), ...group.singles].map((t) => t.id);
}

/** Both wishlist categories as the old pages' artist groups. */
function useArtistGroups(profileId: number) {
  const albums = useQuery(wishlistTracksQueryOptions(profileId, 'albums'));
  const singles = useQuery(wishlistTracksQueryOptions(profileId, 'singles'));
  const photos = useQuery(wishlistArtistPhotosQueryOptions(profileId));
  const groups = useMemo(() => {
    const parse = (rows: unknown[] | undefined, type: 'album' | 'single') =>
      (rows ?? [])
        .map((row) => parseWishlistTrack(row as never, type))
        .filter((t): t is ParsedWishlistTrack => t !== null);
    return groupWishlistArtists(
      parse(albums.data?.tracks, 'album'),
      parse(singles.data?.tracks, 'single'),
    );
  }, [albums.data?.tracks, singles.data?.tracks]);
  const artistImages = useMemo(
    () => buildArtistImageMap([albums.data ?? {}, singles.data ?? {}], photos.data ?? []),
    [albums.data, singles.data, photos.data],
  );
  return { groups, artistImages };
}

/** The actions the nebula and the old list share, as the old page wired them. */
function useGroupActions(onChanged: () => void) {
  const bulk = useMutation({
    mutationFn: ({ action, ids }: { action: WishlistBulkAction; ids: string[] }) =>
      bulkWishlistActionChunked(action, ids),
    onSuccess: (response, { action, ids }) => {
      const ok = (response.results ?? []).filter((r) => r.ok).length;
      const verb = action === 'grab' ? 'Searching for' : action === 'skip' ? 'Removed' : 'Reset';
      window.showToast?.(
        `${verb} ${ok} of ${trackCountLabel(ids.length)}`,
        ok === ids.length ? 'success' : 'warning',
      );
      onChanged();
    },
    onError: (error: Error) => window.showToast?.(`That didn't work: ${error.message}`, 'error'),
  });

  const removeTrack = async (trackId: string) => {
    try {
      await removeWishlistTrack(trackId);
      window.showToast?.('Removed from Wanted', 'success');
    } catch (error) {
      window.showToast?.(`Couldn't remove it: ${(error as Error).message}`, 'error');
    }
    onChanged();
  };

  const removeAlbum = async (albumName: string) => {
    const confirmed = await window.showConfirmDialog?.({
      title: 'Remove album',
      message: `Remove every track of “${albumName}” from Wanted?`,
      confirmText: 'Remove',
      destructive: true,
    });
    if (confirmed === false) return;
    try {
      await removeWishlistAlbum(albumName);
      window.showToast?.(`Removed “${albumName}”`, 'success');
    } catch (error) {
      window.showToast?.(`Couldn't remove it: ${(error as Error).message}`, 'error');
    }
    onChanged();
  };

  return { bulk, removeTrack, removeAlbum };
}

/** The orbital artist view the old Wishlist page opened on. */
/** The old Wishlist's three nebula orders. */
export type NebulaSort = 'busiest' | 'name' | 'failing';

export function NebulaView({
  profileId,
  routedArtists,
  query,
  notFoundOnly,
  sort,
  processing,
  cycle,
  onChanged,
}: {
  profileId: number;
  routedArtists: Set<string>;
  query: string;
  notFoundOnly: boolean;
  sort: NebulaSort;
  processing: boolean;
  cycle: string;
  onChanged: () => void;
}) {
  const { groups, artistImages } = useArtistGroups(profileId);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { bulk, removeTrack, removeAlbum } = useGroupActions(onChanged);
  const visible = useMemo(() => {
    // groups arrive busiest first
    const list = filterWishlistGroups(
      groups.filter((group) => !routedArtists.has(group.name)),
      query,
      notFoundOnly,
    );
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'failing')
      list.sort(
        (a, b) =>
          b.failingCount - a.failingCount || b.total - a.total || a.name.localeCompare(b.name),
      );
    return list;
  }, [groups, routedArtists, query, notFoundOnly, sort]);

  const removeArtist = async (group: WishlistArtistGroup) => {
    const confirmed = await window.showConfirmDialog?.({
      title: 'Remove artist',
      message: `Remove ${trackCountLabel(group.total)} by “${group.name}” from Wanted?`,
      confirmText: 'Remove',
      destructive: true,
    });
    if (confirmed === false) return;
    bulk.mutate({ action: 'skip', ids: groupIds(group) });
  };

  return (
    <div className="wl-nebula">
      <div className={`wl-nebula-field${processing ? ' nebula-processing' : ''}`}>
        {visible.length === 0 ? (
          <div className="wl-nebula-empty">Nothing matches. Clear the filter to see everyone.</div>
        ) : (
          visible.map((group, index) => (
            <WishlistOrb
              key={group.name}
              group={group}
              index={index}
              artistImages={artistImages}
              currentCycle={cycle}
              processing={processing}
              expanded={expanded === group.name}
              onToggleExpand={() =>
                setExpanded((current) => (current === group.name ? null : group.name))
              }
              onRemoveAlbum={(albumName) => void removeAlbum(albumName)}
              onRemoveTrack={(trackId) => void removeTrack(trackId)}
              onGrabArtist={() => bulk.mutate({ action: 'grab', ids: groupIds(group) })}
              onGrabAlbum={(album: WishlistAlbumGroup) =>
                bulk.mutate({ action: 'grab', ids: album.tracks.map((t) => t.id) })
              }
              onRemoveArtist={() => void removeArtist(group)}
              actionBusy={bulk.isPending}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The audiobook wishlist (the old Wishlist → Audiobooks tab), plus the audio
 * plays wanted through the music search but filed as audiobooks.
 */
export function AudiobooksView({
  profileId,
  routedArtists,
  onChanged,
}: {
  profileId: number;
  routedArtists: Set<string>;
  onChanged: () => void;
}) {
  const { groups, artistImages } = useArtistGroups(profileId);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const { bulk, removeTrack, removeAlbum } = useGroupActions(onChanged);
  const routed = useMemo(
    () => groups.filter((group) => routedArtists.has(group.name)),
    [groups, routedArtists],
  );
  const visibleRouted = useMemo(() => filterWishlistGroups(routed, query, false), [routed, query]);

  const clearAll = async () => {
    const confirmed = await window.showConfirmDialog?.({
      title: 'Clear the audiobook wishlist',
      message: 'Remove every audiobook from Wanted? This can’t be undone.',
      confirmText: 'Clear all',
      destructive: true,
    });
    if (confirmed === false) return;
    if (await clearAudiobookWishlist()) {
      window.showToast?.('Audiobook wishlist cleared', 'success');
      setReloadKey((key) => key + 1);
    } else {
      window.showToast?.("Couldn't clear the audiobook wishlist", 'error');
    }
  };

  const searchRouted = async (): Promise<string> => {
    const ids = routed.flatMap(groupIds);
    if (ids.length === 0) return '';
    try {
      const response = await bulk.mutateAsync({ action: 'grab', ids });
      const sent = (response.results ?? []).filter((r) => r.ok).length;
      return `Sent ${sent} of ${trackCountLabel(ids.length)} from the music search to downloads.`;
    } catch {
      return 'Could not send the audio plays to downloads.';
    }
  };

  return (
    <div>
      <WishlistAudiobooks
        key={reloadKey}
        onClearAll={() => void clearAll()}
        onSearchAlso={searchRouted}
        onQueryChange={setQuery}
      />
      {routed.length > 0 && (visibleRouted.length > 0 || !query.trim()) ? (
        <section className="wlp-routed" aria-label="Music releases filed as audiobooks">
          <h2 className="wlp-routed-title">Audio plays from the music search</h2>
          <p className="wlp-routed-note">
            Wanted through the music search, but filed in your audiobook library because the artist
            is set to <strong>Treat as audiobook</strong>.
          </p>
          <WishlistList
            groups={visibleRouted}
            artistImages={artistImages}
            filterActive={Boolean(query.trim())}
            onRemoveAlbum={(albumName) => void removeAlbum(albumName)}
            onRemoveTrack={(trackId) => void removeTrack(trackId)}
            onGrabArtist={(group) => bulk.mutate({ action: 'grab', ids: groupIds(group) })}
            onBulkAction={(action, ids) => bulk.mutateAsync({ action, ids })}
            bulkBusy={bulk.isPending}
          />
        </section>
      ) : null}
    </div>
  );
}

/** Followed labels, podcasts and audiobook authors (the old Watchlist tabs). */
export function FollowedListView({
  list,
  profileId,
  query,
}: {
  list: 'labels' | 'podcasts' | 'audiobooks';
  profileId: number;
  query: string;
}) {
  if (list === 'labels') return <WatchlistLabelsTab profileId={profileId} />;
  if (list === 'podcasts')
    return <WatchlistPodcastsTab profileId={profileId} searchFilter={query} />;
  return <WatchlistAudiobooksTab searchFilter={query} />;
}
