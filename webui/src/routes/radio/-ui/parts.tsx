/**
 * The Radio page's small pieces: icons, the station logo, the station card
 * (4a), the play button, and the Heard rows (4b, 4k). Station and track text
 * is always rendered as text.
 */

import { Link } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';

import type { HeardItem, RadioSessionState, Station } from '@/features/radio/radio.types';

import { Button } from '@/components/form';
import { StatusTag } from '@/components/primitives';
import {
  cardSubline,
  clockTime,
  durationWords,
  heardTag,
  logoText,
  possessive,
  qualityText,
  sourcePhrase,
} from '@/features/radio/radio.format';

import { playStation, radioSession } from '../-radio.session';
import styles from './radio.module.css';

export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4l13 8-13 8z" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

export function StarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden="true"
      width="18"
      height="18"
    >
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
    </svg>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function NoteIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

/** Our own logo address (the server fetches and caches the station's), never another host. */
export function isOwnLogo(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^\/api\/radio\/stations\/[A-Za-z0-9-]+\/logo(\?|$)/.test(url);
}

/**
 * The 56px logo tile (120px on the station page): the station's letters,
 * with its logo over them once it has loaded (HANDOFF 55). The letters stay
 * while it loads, when it can't be fetched and when there's none.
 */
export function StationLogo({
  station,
  big = false,
}: {
  station: Pick<Station, 'name' | 'logo_url' | 'logo_text'>;
  big?: boolean;
}) {
  const [state, setState] = useState<'loading' | 'loaded' | 'broken'>('loading');
  const src = isOwnLogo(station.logo_url) ? station.logo_url : '';
  useEffect(() => setState('loading'), [src]);
  return (
    <span className={big ? `${styles.logo} ${styles.logoBig}` : styles.logo} aria-hidden="true">
      {state !== 'loaded' ? (
        <span className={styles.logoText}>{logoText(station.name, station.logo_text)}</span>
      ) : null}
      {src && state !== 'broken' ? (
        <img
          src={src}
          alt=""
          decoding="async"
          data-loaded={state === 'loaded' ? 'true' : undefined}
          onLoad={() => setState('loaded')}
          onError={() => setState('broken')}
        />
      ) : null}
    </span>
  );
}

export function isPlaying(session: RadioSessionState, stationId: string): boolean {
  return (
    session.station?.id === stationId &&
    (session.status === 'playing' || session.status === 'starting')
  );
}

