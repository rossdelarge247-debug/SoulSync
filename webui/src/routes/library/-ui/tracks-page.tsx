import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button, Select, TextInput } from '@/components/form';
import { Notice, Skeleton } from '@/components/primitives';
import {
  DJ_PAGE_SIZE,
  DJ_QUERY_KEY,
  djBrowseInfiniteQueryOptions,
  djStatusQueryOptions,
  postDjJob,
  type DjTrack,
} from '@/features/dj/dj.api';
import {
  CAMELOT_KEYS,
  analysisLine,
  bpmNumber,
  bpmTitle,
  formatBpmRange,
  isCamelot,
  keyTitle,
  parseBpmRange,
} from '@/features/dj/dj.format';
import { addTrackToPlaylist, playTrackNext, useMixesWith } from '@/features/dj/mixes-dialog';
import { useProfile } from '@/platform/shell/route-controllers';

import type { LibrarySearch } from '../-library.types';
import type { Go } from './albums-page';

import { TRACK_SORTS, pick, type TrackSort } from '../-library.types';
import hs from './history.module.css';
import { FilterField, MoreMenu, PlayIcon, SortSelect, plural } from './parts';
import styles from './tracks.module.css';

const SORT_LABELS: Record<TrackSort, string> = {
  bpm: 'BPM',
  key: 'Key',
  energy: 'Energy',
  title: 'Title',
  artist: 'Artist',
  recent: 'Recently added',
};

function usePhone(): boolean {
  const query = '(max-width: 640px)';
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const on = () => setPhone(list.matches);
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, []);
  return phone;
}

/** "too long to analyse" -> "Too long to analyse", for the meta line. */
function sentenceCase(words: string): string {
  return words ? words[0].toUpperCase() + words.slice(1) : words;
}

function artistHref(track: DjTrack): string | null {
  return track.artist_id === null || track.artist_id === ''
    ? null
    : `/artist-detail/library/${encodeURIComponent(String(track.artist_id))}`;
}

