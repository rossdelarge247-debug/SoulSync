/**
 * A station (4b, 4c, 4d, 4h): the header with the stream picker, Favourite
 * and Play / Stop; Now playing in its states; the auto-add card and its
 * confirm; Heard on this station; shows with tracklists and how tracks are
 * identified. Failures sit at the top as Notices.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import type { NowPlaying, Station } from '@/features/radio/radio.types';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, Select } from '@/components/form';
import { Notice, Skeleton, Spinner, StatusTag } from '@/components/primitives';
import {
  agoWords,
  durationWords,
  possessive,
  secondsSince,
  shortName,
  sourceWords,
} from '@/features/radio/radio.format';
import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import {
  autoAddQueryOptions,
  RADIO_KEY,
  setAutoAdd,
  setFavourite,
  showsQueryOptions,
  stationQueryOptions,
} from '../-radio.api';
import { playStation, radioSession, useRadioSession, useTick } from '../-radio.session';
import { StationHeard } from './heard-list';
import {
  ChevronIcon,
  HowIdentified,
  isPlaying,
  NoteIcon,
  StarIcon,
  StationLogo,
  StopIcon,
  PlayIcon,
} from './parts';
import styles from './radio.module.css';

function QuestionIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01" />
    </svg>
  );
}

function stationLine(station: Station): string {
  const where = [station.genre || station.kind_label, station.city || station.country]
    .filter(Boolean)
    .join(' · ');
  const from =
    station.source === 'built_in'
      ? 'Built-in pick'
      : station.source === 'directory'
        ? 'From the directory'
        : 'Your link';
  const publishes =
    station.has_now_playing && station.has_tracklists
      ? 'Publishes what’s playing and tracklists after shows'
      : station.has_now_playing
        ? 'Publishes what’s playing'
        : 'Names come from the stream';
  return [where, from, publishes].filter(Boolean).join(' · ');
}

/** Now playing (4b, 4c): identified, Listening…, Not identified, off, unavailable. */
export function NowPlayingCard({
  station,
  np,
  skew,
  playingHere,
  adding,
  onAdd,
}: {
  station: Station;
  np: NowPlaying | null;
  skew: number;
  playingHere: boolean;
  adding: boolean;
  onAdd: () => void;
}) {
  useTick(5000);
  if (!playingHere && (!np || !np.playing)) {
    return (
      <section className={styles.panel} aria-label="Now playing">
        <div className={styles.now}>
          <span className={styles.nowArt} data-quiet="true">
            <NoteIcon />
          </span>
          <div className={styles.nowText}>
            <p className={styles.label}>Now playing</p>
            <p className={styles.nowTitle}>Not playing</p>
            <p className={styles.nowSource}>
              Press Play: what’s on is identified while you listen.
            </p>
          </div>
          <div className={styles.nowAside}>
            <Button
              size="lg"
              variant="primary"
              onClick={() => playStation(station.id, { station })}
            >
              Play
            </Button>
          </div>
        </div>
      </section>
    );
  }
  const state = np?.state ?? 'listening';
  if (state === 'identified' && np?.track) {
    const lib = np.library;
    const ago = agoWords(secondsSince(np, skew));
    return (
      <section className={styles.panel} aria-label="Now playing">
        <div className={styles.now}>
          <span className={styles.nowArt}>
            {np.track.art_url?.startsWith('https://') ? (
              <img src={np.track.art_url} alt="" />
            ) : (
              <NoteIcon />
            )}
          </span>
          <div className={styles.nowText} aria-live="polite">
            <p className={styles.label}>Now playing</p>
            <p className={styles.nowTitle}>{np.track.title}</p>
            <p className={styles.nowLine}>
              <span className={styles.artist}>{np.track.artist}</span>
              {np.track.release ? ` · ${np.track.release}` : ''}
            </p>
            <p className={styles.nowSource}>
              {sourceWords(np.source, station.name)} · {ago}
            </p>
          </div>
          <div className={styles.nowAside}>
            {lib?.in_library && lib.below_target ? (
              <>
                <StatusTag tone="warning">Below quality target</StatusTag>
                <Button
                  size="lg"
                  disabled={adding || !np.heard_id}
                  disabledReason={!np.heard_id ? 'In a moment' : undefined}
                  onClick={onAdd}
                >
                  Upgrade via Wanted
                </Button>
              </>
            ) : lib?.in_library ? (
              <>
                <StatusTag tone="success">In your library</StatusTag>
                <span className={styles.nowAsideNote}>Already yours</span>
              </>
            ) : np.on_wanted ? (
              <>
                <StatusTag tone="info" live>
                  On Wanted · Searching
                </StatusTag>
                {np.added_at ? <span className={styles.nowAsideNote}>Added {ago}</span> : null}
              </>
            ) : (
              <>
                <Button
                  size="lg"
                  variant="primary"
                  disabled={adding || !np.heard_id}
                  disabledReason={!np.heard_id ? 'In a moment, once it’s in Heard' : undefined}
                  onClick={onAdd}
                >
                  {adding ? 'Adding…' : 'Add to Wanted'}
                </Button>
                <span className={styles.nowAsideNote}>
                  at your quality target · not in your library
                </span>
              </>
            )}
          </div>
        </div>
      </section>
    );
  }
  if (state === 'listening') {
    const started = np?.started_at
      ? Math.max(0, Math.round(Date.now() / 1000 - skew - np.started_at))
      : 0;
    return (
      <section className={styles.panel} aria-label="Now playing">
        <div className={styles.now}>
          <span className={styles.nowArt} data-quiet="true">
            <Spinner size={24} />
          </span>
          <div className={styles.nowText} role="status" aria-live="polite">
            <p className={styles.label}>Now playing</p>
            <p className={styles.nowTitle}>Listening…</p>
            <p className={styles.nowLine}>
              {started ? `A new track started ${agoWords(started)}. ` : ''}Its name usually arrives
              within a minute
              {np?.previous_title ? `; the last one was ${np.previous_title}.` : '.'}
            </p>
          </div>
          <div className={styles.nowAside}>
            <Button size="lg" disabled disabledReason="Once it’s identified">
              Add to Wanted
            </Button>
          </div>
        </div>
      </section>
    );
  }
  const playingFor = np?.started_at ? Math.max(0, Date.now() / 1000 - skew - np.started_at) : 0;
  return (
    <section className={styles.panel} aria-label="Now playing">
      <div className={styles.now}>
        <span className={styles.nowArt} data-quiet="true">
          <QuestionIcon />
        </span>
        <div className={styles.nowText} aria-live="polite">
          <p className={styles.label}>Now playing</p>
          <p className={styles.nowTitle}>Not identified</p>
          <p className={styles.nowLine}>
            {state === 'off'
              ? 'Identification is off.'
              : state === 'unavailable'
                ? np?.reason
                : `${playingFor >= 90 ? `Playing for ${durationWords(playingFor).replace('about ', '')} without a match. ` : ''}${np?.reason ?? 'Mixes, talk and live sessions often can’t be identified.'} It’s kept in Heard on ${station.name} with its time, so you can look it up on the station’s schedule.`}
          </p>
        </div>
        {station.homepage && state !== 'off' ? (
          <div className={styles.nowAside}>
            <a
              className={styles.inlineLink}
              href={station.homepage}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open {possessive(station.name)} schedule
            </a>
            <span className={styles.nowAsideNote}>We’ll try again as it plays</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The auto-add card (4b) and its confirm (4d). */
function AutoAddCard({
  station,
  identificationOn,
  openConfirm,
  onOpenConfirm,
}: {
  station: Station;
  identificationOn: boolean;
  openConfirm: boolean;
  onOpenConfirm: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const numbers = useQuery(autoAddQueryOptions(station.id));
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => setAutoAdd(station.id, enabled),
    onSuccess: (data, enabled) => {
      queryClient.setQueryData([...RADIO_KEY, 'auto-add', station.id], { success: true, ...data });
      void queryClient.invalidateQueries({ queryKey: [...RADIO_KEY, 'station', station.id] });
      onOpenConfirm(false);
      window.showToast?.(
        enabled ? `Auto-add is on for ${station.name}.` : `Auto-add is off for ${station.name}.`,
        'success',
      );
    },
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
  });
  const n = numbers.data;
  const on = Boolean(n?.enabled);
  const blocked = !identificationOn
    ? 'Track identification is off'
    : n && !n.can_download
      ? 'Needs download rights'
      : null;
  const yesterday = n?.identified_yesterday ?? 0;

  return (
    <section className={styles.panel} aria-labelledby="station-auto-title">
      <div className={styles.auto}>
        <button
          type="button"
          role="switch"
          className={styles.switch}
          aria-checked={on}
          aria-labelledby="station-auto-title"
          aria-disabled={blocked && !on ? 'true' : undefined}
          title={blocked && !on ? blocked : undefined}
          onClick={() => {
            if (mutation.isPending) return;
            if (on) mutation.mutate(false);
            else if (!blocked) onOpenConfirm(true);
          }}
        >
          <span className={styles.switchTrack} aria-hidden="true" />
          {on ? 'On' : 'Off'}
        </button>
        <div>
          <h2 className={styles.autoTitle} id="station-auto-title">
            Auto-add what {station.name} plays to Wanted
          </h2>
          <p className={styles.autoBody}>
            When on, every track identified on this station that you don’t have goes to Wanted at
            your quality target. What you have or already want is skipped, and each addition shows
            in Activity.
            {yesterday
              ? ` It can add a lot: ${station.name} identified about ${yesterday} tracks yesterday.`
              : ''}
          </p>
          <p className={styles.autoNote}>
            {blocked && !on
              ? `${blocked}, so auto-add can’t be turned on.`
              : `Turning it on asks first. Off by default on every station.${
                  n ? ` At most ${n.daily_limit} a day.` : ''
                }${!station.has_now_playing ? ' This station has no now-playing feed, so it adds only while someone listens.' : ''}`}
          </p>
        </div>
      </div>
      <DialogFrame
        open={openConfirm}
        onOpenChange={(open) => onOpenConfirm(open)}
        className={styles.confirm}
      >
        <DialogHeader title={`Add everything ${station.name} plays to Wanted?`} />
        <DialogBody>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Identified yesterday</span>
              <span className={styles.tileValue}>{n?.identified_yesterday ?? '—'}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>You already have</span>
              <span className={styles.tileValue}>{n?.already_have ?? '—'}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.tileLabel}>Would have been added</span>
              <span className={styles.tileValue}>{n?.would_add ?? '—'}</span>
              {n && n.would_add_without_limit > n.would_add ? (
                <span className={styles.tileNote}>
                  of {n.would_add_without_limit}, at the daily limit
                </span>
              ) : null}
            </div>
          </div>
          <p className={styles.dialogText}>
            While this is on, each track identified on {station.name} goes to Wanted at your quality
            target, unless you have it or it’s already there. SYNCHRO.S looks for them on the next
            scheduled search and lists each addition in Activity. At most {n?.daily_limit ?? 50} a
            day from this station, so one busy day can’t fill Wanted.
          </p>
          <p className={styles.dialogNote}>
            You can turn it off any time. What was added stays on Wanted until you remove it there.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button size="lg" onClick={() => onOpenConfirm(false)}>
            Cancel
          </Button>
          <Button
            size="lg"
            variant="primary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(true)}
          >
            Turn on auto-add for {station.name}
          </Button>
        </DialogFooter>
      </DialogFrame>
    </section>
  );
}

function ShowsCard({ station }: { station: Station }) {
  const query = useQuery({ ...showsQueryOptions(station.id), enabled: station.has_tracklists });
  if (!station.has_tracklists) return null;
  const shows = query.data?.shows ?? [];
  const day = (unix: number | null) => {
    if (!unix) return '';
    const d = new Date(unix * 1000);
    const today = new Date();
    const yest = new Date(Date.now() - 86_400_000);
    const t = d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    if (d.toDateString() === today.toDateString()) return `Today ${t}`;
    if (d.toDateString() === yest.toDateString()) return `Yesterday ${t}`;
    return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
  };
  return (
    <section className={styles.panel} aria-labelledby="radio-shows">
      <div
        className={styles.panelHead}
        style={{ flexDirection: 'column', alignItems: 'flex-start' }}
      >
        <h2 className={styles.panelTitle} id="radio-shows">
          Shows with tracklists
        </h2>
        <span className={styles.panelMeta}>
          Published by {shortName(station.name)} after each show, usually within an hour.
        </span>
      </div>
      {query.isPending ? (
        <div className={styles.panelPad}>
          <Skeleton style={{ height: 48 }} />
        </div>
      ) : query.isError ? (
        <div className={styles.panelPad}>
          <p className={styles.howNote}>{(query.error as Error).message}</p>
        </div>
      ) : shows.length === 0 ? (
        <div className={styles.panelPad}>
          <p className={styles.howNote}>
            No tracklists yet. Shows appear here once {shortName(station.name)} publishes them
            {station.id.startsWith('nts')
              ? ' (shows aired while SYNCHRO.S was watching or listening)'
              : ''}
            .
          </p>
        </div>
      ) : (
        <div className={styles.shows}>
          {shows.map((show) => (
            <Link
              key={show.id}
              className={styles.show}
              to="/radio/tracklist"
              search={{ show: show.id }}
            >
              <span>
                <span className={styles.showTitle}>{show.title}</span>
                <br />
                <span className={styles.showMeta}>
                  {[
                    day(show.aired_at),
                    show.track_count != null ? `${show.track_count} tracks` : '',
                    show.missing_count != null ? `${show.missing_count} you don’t have` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <ChevronIcon className={styles.showChevron} />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export function StationPage({
  stationId,
  confirmAutoAdd,
}: {
  stationId: string;
  confirmAutoAdd: boolean;
}) {
  useReactPageShell('radio');
  const { isAdmin } = useProfile();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({ ...stationQueryOptions(stationId), refetchInterval: 15_000 });
  const session = useRadioSession();
  const [streamId, setStreamId] = useState<string>('');
  const [confirm, setConfirm] = useState(confirmAutoAdd);
  useEffect(() => setConfirm(confirmAutoAdd), [confirmAutoAdd]);

  const data = query.data;
  const station = data?.station;
  const playingHere = station ? isPlaying(session, station.id) : false;
  const np = playingHere && session.nowPlaying ? session.nowPlaying : (data?.now_playing ?? null);
  const failed =
    station && session.station?.id === station.id && session.status === 'error'
      ? session.error
      : null;
  const fav = useMutation({
    mutationFn: (on: boolean) => setFavourite(stationId, on),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: RADIO_KEY }),
    onError: (error: Error) => window.showToast?.(error.message, 'error'),
  });
  const otherStream = useMemo(
    () => station?.streams.find((s) => s.id !== (session.stream?.id ?? station.streams[0]?.id)),
    [station, session.stream],
  );

  if (query.isPending) {
    return (
      <div className={styles.page} aria-busy="true">
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 240 }} />
      </div>
    );
  }
  if (query.isError || !station || !data) {
    return (
      <div className={styles.page}>
        <nav className={styles.crumbs} aria-label="Breadcrumb">
          <Link to="/radio">Radio</Link>
        </nav>
        <Notice tone="danger" title="This station couldn’t be opened">
          {(query.error as Error | null)?.message ??
            'It isn’t in the list, the directory or your links.'}
        </Notice>
      </div>
    );
  }
  const admin = data.is_admin ?? isAdmin;
  const identificationOn = data.identification;
  const currentStream = session.stream?.id ?? (streamId || station.streams[0]?.id || '');
  const lossless = station.streams.some((s) => s.lossless);

  const play = (sid?: string) =>
    playStation(station.id, { station, streamId: sid ?? (streamId || undefined) });

  return (
    <div className={styles.page} data-testid="station-page">
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/radio">Radio</Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{station.name}</span>
      </nav>

      {failed ? (
        <Notice
          tone="danger"
          title={`${station.name} isn’t playing right now`}
          actions={
            <>
              <Button size="lg" onClick={() => void radioSession()?.retry()}>
                Try again
              </Button>
              {otherStream ? (
                <Button size="lg" variant="ghost" onClick={() => play(otherStream.id)}>
                  Try the {otherStream.label.replace(' (best offered)', '')} stream
                </Button>
              ) : null}
            </>
          }
        >
          {failed.code === 'busy'
            ? failed.message
            : `${failed.message} Nothing else is affected, and Heard on ${station.name} is kept.`}
        </Notice>
      ) : null}
      {!identificationOn ? (
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
          The station plays, but nothing is identified, so there’s no Add to Wanted, no auto-add and
          no Heard list.
          {admin ? '' : ' An admin can turn it on in Settings → Radio.'}
        </Notice>
      ) : np?.state === 'unavailable' ? (
        <Notice
          tone="warning"
          title="Can’t identify tracks on this station right now"
          actions={
            admin ? (
              <Button size="lg" onClick={() => void navigate({ to: '/setup-check' })}>
                Run Setup check
              </Button>
            ) : undefined
          }
        >
          {np.reason} Heard on this station keeps the times, so you can look them up later.
        </Notice>
      ) : null}

      <div className={`${styles.stationHead} ${failed ? '' : ''}`}>
        <StationLogo station={station} big />
        <div>
          <div className={styles.stationTitleRow}>
            <h1 className={styles.stationName}>{station.name}</h1>
            {playingHere ? (
              <StatusTag tone="info" live>
                Playing
              </StatusTag>
            ) : failed ? (
              <StatusTag tone="danger">Not playing</StatusTag>
            ) : null}
          </div>
          <p className={styles.stationSub}>{stationLine(station)}</p>
          {station.description ? <p className={styles.stationDesc}>{station.description}</p> : null}
          <div className={styles.streamRow}>
            <label className={styles.streamLabel} htmlFor="radio-stream">
              Stream
            </label>
            <Select
              id="radio-stream"
              size="lg"
              value={currentStream}
              onChange={(e) => {
                setStreamId(e.target.value);
                if (playingHere) play(e.target.value);
              }}
            >
              {station.streams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <p className={styles.streamNote}>
            {lossless
              ? 'A lossless stream is offered · quality is what the station declares'
              : 'No lossless stream · quality is what the station declares'}
          </p>
        </div>
        <div className={styles.headActions}>
          {station.source !== 'your_link' ? (
            <Button
              size="lg"
              aria-pressed={station.favourite}
              className={station.favourite ? styles.favOn : undefined}
              onClick={() => fav.mutate(!station.favourite)}
            >
              <span className={styles.star} data-on={station.favourite ? 'true' : undefined}>
                <StarIcon filled={station.favourite} />
              </span>
              {station.favourite ? 'Favourite' : 'Add to Favourites'}
            </Button>
          ) : null}
          {playingHere ? (
            <Button size="lg" onClick={() => void radioSession()?.stop()}>
              <StopIcon /> Stop
            </Button>
          ) : (
            <Button size="lg" variant="primary" onClick={() => play()}>
              <PlayIcon /> Play
            </Button>
          )}
          {station.homepage ? (
            <a
              className={styles.play}
              href={station.homepage}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${possessive(station.name)} website`}
              title="The station’s website"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </a>
          ) : null}
        </div>
      </div>

      <div className={`${styles.grid} ${failed ? styles.faded : ''}`}>
        <div className={styles.col}>
          <NowPlayingCard
            station={station}
            np={identificationOn ? np : { ...(np ?? ({} as NowPlaying)), state: 'off' }}
            skew={session.skew}
            playingHere={playingHere}
            adding={session.adding}
            onAdd={() => {
              if (playingHere)
                void radioSession()
                  ?.addToWanted()
                  .then((ok) => ok && window.showToast?.('Added to Wanted.', 'success'));
            }}
          />
          <AutoAddCard
            station={station}
            identificationOn={identificationOn}
            openConfirm={confirm}
            onOpenConfirm={(open) => {
              setConfirm(open);
              if (!open && confirmAutoAdd) {
                void navigate({
                  to: '/radio/station/$stationId',
                  params: { stationId },
                  search: {},
                  replace: true,
                });
              }
            }}
          />
          {identificationOn ? (
            <StationHeard
              stationId={station.id}
              stationName={station.name}
              homepage={station.homepage}
              identificationOn={identificationOn}
            />
          ) : null}
        </div>
        <div className={styles.col}>
          <ShowsCard station={station} />
          <HowIdentified station={station} />
        </div>
      </div>
    </div>
  );
}
