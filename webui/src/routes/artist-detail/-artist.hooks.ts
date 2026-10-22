import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { profileAsksFirst } from '@/platform/shell/download-rights';

import type { ArtistRelease } from './-artist.helpers';

import {
  addWatchlistArtist,
  removeWatchlistArtist,
  WATCHLIST_QUERY_KEY,
} from '../watchlist/-watchlist.api';
import { WISHLIST_QUERY_KEY } from '../wishlist/-wishlist.api';
import { buildDiscographyPayload } from './-artist-detail.discography-modal';
import { followCheckQueryOptions } from './-artist.api';
import { addOutcome, type AddUpdate, plural, text } from './-artist.helpers';

function toast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') {
  window.showToast?.(message, type);
}

function nudgeShellCounts() {
  try {
    window.updateWatchlistButtonCount?.();
    window.updateWatchlistCount?.();
  } catch {
    /* the nav badge belongs to the shell */
  }
}

/** True on a phone-width viewport (the boards' 390 layout). */
export function usePhone(query = '(max-width: 640px)'): boolean {
  const read = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  const [phone, setPhone] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = () => setPhone(list.matches);
    onChange();
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  return phone;
}

export interface FollowIdentity {
  id: string;
  name: string;
  source?: string;
}

/**
 * Follow / Following, optimistic: the button flips at once and flips back
 * (with a message) if the server says no. Unfollow is only ever called after
 * the page has asked.
 */
export function useFollow(
  profileId: number,
  identity: FollowIdentity | null,
  /** The followed row's own id, which unfollow removes by when known. */
  followedId: string | null,
) {
  const queryClient = useQueryClient();
  const check = useQuery(followCheckQueryOptions(profileId, identity?.id ?? null));
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const checkKey = followCheckQueryOptions(profileId, identity?.id ?? null).queryKey;

  const settle = async (value: boolean) => {
    queryClient.setQueryData(checkKey, value);
    nudgeShellCounts();
    await queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY });
  };

  const follow = useMutation({
    mutationFn: () => {
      if (!identity) throw new Error('This artist has no id SYNCHRO.S can follow.');
      return addWatchlistArtist({
        artistId: identity.id,
        artistName: identity.name,
        source: identity.source,
      });
    },
    onMutate: () => setOptimistic(true),
    onSuccess: async () => {
      await settle(true);
      toast(`Following ${identity?.name}. New releases are added to Wanted as they come out.`);
    },
    onError: (error: Error) =>
      toast(`Couldn't follow ${identity?.name ?? 'this artist'}: ${error.message}`, 'error'),
    onSettled: () => setOptimistic(null),
  });

  const unfollow = useMutation({
    mutationFn: () => {
      const id = followedId || identity?.id;
      if (!id) throw new Error('This artist has no id SYNCHRO.S can unfollow.');
      return removeWatchlistArtist(id);
    },
    onMutate: () => setOptimistic(false),
    onSuccess: async () => {
      await settle(false);
      toast(`Unfollowed ${identity?.name}.`);
    },
    onError: (error: Error) =>
      toast(`Couldn't unfollow ${identity?.name ?? 'this artist'}: ${error.message}`, 'error'),
    onSettled: () => setOptimistic(null),
  });

  return {
    following: optimistic ?? check.data ?? false,
    /** The server hasn't said yet (or couldn't). */
    unknown: optimistic === null && check.data === undefined,
    busy: follow.isPending || unfollow.isPending,
    follow: () => follow.mutate(),
    unfollow: () => unfollow.mutate(),
  };
}

/**
 * POST /api/artist/<id>/download-discography and read its NDJSON: one line
 * per release, then the completion line. A refusal (non-2xx) throws with the
 * server's own sentence.
 */
