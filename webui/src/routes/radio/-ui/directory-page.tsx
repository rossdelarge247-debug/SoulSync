/**
 * Directory search (4f): the Radio Browser directory by name, genre or
 * country, with codec OptionButtons, a minimum bitrate and a country; each
 * row's declared quality, Favourite and Play.
 */

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';

import type { Station } from '@/features/radio/radio.types';

import { Button, OptionButton, Select } from '@/components/form';
import { EmptyState, Notice, SkeletonList, StatusTag } from '@/components/primitives';
import { qualityText } from '@/features/radio/radio.format';
import { useReactPageShell } from '@/platform/shell/route-controllers';

import {
  countriesQueryOptions,
  directoryQueryOptions,
  RADIO_KEY,
  setFavourite,
} from '../-radio.api';
import { useRadioSession } from '../-radio.session';
import { Route } from '../search';
import { PlayButton, SearchIcon, StarIcon } from './parts';
import styles from './radio.module.css';

const BITRATES = [0, 128, 192, 256, 320];

function Quality({ station }: { station: Station }) {
  const q = station.quality;
  if (q.lossless) return <StatusTag tone="success">{q.codec || 'FLAC'}</StatusTag>;
  const text = qualityText(station);
  return text ? (
    <StatusTag tone="neutral">{text}</StatusTag>
  ) : (
    <span className={styles.rowSub}>Not declared</span>
  );
}

export function DirectoryPage() {
  useReactPageShell('radio');
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/radio/search' });
  const queryClient = useQueryClient();
  const session = useRadioSession();
  const [text, setText] = useState(search.q ?? '');
  const [pages, setPages] = useState(1);
  useEffect(() => {
    setText(search.q ?? '');
    setPages(1);
  }, [search.q, search.codec, search.min, search.country]);

  const query = {
    q: search.q ?? '',
    codec: search.codec ?? '',
    min_bitrate: search.min ?? 0,
    country: search.country ?? '',
  };
  const results = useQueries({
    queries: Array.from({ length: pages }, (_, i) => directoryQueryOptions(query, i + 1)),
  });
  const countries = useQuery(countriesQueryOptions());
  const first = results[0];
  const stations = results.flatMap((r) => r.data?.results ?? []);
  const more = results[results.length - 1]?.data?.more ?? false;
  const loadingMore = results.some((r, i) => i > 0 && r.isPending);
  const fav = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => setFavourite(id, on),
    onSuccess: (_d, { on }) => {
      window.showToast?.(on ? 'Added to Favourites.' : 'Removed from Favourites.', 'success');
      void queryClient.invalidateQueries({ queryKey: RADIO_KEY });
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
  });

  const go = (patch: Partial<typeof search>) =>
    void navigate({
      search: (prev) => {
        const next = { ...prev, ...patch } as Record<string, unknown>;
        for (const k of Object.keys(next))
          if (next[k] === undefined || next[k] === '' || next[k] === 0) delete next[k];
        return next as typeof search;
      },
    });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    go({ q: text.trim() || undefined });
  };
  const describe = [
    search.q ? `“${search.q.toUpperCase()}”` : '',
    search.codec ?? '',
    search.min ? `${search.min}+ KBPS` : '',
    search.country ?? '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className={styles.page} data-testid="radio-directory">
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/radio">Radio</Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">Search stations</span>
      </nav>
      <header className={styles.headText}>
        <h1 className={styles.title}>Search stations</h1>
        <p className={styles.subtitle}>
          About 50,000 community-listed stations from the Radio Browser directory. Quality is what
          each station declares; a stream can be lower than it says.
        </p>
      </header>
      <div className={styles.filters}>
        <form className={styles.search} role="search" onSubmit={onSubmit}>
          <SearchIcon className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Name, genre or country"
            aria-label="Search the station directory"
          />
        </form>
        <div className={styles.filters} role="group" aria-label="Codec">
          {(['', 'FLAC', 'AAC', 'MP3'] as const).map((c) => (
            <OptionButton
              key={c || 'any'}
              selected={(search.codec ?? '') === c}
              onClick={() => go({ codec: (c || undefined) as typeof search.codec })}
            >
              {c || 'Any codec'}
            </OptionButton>
          ))}
        </div>
        <Select
          aria-label="Minimum bitrate"
          value={String(search.min ?? 0)}
          onChange={(e) => go({ min: Number(e.target.value) || undefined })}
        >
          {BITRATES.map((b) => (
            <option key={b} value={b}>
              {b ? `At least ${b} kbps` : 'Any bitrate'}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Country"
          value={search.country ?? ''}
          onChange={(e) => go({ country: e.target.value || undefined })}
        >
          <option value="">Any country</option>
          {(countries.data?.countries ?? []).map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      {first?.isPending ? (
        <SkeletonList rows={5} />
      ) : first?.isError ? (
        <Notice
          tone="danger"
          title="The directory didn’t answer"
          actions={
            <Button size="lg" onClick={() => void first.refetch()}>
              Try again
            </Button>
          }
        >
          {(first.error as Error).message}
        </Notice>
      ) : stations.length === 0 ? (
        <EmptyState
          variant="panel"
          title="No stations match"
          description="Try a broader word (a genre like “ambient”, a city, a station’s name), or take off a filter."
        />
      ) : (
        <section className={styles.panel} aria-label="Stations">
          <div className={styles.tableHead}>
            <span className={styles.label}>
              Station · {stations.length}
              {describe ? ` for ${describe}` : ''}
            </span>
            <span className={styles.label}>Country</span>
            <span className={styles.label}>Declared quality</span>
            <span />
          </div>
          <div className={styles.rows}>
            {stations.map((s) => (
              <div
                key={s.id}
                className={`${styles.row} ${styles.dirRow}`}
                data-testid="directory-row"
              >
                <span className={styles.rowTrack}>
                  <Link
                    className={styles.rowTitle}
                    to="/radio/station/$stationId"
                    params={{ stationId: s.id }}
                  >
                    {s.name}
                  </Link>
                  <span className={styles.rowSub}>
                    {[s.tags.slice(0, 3).join(', '), s.favourite ? 'in your Favourites' : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className={styles.rowPhoneMeta}>{s.country}</span>
                </span>
                <span className={styles.rowStation}>{s.country || '—'}</span>
                <span className={styles.rowTag}>
                  <Quality station={s} />
                </span>
                <span className={styles.dirActions}>
                  <button
                    type="button"
                    className={`${styles.play} ${styles.star}`}
                    data-on={s.favourite ? 'true' : undefined}
                    aria-pressed={s.favourite}
                    aria-label={
                      s.favourite
                        ? `Remove ${s.name} from Favourites`
                        : `Add ${s.name} to Favourites`
                    }
                    onClick={() => fav.mutate({ id: s.id, on: !s.favourite })}
                  >
                    <StarIcon filled={s.favourite} />
                  </button>
                  <PlayButton station={s} session={session} />
                </span>
              </div>
            ))}
          </div>
          <div className={styles.panelFoot}>
            <span>
              {stations.length}
              {more ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className={styles.linkButton}
                    disabled={loadingMore}
                    onClick={() => setPages((p) => p + 1)}
                  >
                    {loadingMore ? 'Loading…' : 'Show 20 more'}
                  </button>
                </>
              ) : null}
            </span>
            <span>Sorted by listeners in the directory</span>
          </div>
        </section>
      )}
    </div>
  );
}
