import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { DialogFrame } from '@/components/dialog';
import { Button } from '@/components/form';
import { Checkbox } from '@/components/form/form';
import { LoadingState, Notice } from '@/components/primitives';

import type { DjMatch, DjMixesResponse, DjTrack } from './dj.api';
import type { TraktorSource } from './traktor.api';

import { CamelotWheel } from './camelot-wheel';
import { addTrackToPlaylist, playTrackNext } from './dj-actions';
import { djMixesQueryOptions, djStatusQueryOptions, postDjJob } from './dj.api';
import { bpmNumber, bpmRelationWords, keyRelationWords, keyTitle } from './dj.format';
import styles from './dj.module.css';
import { KeyChip } from './key-chip';
import { MakePlaylistDialog } from './make-playlist-dialog';
import {
  WIDE_WITHIN,
  closeMixes,
  openMixes,
  setMixesFollow,
  setMixesWithin,
  useMixes,
  type MixesSeed,
} from './mixes-store';
import { watchPlayingTrack } from './playing-track';
import { TraktorExportDialog } from './traktor-export-dialog';

/** The panel docks beside the page from here up; under it, it lies over the page. */
export const DOCK_QUERY = '(min-width: 1100px)';
/** Phones get the sheet (17d), as the shell's own phone layout starts. */
export const SHEET_QUERY = '(max-width: 768px)';

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const on = () => setMatches(list.matches);
    on();
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}

/** Between the shell's top bar and its player (their heights live in static/shell.css and player.css). */
const SHELL_PLACE = {
  top: 'var(--ss-topbar-h, 64px)',
  bottom: 'var(--ss-player-h, 0px)',
  fontFamily: 'var(--ss-shell-font, inherit)',
} as const;

/* ── icons ─────────────────────────────────────────────────────────────── */

