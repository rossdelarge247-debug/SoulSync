/**
 * The Mix tab's views (Mix tab.dc.html): the tray's three columns (29a), the
 * Visuals drawer (29b), the phone's Mix · Set sheet (29c) and the states
 * (29d). The data is `useMixModel`'s; the host (mix-host.tsx) places them.
 *
 * Shared parts, as 24a asks: the key chip, the ten-step energy meter
 * (EnergyMeter's `steps`), the star (StarButton), the step's words and the
 * transition chip's words (core/sets/steps.py through the Sets routes), the
 * track menu's order (track-menu.ts) on the phone's set rows, StatusTags'
 * dots and Notices.
 */
import { Menu } from '@base-ui/react/menu';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { ViewRow } from '@/features/sets/sets.api';

import { Button } from '@/components/form';
import { LoadingState, Notice } from '@/components/primitives';
import { AnalysisLine, SweepLine, useLastSweep } from '@/features/dj/analysis-line';
import { inLineCount, isReady, pending } from '@/features/dj/analysis.format';
import { addTrackToPlaylist, playTrackNext } from '@/features/dj/dj-actions';
import { bpmNumber, keyTitle } from '@/features/dj/dj.format';
import { EnergyMeter } from '@/features/dj/energy-meter';
import { KeyChip } from '@/features/dj/key-chip';
import { trackMenu } from '@/features/dj/track-menu';
import { MIX_SET_CHANGED, setsListQueryOptions } from '@/features/sets/sets.api';
import { StarButton, useStar } from '@/features/stars/star-button';

import type { MixModel } from './mix-model';
import type { MixMatch } from './mix.api';

import {
  backToPlaying,
  moreLikeThis,
  setSheetTab,
  setSuggestFrom,
  setTrayMode,
  setVibe,
  setWide,
  type TrayMode,
} from './mix-store';
import { readClock } from './mix-subject';
import { chooseWorkingSet, startWorkingSet } from './mix.api';
import {
  clockWords,
  energyY,
  joinLead,
  matchesFoot,
  nextTransitionWords,
  setMetaWords,
  stepWord,
  stripLine,
  trackOfWords,
  vibeOffWords,
  workingSetName,
} from './mix.format';
import styles from './mix.module.css';

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

function MoreLikeIcon() {
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
      <path d="M5 12h14M13 6l6 6-6 6" />
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

function MoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

/* ── Now playing · Mix ─────────────────────────────────────────────────── */

/** The tray's two modes (29a; key M). Arrow keys move between them. */
/** Switch the tray's mode and keep the focus on the switch that's shown now. */
function switchMode(next: TrayMode, focus: boolean): void {
  setTrayMode(next);
  if (!focus) return;
  window.requestAnimationFrame(() => {
    const tabs = [
      ...document.querySelectorAll<HTMLElement>(`[data-mix-modes] [data-mode="${next}"]`),
    ];
    (tabs.find((t) => t.getClientRects().length) ?? tabs[0])?.focus();
  });
}

export function ModesSwitch({ mode, large = false }: { mode: TrayMode; large?: boolean }) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    switchMode(mode === 'now' ? 'mix' : 'now', true);
  };
  return (
    <div
      role="tablist"
      aria-label="Tray"
      className={styles.modes}
      data-size={large ? 'lg' : undefined}
      data-mix-modes=""
      onKeyDown={onKey}
    >
      <button
        type="button"
        role="tab"
        className={styles.modeTab}
        aria-selected={mode === 'now'}
        tabIndex={mode === 'now' ? 0 : -1}
        data-mode="now"
        onClick={() => mode !== 'now' && switchMode('now', true)}
      >
        Now playing
      </button>
      <button
        type="button"
        role="tab"
        className={styles.modeTab}
        aria-selected={mode === 'mix'}
        tabIndex={mode === 'mix' ? 0 : -1}
        title="Mix (M)"
        data-mode="mix"
        onClick={() => mode !== 'mix' && switchMode('mix', true)}
      >
        Mix
      </button>
    </div>
  );
}

/* ── this track (29a's left column) ───────────────────────────────────── */

function useClock(active: boolean): string {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const c = readClock();
      setText(c ? `${clockWords(c.at)} / ${clockWords(c.length)}` : '');
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    window.addEventListener('ss:player', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('ss:player', tick);
    };
  }, [active]);
  return text;
}

