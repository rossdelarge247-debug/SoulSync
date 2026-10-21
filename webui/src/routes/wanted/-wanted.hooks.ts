import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useRoutedArtists } from '@/features/audiobook-routes/audiobook-routes.queries';
import { useReactPageShell } from '@/platform/shell/route-controllers';

import type { WantedTab, WantedTrack } from './-wanted.types';

import { WATCHLIST_QUERY_KEY, watchlistScanStatusQueryOptions } from '../watchlist/-watchlist.api';
import { useLiveWatchlistScan, type WatchlistScanFrame } from '../watchlist/-watchlist.scan';
import { WISHLIST_QUERY_KEY, wishlistTracksQueryOptions } from '../wishlist/-wishlist.api';
import { buildWantedItems, parseWantedTrack, type WishlistApiTrack } from './-wanted.helpers';

/**
 * The page's chrome in the legacy shell. The shell's sidebar gets a Wanted row
 * from the navigation work (ux/shell-a); until it has one, the row for the tab
 * on show (Wishlist or Watchlist) stays lit so the sidebar still says where
 * you are.
 */
export function useWantedPageShell(tab: WantedTab) {
  const bridge = useReactPageShell('wanted');
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.querySelector('.nav-button[data-page="wanted"]')) return;
    const legacy = tab === 'followed' ? 'watchlist' : 'wishlist';
    const button = document.querySelector<HTMLElement>(`.nav-button[data-page="${legacy}"]`);
    if (!button) return;
    const light = () => {
      if (button.classList.contains('active')) return;
      button.classList.add('active');
      button.setAttribute('aria-current', 'page');
    };
    light();
    // the shell's own setActivePageChrome('wanted') runs again once its boot
    // finishes and clears every row; put this one back while we're mounted
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(light) : null;
    observer?.observe(button, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer?.disconnect();
      button.classList.remove('active');
      button.removeAttribute('aria-current');
    };
  }, [tab]);
  return bridge;
}

function tracksOf(payload: unknown): WishlistApiTrack[] {
  const tracks = (payload as { tracks?: unknown } | undefined)?.tracks;
  return Array.isArray(tracks) ? (tracks as WishlistApiTrack[]) : [];
}

/**
 * Everything on Wanted, as rows. Both wishlist categories load (the same two
 * queries, and cache, the old Wishlist page used). Artists filed as audiobooks
 * are wanted through the music search but belong with the audiobooks, so they
 * are left out of the music rows and kept for the Audiobooks view.
 */
export function useWantedData(profileId: number, enabled = true) {
  const albums = useQuery({ ...wishlistTracksQueryOptions(profileId, 'albums'), enabled });
  const singles = useQuery({ ...wishlistTracksQueryOptions(profileId, 'singles'), enabled });

  const tracks = useMemo(
    () =>
      [...tracksOf(albums.data), ...tracksOf(singles.data)]
        .map(parseWantedTrack)
        .filter((track): track is WantedTrack => track !== null),
    [albums.data, singles.data],
  );
  const routed = useRoutedArtists(tracks.map((track) => track.artist));
  const routedKey = [...routed].sort().join('\u0000');
  const music = useMemo(
    () => tracks.filter((track) => !routed.has(track.artist)),
    // routed is a fresh Set every render; its contents are what matter
    [tracks, routedKey],
  );
  const items = useMemo(() => buildWantedItems(music), [music]);

  const refetch = useCallback(
    () => Promise.all([albums.refetch(), singles.refetch()]),
    [albums, singles],
  );

  return {
    items,
    routedArtists: routed,
    isPending: albums.isPending || singles.isPending,
    isError: albums.isError || singles.isError,
    error: albums.error ?? singles.error,
    isFetching: albums.isFetching || singles.isFetching,
    refetch,
  };
}

/** Take tracks off both wishlist caches at once, before the server answers. */
export function useDropFromWantedCache(profileId: number) {
  const queryClient = useQueryClient();
  return useCallback(
    (ids: string[]) => {
      const gone = new Set(ids);
      for (const category of ['albums', 'singles'] as const) {
        queryClient.setQueryData(wishlistTracksQueryOptions(profileId, category).queryKey, (old) =>
          old
            ? {
                ...old,
                tracks: (old.tracks ?? []).filter(
                  (row) => !gone.has(String(row.spotify_track_id || row.id || '')),
                ),
              }
            : old,
        );
      }
    },
    [profileId, queryClient],
  );
}

export function useRefreshWanted() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY }),
    [queryClient],
  );
}

/**
 * The followed-artist check as it runs: socket frames first (core.js
 * re-broadcasts them), the status route when the socket is quiet. A check
 * that finishes refreshes the watchlist and the wishlist it added to.
 */
export function useFollowedScan(profileId: number) {
  const queryClient = useQueryClient();
  const [poll, setPoll] = useState(false);
  const status = useQuery({
    ...watchlistScanStatusQueryOptions(profileId),
    refetchInterval: poll ? 2000 : false,
  });
  const { frame, needsPolling } = useLiveWatchlistScan();
  const scan: WatchlistScanFrame | undefined = frame ?? status.data;
  const scanning = scan?.status === 'scanning';

  useEffect(() => {
    setPoll(scanning && needsPolling);
  }, [scanning, needsPolling]);

  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    const now = scan?.status;
    if (previous.current === 'scanning' && now && now !== 'scanning') {
      void queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY });
      try {
        window.updateWatchlistButtonCount?.();
      } catch {
        /* the nav badge is the shell's */
      }
    }
    previous.current = now;
  }, [scan?.status, queryClient]);

  return { scan, scanning };
}

/** Date.now(), refreshed every `intervalMs`, so "3 minutes ago" keeps up. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Seconds left until a server-given run time, counting down locally. */
export function useCountdownFrom(seconds: number | undefined): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds || seconds <= 0) return;
    const id = window.setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [seconds]);
  return left;
}
