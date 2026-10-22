import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, Select, TextInput } from '@/components/form';
import { StatusTag } from '@/components/primitives';

import type { ProviderSearchResult } from '../../watchlist/-watchlist.types';

import {
  addWatchlistArtist,
  searchProviderArtists,
  WATCHLIST_QUERY_KEY,
} from '../../watchlist/-watchlist.api';
import styles from './wanted-page.module.css';

/** The providers the old Watchlist "Add Artist" panel searched, in its order. */
export const FOLLOW_PROVIDERS = [
  { value: 'deezer', label: 'Deezer' },
  { value: 'spotify', label: 'Spotify' },
  { value: 'itunes', label: 'Apple Music' },
  { value: 'discogs', label: 'Discogs' },
  { value: 'musicbrainz', label: 'MusicBrainz' },
] as const;

type Provider = (typeof FOLLOW_PROVIDERS)[number]['value'];

function providerLabel(value: string): string {
  return FOLLOW_PROVIDERS.find((p) => p.value === value)?.label ?? value;
}

/**
 * Follow an artist without leaving the page: pick where to look, type a name,
 * follow from the results. The same provider search and add the old Watchlist
 * panel used (POST /api/library/search-service, POST /api/watchlist/add).
 */
export function FollowArtistDialog({
  open,
  profileId,
  followedNames,
  onClose,
}: {
  open: boolean;
  profileId: number;
  /** Lower-cased names already followed, so a result can say so. */
  followedNames: Set<string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const providerId = useId();
  const [provider, setProvider] = useState<Provider>('deezer');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [added, setAdded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const next = query.trim();
    if (next.length < 2) {
      setDebounced('');
      return;
    }
    const timer = window.setTimeout(() => setDebounced(next), 320);
    return () => window.clearTimeout(timer);
  }, [query, provider]);

  const results = useQuery({
    queryKey: [...WATCHLIST_QUERY_KEY, 'artist-search', profileId, provider, debounced] as const,
    queryFn: () => searchProviderArtists(provider, debounced),
    enabled: open && debounced.length >= 2,
  });

  const follow = useMutation({
    mutationFn: (result: ProviderSearchResult) =>
      addWatchlistArtist({ artistId: result.id, artistName: result.name, source: provider }),
    onSuccess: async (_ignored, result) => {
      setAdded((prev) => new Set(prev).add(`${provider}:${result.id}`));
      window.showToast?.(`Following ${result.name}`, 'success');
      await queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY });
      try {
        window.updateWatchlistButtonCount?.();
      } catch {
        /* the nav badge is the shell's; a failure there is not ours */
      }
    },
    onError: (error: Error, result) =>
      window.showToast?.(`Couldn't follow ${result.name}: ${error.message}`, 'error'),
  });

  const trimmed = query.trim();
  const waiting = trimmed.length >= 2 && trimmed !== debounced;
  const searching = results.isFetching || waiting;
  const list = results.data ?? [];

  let status: string;
  if (trimmed.length < 2) status = 'Type at least 2 letters of the name.';
  else if (searching) status = `Searching ${providerLabel(provider)}…`;
  else if (results.isError)
    status = `Couldn't search ${providerLabel(provider)}. Try another source.`;
  else if (list.length === 0)
    status = `${providerLabel(provider)} has no artist called “${debounced}”.`;
  else status = `${list.length} found on ${providerLabel(provider)}.`;

  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.dialog}
    >
      <DialogHeader title="Follow an artist" />
      <DialogBody>
        <p className={styles.dialogText}>
          SYNCHRO.S checks the artists you follow for new releases and adds them to Wanted.
        </p>
        <div className={styles.searchRow} role="search">
          <label className={styles.visuallyHidden} htmlFor={providerId}>
            Search on
          </label>
          <Select
            id={providerId}
            size="lg"
            value={provider}
            onChange={(event) => setProvider(event.target.value as Provider)}
          >
            {FOLLOW_PROVIDERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <label className={styles.visuallyHidden} htmlFor={inputId}>
            Artist name
          </label>
          <TextInput
            id={inputId}
            value={query}
            placeholder="Artist name"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <p className={styles.dialogNote} role="status" aria-live="polite">
          {status}
        </p>
        {list.length > 0 && !waiting ? (
          <ul className={styles.results} aria-label="Artists found">
            {list.slice(0, 8).map((result) => {
              const following =
                added.has(`${provider}:${result.id}`) ||
                followedNames.has(result.name.trim().toLowerCase());
              return (
                <li key={`${provider}-${result.id}`} className={styles.result}>
                  {result.image ? (
                    <img className={styles.resultArt} src={result.image} alt="" />
                  ) : (
                    <span className={styles.resultArt} aria-hidden="true" />
                  )}
                  <span className={styles.main}>
                    <span className={styles.rowTitle}>{result.name}</span>
                    {result.extra ? <span className={styles.meta}>{result.extra}</span> : null}
                  </span>
                  {following ? (
                    <StatusTag tone="success">Following</StatusTag>
                  ) : (
                    <Button
                      size="lg"
                      className={styles.rowAction}
                      disabled={follow.isPending}
                      focusableWhenDisabled
                      onClick={() => follow.mutate(result)}
                    >
                      Follow
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
