import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/form';
import { Notice, Skeleton, StatusTag } from '@/components/primitives';
import { DjMeta } from '@/features/dj/dj-meta';
import { useDjInfo, type DjInfo } from '@/features/dj/dj.api';
import { usePlayingTrackId } from '@/features/dj/playing-track';
import { RowPlay, playTrackNow, rowPlayHandlers } from '@/features/dj/row-play';
import { trackMenu } from '@/features/dj/track-menu';
import { awayWords } from '@/features/drives/drives.format';
import { useMixTabShown } from '@/features/mix/mix-visibility';
import { playInAppPlayer } from '@/features/playback/app-player';
import { openAddToPlaylist } from '@/features/playlists/add-to-playlist';
import { StarButton, useStar } from '@/features/stars/star-button';
import { useProfile } from '@/platform/shell/route-controllers';

import type { LibrarySearch } from '../-library.types';
import type { Go } from './albums-page';

import {
  HISTORY_KINDS,
  HISTORY_PAGE_SIZE,
  HISTORY_RANGES,
  browserTz,
  clockTime,
  dayHead,
  emptyTitle,
  groupByDay,
  historyCountsQueryOptions,
  historyInfiniteQueryOptions,
  historyMeta,
  lengthWords,
  plural,
  readRememberedRange,
  rememberRange,
  sourcePhrase,
  spokenParts,
  widerRange,
  type HistoryKind,
  type HistoryRange,
  type MusicHistoryPage,
  type MusicPlay,
  type SpokenHistoryPlay,
} from '../-library.history';
import { ActionSheet } from './action-sheet';
import styles from './history.module.css';
import { CountBadge, FilterField, MoreMenu, PlayIcon } from './parts';

function artistHref(play: MusicPlay): string | null {
  return play.artist_id === null || play.artist_id === ''
    ? null
    : `/artist-detail/library/${encodeURIComponent(String(play.artist_id))}`;
}

function albumHref(play: MusicPlay): string | null {
  const base = artistHref(play);
  return base && play.album_id !== null && play.album_id !== ''
    ? `${base}?album=${play.album_id}`
    : null;
}

function historyTrack(play: MusicPlay): Record<string, unknown> {
  return {
    id: play.track_id,
    title: play.title,
    artist: play.artist,
    album: play.album,
    file_path: play.file_path,
    artist_id: play.artist_id,
    album_id: play.album_id,
    image_url: play.image_url,
    bitrate: play.bitrate,
    duration: play.length_s,
  };
}

/** Queue a play after the current track (Play next; the engine says "Playing next"). */
function queueNext(play: MusicPlay): void {
  if (!play.track_id || !window.playNext) {
    window.showToast?.("The player isn't ready yet. Try again in a moment.", 'error');
    return;
  }
  window.playNext(historyTrack(play));
}

/** Play it now (Brief D's Play). */
function playNow(play: MusicPlay): void {
  if (!play.track_id) return;
  playTrackNow(historyTrack(play));
}

function playSpoken(play: SpokenHistoryPlay): void {
  if (!play.src) return;
  playInAppPlayer({
    kind: play.kind,
    id: play.media_id,
    src: play.src,
    title: play.title,
    subtitle: play.subtitle || undefined,
    artUrl: play.image_url,
    durationHint: play.duration_s ?? null,
  });
}

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

function Art({ url }: { url: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={styles.art} aria-hidden="true">
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : null}
    </span>
  );
}