/** Play, or Stop while this station plays. */
export function PlayButton({
  station,
  session,
  className,
}: {
  station: Station;
  session: RadioSessionState;
  className?: string;
}) {
  const on = isPlaying(session, station.id);
  return (
    <button
      type="button"
      className={className ?? styles.play}
      data-on={on ? 'true' : undefined}
      aria-label={on ? `Stop ${station.name}` : `Play ${station.name}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (on) void radioSession()?.stop();
        else playStation(station.id, { station });
      }}
    >
      {on ? <StopIcon /> : <PlayIcon />}
    </button>
  );
}

/** The quality on a card: FLAC as a success tag, the rest as meta. */
export function QualityLabel({ station }: { station: Station }) {
  if (station.quality.lossless) {
    return <StatusTag tone="success">{station.quality.codec || 'FLAC'}</StatusTag>;
  }
  return <span className={styles.quality}>{qualityText(station)}</span>;
}

/** The station card (4a): logo, name, "kind · city", quality, Play; selected while it plays. */
export function StationCard({
  station,
  session,
}: {
  station: Station;
  session: RadioSessionState;
}) {
  const playing = isPlaying(session, station.id);
  return (
    <article
      className={styles.card}
      data-playing={playing ? 'true' : undefined}
      data-testid="station-card"
    >
      <Link
        className={styles.cardLink}
        to="/radio/station/$stationId"
        params={{ stationId: station.id }}
        aria-label={`${station.name}, ${cardSubline(station)}`}
      />
      <StationLogo station={station} />
      <div className={styles.cardText}>
        <span className={styles.cardName}>{station.name}</span>
        <span className={styles.cardSub}>{cardSubline(station)}</span>
      </div>
      {/* HANDOFF 53: known before you play */}
      {!station.has_now_playing ? (
        <span className={styles.cardTag}>
          <StatusTag>Identified while you listen</StatusTag>
        </span>
      ) : null}
      <div className={styles.cardFoot}>
        {playing ? (
          <StatusTag tone="info" live>
            Playing
          </StatusTag>
        ) : (
          <QualityLabel station={station} />
        )}
        {playing ? (
          <span className={styles.quality}>{qualityText(station)}</span>
        ) : (
          <PlayButton station={station} session={session} />
        )}
      </div>
    </article>
  );
}

/** One Heard row's action column. */
function HeardAction({
  item,
  homepage,
  onWant,
  busy,
}: {
  item: HeardItem;
  homepage?: string;
  onWant: (item: HeardItem) => void;
  busy: boolean;
}): ReactNode {
  if (item.state === 'not_added') {
    return (
      <Button size="lg" disabled={busy} focusableWhenDisabled onClick={() => onWant(item)}>
        {busy ? 'Adding…' : 'Add to Wanted'}
      </Button>
    );
  }
  if (item.state === 'in_library' && item.below_target) {
    return (
      <Button size="lg" disabled={busy} focusableWhenDisabled onClick={() => onWant(item)}>
        Upgrade via Wanted
      </Button>
    );
  }
  if ((item.state === 'on_wanted' || item.state === 'added_by_auto_add') && item.added_at) {
    return <span>Added {clockTime(item.added_at)}</span>;
  }
  if (item.state === 'not_identified' && homepage) {
    return (
      <a className={styles.inlineLink} href={homepage} target="_blank" rel="noopener noreferrer">
        Search by time on {item.station_name.split(' · ')[0]}
      </a>
    );
  }
  if (item.state === 'cant_match') return <span>No artist to search for</span>;
  return null;
}

export function HeardRow({
  item,
  showStation = false,
  homepage,
  onWant,
  busy,
}: {
  item: HeardItem;
  showStation?: boolean;
  homepage?: string;
  onWant: (item: HeardItem) => void;
  busy: boolean;
}) {
  const tag = heardTag(item);
  const named = item.state !== 'not_identified' && item.title;
  const title = named ? (item.title as string) : 'Not identified';
  // the same source phrase as the bar and now playing (HANDOFF 58)
  const sub = named
    ? [item.artist, item.release, sourcePhrase(item.source)].filter(Boolean).join(' · ')
    : `${durationWords(item.duration_s)[0]!.toUpperCase()}${durationWords(item.duration_s).slice(1)} · probably a mix or talk`;
  return (
    <div
      className={showStation ? `${styles.row} ${styles.rowAll}` : styles.row}
      data-testid="heard-row"
    >
      <span className={styles.rowTime}>{clockTime(item.heard_at)}</span>
      <span className={styles.rowTrack}>
        <span className={styles.rowPhoneMeta}>
          {clockTime(item.heard_at)} · {item.station_name}
        </span>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowSub}>{sub}</span>
      </span>
      {showStation ? <span className={styles.rowStation}>{item.station_name}</span> : null}
      <span className={styles.rowTag}>
        <StatusTag tone={tag.tone} live={item.state === 'on_wanted'}>
          {tag.label}
        </StatusTag>
      </span>
      <span className={styles.rowAction}>
        <HeardAction item={item} homepage={homepage} onWant={onWant} busy={busy} />
      </span>
    </div>
  );
}

/** "How tracks are identified" (4b). */
export function HowIdentified({ station }: { station: Station }) {
  return (
    <section className={`${styles.panel} ${styles.panelPad}`} aria-labelledby="radio-how">
      <h2 className={styles.panelTitle} id="radio-how">
        How tracks are identified
      </h2>
      <ol className={styles.steps}>
        <li>
          The station’s own now-playing feed{' '}
          {station.has_now_playing
            ? `(${station.name} has one)`
            : `(${station.name} doesn’t publish one)`}
        </li>
        <li>Track names sent with the stream</li>
        <li>A fingerprint of a few seconds of audio, as a fallback</li>
      </ol>
      <p className={styles.howNote}>
        A name usually arrives within a minute of a track starting. Mixes, talk and live sessions
        often can’t be matched; those show as Not identified.
      </p>
    </section>
  );
}

export { possessive };