function KeyAndBpm({ model, long }: { model: MixModel; long: boolean }) {
  const dj = model.dj;
  return (
    <>
      {dj?.key ? (
        <KeyChip code={dj.key} uncertain={dj.key_uncertain} title={keyTitle(dj)} />
      ) : (
        <span className={styles.bpm} title="Key not worked out yet">
          —
        </span>
      )}
      {long && dj?.key_long ? <span className={styles.keyName}>{dj.key_long}</span> : null}
      <span className={styles.bpm}>{dj?.bpm ? `${bpmNumber(dj.bpm)} BPM` : '— BPM'}</span>
    </>
  );
}

/**
 * The Mix tab's header line (31c, 31e): the playing track's analysis while
 * it isn't ready to mix ("Analysing Night Ferry · tempo (2 of 6) · matches
 * follow once it's ready", Cancel while it's in line), "Night Ferry is
 * ready to mix" for 4 s, then nothing. On a phone the sheet's line says how
 * many are in line at its right, and shows a match being analysed too.
 */
function NotAnalysedLine({ model, phone = false }: { model: MixModel; phone?: boolean }) {
  const sweep = useLastSweep();
  const entry = model.progress;
  const title = model.subject?.title ?? null;
  const n = inLineCount(sweep);
  const meta = phone && n ? `${n.toLocaleString('en-GB')} in line` : null;
  if (entry && !isReady(entry)) {
    // Cancel only takes out your own ask (review L4)
    const queued =
      (entry.state === 'queued' || (entry.state === 'waiting' && entry.position !== null)) &&
      Boolean(entry.yours);
    return (
      <AnalysisLine
        size="line"
        entry={entry}
        title={title}
        trackId={model.subject?.id ?? null}
        extra={entry.state === 'working' && !phone ? "matches follow once it's ready" : null}
        action={queued ? { label: 'Cancel', onClick: model.cancelAnalyse } : null}
        meta={meta}
        className={styles.analysisLine}
      />
    );
  }
  // the phone's sheet: a match being analysed shows in its header (31e)
  const current = sweep?.current;
  if (phone && current?.track_id && model.matches.some((m) => m.id === current.track_id))
    return <SweepLine sweep={sweep} action={false} className={styles.analysisLine} />;
  // ready: "Night Ferry is ready to mix", once, then nothing
  return (
    <AnalysisLine
      size="line"
      entry={entry}
      title={title}
      trackId={model.subject?.id ?? null}
      hideWhenReady
      meta={meta}
      className={styles.analysisLine}
    />
  );
}

export function ThisTrack({ model, mode }: { model: MixModel; mode: TrayMode }) {
  const subject = model.subject;
  const clock = useClock(Boolean(subject));
  if (!subject) return null;
  return (
    <>
      <ModesSwitch mode={mode} />
      <div className={styles.now}>
        <span className={styles.art} aria-hidden="true">
          {subject.image ? <img src={subject.image} alt="" /> : null}
        </span>
        <span className={styles.nowText}>
          <span className={styles.nowTitle}>{subject.title}</span>
          <span className={styles.nowArtist}>{subject.artist}</span>
          {clock ? <span className={styles.clock}>{clock}</span> : null}
        </span>
      </div>
      <div className={styles.keyLine}>
        <KeyAndBpm model={model} long />
        <span className={styles.spacer} />
        <span className={styles.star}>
          <StarButton id={subject.id} title={subject.title} variant="player" />
        </span>
      </div>
      <EnergyMeter energy={model.dj?.energy} variant="steps" label />
    </>
  );
}

/* ── Mixes well with (29a's middle column) ────────────────────────────── */

function SuggestFrom({ model }: { model: MixModel }) {
  const end = model.state.from === 'end';
  const noSet = !model.rows.some((r) => r.track);
  return (
    <>
      <span className={styles.headMeta} id="mix-suggest-from">
        Suggest from
      </span>
      <span role="radiogroup" aria-labelledby="mix-suggest-from" className={styles.choices}>
        <button
          type="button"
          role="radio"
          aria-checked={!end}
          className={styles.choice}
          onClick={() => setSuggestFrom('now')}
        >
          Now playing
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={end}
          aria-disabled={noSet ? 'true' : undefined}
          title={noSet ? 'Once the working set has a track' : 'Follow the set’s last track'}
          className={styles.choice}
          onClick={() => (noSet ? null : setSuggestFrom('end'))}
        >
          End of set
        </button>
      </span>
    </>
  );
}

