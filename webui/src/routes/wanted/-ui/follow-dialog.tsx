import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { apiClient, readJson } from '@/app/api-client';
import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, OptionButton } from '@/components/form';
import { StatusTag } from '@/components/primitives';
import { profileAsksFirst } from '@/platform/shell/download-rights';

import { followedAuthorsQueryOptions } from '../-wanted.api';
import {
  ARTIST_SOURCES,
  FOLLOW_KINDS,
  artistResults,
  authorResults,
  followNote,
  kindNoun,
  labelResults,
  podcastResults,
  sourceName,
  type ArtistSource,
  type FollowKind,
  type FollowResult,
} from '../-wanted.follow';
import { findSystemAutomation, intervalText } from '../-wanted.helpers';
import { followAuthor, searchAudiobooks } from '../../audiobooks/-audiobooks.api';
import { automationsListQueryOptions } from '../../automations/-automations.api';
import { setLabelWatched } from '../../label-detail/-label-detail.api';
import { addPodcastToWatchlist, searchPodcasts } from '../../podcasts/-podcasts.api';
import { fetchLabels } from '../../search/-search.api';
import {
  WATCHLIST_QUERY_KEY,
  addWatchlistArtist,
  searchProviderArtists,
  watchlistLabelsQueryOptions,
  watchlistPodcastsQueryOptions,
} from '../../watchlist/-watchlist.api';
import styles from './follow-dialog.module.css';

/** The automation that checks each kind (its interval goes in the meta line). */
const CHECKED_BY: Record<FollowKind, string> = {
  artist: 'scan_watchlist',
  label: 'scan_watchlist',
  podcast: 'scan_watchlist_podcasts',
  author: 'audiobook_scan_watchlist',
};

function ResultArt({ result }: { result: FollowResult }) {
  const [failed, setFailed] = useState(false);
  if (result.image && !failed) {
    return (
      <img
        className={styles.art}
        data-round={result.round ? 'true' : undefined}
        src={result.image}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className={styles.art} data-round={result.round ? 'true' : undefined} aria-hidden="true">
      {result.initials}
    </span>
  );
}

/**
 * The Modules switch as 9b draws it: a 104×44 labelled control with the word
 * first and the track on the right.
 */
function OptionSwitch({
  checked,
  label,
  disabledReason,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabledReason?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className={styles.switch}
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabledReason ? 'true' : undefined}
      title={disabledReason}
      onClick={() => {
        if (!disabledReason) onChange(!checked);
      }}
    >
      {checked ? 'On' : 'Off'}
      <span className={styles.switchTrack} aria-hidden="true" />
    </button>
  );
}

/**
 * Follow… in place (board 9b, HANDOFF 36): one dialog for artists, labels,
 * podcasts and audiobook authors. The Kind row changes the search's source
 * and the result art; a result already followed is a disabled row with the
 * Following tag; podcasts add their two switches; the primary names the pick.
 */