function TrackRow({
  track,
  phone,
  onMixes,
}: {
  track: DjTrack;
  phone: boolean;
  onMixes: (track: DjTrack) => void;
}) {
  const dj = track.dj;
  const artist = artistHref(track);
  const album =
    artist && track.album_id !== null && track.album_id !== ''
      ? `${artist}?album=${encodeURIComponent(String(track.album_id))}`
      : null;
  const rowRef = useRef<HTMLLIElement>(null);
  const [failed, setFailed] = useState(false);
  const djPhone = [
    dj?.bpm ? `${bpmNumber(dj.bpm)} BPM` : '',
    dj?.key ? `${dj.key}${dj.key_uncertain ? '?' : ''}` : '',
    dj?.skipped ? sentenceCase(dj.skipped) : '',
  ].filter(Boolean);
  return (
    <li ref={rowRef} className={styles.row} data-track-row={track.id}>
      <span className={hs.art} aria-hidden="true">
        {track.image_url && !failed ? (
          <img src={track.image_url} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : null}
      </span>
      <div className={hs.text}>
        <span className={hs.title}>{track.title}</span>
        <span className={hs.meta}>
          {artist ? (
            <a href={artist}>{track.artist_name}</a>
          ) : (
            track.artist_name || 'Unknown artist'
          )}
          {phone ? (
            djPhone.length ? (
              <> · {djPhone.join(' · ')}</>
            ) : null
          ) : track.album_title ? (
            <> · {album ? <a href={album}>{track.album_title}</a> : track.album_title}</>
          ) : null}
          {!phone && dj?.skipped ? <> · {sentenceCase(dj.skipped)}</> : null}
        </span>
      </div>
      {phone ? null : (
        <>
          <span className={styles.num} title={dj ? bpmTitle(dj) : undefined}>
            {dj?.bpm ? bpmNumber(dj.bpm) : <span className={styles.none}>–</span>}
          </span>
          <span className={styles.num}>
            {dj?.key ? (
              <abbr
                title={keyTitle(dj)}
                className={styles.key}
                data-uncertain={dj.key_uncertain ? 'true' : undefined}
              >
                {dj.key}
                {dj.key_uncertain ? '?' : null}
              </abbr>
            ) : (
              <span className={styles.none}>–</span>
            )}
          </span>
          <span className={styles.num}>{dj?.energy ?? <span className={styles.none}>–</span>}</span>
        </>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={hs.play}
          aria-label={`Play ${track.title} next`}
          title="Play next, after the current track"
          onClick={() => playTrackNext(track)}
        >
          <PlayIcon />
        </button>
        <MoreMenu
          className={hs.more}
          label={`More for ${track.title}`}
          entries={[
            { key: 'mixes', label: 'Mixes well with…', onSelect: () => onMixes(track) },
            {
              key: 'playlist',
              label: 'Add to playlist…',
              onSelect: () =>
                addTrackToPlaylist(
                  track,
                  rowRef.current?.querySelector<HTMLElement>('[aria-label^="More for"]'),
                ),
            },
            ...(artist
              ? [
                  {
                    key: 'artist',
                    label: 'Open artist',
                    onSelect: () => window.location.assign(artist),
                  },
                ]
              : []),
            ...(album
              ? [
                  {
                    key: 'album',
                    label: 'Open album',
                    onSelect: () => window.location.assign(album),
                  },
                ]
              : []),
          ]}
        />
      </div>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <ul className={hs.list} aria-hidden="true">
      {Array.from({ length: 6 }, (_v, i) => (
        <li key={i} className={styles.row}>
          <Skeleton className={hs.art} />
          <div className={hs.text}>
            <Skeleton className={hs.skeletonTitle} />
            <Skeleton className={hs.skeletonMeta} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** "BPM from [ ] to [ ]": applied a moment after typing stops, like the filter. */
function BpmRange({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const parsed = parseBpmRange(value);
  const [min, setMin] = useState(parsed.min === null ? '' : String(parsed.min));
  const [max, setMax] = useState(parsed.max === null ? '' : String(parsed.max));
  const committed = useRef(value);
  const minId = useId();
  const maxId = useId();
  useEffect(() => {
    if (value === committed.current) return;
    committed.current = value;
    const next = parseBpmRange(value);
    setMin(next.min === null ? '' : String(next.min));
    setMax(next.max === null ? '' : String(next.max));
  }, [value]);
  useEffect(() => {
    const read = (raw: string) => {
      const n = Number(raw);
      return raw.trim() && Number.isFinite(n) && n >= 20 && n <= 400
        ? Math.round(n * 10) / 10
        : null;
    };
    const next = formatBpmRange(read(min), read(max));
    if (next === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = next;
      onChange(next);
    }, 400);
    return () => clearTimeout(timer);
  }, [min, max, onChange]);
  return (
    <div className={styles.bpmRange} role="group" aria-labelledby={`${minId}-label`}>
      <span className={hs.rowLabel} id={`${minId}-label`}>
        BPM
      </span>
      <label className={styles.srOnly} htmlFor={minId}>
        Lowest BPM
      </label>
      <TextInput
        id={minId}
        className={styles.bpmInput}
        inputMode="decimal"
        placeholder="From"
        value={min}
        onChange={(event) => setMin(event.target.value)}
      />
      <span className={styles.dash} aria-hidden="true">
        –
      </span>
      <label className={styles.srOnly} htmlFor={maxId}>
        Highest BPM
      </label>
      <TextInput
        id={maxId}
        className={styles.bpmInput}
        inputMode="decimal"
        placeholder="To"
        value={max}
        onChange={(event) => setMax(event.target.value)}
      />
    </div>
  );
}

/**
 * Library → Tracks (/library?view=tracks; no board yet, BACKLOG "DJ area"
 * stage 1): every track you have with its BPM, key (Camelot) and energy,
 * filtered by a BPM range and a key, sorted by BPM by default. The URL holds
 * the range (`bpm=120-128`), the key (`key=8A`, `8A:mix` with the keys that
 * mix with it), the sort and the filter text.
 */
export function TracksPage({ search, go }: { search: LibrarySearch; go: Go }) {
  const { profileId } = useProfile();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const mixes = useMixesWith();
  const sort = pick(search.sort, TRACK_SORTS);
  const withMix = search.key.endsWith(':mix');
  const keyCode = withMix ? search.key.slice(0, -4) : search.key;
  const key = isCamelot(keyCode) ? keyCode : '';
  const { min, max } = parseBpmRange(search.bpm);
  const q = search.q.trim();
  const keyId = useId();

  const status = useQuery({ ...djStatusQueryOptions(), retry: false });
  const query = useInfiniteQuery(
    djBrowseInfiniteQueryOptions(profileId, {
      bpmMin: min,
      bpmMax: max,
      key: key ? `${key}${withMix ? ':mix' : ''}` : '',
      q,
      sort,
    }),
  );
  const pages = query.data?.pages ?? [];
  const tracks = useMemo(() => pages.flatMap((p) => p.tracks), [pages]);
  const total = pages[0]?.total ?? 0;
  const filtered = Boolean(q || key || min !== null || max !== null);

  // a running analysis fills rows in: refresh the list when it moves on
  const done = status.data?.job?.status === 'running' ? status.data.job.done : null;
  useEffect(() => {
    if (done !== null && done > 0 && done % 25 === 0) {
      void queryClient.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'browse'] });
    }
  }, [done, queryClient]);

  const job = useMutation({
    mutationFn: (action: 'start' | 'stop') => postDjJob(action),
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'status'] }),
  });

  const s = status.data;
  const running = s?.job?.status === 'running';
  const line = s ? analysisLine(s) : '';

  return (
    <div className={hs.page}>
      <header className={hs.header}>
        <div className={hs.headText}>
          <h1 className={hs.heading}>Tracks</h1>
          <p className={hs.subtitle}>
            Every track you have with its BPM, key and energy, for finding the next track in a mix.
          </p>
        </div>
        <div className={hs.headActions}>
          <FilterField
            value={search.q}
            onChange={(next) => go({ q: next }, { replace: true })}
            placeholder="Filter by title, artist or album"
            phonePlaceholder="Title, artist or album"
            label="Filter your tracks"
          />
        </div>
      </header>

      {line ? (
        <div className={styles.analysis} aria-live="polite">
          <span className={hs.metaLine}>{line}</span>
          {s?.can_stop && running ? (
            <Button
              size="lg"
              variant="ghost"
              disabled={job.isPending}
              onClick={() => job.mutate('stop')}
            >
              Stop
            </Button>
          ) : s?.can_start && !running && s.counts.pending > 0 && s.settings.analyze ? (
            <Button
              size="lg"
              variant="secondary"
              disabled={job.isPending}
              onClick={() => job.mutate('start')}
            >
              Start now
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <BpmRange value={search.bpm} onChange={(next) => go({ bpm: next }, { replace: true })} />
        <div className={styles.keyGroup}>
          <label className={hs.rowLabel} htmlFor={keyId}>
            Key
          </label>
          <Select
            id={keyId}
            size="lg"
            value={key}
            onChange={(event) =>
              go({ key: event.target.value ? `${event.target.value}${withMix ? ':mix' : ''}` : '' })
            }
          >
            <option value="">Any key</option>
            {CAMELOT_KEYS.map((k) => (
              <option key={k.code} value={k.code}>
                {k.code} · {k.name}
              </option>
            ))}
          </Select>
          {key ? (
            <button
              type="button"
              className={hs.chip}
              aria-pressed={withMix}
              onClick={() => go({ key: `${key}${withMix ? '' : ':mix'}` })}
            >
              And keys that mix
            </button>
          ) : null}
        </div>
        <SortSelect
          className={styles.sort}
          options={TRACK_SORTS.map((k) => ({ key: k, label: SORT_LABELS[k] }))}
          value={sort}
          onChange={(next) => go({ sort: next === 'bpm' ? '' : next }, { replace: true })}
        />
      </div>

      {query.isError ? (
        <>
          <Notice
            tone="danger"
            role="alert"
            title="Couldn't load your tracks"
            actions={
              <Button size="lg" variant="secondary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          >
            SYNCHRO.S couldn&apos;t read your library just now. Nothing is lost; this is a display
            problem.
          </Notice>
          <div className={hs.faded}>
            <RowsSkeleton />
          </div>
        </>
      ) : query.isPending ? (
        <RowsSkeleton />
      ) : tracks.length ? (
        <>
          {phone ? null : (
            <div className={styles.head} aria-hidden="true">
              <span />
              <span>Track</span>
              <span>BPM</span>
              <span>Key</span>
              <span>Energy</span>
              <span />
            </div>
          )}
          <ul className={hs.list} aria-label="Your tracks">
            {tracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                phone={phone}
                onMixes={(t) => mixes.open({ id: t.id, title: t.title })}
              />
            ))}
          </ul>
        </>
      ) : (
        <div className={hs.empty}>
          <h2>
            {filtered
              ? 'No tracks match these filters'
              : 'No tracks with a file in your library yet'}
          </h2>
          {filtered ? (
            <div className={hs.emptyActions}>
              <Button size="lg" variant="secondary" onClick={() => go({ q: '', bpm: '', key: '' })}>
                Clear the filters
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {tracks.length ? (
        <div className={hs.footer}>
          <span>
            {tracks.length.toLocaleString()} of {plural(total, 'track')}
          </span>
          {query.hasNextPage ? (
            <Button
              size="lg"
              variant="secondary"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage
                ? 'Loading…'
                : `Show ${Math.min(DJ_PAGE_SIZE, total - tracks.length)} more`}
            </Button>
          ) : null}
        </div>
      ) : null}
      {mixes.dialog}
    </div>
  );
}