/** Vibe (29a): off by default; the AI re-ranks the top 20 for feel. */
export function VibeSwitch({
  model,
  large = false,
  onRefused,
}: {
  model: MixModel;
  large?: boolean;
  onRefused: () => void;
}) {
  const off = model.vibe.reason;
  const why = vibeOffWords(off);
  const reasonId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={model.vibe.on && !off}
      aria-disabled={off ? 'true' : undefined}
      aria-describedby={off ? reasonId : undefined}
      title={off ? why : 'Vibe: the AI re-ranks for feel'}
      className={styles.vibe}
      data-size={large ? 'lg' : undefined}
      data-mix-vibe=""
      onClick={() => (off ? onRefused() : setVibe(!model.vibe.on))}
    >
      Vibe
      <span className={styles.vibeTrack} aria-hidden="true" />
      {off ? (
        <span id={reasonId} className={styles.srOnly}>
          {why}
        </span>
      ) : null}
    </button>
  );
}

function StateCard({
  tone = 'neutral',
  title,
  children,
  action,
}: {
  tone?: 'neutral' | 'info';
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.state} data-tone={tone} data-mix-state="">
      <p className={styles.stateTitle}>
        <span className={styles.stateDot} aria-hidden="true" />
        {title}
      </p>
      <p className={styles.stateBody}>{children}</p>
      {action}
    </div>
  );
}

function useAddedFor(ms = 4000) {
  const [number, setNumber] = useState<number | null>(null);
  useEffect(() => {
    if (number === null) return;
    const t = window.setTimeout(() => setNumber(null), ms);
    return () => window.clearTimeout(t);
  }, [number, ms]);
  return [number, setNumber] as const;
}

type RowPlace = 'tray' | 'drawer' | 'sheet';

function MatchRowView({
  model,
  match,
  place,
}: {
  model: MixModel;
  match: MixMatch;
  place: RowPlace;
}) {
  const star = useStar(match.id);
  const starred = star ? star.starred : match.starred;
  const [added, setAdded] = useAddedFor();
  const press = useRef<number | null>(null);
  const dj = match.dj;
  const setName = model.workingSet?.name ?? 'a new mix set';
  const add = async () => {
    const n = await model.addTrack({ id: match.id, title: match.title });
    if (n !== null) setAdded(n);
  };
  const more = () => moreLikeThis({ id: match.id, title: match.title });
  // the phone: More like this is in each row's long-press (29c)
  const longPress =
    place === 'sheet'
      ? {
          onPointerDown: () => {
            press.current = window.setTimeout(more, 550);
          },
          onPointerUp: () => press.current && window.clearTimeout(press.current),
          onPointerLeave: () => press.current && window.clearTimeout(press.current),
          onContextMenu: (e: { preventDefault: () => void }) => {
            e.preventDefault();
            more();
          },
        }
      : {};
  return (
    <li className={styles.row} data-star-row={match.id} data-mix-row={match.id} {...longPress}>
      {place === 'tray' ? (
        <span className={styles.rowArt} aria-hidden="true">
          {match.image_url ? <img src={match.image_url} alt="" loading="lazy" /> : null}
        </span>
      ) : null}
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>
          {match.title}
          {place !== 'sheet' && match.artist_name ? (
            <span className={styles.rowArtist}> · {match.artist_name}</span>
          ) : null}
          {starred && place === 'tray' ? (
            <span className={styles.starMark} aria-label="starred" role="img">
              {' '}
              ★
            </span>
          ) : null}
        </span>
        <span className={styles.rowMeta}>
          {dj?.key ? (
            <KeyChip
              code={dj.key}
              uncertain={dj.key_uncertain}
              title={keyTitle(dj)}
              variant="text"
            />
          ) : null}
          {dj?.key ? ' · ' : null}
          {place === 'sheet' ? match.reason_short : match.reason}
        </span>
      </span>
      {/* Preview's place: headphone preview needs DJ stage 3's second output */}
      <span className={styles.previewSlot} data-mix-preview="" aria-hidden="true" />
      <button
        type="button"
        className={styles.iconButton}
        aria-label={`Play ${match.title} next`}
        title="Play next"
        onClick={() => playTrackNext(match)}
      >
        <PlayNextIcon />
      </button>
      {place === 'tray' ? (
        <button
          type="button"
          className={styles.addButton}
          disabled={model.busy}
          aria-label={
            added ? `Added ${match.title} as #${added}` : `Add ${match.title} to ${setName}`
          }
          onClick={() => void add()}
        >
          {added ? `✓ #${added}` : 'Add to set'}
        </button>
      ) : (
        <button
          type="button"
          className={styles.iconButton}
          data-bordered=""
          disabled={model.busy}
          aria-label={
            added ? `Added ${match.title} as #${added}` : `Add ${match.title} to ${setName}`
          }
          title={added ? `Added · #${added}` : `Add to ${setName}`}
          onClick={() => void add()}
        >
          {added ? '✓' : <PlusIcon />}
        </button>
      )}
      {place !== 'sheet' ? (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`More like ${match.title}`}
          title="More like this"
          onClick={more}
        >
          <MoreLikeIcon />
        </button>
      ) : null}
    </li>
  );
}