async function streamAdd(
  artistId: string,
  payload: unknown,
  onLine: (line: Record<string, unknown>) => void,
): Promise<void> {
  const response = await fetch(`/api/artist/${encodeURIComponent(artistId)}/download-discography`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(text(data.error) || `SYNCHRO.S answered ${response.status}`);
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (lines: string[]) => {
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* a broken line is skipped; the completion line says how it went */
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    flush(lines);
  }
  flush([buffer + decoder.decode()]);
}

/** The old page's per-section types the add endpoint files a release under. */
function entryOf(release: ArtistRelease) {
  return {
    id: release.id,
    name: release.title,
    tracks: release.trackCount ?? 0,
    gapSource: release.gapSource,
    albumType: release.kind,
  };
}

/**
 * Add to Wanted, through the endpoint the old Download Discography used
 * (POST /api/artist/<id>/download-discography): it adds the tracks you don't
 * have, skipping what's in your library or already on Wanted. Optimistic: the
 * cards read "Wanted · Searching" straight away and go back, with the reason,
 * for any release that ends up with nothing on Wanted.
 */
export function useAddToWanted(artist: { id: string | null; name: string; source: string | null }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  // a new artist starts with nothing in flight
  useEffect(() => {
    setPending(new Set());
    setBusy(false);
  }, [artist.id]);

  const mark = useCallback((keys: string[], on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, []);

  const add = useCallback(
    async (releases: ArtistRelease[]) => {
      if (!artist.id || releases.length === 0) return;
      const asksFirst = profileAsksFirst();
      if (asksFirst && window.checkMusicRequestQuota && !(await window.checkMusicRequestQuota()))
        return;
      const keys = releases.map((r) => r.key);
      mark(keys, true);
      setBusy(true);
      const outcomes = new Map<string, { ok: boolean; reason: string }>();
      let serverError = '';
      let completed = false;
      let added = 0;
      try {
        await streamAdd(
          artist.id,
          buildDiscographyPayload(releases.map(entryOf), {
            id: artist.id,
            name: artist.name,
            source: artist.source,
          }),
          (line) => {
            if (line.status === 'complete') {
              completed = true;
              return;
            }
            const u = line as AddUpdate & { error?: unknown };
            if (u.album_id === undefined || u.album_id === null) {
              if (u.error) serverError = text(u.error);
              return;
            }
            outcomes.set(text(u.album_id), addOutcome(u));
            added += Number(u.tracks_added) || 0;
          },
        );
      } catch (error) {
        serverError = (error as Error).message || 'SYNCHRO.S didn’t answer';
      }

      if (!completed) {
        mark(keys, false);
        setBusy(false);
        const what = releases.length === 1 ? releases[0].title : plural(releases.length, 'release');
        toast(
          `Couldn't add ${what} to Wanted: ${serverError || 'the request stopped part way'}. Nothing you already have changed.`,
          'error',
        );
        return;
      }

      const failed = releases.filter((r) => !outcomes.get(r.id)?.ok);
      const worked = releases.filter((r) => outcomes.get(r.id)?.ok);
      mark(
        failed.map((r) => r.key),
        false,
      );
      // keep the rest showing as wanted until the Wanted list itself has them
      await queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY });
      mark(
        worked.map((r) => r.key),
        false,
      );
      setBusy(false);

      if (worked.length > 0 && !(asksFirst && window.announceWishlistRequest?.())) {
        toast(
          worked.length === 1
            ? `Added ${worked[0].title} to Wanted. SYNCHRO.S searches for it on the next scheduled search.`
            : `Added ${plural(worked.length, 'release')} to Wanted (${plural(added, 'track')}).`,
        );
      }
      if (failed.length === 1) {
        toast(
          `${failed[0].title} wasn't added: ${outcomes.get(failed[0].id)?.reason || 'it couldn’t be looked up'}.`,
          'warning',
        );
      } else if (failed.length > 1) {
        toast(
          `${plural(failed.length, 'release')} weren't added (${failed
            .slice(0, 3)
            .map((r) => r.title)
            .join(', ')}${failed.length > 3 ? '…' : ''}). Open one to see why.`,
          'warning',
        );
      }
    },
    [artist.id, artist.name, artist.source, mark, queryClient],
  );

  return useMemo(() => ({ pending, busy, add }), [pending, busy, add]);
}