function MusicRow({
  play,
  phone,
  dj,
  away,
  playing = false,
}: {
  play: MusicPlay;
  /** what the player has loaded: Playing (green) in Play's place (34a) */
  playing?: boolean;
  phone: boolean;
  /** While the library's drive is away (123): Play is disabled-neutral and
   *  described by the reason ("Music HD isn't connected", element `id`). */
  away?: { id: string; words: string };
  /** The track's BPM and key (the library's DJ data), when known. */
  dj?: DjInfo;
}) {
  // the "…" follows Settings → Library → DJ's "Show the Mix tab" (Mixes well with…)
  useMixTabShown();
  const time = clockTime(play.played_at);
  const artist = artistHref(play);
  const album = albumHref(play);
  const phrase = sourcePhrase(play);
  const gone = !play.in_library;
  const rowRef = useRef<HTMLLIElement>(null);
  const [sheet, setSheet] = useState(false);
  const addToPlaylist = () =>
    openAddToPlaylist(
      {
        track_name: play.title,
        artist_name: play.artist,
        album_name: play.album,
        duration_ms: (play.length_s ?? 0) * 1000,
      },
      rowRef.current?.querySelector<HTMLElement>('[aria-label^="More for"]'),
    );
  const trackId = play.track_id ? String(play.track_id) : null;
  const star = useStar(trackId);
  const anchor = () => rowRef.current?.querySelector<HTMLElement>('[aria-label^="More for"]');
  // 24a's one order (Play next, Mixes well with…, Add to set…, Add to
  // playlist…, Open artist, Open album); Star first in the phone's sheet
  const entries = (sheetStar: boolean) =>
    trackId
      ? trackMenu(
          { id: trackId, title: play.title, artist: play.artist },
          {
            phone: sheetStar,
            star,
            anchor,
            playNext: {
              onSelect: () => queueNext(play),
              disabled: Boolean(away),
              reason: away?.words,
            },
            // 277: appends without jumping the queue
            addToUpNext: {
              onSelect: () => window.addToQueue?.(historyTrack(play)),
              disabled: Boolean(away),
              reason: away?.words,
            },
            // Mixes well with… opens the tray in Mix (33a); idle, it plays first
            play: away ? null : () => playNow(play),
            addToPlaylist,
            artistHref: artist,
            albumHref: album,
          },
        )
      : [
          {
            key: 'next',
            label: 'Play next',
            onSelect: () => queueNext(play),
            disabled: Boolean(away),
            reason: away?.words,
          },
          { key: 'playlist', label: 'Add to playlist…', onSelect: addToPlaylist },
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
            ? [{ key: 'album', label: 'Open album', onSelect: () => window.location.assign(album) }]
            : []),
        ];
  const meta = (
    <>
      {artist ? <a href={artist}>{play.artist}</a> : play.artist || 'Unknown artist'}
      {gone ? (
        <> · {play.was_in_library ? 'no longer in your library' : 'not in your library'}</>
      ) : (
        <>
          {/* on a phone the album is in the "…" sheet's Open album (15d) */}
          {play.album && !phone ? (
            <> · {album ? <a href={album}>{play.album}</a> : play.album}</>
          ) : null}
          {play.format ? (
            <>
              {' · '}
              <span className={play.below_target ? styles.below : undefined}>{play.format}</span>
            </>
          ) : null}
          {play.length_s ? <> · {lengthWords(play.length_s)}</> : null}
          {phone ? null : <DjMeta dj={dj} lead />}
        </>
      )}
      {phrase ? <> · {phrase}</> : null}
      {phone && time ? <> · {time}</> : null}
    </>
  );
  return (
    <li
      ref={rowRef}
      className={styles.row}
      data-gone={gone ? 'true' : undefined}
      data-history-row={play.id}
      data-playing={playing ? 'true' : undefined}
      data-row-play-host=""
      {...rowPlayHandlers(phone || gone || away ? null : () => playNow(play), playing)}
      onClick={
        // 34c: on a phone a tap on the row plays
        phone && !gone && !away
          ? (event) => {
              if ((event.target as HTMLElement).closest('a, button, [role="dialog"]')) return;
              if (!playing) playNow(play);
            }
          : undefined
      }
      data-star-row={trackId ?? undefined}
      data-music=""
    >
      {phone ? null : (
        <time className={styles.time} dateTime={play.played_at.replace(' ', 'T') + 'Z'}>
          {time}
        </time>
      )}
      <Art url={play.image_url} />
      <div className={styles.text}>
        <span className={styles.title}>{play.title}</span>
        <span className={styles.meta}>{meta}</span>
      </div>
      {phone ? null : (
        <span className={styles.tagSlot}>
          {play.below_target && !gone ? (
            <StatusTag tone="warning">Below your target</StatusTag>
          ) : null}
        </span>
      )}
      <span className={styles.starCell}>
        <StarButton id={trackId} title={play.title} />
      </span>
      <div className={styles.actions}>
        {gone ? null : (
          <>
            {phone ? null : (
              // Brief D (34b, 278): the star's column, then Play and Play next
              <RowPlay
                title={play.title}
                playing={playing}
                disabled={away ?? null}
                onPlay={() => playNow(play)}
                onPlayNext={() => queueNext(play)}
              />
            )}
            {phone ? (
              // 15d: "…" opens the phone's action sheet
              <>
                <button
                  type="button"
                  className={styles.phoneMore}
                  aria-label={`More for ${play.title}`}
                  aria-haspopup="dialog"
                  aria-expanded={sheet}
                  onClick={() => setSheet(true)}
                >
                  <MoreDotsIcon />
                </button>
                {sheet ? (
                  <ActionSheet
                    label={`More for ${play.title}`}
                    heading={[play.title, play.artist].filter(Boolean).join(' · ')}
                    onClose={() => setSheet(false)}
                    actions={entries(true)}
                  />
                ) : null}
              </>
            ) : (
              <MoreMenu
                className={styles.more}
                label={`More for ${play.title}`}
                entries={entries(false)}
              />
            )}
          </>
        )}
      </div>
    </li>
  );
}

function MoreDotsIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  );
}

function SpokenRow({ play, phone }: { play: SpokenHistoryPlay; phone: boolean }) {
  const time = clockTime(play.played_at);
  const { lead, progress, resumable } = spokenParts(play);
  const playable = Boolean(play.src);
  return (
    <li className={styles.row} data-history-row={`${play.kind}-${play.play_id}`}>
      {phone ? null : (
        <time className={styles.time} dateTime={play.played_at.replace(' ', 'T') + 'Z'}>
          {time}
        </time>
      )}
      <Art url={play.image_url} />
      <div className={styles.text}>
        <span className={styles.title}>{play.title}</span>
        <span className={styles.meta}>
          {lead}
          {progress ? (
            <>
              {lead ? ' · ' : ''}
              <span className={resumable ? styles.progress : undefined}>{progress}</span>
            </>
          ) : null}
          {phone && time ? <> · {time}</> : null}
        </span>
      </div>
      {phone ? null : <span className={styles.tagSlot} />}
      <div className={styles.actions}>
        {playable ? (
          <button
            type="button"
            className={resumable ? styles.play : styles.ghostPlay}
            aria-label={
              resumable ? `Resume ${play.title}, ${progress}` : `Play ${play.title} again`
            }
            title={resumable ? 'Resume from where you left off' : 'Play from the start'}
            onClick={() => playSpoken(play)}
          >
            <PlayIcon />
          </button>
        ) : null}
      </div>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <ul className={styles.list} aria-hidden="true">
      {Array.from({ length: 6 }, (_v, i) => (
        <li key={i} className={styles.row}>
          <Skeleton className={styles.skeletonTime} />
          <Skeleton className={styles.art} />
          <div className={styles.text}>
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonMeta} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Library → Listening history (13a, 13b): what this profile played, newest
 * first, by day. Kind and Range sit under the header; the range is
 * remembered per browser and the URL holds the kind, an explicit range and
 * the filter.
 */
export function HistoryPage({
  search,
  go,
  awayDrive = null,
}: {
  search: LibrarySearch;
  go: Go;
  /** The library's drive while it's away (123): music rows' Play waits for it. */
  awayDrive?: string | null;
}) {
  const awayId = useId();
  const away = awayDrive ? { id: awayId, words: awayWords(awayDrive) } : undefined;
  const { profileId } = useProfile();
  const phone = usePhone();
  const kind: HistoryKind = search.kind;
  const [remembered, setRemembered] = useState<HistoryRange>(() => readRememberedRange());
  const range: HistoryRange = search.range || remembered;
  const q = search.q.trim();
  const tz = useMemo(() => browserTz(), []);

  const counts = useQuery(historyCountsQueryOptions(profileId, tz));
  const query = useInfiniteQuery(historyInfiniteQueryOptions(profileId, { kind, range, q }, tz));
  const pages = query.data?.pages ?? [];
  const first = pages[0];
  const playingId = usePlayingTrackId();
  const items = useMemo(
    () => pages.flatMap((p) => p.items as (MusicPlay | SpokenHistoryPlay)[]),
    [pages],
  );
  const days = useMemo(
    () => Object.assign({}, ...pages.map((p) => p.days)) as Record<string, number>,
    [pages],
  );
  const total = first?.total ?? 0;
  const groups = useMemo(() => groupByDay(items), [items]);
  const now = new Date();

  const pickRange = (next: HistoryRange) => {
    rememberRange(next);
    setRemembered(next);
    // the remembered range is the default, so the URL only names another
    go({ range: undefined }, { replace: true });
  };

  const music = first && kind === 'music' ? (first as MusicHistoryPage) : null;
  const wider = widerRange(range);
  // BPM and key on the music rows (the library's DJ data), one request per page set
  const djInfo = useDjInfo(
    kind === 'music' ? items.map((p) => (p.kind === 'music' ? p.track_id : null)) : [],
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headText}>
          <div className={styles.titleRow}>
            <h1 className={styles.heading}>Listening history</h1>
            <a className={styles.statsLink} href="/stats">
              Stats
            </a>
          </div>
          <p className={styles.subtitle}>
            What you&apos;ve played, newest first. Music here feeds Stats and scrobbling; podcasts
            and audiobooks are kept apart.
          </p>
        </div>
        <div className={styles.headActions}>
          <FilterField
            value={search.q}
            onChange={(next) => go({ q: next }, { replace: true })}
            placeholder="Filter by title, artist or album"
            phonePlaceholder="Title, artist or album"
            label="Filter what you played"
          />
          <a className={styles.openStats} href="/stats">
            Open Stats
          </a>
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.kindRow} role="group" aria-labelledby="history-kind-label">
          <span className={styles.rowLabel} id="history-kind-label">
            Kind
          </span>
          <div className={styles.kinds}>
            {HISTORY_KINDS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={styles.chip}
                aria-pressed={kind === option.value}
                onClick={() => go({ kind: option.value === 'music' ? undefined : option.value })}
              >
                {option.label}
                <CountBadge count={counts.data?.[option.value][range]} />
              </button>
            ))}
          </div>
        </div>
        <div className={styles.ranges} role="group" aria-label="Range">
          {HISTORY_RANGES.map((option) => (
            <button
              key={option.value}
              type="button"
              className={styles.chip}
              aria-pressed={range === option.value}
              onClick={() => pickRange(option.value)}
            >
              {phone ? option.short : option.label}
            </button>
          ))}
        </div>
      </div>

      {first && total > 0 ? (
        <p className={styles.metaLine}>
          {historyMeta({
            kind,
            range,
            total,
            filtered: Boolean(q),
            sources: music?.sources,
            sharedWith: music?.shared_with,
          })}
        </p>
      ) : null}

      {query.isError ? (
        <>
          <Notice
            tone="danger"
            role="alert"
            title="Couldn't load what you played"
            actions={
              <Button size="lg" variant="secondary" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          >
            SYNCHRO.S couldn&apos;t read your listening history just now. Nothing is lost; this is a
            display problem.
          </Notice>
          <div className={styles.faded}>
            <RowsSkeleton />
          </div>
        </>
      ) : query.isPending ? (
        <RowsSkeleton />
      ) : items.length ? (
        <div className={styles.groups} data-history-kind={kind}>
          {away ? (
            <span id={away.id} className={styles.srOnly}>
              {away.words}
            </span>
          ) : null}
          {groups.map((group) => (
            <section key={group.day} className={styles.group} aria-label={dayHead(group.day, now)}>
              <h2 className={styles.dayHead}>
                <span className={styles.dayName}>{dayHead(group.day, now, phone)}</span>
                {phone || days[group.day] === undefined ? null : (
                  <span className={styles.dayCount}>
                    · {plural(days[group.day], kind === 'podcast' ? 'episode' : 'play')}
                  </span>
                )}
              </h2>
              <ul className={styles.list}>
                {group.items.map((play) =>
                  play.kind === 'music' ? (
                    <MusicRow
                      key={`m-${play.id}`}
                      play={play}
                      phone={phone}
                      playing={Boolean(play.track_id) && String(play.track_id) === playingId}
                      dj={play.track_id ? djInfo[String(play.track_id)] : undefined}
                      away={away}
                    />
                  ) : (
                    <SpokenRow key={`s-${play.play_id}`} play={play} phone={phone} />
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          <h2>{emptyTitle(kind, range, Boolean(q))}</h2>
          <div className={styles.emptyActions}>
            {q ? (
              <Button size="lg" variant="secondary" onClick={() => go({ q: '' })}>
                Clear the filter
              </Button>
            ) : wider ? (
              <Button size="lg" variant="secondary" onClick={() => pickRange(wider)}>
                Try{' '}
                {HISTORY_RANGES.find((r) => r.value === wider)!.label.replace(
                  'All time',
                  'all time',
                )}
              </Button>
            ) : null}
            {kind === 'music' ? (
              <Button size="lg" variant="ghost" onClick={() => void window.startLibraryRadio?.()}>
                Shuffle your library
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {items.length ? (
        <div className={styles.footer}>
          <span>
            {items.length.toLocaleString()} of {total.toLocaleString()}
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
                : `Show ${Math.min(HISTORY_PAGE_SIZE, total - items.length)} more`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