/** The matches, or the state that stands in for them (29d). */
export function MatchesBody({ model, place }: { model: MixModel; place: RowPlace }) {
  const { mix, seed } = model;
  if (!seed) return null;
  if (mix.isPending) {
    return <LoadingState label="Finding tracks that mix…" />;
  }
  if (mix.isError) {
    const status = (mix.error as { status?: number } | null)?.status;
    if (status === 404) {
      return (
        <StateCard title="Mix works on your own tracks">
          {seed.title || 'This track'} isn&apos;t in your library, so there&apos;s nothing to match.
          Matches for it come once it&apos;s downloaded.
        </StateCard>
      );
    }
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't look for tracks that mix"
        actions={
          <Button size="lg" variant="secondary" onClick={() => void mix.refetch()}>
            Try again
          </Button>
        }
      >
        SYNCHRO.S didn&apos;t answer. Nothing is lost; this is a display problem.
      </Notice>
    );
  }
  const data = mix.data;
  const title = data.track?.title || seed.title || 'This track';
  if (data.reason === 'not_analyzed') {
    const tdj = data.track?.dj;
    if (tdj?.skipped || tdj?.analyzed) {
      return (
        <StateCard tone="info" title={`${title} can't be matched`}>
          {tdj.skipped
            ? `SYNCHRO.S can't work out its BPM and key: ${tdj.skipped}.`
            : "SYNCHRO.S couldn't work out its BPM or key, so there's nothing to match it against."}
        </StateCard>
      );
    }
    const entry = model.seedProgress;
    const inLine = pending(entry) && (entry?.state !== 'waiting' || entry.position !== null);
    const ahead =
      model.pending && !inLine ? ` (${model.pending.toLocaleString()} tracks ahead)` : '';
    return (
      <StateCard
        tone="info"
        title={`${title} is being worked out`}
        action={
          model.canAnalyse && seed.id === model.subject?.id && !inLine ? (
            <button
              type="button"
              className={styles.stateAction}
              disabled={model.analysing}
              onClick={() => void model.analyse()}
            >
              {model.analysing ? 'Working it out now…' : 'Analyse this one now'}
            </button>
          ) : null
        }
      >
        BPM, key and energy are worked out in the background{ahead}. Matches show once it&apos;s
        done.
      </StateCard>
    );
  }
  if (!model.matches.length) {
    const wide = data.wide;
    return (
      <StateCard
        title={`Nothing in your library fits ${title}`}
        action={
          wide ? null : (
            <button type="button" className={styles.stateAction} onClick={() => setWide(true)}>
              Widen the search
            </button>
          )
        }
      >
        {wide
          ? 'Nothing within 10% BPM in any key either.'
          : `Nothing within ${data.within ?? 6}% BPM and one step on the wheel. Wider: 10% and any key.`}
      </StateCard>
    );
  }
  return (
    <ul
      className={styles.list}
      aria-label={`Tracks that mix well with ${title}`}
      aria-busy={model.vibe.thinking ? 'true' : undefined}
      data-mix-list=""
    >
      {model.matches.map((m) => (
        <MatchRowView key={m.id} model={model} match={m} place={place} />
      ))}
    </ul>
  );
}

function BackRow({ model }: { model: MixModel }) {
  if (model.following !== 'chain' || !model.subject) return null;
  return (
    <div className={styles.back}>
      <button type="button" className={styles.textButton} onClick={backToPlaying}>
        Back to {model.subject.title || 'the playing track'}
      </button>
      <span>· following {model.seed?.title}</span>
    </div>
  );
}