function PlayNextIcon() {
  return (
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
      <path d="M5 4l10 8-10 8V4zM19 5v14" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
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
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

/* ── words ─────────────────────────────────────────────────────────────── */

/** "Tidewater · 124 BPM · A minor": the header's line. */
export function seedLine(track: DjTrack | null | undefined): string {
  if (!track) return '';
  const dj = track.dj;
  return [
    track.artist_name,
    dj?.bpm ? `${bpmNumber(dj.bpm)} BPM` : '',
    dj?.key_long ? `${dj.key_uncertain ? 'Maybe ' : ''}${dj.key_long}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The rule in two lines, under the wheel (17a). */
export function ruleLines(track: DjTrack | null | undefined, within: number): [string, string] {
  const key = track?.dj?.key ?? '';
  const relative = key.endsWith('A')
    ? 'its relative major'
    : key.endsWith('B')
      ? 'its relative minor'
      : 'its relative major or minor';
  const bpm = track?.dj?.bpm;
  return [
    `Same key, one step round the wheel, or ${relative}.`,
    `Within ${within}% of ${bpm ? `${bpmNumber(bpm)} BPM` : 'its tempo'}, or half and double time.`,
  ];
}

/** "Same key · −1.6%" */
export function howItMixes(match: DjMatch): string {
  return `${keyRelationWords(match.key_relation, match.dj?.key ?? null)} · ${bpmRelationWords(
    match.bpm_relation,
    match.bpm_diff_pct,
  )}`;
}

export function countWords(total: number): string {
  return `${total.toLocaleString()} ${total === 1 ? 'track mixes' : 'tracks mix'} with it`;
}

/* ── the rows ─────────────────────────────────────────────────────────── */

function MatchRow({ match, phone }: { match: DjMatch; phone: boolean }) {
  const plusRef = useRef<HTMLButtonElement>(null);
  const dj = match.dj;
  const how = howItMixes(match);
  return (
    <li className={styles.mixRow} data-mix-row={match.id}>
      <span className={styles.mixArt} aria-hidden="true">
        {match.image_url ? <img src={match.image_url} alt="" loading="lazy" /> : null}
      </span>
      <span className={styles.mixText}>
        <span className={styles.mixTitle}>{match.title}</span>
        {phone ? (
          <span className={styles.mixMeta}>
            {dj?.key ? (
              <KeyChip
                code={dj.key}
                uncertain={dj.key_uncertain}
                title={keyTitle(dj)}
                variant="text"
              />
            ) : null}
            {dj?.key ? ' · ' : null}
            {how}
          </span>
        ) : (
          <span className={styles.mixMetaRow}>
            {dj?.key ? (
              <KeyChip
                code={dj.key}
                uncertain={dj.key_uncertain}
                title={keyTitle(dj)}
                className={styles.mixChip}
              />
            ) : null}
            {dj?.bpm ? <span className={styles.mixBpm}>{bpmNumber(dj.bpm)}</span> : null}
            <span className={styles.mixHow}>{how}</span>
          </span>
        )}
      </span>
      <button
        type="button"
        className={styles.mixButton}
        aria-label={`Play ${match.title} next`}
        title="Play next"
        onClick={() => playTrackNext(match)}
      >
        <PlayNextIcon />
      </button>
      <button
        ref={plusRef}
        type="button"
        className={styles.mixButton}
        aria-label={`Add ${match.title} to a playlist`}
        title="Add to playlist"
        onClick={() => addTrackToPlaylist(match, plusRef.current)}
      >
        <PlusIcon />
      </button>
    </li>
  );
}

/** Not analysed yet (17b): why, how far the queue is, and "analyse it now" for admins. */
function NotAnalysed({ track, onQueued }: { track: DjTrack | null; onQueued: () => void }) {
  const status = useQuery({ ...djStatusQueryOptions(), retry: false });
  const [asked, setAsked] = useState<'idle' | 'asking' | 'queued'>('idle');
  const dj = track?.dj;
  const missing = dj?.key ? 'tempo' : 'key';
  if (dj?.skipped) {
    return (
      <p className={styles.stateLine}>
        SYNCHRO.S can&apos;t work out this track&apos;s {missing}: {dj.skipped}.
      </p>
    );
  }
  if (dj?.analyzed) {
    return (
      <p className={styles.stateLine}>
        SYNCHRO.S couldn&apos;t work out this track&apos;s {missing}, so there&apos;s nothing to
        match it against.
      </p>
    );
  }
  const s = status.data;
  const ask = async () => {
    setAsked('asking');
    try {
      await postDjJob('start', track?.id);
      setAsked('queued');
      onQueued();
    } catch (err) {
      setAsked('idle');
      window.showToast?.(err instanceof Error ? err.message : "That didn't work.", 'error');
    }
  };
  let rest: ReactNode;
  if (asked === 'queued') rest = ' Working it out now…';
  else if (s && !s.settings.analyze)
    rest = ' Working out BPM and key is off in Settings → Library.';
  else {
    const left = s?.counts.pending ? ` (${s.counts.pending.toLocaleString()} left)` : '';
    rest = (
      <>
        {` It's in the queue${left}`}
        {s?.can_start ? (
          <>
            ;{' '}
            <button
              type="button"
              className={styles.inlineLink}
              disabled={asked === 'asking'}
              onClick={() => void ask()}
            >
              analyse it now
            </button>
            .
          </>
        ) : (
          '.'
        )}
      </>
    );
  }
  return (
    <p className={styles.stateLine} aria-live="polite">
      SYNCHRO.S hasn&apos;t worked out this track&apos;s {missing} yet.{rest}
    </p>
  );
}

/** What sits under the header: loading, the states (17b) or the rows. */
function MixesBody({
  query,
  phone,
  within,
  onQueued,
}: {
  query: ReturnType<typeof useMixesQuery>;
  phone: boolean;
  within: number;
  onQueued: () => void;
}) {
  if (query.isPending) {
    return (
      <div className={styles.stateBox}>
        <LoadingState label="Finding tracks that mix…" />
      </div>
    );
  }
  if (query.isError) {
    const gone =
      (query.error as { response?: { status?: number } } | null)?.response?.status === 404;
    if (gone) {
      return (
        <p className={styles.stateLine}>
          That track isn&apos;t in your library any more, so there&apos;s nothing to match.
        </p>
      );
    }
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't look for tracks that mix"
        actions={
          <Button size="lg" variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        SYNCHRO.S didn&apos;t answer. Nothing is lost; this is a display problem.
      </Notice>
    );
  }
  const data = query.data;
  if (data.reason === 'not_analyzed') {
    return <NotAnalysed track={data.track} onQueued={onQueued} />;
  }
  const dj = data.track?.dj;
  const unsure =
    dj?.key_uncertain && dj.key ? (
      <p className={styles.stateLine} data-mixes-uncertain="">
        Its key sounded like {dj.key}, but SYNCHRO.S isn&apos;t sure, so these matches may not mix.
      </p>
    ) : null;
  if (!data.matches.length) {
    return (
      <>
        {unsure}
        <p className={styles.stateLine}>
          Nothing in your library mixes with it within {data.within ?? within}%.
          {(data.within ?? within) < WIDE_WITHIN ? (
            <>
              {' '}
              <button
                type="button"
                className={styles.inlineLink}
                onClick={() => setMixesWithin(WIDE_WITHIN)}
              >
                Widen to {WIDE_WITHIN}%
              </button>
            </>
          ) : null}
        </p>
      </>
    );
  }
  return (
    <>
      {unsure}
      <ul
        className={styles.mixList}
        aria-label={`Tracks that mix well with ${data.track?.title ?? 'this track'}`}
      >
        {data.matches.map((match) => (
          <MatchRow key={match.id} match={match} phone={phone} />
        ))}
      </ul>
    </>
  );
}

function useMixesQuery(seed: MixesSeed, within: number, waiting: boolean) {
  return useQuery({
    ...djMixesQueryOptions(seed.id, within),
    retry: false,
    // "analyse it now": look again until its key is known
    refetchInterval: (q) =>
      waiting && (q.state.data as DjMixesResponse | undefined)?.reason === 'not_analyzed'
        ? 4_000
        : false,
  });
}

/** The panel's set for "Export to Traktor…": the seed and what mixes with it. */
function traktorFrom(trackId: string, within: number): TraktorSource {
  return within === 6
    ? { source: 'mixes', track_id: trackId }
    : { source: 'mixes', track_id: trackId, within };
}

function Foot({
  data,
  tall,
  onMake,
  onExport,
}: {
  data: DjMixesResponse | undefined;
  tall?: boolean;
  onMake: () => void;
  onExport: () => void;
}) {
  if (!data?.matches.length) return null;
  const total = data.total ?? data.matches.length;
  const button = tall ? `${styles.makeButton} ${styles.makeButtonTall}` : styles.makeButton;
  // 21a: the count, then "Make a playlist…" and "Export to Traktor…" side by side
  return (
    <div className={styles.mixFoot}>
      {tall ? null : <span className={styles.mixCount}>{countWords(total)}</span>}
      <div className={styles.footButtons}>
        <Button size="lg" variant="secondary" className={button} onClick={onMake}>
          Make a playlist…
        </Button>
        <Button size="lg" variant="secondary" className={button} onClick={onExport}>
          Export to Traktor…
        </Button>
      </div>
    </div>
  );
}

/**
 * "Mixes well with" docked at the right (17a, HANDOFF 152): 400px on the
 * sidebar's `#101010`, between the top bar and the player. The header
 * (label, the title at 18/600, "artist · BPM · key"), the 148px wheel with
 * the seed and its three neighbours lit beside the rule in two lines,
 * "Follow what's playing", the rows, then the count and "Make a playlist
 * from these…".
 */
export function MixesPanel({
  seed,
  within,
  follow,
  onPick,
  onClose,
  autoFocus = false,
}: {
  seed: MixesSeed;
  within: number;
  follow: boolean;
  onPick?: (code: string) => void;
  onClose: () => void;
  autoFocus?: boolean;
}) {
  const [waiting, setWaiting] = useState(false);
  const [making, setMaking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const query = useMixesQuery(seed, within, waiting);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => setWaiting(false), [seed.id]);
  useEffect(() => {
    if (autoFocus) titleRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const track = query.data?.track ?? null;
  const title = track?.title || seed.title;
  const [ruleA, ruleB] = ruleLines(track, query.data?.within ?? within);
  return (
    <aside
      className={styles.panel}
      aria-label={`Mixes well with ${title}`}
      data-mixes-panel=""
      style={SHELL_PLACE}
    >
      <div className={styles.panelHead}>
        <div className={styles.panelHeadText}>
          <span className={styles.panelLabel}>Mixes well with</span>
          <h2 ref={titleRef} tabIndex={-1} className={styles.panelTitle}>
            {title}
          </h2>
          {track ? <span className={styles.panelMeta}>{seedLine(track)}</span> : null}
        </div>
        <button type="button" className={styles.closeButton} aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className={styles.wheelRow}>
        <CamelotWheel
          size={148}
          seed={track?.dj?.key ?? null}
          uncertain={Boolean(track?.dj?.key_uncertain)}
          onPick={onPick}
        />
        <div className={styles.rule}>
          <span>{ruleA}</span>
          <span>{ruleB}</span>
        </div>
      </div>
      <label className={styles.followRow}>
        <Checkbox checked={follow} onCheckedChange={(on) => setMixesFollow(Boolean(on))} />
        <span>Follow what&apos;s playing</span>
      </label>
      <div className={styles.panelBody}>
        <MixesBody query={query} phone={false} within={within} onQueued={() => setWaiting(true)} />
      </div>
      <Foot data={query.data} onMake={() => setMaking(true)} onExport={() => setExporting(true)} />
      {making && query.data ? (
        <MakePlaylistDialog
          seed={query.data.track}
          matches={query.data.matches}
          onClose={() => setMaking(false)}
        />
      ) : null}
      {exporting ? (
        <TraktorExportDialog
          from={traktorFrom(seed.id, within)}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </aside>
  );
}

/**
 * The phone's sheet (17d): `#141416` from 96px down over a 50% scrim, the
 * grabber, the header ("Tidewater · 124 BPM · 8A A minor", the key's text in
 * its hue), the rows `44px 1fr 44px 44px` with bordered buttons and the key
 * and how it mixes in the meta line, then a 48px "Make a playlist from
 * these…". No wheel: the rows are what a phone needs.
 */
export function MixesSheet({
  seed,
  within,
  onClose,
}: {
  seed: MixesSeed;
  within: number;
  onClose: () => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [making, setMaking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const query = useMixesQuery(seed, within, waiting);
  const track = query.data?.track ?? null;
  const title = track?.title || seed.title;
  const dj = track?.dj;
  return (
    <>
      <DialogFrame
        open={!making && !exporting}
        onOpenChange={(open) => (open ? null : onClose())}
        aria-label={`Mixes well with ${title}`}
        viewportClassName={styles.sheetViewport}
        className={styles.sheet}
      >
        <span className={styles.grabber} aria-hidden="true" />
        <div className={styles.panelHead}>
          <div className={styles.panelHeadText}>
            <span className={styles.panelLabel}>Mixes well with</span>
            <h2 className={`${styles.panelTitle} ${styles.sheetTitle}`}>{title}</h2>
            {track ? (
              <span className={styles.panelMeta}>
                {[track.artist_name, dj?.bpm ? `${bpmNumber(dj.bpm)} BPM` : '']
                  .filter(Boolean)
                  .join(' · ')}
                {dj?.key ? (
                  <>
                    {' · '}
                    <KeyChip
                      code={dj.key}
                      uncertain={dj.key_uncertain}
                      title={keyTitle(dj)}
                      variant="text"
                    />{' '}
                    {dj.key_long}
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
          <button type="button" className={styles.closeButton} aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className={`${styles.panelBody} ${styles.sheetBody}`}>
          <MixesBody query={query} phone within={within} onQueued={() => setWaiting(true)} />
        </div>
        <Foot
          data={query.data}
          tall
          onMake={() => setMaking(true)}
          onExport={() => setExporting(true)}
        />
      </DialogFrame>
      {making && query.data ? (
        <MakePlaylistDialog
          seed={query.data.track}
          matches={query.data.matches}
          onClose={() => setMaking(false)}
        />
      ) : null}
      {exporting ? (
        <TraktorExportDialog
          from={traktorFrom(seed.id, within)}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The one "Mixes well with" (HANDOFF 164): rendered by the router's root, so
 * it survives navigation. On a desktop it docks at the right and the page
 * column makes room (`html[data-mixes-panel]`, from 1100px; narrower, it
 * lies over the page); on a phone it's the sheet. With "Follow what's
 * playing" on, a new library track in the player re-seeds it (once the
 * library knows the track: a stream from elsewhere leaves it as it is).
 */
export function MixesPanelHost() {
  const { seed, follow, within } = useMixes();
  const phone = useMedia(SHEET_QUERY);
  const docked = useMedia(DOCK_QUERY);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const open = Boolean(seed);
  // open already when the page loaded (a seed kept for this tab): don't take the focus
  const wasOpen = useRef(open);
  const justOpened = open && !wasOpen.current;
  useEffect(() => {
    wasOpen.current = open;
  }, [open]);

  // the page column makes room while the panel is docked
  useEffect(() => {
    const root = document.documentElement;
    if (open && !phone) root.dataset.mixesPanel = docked ? 'docked' : 'over';
    else delete root.dataset.mixesPanel;
    return () => {
      delete root.dataset.mixesPanel;
    };
  }, [open, phone, docked]);

  // Follow what's playing: re-seed when the player moves to another library track
  const seedId = seed?.id ?? null;
  useEffect(() => {
    if (!seedId || !follow) return;
    return watchPlayingTrack((track) => {
      if (!track || track.id === seedId) return;
      queryClient
        .fetchQuery(djMixesQueryOptions(track.id))
        .then((data) => {
          if (data.track) openMixes({ id: track.id, title: data.track.title || track.title });
        })
        .catch(() => {
          /* not a library track: keep matching the one shown */
        });
    });
  }, [seedId, follow, queryClient]);

  if (!seed) return null;
  if (phone) return <MixesSheet seed={seed} within={within} onClose={closeMixes} />;
  return createPortal(
    <MixesPanel
      seed={seed}
      within={within}
      follow={follow}
      autoFocus={justOpened}
      onClose={closeMixes}
      onPick={(code) =>
        void navigate({
          to: '/library',
          search: { view: 'tracks', key: code } as never,
        })
      }
    />,
    document.body,
  );
}