export function FollowDialog({
  open,
  profileId,
  initialKind,
  allowed,
  followedNames,
  onClose,
}: {
  open: boolean;
  profileId: number;
  initialKind: FollowKind;
  /** Podcasts and authors are there only while their modules (and pages) are. */
  allowed: { podcasts: boolean; authors: boolean };
  /** Lower-cased names of the artists this profile follows. */
  followedNames: Set<string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const kinds = FOLLOW_KINDS.filter(
    ({ kind }) =>
      (kind !== 'podcast' || allowed.podcasts) && (kind !== 'author' || allowed.authors),
  );
  const [kind, setKind] = useState<FollowKind>(initialKind);
  const [source, setSource] = useState<ArtistSource>('deezer');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const asksFirst = profileAsksFirst();
  const [download, setDownload] = useState(!asksFirst);
  const [keep, setKeep] = useState(false);

  // a fresh dialog each time it opens, on the kind it was opened for
  useEffect(() => {
    if (!open) return;
    setKind(kinds.some((k) => k.kind === initialKind) ? initialKind : 'artist');
    setQuery('');
    setDebounced('');
    setPicked(null);
    setDownload(!profileAsksFirst());
    setKeep(false);
    // kinds follows the modules; the dialog resets only when it opens
  }, [open, initialKind]);

  useEffect(() => {
    const next = query.trim();
    if (next.length < 2) {
      setDebounced('');
      return;
    }
    const timer = window.setTimeout(() => setDebounced(next), 320);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => setPicked(null), [kind, source, debounced]);

  // what's followed already, per kind
  const labels = useQuery({ ...watchlistLabelsQueryOptions(profileId), enabled: open });
  const podcasts = useQuery({
    ...watchlistPodcastsQueryOptions(profileId),
    enabled: open && allowed.podcasts,
  });
  const authors = useQuery({
    ...followedAuthorsQueryOptions(profileId),
    enabled: open && allowed.authors,
  });
  const automations = useQuery({ ...automationsListQueryOptions(profileId), enabled: open });
  const lookback = useQuery({
    queryKey: ['discovery', 'lookback-period'] as const,
    queryFn: () => readJson<{ period?: string }>(apiClient.get('discovery/lookback-period')),
    enabled: open && kind === 'artist',
    staleTime: 60_000,
  });

  const search = useQuery({
    queryKey: [
      ...WATCHLIST_QUERY_KEY,
      'follow-search',
      profileId,
      kind,
      source,
      debounced,
    ] as const,
    enabled: open && debounced.length >= 2,
    queryFn: async () => {
      switch (kind) {
        case 'artist':
          return { kind, artists: await searchProviderArtists(source, debounced) } as const;
        case 'label':
          return { kind, labels: await fetchLabels(debounced) } as const;
        case 'podcast':
          return { kind, shows: await searchPodcasts(debounced, 8) } as const;
        case 'author':
          return {
            kind,
            books: (await searchAudiobooks(debounced, 'author', 30)).results,
          } as const;
      }
    },
  });

  const results: FollowResult[] = useMemo(() => {
    const data = search.data;
    if (!data || data.kind !== kind) return [];
    switch (data.kind) {
      case 'artist':
        return artistResults(data.artists, followedNames);
      case 'label':
        return labelResults(
          data.labels,
          new Set((labels.data ?? []).map((l) => l.musicbrainz_label_id)),
        );
      case 'podcast':
        return podcastResults(
          data.shows,
          new Set((podcasts.data ?? []).map((p) => String(p.feed_url))),
        );
      case 'author':
        return authorResults(
          data.books,
          new Set(
            (authors.data ?? [])
              .filter((a) => (a.role || 'author') === 'author')
              .map((a) => a.name.trim().toLowerCase()),
          ),
          debounced,
        );
    }
  }, [search.data, kind, followedNames, labels.data, podcasts.data, authors.data, debounced]);

  const choice = results.find((r) => r.key === picked && !r.following) ?? null;

  const follow = useMutation({
    mutationFn: async (result: FollowResult) => {
      const raw = result.raw;
      if (raw.kind === 'artist') {
        await addWatchlistArtist({
          artistId: raw.result.id,
          artistName: raw.result.name,
          source,
        });
        return;
      }
      if (raw.kind === 'label') {
        if (!(await setLabelWatched(String(raw.label.id), result.name, true)))
          throw new Error('the label watchlist didn’t take it');
        return;
      }
      if (raw.kind === 'podcast') {
        const out = await addPodcastToWatchlist(raw.show, {
          auto_download: download,
          // off: an episode is removed a week after it downloads; on: kept
          retention_days: keep ? 0 : 7,
        });
        if (!out.success) throw new Error('the podcast watchlist didn’t take it');
        return;
      }
      if (!(await followAuthor(raw.name, raw.cover)))
        throw new Error('the audiobook watchlist didn’t take it');
    },
    onSuccess: async (_none, result) => {
      window.showToast?.(`Following ${result.name}.`, 'success');
      await queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY });
      try {
        window.updateWatchlistButtonCount?.();
      } catch {
        /* the nav badge is the shell's */
      }
      onClose();
    },
    onError: (error: Error, result) =>
      window.showToast?.(`Couldn’t follow ${result.name}: ${error.message}.`, 'error'),
  });

  const trimmed = query.trim();
  const waiting = trimmed.length >= 2 && trimmed !== debounced;
  const where = sourceName(kind, source);
  let status = '';
  if (trimmed.length < 2) status = `Type at least 2 letters of the ${kindNoun(kind)}’s name.`;
  else if (waiting || search.isFetching) status = `Searching ${where}…`;
  else if (search.isError) status = `Couldn’t search ${where}. Try again in a moment.`;
  else if (results.length === 0)
    status = `${where} has no ${kindNoun(kind)} called “${debounced}”.`;
  else status = `${results.length} found on ${where}.`;

  const every = (() => {
    const automation = findSystemAutomation(automations.data, CHECKED_BY[kind]);
    if (!automation || !automation.enabled) return '';
    return intervalText(automation.trigger_config ?? null) || 'on a schedule';
  })();
  const podcastChoice = choice?.raw.kind === 'podcast' ? choice.raw.show : null;
  const note = followNote(kind, every, {
    lookback: lookback.data?.period,
    episodes: podcastChoice?.episode_count ?? null,
  });
  const showResults = results.length > 0 && !waiting;

  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.dialog}
      initialFocus={inputRef}
    >
      <DialogHeader
        title="Follow…"
        description="New releases or episodes go to Wanted as they come out."
        closeLabel="Close"
      />
      <DialogBody>
        <div className={styles.kinds} role="group" aria-label="Kind">
          {kinds.map(({ kind: k, label }) => (
            <OptionButton key={k} selected={k === kind} onClick={() => setKind(k)}>
              {label}
            </OptionButton>
          ))}
        </div>

        <div className={styles.field} role="search">
          <svg
            className={styles.fieldIcon}
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            value={query}
            placeholder={`${kindNoun(kind)[0].toUpperCase()}${kindNoun(kind).slice(1)} name`}
            aria-label={`Search ${kindNoun(kind, true)}`}
            aria-describedby={statusId}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          {kind === 'artist' ? (
            <select
              className={styles.source}
              aria-label="Search on"
              value={source}
              onChange={(event) => setSource(event.target.value as ArtistSource)}
            >
              {ARTIST_SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          ) : (
            <span className={styles.sourceText}>{where}</span>
          )}
          {query ? (
            <button
              type="button"
              className={styles.clear}
              aria-label="Clear"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>
        <p
          id={statusId}
          className={showResults ? styles.statusHidden : styles.status}
          role="status"
          aria-live="polite"
        >
          {status}
        </p>

        {showResults ? (
          <div className={styles.results} role="radiogroup" aria-label="Results">
            {results.map((result) =>
              result.following ? (
                <div key={result.key} className={styles.row} aria-disabled="true">
                  <span className={styles.radio} aria-hidden="true" />
                  <ResultArt result={result} />
                  <span className={styles.text}>
                    <span className={styles.name}>{result.name}</span>
                    {result.meta ? <span className={styles.meta}>{result.meta}</span> : null}
                  </span>
                  <StatusTag tone="success">Following</StatusTag>
                </div>
              ) : (
                <label
                  key={result.key}
                  className={styles.row}
                  data-checked={picked === result.key ? 'true' : undefined}
                >
                  <input
                    className={styles.radioInput}
                    type="radio"
                    name="follow-result"
                    checked={picked === result.key}
                    onChange={() => setPicked(result.key)}
                  />
                  <span className={styles.radio} aria-hidden="true" />
                  <ResultArt result={result} />
                  <span className={styles.text}>
                    <span className={styles.name}>{result.name}</span>
                    {result.meta ? <span className={styles.meta}>{result.meta}</span> : null}
                  </span>
                  {result.have ? <span className={styles.have}>{result.have}</span> : <span />}
                </label>
              ),
            )}
          </div>
        ) : null}

        {kind === 'podcast' ? (
          <div className={styles.options}>
            <div className={styles.option}>
              <div className={styles.optionText}>
                <span className={styles.optionTitle}>Download new episodes</span>
                <span className={styles.optionLine}>
                  {asksFirst
                    ? 'Your profile can’t download, so new episodes are counted, not downloaded.'
                    : download
                      ? `Each new episode downloads when the ${every ? `check (${every})` : 'check'} finds it.`
                      : 'Off: new episodes are counted on the Following tab, not downloaded.'}
                </span>
              </div>
              <OptionSwitch
                checked={download}
                label="Download new episodes"
                disabledReason={asksFirst ? 'Your profile can’t download' : undefined}
                onChange={setDownload}
              />
            </div>
            <div className={styles.option}>
              <div className={styles.optionText}>
                <span className={styles.optionTitle}>Keep every episode</span>
                <span className={styles.optionLine}>
                  {keep
                    ? 'On: episodes stay until you delete them.'
                    : 'Off: each episode is removed a week after it downloads.'}
                </span>
              </div>
              <OptionSwitch checked={keep} label="Keep every episode" onChange={setKeep} />
            </div>
          </div>
        ) : null}

        <p className={styles.note}>{note}</p>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={!choice || follow.isPending}
          disabledReason={!choice ? 'Pick one from the results' : undefined}
          onClick={() => choice && follow.mutate(choice)}
        >
          {choice ? `Follow ${choice.name}` : 'Follow'}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