function Foot({ model, refused, place }: { model: MixModel; refused: boolean; place: RowPlace }) {
  const v = model.vibe;
  if (!model.matches.length && !v.error && !refused) return null;
  if (refused && v.reason)
    return (
      <p className={styles.foot} role="status">
        Vibe: {vibeOffWords(v.reason)}
      </p>
    );
  if (v.on && v.thinking)
    return (
      <p className={styles.foot} role="status">
        Vibe: the AI is ordering these for feel…
      </p>
    );
  if (v.on && v.error)
    return (
      <p className={styles.foot} data-tone="warning" role="status">
        Vibe: {v.error.message} Code&apos;s order is shown.
      </p>
    );
  if (place === 'sheet')
    return <p className={styles.foot}>More like this is in each row&apos;s long-press.</p>;
  return (
    <p className={styles.foot}>
      {matchesFoot({ vibeLine: v.on ? v.line : null, leftOut: model.mix.data?.set?.left_out })}
    </p>
  );
}

export function MatchesColumn({ model }: { model: MixModel }) {
  const [refused, setRefused] = useState(false);
  useEffect(() => setRefused(false), [model.vibe.reason]);
  return (
    <>
      {/* 31c: the Mix tab's header line while the playing track isn't ready,
          with 29d's card under it in place of the matches */}
      <NotAnalysedLine model={model} />
      <div className={styles.head}>
        <h3 className={styles.headTitle}>Mixes well with</h3>
        <span className={styles.spacer} />
        <SuggestFrom model={model} />
        <VibeSwitch model={model} onRefused={() => setRefused(true)} />
      </div>
      <BackRow model={model} />
      <MatchesBody model={model} place="tray" />
      <Foot model={model} refused={refused} place="tray" />
    </>
  );
}

/* ── the working set (29a's right column) ─────────────────────────────── */

