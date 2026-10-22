/**
 * The Radio home (4a, phone 4i, 4k): Stations / Heard on radio; Favourites
 * (with admins' links marked "Your link"), then the four kinds as rows of
 * four cards, and a search across the directory.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';

import type { Station } from '@/features/radio/radio.types';

import { Button } from '@/components/form';
import { EmptyState, Notice, Skeleton } from '@/components/primitives';
import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import { stationsQueryOptions } from '../-radio.api';
import { useRadioSession } from '../-radio.session';
import { Route } from '../index';
import { AddLinkDialog } from './add-link-dialog';
import { HeardTab } from './heard-list';
import { SearchIcon, StationCard } from './parts';
import styles from './radio.module.css';

const ROW = 4;

function KindRow({
  label,
  blurb,
  stations,
  session,
}: {
  label: string;
  blurb: string;
  stations: Station[];
  session: ReturnType<typeof useRadioSession>;
}) {
  const [all, setAll] = useState(false);
  const id = useId();
  const shown = all ? stations : stations.slice(0, ROW);
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id={id}>
          {label}
          {blurb ? <span className={styles.blurb}>{blurb}</span> : null}
        </h2>
        {stations.length > ROW ? (
          <button
            type="button"
            className={styles.linkButton}
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
          >
            {all ? 'Show fewer' : `All ${stations.length}`}
          </button>
        ) : null}
      </div>
      <div className={styles.cards}>
        {shown.map((s) => (
          <StationCard key={s.id} station={s} session={session} />
        ))}
      </div>
    </section>
  );
}

export function RadioHome() {
  useReactPageShell('radio');
  const { isAdmin } = useProfile();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const tab = search.tab === 'heard' ? 'heard' : 'stations';
  const query = useQuery(stationsQueryOptions());
  const session = useRadioSession();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(search.add === 'link');
  const data = query.data;
  const admin = data?.is_admin ?? isAdmin;

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    void navigate({ to: '/radio/search', search: q.trim() ? { q: q.trim() } : {} });
  };

  return (
    <div className={styles.page} data-testid="radio-home">
      <header className={styles.header}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Radio</h1>
          <p className={styles.subtitle}>
            Free stations, with what’s playing identified and one click from Wanted. A station keeps
            playing while you browse.
          </p>
        </div>
        {admin ? (
          <div className={styles.headActions}>
            <Button size="lg" onClick={() => setAdding(true)}>
              Add a stream link
            </Button>
          </div>
        ) : null}
      </header>

      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="Radio">
          <Link
            to="/radio"
            search={{}}
            role="tab"
            aria-selected={tab === 'stations'}
            className={styles.tab}
          >
            Stations
          </Link>
          <Link
            to="/radio"
            search={{ tab: 'heard' }}
            role="tab"
            aria-selected={tab === 'heard'}
            className={styles.tab}
          >
            <span>Heard on radio</span>
            {data ? <span className={styles.count}>{data.heard_count}</span> : null}
          </Link>
        </div>
        <form className={styles.search} role="search" onSubmit={onSearch}>
          <SearchIcon className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search 50,000 stations by name, genre or country"
            aria-label="Search the station directory"
          />
        </form>
      </div>

      {data && !data.identification ? (
        <Notice
          tone="warning"
          title="Track identification is off"
          actions={
            admin ? (
              <Button size="lg" onClick={() => window.openRadioSettings?.()}>
                Open Settings → Radio
              </Button>
            ) : undefined
          }
        >
          Stations play, but nothing is identified, so there’s no Add to Wanted, no auto-add and no
          Heard list.
          {admin ? '' : ' An admin can turn it on in Settings → Radio.'}
        </Notice>
      ) : null}

      {tab === 'heard' ? (
        <HeardTab
          missingOnly={search.show === 'missing'}
          onMissing={(on) =>
            void navigate({
              to: '/radio',
              search: on ? { tab: 'heard', show: 'missing' } : { tab: 'heard' },
            })
          }
        />
      ) : query.isPending ? (
        <div className={styles.stack} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.cards}>
              {[0, 1, 2, 3].map((j) => (
                <Skeleton key={j} className={styles.card} />
              ))}
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <Notice
          tone="danger"
          title="The stations didn’t load"
          actions={
            <Button size="lg" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        >
          {(query.error as Error).message}. Nothing is lost.
        </Notice>
      ) : data ? (
        <>
          <section className={styles.section} aria-labelledby="radio-favourites">
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle} id="radio-favourites">
                Favourites
              </h2>
              <span className={styles.sectionMeta}>
                {data.favourites.length} station{data.favourites.length === 1 ? '' : 's'} · the star
                on any station adds it here
              </span>
            </div>
            {data.favourites.length ? (
              <div className={`${styles.cards} ${styles.favRows}`}>
                {data.favourites.map((s) => (
                  <StationCard key={s.id} station={s} session={session} />
                ))}
              </div>
            ) : (
              <EmptyState
                variant="panel"
                title="No favourites yet"
                description="Star a station on its page and it shows here, at the top, for one-click listening."
              />
            )}
          </section>
          {data.kinds.map((k) => (
            <KindRow
              key={k.kind}
              label={k.label}
              blurb={k.blurb}
              stations={k.stations}
              session={session}
            />
          ))}
        </>
      ) : null}

      {admin ? (
        <AddLinkDialog
          open={adding}
          onClose={() => {
            setAdding(false);
            if (search.add) void navigate({ to: '/radio', search: {}, replace: true });
          }}
        />
      ) : null}
    </div>
  );
}
