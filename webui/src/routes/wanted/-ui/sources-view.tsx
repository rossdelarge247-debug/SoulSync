import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { Button } from '@/components/form';
import { EmptyState, StatusTag } from '@/components/primitives';

import type { JourneyStatus, TrackJourney, WantedItem, WantedTrack } from '../-wanted.types';

import { JOURNEY_LABELS } from '../-wanted.helpers';
import {
  SOURCE_GROUPS,
  barLabel,
  n,
  sourceTracks,
  trackDetail,
  type DetailContext,
  type SourceSummary,
} from '../-wanted.journey';
import styles from './wanted-page.module.css';

/** The bar's colours, left to right (board 2's legend). */
const LEGEND: { key: keyof SourceSummary['bar']; label: string }[] = [
  { key: 'owned', label: 'In your library' },
  { key: 'active', label: 'Downloading or searching' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'decision', label: 'Needs your decision' },
  { key: 'notFound', label: 'Not found' },
];

/** A stacked bar of where a source's songs are; its words are its label. */
export function SourceBar({ bar, large = false }: { bar: SourceSummary['bar']; large?: boolean }) {
  return (
    <div
      className={large ? `${styles.bar} ${styles.barLarge}` : styles.bar}
      role="img"
      aria-label={barLabel(bar)}
    >
      {LEGEND.map(({ key }) =>
        bar[key] > 0 ? (
          <span
            key={key}
            className={styles.barPart}
            data-part={key}
            style={{ flexGrow: bar[key] }}
          />
        ) : null,
      )}
    </div>
  );
}