function WorkingPicker({ model, large = false }: { model: MixModel; large?: boolean }) {
  const profileId = model.profileId;
  const sets = useQuery({ ...setsListQueryOptions(profileId ?? 0), retry: false });
  const ws = model.workingSet;
  const mine = sets.data?.find((s) => s.id === ws?.id);
  const meta = mine ? setMetaWords(mine.tracks, mine.seconds, large) : '';
  const choose = async (id: number | null) => {
    try {
      await chooseWorkingSet(id);
      window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: {} }));
    } catch (err) {
      window.showToast?.(err instanceof Error ? err.message : "That set wasn't chosen.", 'error');
    }
  };
  const start = async () => {
    if (!model.subject) return;
    const name = workingSetName();
    try {
      await startWorkingSet(name, [model.subject.id]);
      window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: {} }));
      window.showToast?.(`Started ${name} with ${model.subject.title} · #1`, 'success');
    } catch (err) {
      window.showToast?.(err instanceof Error ? err.message : "The mix set wasn't made.", 'error');
    }
  };
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        className={styles.pickButton}
        data-size={large ? 'lg' : undefined}
        aria-label={
          ws ? `Working on ${ws.name}. Choose another mix set` : 'Choose a mix set to work on'
        }
      >
        <span className={styles.pickName}>{ws ? ws.name : 'Choose a mix set'}</span>
        <span className={styles.pickMeta}>
          {meta ? `${meta} ` : ''}
          <span aria-hidden="true">▾</span>
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={styles.menu} align="end" sideOffset={6}>
          <Menu.Popup aria-label="Your mix sets">
            <Menu.RadioGroup
              value={ws?.id ?? 0}
              onValueChange={(v) => void choose(Number(v) || null)}
            >
              {(sets.data ?? []).map((s) => (
                <Menu.RadioItem key={s.id} value={s.id} className={styles.menuItem}>
                  <span className={styles.pickName}>{s.name}</span>
                  <span className={styles.menuItemMeta}>{setMetaWords(s.tracks, s.seconds)}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            {sets.isPending ? <p className={styles.foot}>Loading your mix sets…</p> : null}
            <Menu.Separator className={styles.menuSeparator} />
            <Menu.Item
              className={styles.menuItem}
              onClick={() => void start()}
              disabled={!model.subject}
            >
              New mix set with {model.subject?.title || 'this track'}
            </Menu.Item>
            {ws ? (
              <Menu.Item className={styles.menuItem} onClick={() => void choose(null)}>
                No working set
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function PlayingCard({ model, compact = false }: { model: MixModel; compact?: boolean }) {
  const p = model.playing;
  const ws = model.workingSet;
  if (!p || !ws) return null;
  const nextTitle = p.next?.track?.title || p.next?.title || '';
  return (
    <div className={styles.playing} data-mix-playing="">
      <p className={styles.playingTitle}>
        {compact
          ? trackOfWords(p.number, p.total)
          : `Playing ${ws.name} · ${trackOfWords(p.number, p.total).toLowerCase()}`}
      </p>
      {p.next ? (
        <span className={styles.playingNext}>
          <span className={styles.pill} data-tone={p.step?.kind ?? 'unknown'}>
            <i aria-hidden="true" />
            {nextTransitionWords(p.row)}
          </span>
          next: {nextTitle}
          {p.step?.kind === 'jump' ? ' · a jump: mix on a break' : ''}
        </span>
      ) : (
        <span className={styles.playingNext}>The set&apos;s last track</span>
      )}
    </div>
  );
}

function Strip({ model }: { model: MixModel }) {
  const cells = model.strip;
  const line = stripLine(cells.map((c) => c.dj?.energy ?? null));
  const label = `Energy ${cells.map((c) => (c.dj?.energy ? String(c.dj.energy) : '—')).join(', ')}, the last for the playing track`;
  const step = model.playing ? model.playing.step : model.joinStep;
  const lead = model.playing
    ? model.playing.next
      ? joinLead(
          model.playing.next.track?.title || model.playing.next.title || '',
          model.subject?.title ?? '',
        )
      : ''
    : model.last && model.subject && String(model.last.track_id) !== model.subject.id
      ? joinLead(model.subject.title, model.last.track?.title || model.last.title || '')
      : '';
  return (
    <div className={styles.stripCard}>
      <ol className={styles.strip} aria-label="The set's last tracks, then the playing one">
        {cells.map((c) => (
          <li key={c.key} className={styles.cell} data-now={c.now ? '' : undefined}>
            <span className={styles.cellPos}>{c.pos}</span>
            <span className={styles.cellTitle}>{c.title}</span>
            {c.dj?.key ? (
              <KeyChip
                code={c.dj.key}
                uncertain={c.dj.key_uncertain}
                title={keyTitle(c.dj)}
                variant="text"
              />
            ) : (
              <span className={styles.cellPos}>—</span>
            )}
          </li>
        ))}
      </ol>
      <svg
        className={styles.energyLine}
        viewBox="0 0 100 28"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {line.solid ? <polyline points={line.solid} vectorEffect="non-scaling-stroke" /> : null}
        {line.dashed ? (
          <polyline points={line.dashed} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        ) : null}
      </svg>
      {lead && step ? (
        <p className={styles.join}>
          {lead}:{' '}
          <span className={styles.stepWord} data-kind={step.kind}>
            {stepWord(step)}
          </span>{' '}
          · {step.reason}
        </p>
      ) : model.inSet.length && !model.playing ? (
        <p className={styles.join}>
          {model.subject?.title} is in {model.workingSet?.name} already, as #{model.inSet[0]}.
        </p>
      ) : null}
    </div>
  );
}

export function WorkingColumn({
  model,
  mode = 'tray',
}: {
  model: MixModel;
  mode?: 'tray' | 'sheet';
}) {
  return (
    <>
      {mode === 'tray' ? (
        <div className={styles.workingRow}>
          <span className={styles.headMeta}>Working on</span>
          <WorkingPicker model={model} />
        </div>
      ) : (
        <WorkingPicker model={model} large />
      )}
      {mode === 'tray' ? <PlayingCard model={model} /> : null}
      {model.workingSet ? (
        mode === 'tray' ? (
          <Strip model={model} />
        ) : null
      ) : model.workingLoading ? null : (
        <StateCard
          title="Start a mix set to collect tracks"
          action={
            <button
              type="button"
              className={styles.stateAction}
              disabled={model.busy || !model.subject}
              onClick={() => void model.addPlaying()}
            >
              New mix set
            </button>
          }
        >
          Matches still show. A, or Add to set, makes &ldquo;{workingSetName()}&rdquo; and adds the
          track.
        </StateCard>
      )}
      {mode === 'tray' ? (
        <>
          <button
            type="button"
            className={styles.primary}
            title={model.workingSet ? `Add to ${model.workingSet.name} (A)` : 'Start a mix set (A)'}
            disabled={model.busy || model.primaryDisabled || !model.subject}
            onClick={() => void model.addPlaying()}
            data-mix-primary=""
          >
            {model.primaryLabel}
          </button>
          <p className={styles.keys}>
            Keys: S star · A add · N play the top match next · M back to Now playing.
          </p>
        </>
      ) : null}
    </>
  );
}

/* ── the tray (29a) ───────────────────────────────────────────────────── */

export function MixTray({ model }: { model: MixModel }) {
  return (
    <>
      <div className={styles.left} data-mix-col="this-track">
        <ThisTrack model={model} mode="mix" />
      </div>
      <section className={styles.middle} aria-label="Mixes well with" data-mix-col="matches">
        <MatchesColumn model={model} />
      </section>
      <section className={styles.right} aria-label="The working set" data-mix-col="working-set">
        <WorkingColumn model={model} />
      </section>
    </>
  );
}

/** A not-from-your-library track (a preview) in the tray: 29d's card in the matches' place. */
export function PreviewTray({ title }: { title: string }) {
  return (
    <>
      <div className={styles.left} data-mix-col="this-track">
        <ModesSwitch mode="mix" />
        <div className={styles.nowText}>
          <span className={styles.nowTitle}>{title}</span>
        </div>
      </div>
      <section className={styles.middle} aria-label="Mixes well with" data-mix-col="matches">
        <div className={styles.head}>
          <h3 className={styles.headTitle}>Mixes well with</h3>
        </div>
        <PreviewState />
      </section>
      <section className={styles.right} aria-label="The working set" />
    </>
  );
}

export function PreviewState() {
  return (
    <StateCard title="Mix works on your own tracks">
      This is a stream preview. Matches for it come once it&apos;s downloaded.
    </StateCard>
  );
}

/* ── Visuals: the drawer (29b) ────────────────────────────────────────── */

export function MixDrawer({ model, onClose }: { model: MixModel; onClose: () => void }) {
  const subject = model.subject;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  if (!subject) return null;
  return (
    <div
      ref={ref}
      id="ss-mix-drawer"
      role="region"
      aria-label="Mix"
      tabIndex={-1}
      className={styles.drawer}
      data-mix-drawer=""
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.keyLine}>
        <KeyAndBpm model={model} long={false} />
        {model.dj?.energy ? <span className={styles.bpm}>· E{model.dj.energy}</span> : null}
        <span className={styles.spacer} />
        <span className={styles.star}>
          <StarButton id={subject.id} title={subject.title} variant="player" />
        </span>
      </div>
      <NotAnalysedLine model={model} />
      <PlayingCard model={model} />
      <div className={styles.head}>
        <h3 className={styles.headTitle}>Mixes well with</h3>
        <span className={styles.spacer} />
        {model.mix.data?.set ? (
          <span className={styles.headMeta}>leaving out the set&apos;s own tracks</span>
        ) : null}
      </div>
      <BackRow model={model} />
      <MatchesBody model={model} place="drawer" />
      <p className={styles.foot}>
        {model.playing
          ? `Playing a set, Add puts a track straight after the playing one (#${model.playing.number + 1}), and Play next leaves the set for one track, then returns to it.`
          : model.workingSet
            ? `Add puts a track at the end of ${model.workingSet.name}.`
            : 'Add starts a mix set with the track.'}
      </p>
    </div>
  );
}

/* ── the phone: Mix · Set (29c) ───────────────────────────────────────── */

function SetEnergy({ rows }: { rows: ViewRow[] }) {
  const energies = rows.filter((r) => r.track).map((r) => r.track?.dj?.energy ?? null);
  const known = energies.map((e, i) => [i, e] as const).filter(([, e]) => e !== null) as [
    number,
    number,
  ][];
  const n = Math.max(1, energies.length - 1);
  const points = known.map(
    ([i, e]) => `${((100 * i) / n).toFixed(1)},${energyY(e, 40, 6).toFixed(1)}`,
  );
  return (
    <svg
      className={styles.sheetGraph}
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      role="img"
      aria-label="Energy across the set"
    >
      {points.length > 1 ? (
        <polyline points={points.join(' ')} vectorEffect="non-scaling-stroke" />
      ) : null}
    </svg>
  );
}

function SetRowMenu({ row, label }: { row: ViewRow; label: string }) {
  const track = row.track;
  const anchor = useRef<HTMLButtonElement>(null);
  if (!track) return <span />;
  const entries = trackMenu(
    { id: track.id, title: track.title, artist: track.artist_name },
    {
      phone: true,
      playNext: { onSelect: () => playTrackNext(track) },
      anchor: () => anchor.current,
      addToPlaylist: () => addTrackToPlaylist(track, anchor.current),
    },
  );
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger ref={anchor} className={styles.iconButton} aria-label={label}>
        <MoreIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={styles.menu} align="end" sideOffset={6}>
          <Menu.Popup aria-label={label}>
            {entries.map((e) => (
              <Menu.Item
                key={e.key}
                className={styles.menuItem}
                disabled={e.disabled}
                onClick={e.onSelect}
              >
                {e.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function SetTab({ model }: { model: MixModel }) {
  const rows = model.rows;
  const steps = model.setView?.steps ?? [];
  let n = 0;
  const numbered = rows.map((r) => (r.track_id ? ++n : null));
  // the step into each row: the one after the playing row before it
  const into: (typeof steps)[number][] = rows.map(() => null);
  let lastPlaying = -1;
  rows.forEach((r, i) => {
    if (!r.track) return;
    if (lastPlaying >= 0) into[i] = steps[lastPlaying] ?? null;
    lastPlaying = i;
  });
  const nextNumber = model.playing ? model.playing.number + 1 : n + 1;
  return (
    <>
      <WorkingColumn model={model} mode="sheet" />
      {model.workingSet ? (
        <>
          <SetEnergy rows={rows} />
          <ol className={styles.setList} aria-label={`${model.workingSet.name}'s tracks`}>
            {rows.map((r, i) => {
              const t = r.track ?? r.gone_track ?? null;
              const step = into[i];
              return (
                <li key={`${i}-${r.track_id ?? r.title}`} className={styles.setRow}>
                  <span className={styles.setNumber}>{numbered[i] ?? ''}</span>
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>{t?.title || r.title}</span>
                    <span className={styles.setMeta}>
                      {t?.dj?.key ? (
                        <KeyChip code={t.dj.key} uncertain={t.dj.key_uncertain} variant="text" />
                      ) : (
                        '—'
                      )}
                      {t?.dj?.bpm ? ` · ${bpmNumber(t.dj.bpm)}` : ''}
                      {' · '}
                      <span className={styles.stepWord} data-kind={step?.kind ?? 'start'}>
                        {step ? stepWord(step) : 'start'}
                      </span>
                    </span>
                  </span>
                  <SetRowMenu row={r} label={`More for ${t?.title || r.title || 'this track'}`} />
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
      <button
        type="button"
        className={styles.primary}
        disabled={model.busy || model.primaryDisabled || !model.subject}
        onClick={() => void model.addPlaying()}
      >
        {model.primaryDisabled || model.primaryLabel.startsWith('✓')
          ? model.primaryLabel
          : model.workingSet
            ? `Add ${model.subject?.title ?? 'it'} · as #${nextNumber}`
            : model.primaryLabel}
      </button>
    </>
  );
}

function MixTabPhone({ model }: { model: MixModel }) {
  const [refused, setRefused] = useState(false);
  const subject = model.subject;
  if (!subject) return null;
  return (
    <>
      <div className={styles.sheetTop}>
        <KeyAndBpm model={model} long={false} />
        <span className={styles.sheetMeter}>
          <EnergyMeter energy={model.dj?.energy} variant="steps" />
        </span>
        <span className={styles.star}>
          <StarButton id={subject.id} title={subject.title} variant="player" />
        </span>
      </div>
      <NotAnalysedLine model={model} phone />
      <div className={styles.head}>
        <h3 className={`${styles.headTitle} ${styles.spacer}`}>Mixes well with</h3>
        <VibeSwitch model={model} large onRefused={() => setRefused(true)} />
      </div>
      <BackRow model={model} />
      <MatchesBody model={model} place="sheet" />
      <Foot model={model} refused={refused} place="sheet" />
    </>
  );
}

export function MixSheet({
  model,
  tab,
  preview,
}: {
  model: MixModel;
  tab: 'mix' | 'set';
  preview: string | null;
}) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setSheetTab(tab === 'mix' ? 'set' : 'mix');
  };
  return (
    <div className={styles.sheet} data-mix-sheet="">
      <button type="button" className={styles.textButton} onClick={() => setTrayMode('now')}>
        ‹ Now playing
      </button>
      <div
        role="tablist"
        aria-label="Mix"
        className={styles.modes}
        data-size="lg"
        onKeyDown={onKey}
      >
        <button
          type="button"
          role="tab"
          className={styles.modeTab}
          aria-selected={tab === 'mix'}
          tabIndex={tab === 'mix' ? 0 : -1}
          onClick={() => setSheetTab('mix')}
        >
          Mix
        </button>
        <button
          type="button"
          role="tab"
          className={styles.modeTab}
          aria-selected={tab === 'set'}
          tabIndex={tab === 'set' ? 0 : -1}
          onClick={() => setSheetTab('set')}
        >
          Set
        </button>
      </div>
      {preview !== null ? (
        <PreviewState />
      ) : tab === 'mix' ? (
        <MixTabPhone model={model} />
      ) : (
        <SetTab model={model} />
      )}
    </div>
  );
}