function Legend() {
  return (
    <ul className={styles.legend} aria-label="What the colours mean">
      {LEGEND.map(({ key, label }) => (
        <li key={key}>
          <span className={styles.legendDot} data-part={key} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Sources (board 2): every place wanted songs came from, grouped as
 * Playlists, Following and Your requests, each with its stacked bar and one
 * headline. "In your library" only for a mirrored playlist the sync has
 * checked track by track.
 */
export function SourcesView({
  sources,
  loading,
  onOpen,
}: {
  sources: SourceSummary[];
  /** The live read hasn't answered yet: the bars may still move. */
  loading: boolean;
  onOpen: (key: string) => void;
}) {
  if (sources.length === 0) {
    return (
      <EmptyState
        variant="panel"
        title="Nothing wanted from anywhere yet"
        description="When a playlist, a followed artist or a request of yours puts songs on Wanted, each source is listed here with how far along it is."
      />
    );
  }
  return (
    <div className={styles.sources} aria-busy={loading || undefined}>
      <Legend />
      {SOURCE_GROUPS.map(({ group, label }) => {
        const list = sources.filter((source) => source.group === group);
        if (list.length === 0) return null;
        const songs = list.reduce((sum, source) => sum + source.wanted, 0);
        const kind = group === 'playlists' ? 'playlist' : 'source';
        return (
          <section key={group} className={styles.sourceCard} aria-label={label}>
            <div className={styles.sourceHead}>
              <h2 className={styles.sourceGroup}>{label}</h2>
              <span className={styles.sourceSum}>
                {`${n(list.length)} ${list.length === 1 ? kind : `${kind}s`} · ${n(songs)} ${songs === 1 ? 'song' : 'songs'} still wanted`}
              </span>
            </div>
            <ul className={styles.sourceList}>
              {list.map((source) => (
                <li key={source.key} className={styles.sourceRow}>
                  <div className={styles.sourceText}>
                    <p className={styles.sourceName}>{source.label}</p>
                    <p className={styles.sourceMeta}>{source.meta}</p>
                  </div>
                  <div className={styles.sourceProgress}>
                    <SourceBar bar={source.bar} />
                    <p className={styles.sourceHeadline}>{source.headline}</p>
                  </div>
                  <div className={styles.sourceAction}>
                    <Button size="lg" onClick={() => onOpen(source.key)}>
                      Show songs
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className={styles.sourcesNote}>
        “In your library” is shown only for playlists SYNCHRO.S mirrors and has checked track by
        track. For the others it shows what’s still wanted, and offers to mirror the playlist so it
        can count the rest.
      </p>
    </div>
  );
}

/** The groups of "the N still to get", Needs you first (board 3). */
const STILL_GROUPS: { key: string; label: string; states: JourneyStatus[]; tone: string }[] = [
  { key: 'decision', label: JOURNEY_LABELS.decision, states: ['decision'], tone: 'decision' },
  { key: 'not-found', label: JOURNEY_LABELS['not-found'], states: ['not-found'], tone: 'notFound' },
  {
    key: 'active',
    label: 'Downloading or searching',
    states: ['downloading', 'searching'],
    tone: 'active',
  },
  { key: 'waiting', label: JOURNEY_LABELS.waiting, states: ['waiting'], tone: 'waiting' },
];

const GROUP_PAGE = 25;

export interface SourcePageProps {
  sourceKey: string;
  summary: SourceSummary | null;
  items: WantedItem[];
  journeys: Map<string, TrackJourney>;
  context: DetailContext;
  canSearch: boolean;
  onBack: () => void;
  /** This source's songs in the Songs view (its From filter). */
  onSongs: () => void;
  onReview: (entryId: string) => void;
  onOpenDownloads: () => void;
  onSearchByHand: (track: WantedTrack) => void;
  onSearchNow: (track: WantedTrack) => void;
}

function SongAction({
  track,
  status,
  live,
  props,
}: {
  track: WantedTrack;
  status: JourneyStatus;
  live: TrackJourney | undefined;
  props: SourcePageProps;
}) {
  if (status === 'decision' && live?.quarantineEntry) {
    const entry = live.quarantineEntry;
    return (
      <Button size="lg" variant="primary" onClick={() => props.onReview(entry)}>
        Review
      </Button>
    );
  }
  if (status === 'downloading' || status === 'searching') {
    return (
      <Button size="lg" onClick={props.onOpenDownloads}>
        Details
      </Button>
    );
  }
  if (!props.canSearch) return null;
  if (status === 'not-found') {
    return (
      <Button size="lg" onClick={() => props.onSearchByHand(track)}>
        Search by hand
      </Button>
    );
  }
  return (
    <Button size="lg" onClick={() => props.onSearchNow(track)}>
      Search now
    </Button>
  );
}

/**
 * One source (board 3): Wanted › Sources › its name, the progress card, and
 * the songs still to get, grouped by status, Needs you first.
 */
export function SourcePage(props: SourcePageProps) {
  const { sourceKey, summary, items, journeys, context, onBack, onSongs } = props;
  const [shown, setShown] = useState<Record<string, number>>({});
  const name = summary?.label ?? sourceKey.replace(/^playlist:/, '');
  const tracks = summary ? sourceTracks(items, sourceKey, journeys) : [];
  const library = summary?.library ?? null;
  const mirrored = library?.kind === 'known' || library?.kind === 'checking';

  const crumbs = (
    <nav className={styles.crumbs} aria-label="Breadcrumb">
      <button type="button" className={styles.linkButton} onClick={onSongs}>
        Wanted
      </button>
      <span aria-hidden="true"> › </span>
      <button type="button" className={styles.linkButton} onClick={onBack}>
        Sources
      </button>
      <span aria-hidden="true"> › </span>
      <span aria-current="page">{name}</span>
    </nav>
  );

  if (!summary) {
    return (
      <div className={styles.sourcePage}>
        {crumbs}
        <EmptyState
          variant="panel"
          title={`Nothing from ${name} is on Wanted now`}
          description="Everything it asked for has arrived or been removed from Wanted."
          actions={
            <Button size="lg" onClick={onBack}>
              All sources
            </Button>
          }
        />
      </div>
    );
  }

  const headline =
    library?.kind === 'known'
      ? `${n(library.owned)} of ${n(library.total)} songs in your library`
      : `${n(summary.wanted)} ${summary.wanted === 1 ? 'song' : 'songs'} still wanted`;
  const tiles = [
    { key: 'waiting', label: JOURNEY_LABELS.waiting, count: summary.counts.waiting },
    {
      key: 'active',
      label: 'Downloading or searching',
      count: summary.counts.downloading + summary.counts.searching,
    },
    { key: 'decision', label: JOURNEY_LABELS.decision, count: summary.counts.decision },
    { key: 'notFound', label: JOURNEY_LABELS['not-found'], count: summary.counts['not-found'] },
  ];

  return (
    <div className={styles.sourcePage}>
      <header className={styles.sourcePageHead}>
        <div>
          {crumbs}
          <h2 className={styles.sourceTitle}>{name}</h2>
          <p className={styles.sourceMeta}>{summary.meta}</p>
        </div>
        <div className={styles.sourcePageActions}>
          {mirrored ? (
            <Link to="/sync" className={styles.linkButton}>
              Open Mirrored playlists
            </Link>
          ) : null}
          <Button size="lg" onClick={onSongs}>
            Show in the list
          </Button>
        </div>
      </header>

      <section className={styles.progressCard} aria-label="Progress">
        <p className={styles.progressHeadline}>{headline}</p>
        <SourceBar bar={summary.bar} large />
        {library?.kind === 'checking' ? (
          <p className={styles.sourceMeta}>
            {`The sync has checked ${n(library.checked)} of its ${n(library.total)} songs against your library so far, so how many you have isn’t known yet.`}
          </p>
        ) : summary.playlist && library?.kind === 'not-mirrored' ? (
          <p className={styles.sourceMeta}>
            It isn’t mirrored, so SYNCHRO.S can’t count what you already have.{' '}
            <Link to="/sync" className={styles.linkButton}>
              Mirror it
            </Link>{' '}
            to count the rest.
          </p>
        ) : null}
        <div className={styles.tiles}>
          {tiles.map((tile) => (
            <div key={tile.key} className={styles.tile} data-part={tile.key}>
              <p className={styles.tileLabel}>{tile.label}</p>
              <p className={styles.tileCount}>{n(tile.count)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.stillCard} aria-label="Still to get">
        <div className={styles.sourceHead}>
          <h3 className={styles.stillTitle}>
            {summary.wanted === 1 ? 'The 1 still to get' : `The ${n(summary.wanted)} still to get`}
          </h3>
          <span className={styles.sourceSum}>Needs you first</span>
        </div>
        {STILL_GROUPS.map((group) => {
          const list = tracks.filter((entry) => group.states.includes(entry.status));
          if (list.length === 0) return null;
          const limit = shown[group.key] ?? GROUP_PAGE;
          return (
            <div key={group.key} className={styles.stillGroup}>
              <h4 className={styles.stillGroupHead}>
                <span className={styles.legendDot} data-part={group.tone} aria-hidden="true" />
                {`${group.label} · ${n(list.length)}`}
              </h4>
              <ul className={styles.stillList}>
                {list.slice(0, limit).map(({ track, status }) => {
                  const live = journeys.get(track.id);
                  return (
                    <li key={track.id} className={styles.stillRow}>
                      <div className={styles.sourceText}>
                        <p className={styles.rowTitle} title={track.title}>
                          {track.title}
                        </p>
                        <p className={styles.sourceMeta}>{track.artist}</p>
                      </div>
                      <span className={styles.stillDetail}>
                        {group.key === 'active' ? (
                          <StatusTag
                            tone="info"
                            live
                            className={status === 'downloading' ? styles.tagAccent : undefined}
                          >
                            {JOURNEY_LABELS[status]}
                          </StatusTag>
                        ) : null}
                        {trackDetail(track, live, context)}
                      </span>
                      <div className={styles.sourceAction}>
                        <SongAction track={track} status={status} live={live} props={props} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {list.length > limit ? (
                <div className={styles.stillMore}>
                  <Button
                    size="lg"
                    variant="ghost"
                    onClick={() =>
                      setShown((prev) => ({ ...prev, [group.key]: limit + GROUP_PAGE * 2 }))
                    }
                  >
                    {`Show ${n(Math.min(GROUP_PAGE * 2, list.length - limit))} more of ${n(list.length - limit)}`}
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}
