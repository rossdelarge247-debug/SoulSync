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
import { LoadingState, Notice, StatusTag } from '@/components/primitives';
import { usePrefs } from '@/features/automix/prefs';
import { AnalysisLine, SweepLine, useLastSweep } from '@/features/dj/analysis-line';
import { inLineCount, isReady, pending } from '@/features/dj/analysis.format';
import { addTrackToPlaylist, playDjTrackNow, playTrackNext } from '@/features/dj/dj-actions';
import { openDjSettings } from '@/features/dj/dj-settings-link';
import { bpmNumber, keyTitle } from '@/features/dj/dj.format';
import { KeyChip } from '@/features/dj/key-chip';
import { RowPlay, rowPlayHandlers } from '@/features/dj/row-play';
import { trackMenu } from '@/features/dj/track-menu';
import { TraktorExportDialog } from '@/features/dj/traktor-export-dialog';
import { useDndSelect, useDropTarget } from '@/features/dnd/dnd-engine';
import { duplicateWords } from '@/features/dnd/dnd-model';
import { Grip } from '@/features/dnd/grip';
import { djItem, onGripDown } from '@/features/dnd/items';
import { useRowGrid } from '@/features/dnd/row-grid';
import { sendToSet, setRefusal } from '@/features/dnd/send-to';
import { openSendToTray } from '@/features/dnd/send-to-ui';
import { holdingNumber } from '@/features/dnd/set-targets';
import { MIX_SET_CHANGED, setsListQueryOptions } from '@/features/sets/sets.api';
import { StarButton, useStar } from '@/features/stars/star-button';
import { MoreMenu } from '@/routes/library/-ui/parts';

import type { MixModel } from './mix-model';
import type { MixMatch } from './mix.api';

import { MakePlaylistDialog } from './make-playlist-dialog';
import {
  DJ_MODE_READY,
  backToPlaying,
  moreLikeThis,
  setSheetTab,
  setSuggestFrom,
  setTrayMode,
  setVibe,
  setWide,
  type SheetTab,
  type TrayMode,
} from './mix-store';
import { chooseWorkingSet, startWorkingSet } from './mix.api';
import {
  energyY,
  joinLead,
  matchesFoot,
  nextTransitionWords,
  setMetaWords,
  stepWord,
  trackOfWords,
  vibeOffWords,
  workingSetName,
} from './mix.format';
import styles from './mix.module.css';
import { WorkingSetMix } from './working-set-mix';

/* ── icons ─────────────────────────────────────────────────────────────── */

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

/* ── Now playing · Mix · DJ (33a, 36a; the phone's Now playing · Mix · Set, 33d) ── */

type ModeKey = 'now' | 'mix' | 'dj' | 'set';

const DESKTOP_MODES: { key: ModeKey; label: string; title?: string }[] = [
  { key: 'now', label: 'Now playing' },
  { key: 'mix', label: 'Mix', title: 'Mix (M)' },
  // DJ now (Brief E) is step 5: its tab joins here when DJ_MODE_READY
  ...(DJ_MODE_READY ? [{ key: 'dj' as const, label: 'DJ', title: 'DJ now (D)' }] : []),
];

const PHONE_MODES: { key: ModeKey; label: string; title?: string }[] = [
  { key: 'now', label: 'Now playing' },
  { key: 'mix', label: 'Mix' },
  { key: 'set', label: 'Set' },
];

function selectMode(key: ModeKey): void {
  if (key === 'set') {
    setSheetTab('set');
    setTrayMode('mix');
  } else if (key === 'mix') {
    setSheetTab('mix');
    setTrayMode('mix');
  } else setTrayMode(key);
}

/** Switch the tray's mode and keep the focus on the switch that's shown now. */
function switchMode(next: ModeKey, focus: boolean): void {
  selectMode(next);
  if (!focus) return;
  window.requestAnimationFrame(() => {
    const tabs = [
      ...document.querySelectorAll<HTMLElement>(`[data-mix-modes] [data-mode="${next}"]`),
    ];
    (tabs.find((t) => t.getClientRects().length) ?? tabs[0])?.focus();
  });
}

/**
 * The tray's modes (33a; key M): Now playing · Mix, and DJ once DJ now is
 * built (36a). On a phone it's the sheet's one tab row under the handle,
 * Now playing · Mix · Set (33d, 291). Arrow keys move between them.
 */
export function ModesSwitch({
  mode,
  large = false,
  phone = false,
  sheetTab = 'mix',
}: {
  mode: TrayMode;
  large?: boolean;
  phone?: boolean;
  sheetTab?: SheetTab;
}) {
  const tabs = phone ? PHONE_MODES : DESKTOP_MODES;
  const current: ModeKey = phone ? (mode === 'now' ? 'now' : sheetTab) : mode;
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const at = tabs.findIndex((t) => t.key === current);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    switchMode(tabs[(at + step + tabs.length) % tabs.length].key, true);
  };
  return (
    <div
      role="tablist"
      aria-label={phone ? 'Player' : 'Tray'}
      className={styles.modes}
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      data-size={large || phone ? 'lg' : undefined}
      data-mix-modes=""
      onKeyDown={onKey}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          className={styles.modeTab}
          aria-selected={current === t.key}
          tabIndex={current === t.key ? 0 : -1}
          title={t.title}
          data-mode={t.key}
          onClick={() => current !== t.key && switchMode(t.key, true)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ── this track (29a's left column) ───────────────────────────────────── */

function KeyAndBpm({ model, long }: { model: MixModel; long: boolean }) {
  const dj = model.dj;
  // UX-26: with neither known it's one "— BPM", not "— — BPM"
  if (!dj?.key && !dj?.bpm)
    return (
      <span className={styles.bpm} title="BPM and key not worked out yet">
        — BPM
      </span>
    );
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

/** "Tidewater · 8A · 124 · E6": the record's line in Mix (33b, 33d), the key in its hue. */
function RecordLine({ model, artist = true }: { model: MixModel; artist?: boolean }) {
  const dj = model.dj;
  const parts: ReactNode[] = [];
  if (artist && model.subject?.artist) parts.push(model.subject.artist);
  if (dj?.key)
    parts.push(
      <KeyChip
        key="k"
        code={dj.key}
        uncertain={dj.key_uncertain}
        title={keyTitle(dj)}
        variant="text"
      />,
    );
  parts.push(dj?.bpm ? bpmNumber(dj.bpm) : '— BPM');
  if (dj?.energy) parts.push(`E${dj.energy}`);
  return (
    <span className={styles.recordLine}>
      {parts.map((p, i) => (
        <span key={i}>
          {i ? ' · ' : null}
          {p}
        </span>
      ))}
    </span>
  );
}

/** Ready to mix, or where its analysis is (31c's marker), under the record. */
function ReadyLine({ model }: { model: MixModel }) {
  const entry = model.progress;
  if (isReady(entry))
    return (
      <span className={styles.ready}>
        <i aria-hidden="true" data-tone="ready" />
        Ready to mix
      </span>
    );
  return <AnalysisLine size="marker" entry={entry} />;
}

/**
 * Mix's record (33b): the 56px art, the title, "Tidewater · 8A · 124 · E6"
 * and Ready to mix, under the set card. The full record is Now playing's.
 */
function CompactRecord({ model }: { model: MixModel }) {
  const subject = model.subject;
  if (!subject) return null;
  return (
    <div className={styles.compact} data-mix-record="">
      <span className={styles.compactArt} aria-hidden="true">
        {subject.image ? <img src={subject.image} alt="" /> : null}
      </span>
      <span className={styles.nowText}>
        <span className={styles.nowTitle}>{subject.title}</span>
        <RecordLine model={model} />
        <ReadyLine model={model} />
      </span>
    </div>
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

/** Mix's left column (33b): the modes, the set card, then the record at 56px. */
export function MixLeft({ model, mode }: { model: MixModel; mode: TrayMode }) {
  if (!model.subject) return null;
  return (
    <>
      <ModesSwitch mode={mode} />
      <SetCard model={model} />
      <CompactRecord model={model} />
    </>
  );
}

/**
 * The record's key line in Now playing (36a, 279): the key chip, "124 BPM ·
 * E6" and Ready to mix; the star sits beside it (index.html moves the
 * record's star slot there).
 */
export function RecordKeyLine({ model }: { model: MixModel }) {
  const dj = model.dj;
  if (!model.subject) return null;
  return (
    <span className={styles.keyLineRecord} data-mix-keyline="">
      <span className={styles.keyLineTop}>
        {dj?.key ? (
          <KeyChip code={dj.key} uncertain={dj.key_uncertain} title={keyTitle(dj)} />
        ) : null}
        <span className={styles.bpm}>
          {[dj?.bpm ? `${bpmNumber(dj.bpm)} BPM` : '— BPM', dj?.energy ? `E${dj.energy}` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <ReadyLine model={model} />
    </span>
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

/** "Smooth" / "Jump" before the reason (33b: "Smooth · same key, +4 BPM"). */
function MatchStep({ match }: { match: MixMatch }) {
  if (!match.step || match.step === 'unknown') return null;
  return (
    <>
      <span className={styles.stepWord} data-kind={match.step}>
        {match.step === 'smooth' ? 'Smooth' : 'Jump'}
      </span>
      {' · '}
    </>
  );
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

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
  const anchor = useRef<HTMLButtonElement>(null);
  const dj = match.dj;
  const setName = model.workingSet?.name ?? 'a new set';
  const at = model.workingSet ? model.addAt : 1;
  const add = async () => {
    const n = await model.addTrack({ id: match.id, title: match.title });
    if (n !== null) setAdded(n);
  };
  const more = () => moreLikeThis({ id: match.id, title: match.title });
  const ready = isReady(model.progressOf[match.id]);
  const playNow = () => playDjTrackNow(match);
  // Brief B (32g): a match lifts onto a set's list, a set, the set card, Up next or a gap
  const rowRef = useRef<HTMLLIElement>(null);
  const item = djItem(match);
  const lift = () => ({
    items: [item],
    source: { kind: 'mix' as const, listId: 'mix', indexes: [model.matches.indexOf(match)] },
    rows: rowRef.current ? [rowRef.current] : [],
  });
  // the phone: More like this is in each row's long-press (29c) and its "…"
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
  const addLabelWords = added ? `✓ #${added}` : `Add as #${at}`;
  return (
    <li
      ref={rowRef}
      className={styles.row}
      data-place={place}
      data-star-row={match.id}
      data-mix-row={match.id}
      // a tab stop in the row grid: it says which track it is (L8)
      aria-label={[match.title, match.artist_name].filter(Boolean).join(', ')}
      data-row-play-host=""
      data-dnd-row={place === 'sheet' ? undefined : 'mix'}
      {...(place === 'sheet' ? {} : rowPlayHandlers(playNow))}
      {...longPress}
    >
      {/* the grip (32b); on the phone a long-press is More like this (29c), so Send to… is in the "…" */}
      {place === 'sheet' ? null : <Grip onPointerDown={onGripDown(lift)} />}
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
          {place === 'tray' ? (
            <i
              className={styles.readyDot}
              data-tone={ready ? 'ready' : 'neutral'}
              role="img"
              aria-label={ready ? 'Ready to mix' : 'BPM and key only'}
              title={ready ? 'Ready to mix' : 'BPM and key only: no beat grid yet'}
            />
          ) : null}
          {dj?.key ? (
            <KeyChip
              code={dj.key}
              uncertain={dj.key_uncertain}
              title={keyTitle(dj)}
              variant="text"
            />
          ) : null}
          {dj?.key ? ' · ' : null}
          <MatchStep match={match} />
          {place === 'sheet' ? match.reason_short : lowerFirst(match.reason)}
        </span>
      </span>
      {/* Preview's place (298): first, once a preview route exists (DJ now, step 5) */}
      <span className={styles.previewSlot} data-mix-preview="" aria-hidden="true" />
      {place === 'sheet' ? (
        <>
          {/* 33d: Play, and the "…" with Play next, Add and More like this */}
          <RowPlay title={match.title} onPlay={playNow} onPlayNext={null} />
          <Menu.Root modal={false}>
            <Menu.Trigger
              ref={anchor}
              className={styles.iconButton}
              aria-label={`More for ${match.title}`}
            >
              <MoreIcon />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner className={styles.menu} align="end" sideOffset={6}>
                <Menu.Popup aria-label={`More for ${match.title}`}>
                  <Menu.Item className={styles.menuItem} onClick={() => playTrackNext(match)}>
                    Play next
                  </Menu.Item>
                  <Menu.Item
                    className={styles.menuItem}
                    disabled={model.busy}
                    onClick={() => void add()}
                  >
                    {model.workingSet ? `Add as #${at}` : 'Add to a new set'}
                  </Menu.Item>
                  <Menu.Item className={styles.menuItem} onClick={more}>
                    More like this
                  </Menu.Item>
                  <Menu.Item className={styles.menuItem} onClick={() => openSendToTray([item])}>
                    Send to…
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </>
      ) : (
        <>
          {/* 34b: Play and Play next always shown here, the tab is about deciding */}
          <RowPlay
            title={match.title}
            onPlay={playNow}
            onPlayNext={() => playTrackNext(match)}
            nextAlways
          />
          {place === 'tray' ? (
            <button
              type="button"
              className={styles.addButton}
              disabled={model.busy}
              aria-label={
                added
                  ? `Added ${match.title} as #${added}`
                  : `Add ${match.title} to ${setName} as #${at}`
              }
              onClick={() => void add()}
            >
              {addLabelWords}
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
              title={added ? `Added · #${added}` : `Add to ${setName} as #${at}`}
              onClick={() => void add()}
            >
              {added ? '✓' : <PlusIcon />}
            </button>
          )}
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`More like ${match.title}`}
            title="More like this"
            onClick={more}
          >
            <MoreLikeIcon />
          </button>
        </>
      )}
    </li>
  );
}

/** The matches, or the state that stands in for them (29d). */
export function MatchesBody({ model, place }: { model: MixModel; place: RowPlace }) {
  const { mix, seed } = model;
  // UX-27's row grid; Space sends the match somewhere (Send to…, 32d)
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null);
  useRowGrid(listEl, {
    rowSelector: '[data-mix-row]',
    hint: 'Arrows move between tracks; Enter plays; Space sends it to a set or Up next; the right arrow reaches its buttons.',
    onSpace: (row) => {
      const match = model.matches.find((m) => m.id === row.getAttribute('data-mix-row'));
      if (!match) return false;
      openSendToTray([djItem(match)]);
      return true;
    },
  });
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
          Mixes well with fills in once it&apos;s downloaded.
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
        BPM, key and energy are worked out in the background{ahead}. Mixes well with fills in once
        it&apos;s ready to mix.
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
      ref={setListEl}
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

/**
 * "Following Copper Sky · Back to Night Ferry" (33a, 33b): what the list
 * follows when it isn't the playing track (More like this, or "Mixes well
 * with…" from any track's "…"), with the way back.
 */
function FollowingPill({ model }: { model: MixModel }) {
  if (model.following !== 'chain' || !model.subject || !model.seed) return null;
  return (
    <span className={styles.following} data-mix-following="">
      <span className={styles.followingWord}>Following</span>
      <span className={styles.followingTitle}>{model.seed.title}</span>
      <button type="button" className={styles.followingBack} onClick={backToPlaying}>
        Back to {model.subject.title || 'the playing track'}
      </button>
    </span>
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

/** The keys (33b's foot): where Add puts a track while a set plays, then A · N · M. */
function KeysLine({ model }: { model: MixModel }) {
  const lead = model.playingWorking
    ? 'Add inserts after the playing track while the set plays. '
    : '';
  return (
    <p className={styles.keys}>
      {lead}Keys: A add · N play the top match next · M Now playing
      {DJ_MODE_READY ? ' · D DJ' : ''}. Style and key lock:{' '}
      <button type="button" className={styles.inlineLink} onClick={() => openDjSettings('between')}>
        Settings → Library → DJ
      </button>
    </p>
  );
}

/**
 * The matches' "…" (gauntlet review L3): what the retired Mixes panel's foot
 * did, so nothing Ross had is lost. "Make a playlist from these…" (17b) and
 * "Export these to Traktor…" take the track the matches follow and the
 * matches as shown (Vibe's order when it's on).
 */
function MatchesMore({ model }: { model: MixModel }) {
  const [making, setMaking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const seed = model.mix.data?.track ?? null;
  const matches = model.matches;
  if (!matches.length) return null;
  const name = `Mixes with ${seed?.title || 'this track'}`;
  const ids = [...(seed ? [String(seed.id)] : []), ...matches.map((m) => String(m.id))];
  return (
    <>
      <MoreMenu
        label="More for these matches"
        entries={[
          {
            key: 'playlist',
            label: 'Make a playlist from these…',
            onSelect: () => setMaking(true),
          },
          { key: 'traktor', label: 'Export these to Traktor…', onSelect: () => setExporting(true) },
        ]}
      />
      {making ? (
        <MakePlaylistDialog seed={seed} matches={matches} onClose={() => setMaking(false)} />
      ) : null}
      {exporting ? (
        <TraktorExportDialog
          from={{ source: 'tracks', track_ids: ids, name }}
          name={name}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </>
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
        {model.following === 'chain' ? <FollowingPill model={model} /> : null}
        <span className={styles.spacer} />
        {model.following === 'chain' ? null : <SuggestFrom model={model} />}
        <VibeSwitch model={model} onRefused={() => setRefused(true)} />
        <MatchesMore model={model} />
      </div>
      <MatchesBody model={model} place="tray" />
      <Foot model={model} refused={refused} place="tray" />
      <KeysLine model={model} />
    </>
  );
}

/* ── the set card (33b; the working-set strip folds into it, 33a) ─────── */

/**
 * First run (33d, 33e): "Start a set to mix into". New set makes "Set from
 * Monday 27 Oct" with the playing track without asking (292; renamed in
 * place on its page); Choose a set… opens the picker. No other primary
 * shows while it does (292).
 */
function FirstRun({ model, phone = false }: { model: MixModel; phone?: boolean }) {
  const title = model.subject?.title || 'this track';
  return (
    <div className={styles.firstRun} data-mix-first-run="" data-phone={phone ? '' : undefined}>
      {phone ? (
        <span className={styles.firstRunIcon} aria-hidden="true">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="9" cy="12" r="5" />
            <circle cx="15" cy="12" r="5" />
          </svg>
        </span>
      ) : null}
      <p className={styles.firstRunTitle}>Start a set to mix into</p>
      <p className={styles.firstRunBody}>
        {phone
          ? "A set is a list of tracks in the order you'd play them. Add the track that's playing, or pick a set you already have."
          : "A set is a list of tracks in the order you'd play them. SYNCHRO.S shows how each one leads to the next."}
      </p>
      <div className={styles.firstRunActions}>
        <button
          type="button"
          className={styles.primary}
          data-size="auto"
          disabled={model.busy || !model.subject}
          onClick={() => void model.addPlaying()}
        >
          New set with {title}
        </button>
        <WorkingPicker model={model} large={phone} trigger="choose" />
      </div>
      {phone ? (
        <p className={styles.firstRunNote}>
          Named &ldquo;{workingSetName()}&rdquo; until you rename it.
        </p>
      ) : null}
    </div>
  );
}

/** A set holds at most this many tracks (the server's MAX_ROWS). */
const SET_MAX_TRACKS = 500;

/**
 * "Save as a set" (Brief E's Build row, folded in here, 33a): Up next's
 * library tracks as a new set. Gauntlet review L1: the toast says how many
 * the server put in, a longer Up next is cut to the first 500 (and says so),
 * and the button waits while it saves.
 */
function SaveUpNext({ model }: { model: MixModel }) {
  const [saving, setSaving] = useState(false);
  const ids = model.upNextIds;
  if (ids.length < 2 || model.queueFrom) return null;
  const save = async () => {
    if (saving) return;
    const name = workingSetName();
    const sent = ids.slice(0, SET_MAX_TRACKS);
    setSaving(true);
    try {
      const made = await startWorkingSet(name, sent);
      window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: {} }));
      const count = typeof made.tracks === 'number' ? made.tracks : sent.length;
      const cut =
        ids.length > SET_MAX_TRACKS
          ? ` (the first ${SET_MAX_TRACKS}: a set holds ${SET_MAX_TRACKS})`
          : '';
      window.showToast?.(
        `Saved Up next as ${name} · ${count} ${count === 1 ? 'track' : 'tracks'}${cut} · your working set`,
        'success',
      );
    } catch (err) {
      window.showToast?.(err instanceof Error ? err.message : "The set wasn't made.", 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <button
      type="button"
      className={styles.textButton}
      onClick={() => void save()}
      disabled={saving}
      aria-busy={saving || undefined}
    >
      {saving ? 'Saving Up next…' : 'Save Up next as a set'}
    </button>
  );
}

/**
 * The set card (33b), at the top of Mix's left column:
 * - a set playing: "Playing Sunday Set · track 4 of 12", then "as a mix ·
 *   (Long blend · 32) into Static Bloom";
 * - else the working set: its name (the picker), "6 tracks · 38 min", how
 *   the playing track would follow its last, and "Add Night Ferry as #7"
 *   (A); a track already in it says so with Add again (UX-7);
 * - no working set: first run (33e).
 */
export function SetCard({ model }: { model: MixModel }) {
  const p = model.playing;
  const ws = model.workingSet;
  const card = useRef<HTMLDivElement>(null);
  const over = useDndSelect((s) => s.over);
  // Brief B (32b state 3): the set card is the working set's drop target; it
  // appends, or while the set plays goes in after the playing track (293)
  const playingThis = Boolean(p && ws && p.set?.id === ws.id);
  useDropTarget(ws ? 'mix-working' : null, () => ({
    id: 'mix-working',
    kind: 'working',
    listId: `working:${ws?.id ?? 0}`,
    name: ws?.name ?? 'the working set',
    el: () => card.current,
    accepts: () => {
      const reason = setRefusal(ws);
      return reason ? { ok: false, reason } : { ok: true };
    },
    hint: (drag) => {
      if (p && playingThis)
        return `after ${p.row.track?.title || p.row.title || 'the playing track'} (#${p.number}) · adds as #${p.number + 1}`;
      const n = ws ? holdingNumber(ws.id, drag.items) : null;
      return n ? duplicateWords(n) : `adds as #${model.addAt}`;
    },
    drop: async (drag) => {
      if (!ws) return null;
      const after =
        p && playingThis && p.row.track_id
          ? { track_id: String(p.row.track_id), number: p.number }
          : null;
      return sendToSet(ws, drag.items, { after });
    },
  }));
  const dropLine =
    over?.id === 'mix-working' ? (
      <p className={styles.setCardLine} data-dnd-sub="">
        {over.verdict.ok ? over.hint : over.verdict.reason}
      </p>
    ) : null;
  if (p) {
    const nextTitle = p.next?.track?.title || p.next?.title || '';
    const name = p.set?.name ?? ws?.name ?? 'the set';
    return (
      <div ref={card} className={styles.setCard} data-mix-set-card="" data-playing="">
        <p className={styles.setCardTitle}>
          Playing {name} · {trackOfWords(p.number, p.total).toLowerCase()}
        </p>
        {dropLine}
        {p.next ? (
          <p className={styles.setCardLine}>
            {p.asMix ? 'as a mix · ' : ''}
            <span className={styles.pill} data-tone={p.step?.kind ?? 'unknown'}>
              <i aria-hidden="true" />
              {nextTransitionWords(p.row)}
            </span>{' '}
            into {nextTitle}
            {p.step?.kind === 'jump' ? ' · a jump: mix on a break' : ''}
          </p>
        ) : (
          <p className={styles.setCardLine}>The set&apos;s last track</p>
        )}
        {/* fix/mix-stops: how ready the working set is to mix (its Play as a mix hides while a set plays) */}
        <WorkingSetMix model={model} />
      </div>
    );
  }
  if (!ws) return model.workingLoading ? null : <FirstRun model={model} />;
  const step = model.joinStep;
  const lead =
    model.last && model.subject && String(model.last.track_id) !== model.subject.id
      ? joinLead(model.subject.title, model.last.track?.title || model.last.title || '')
      : '';
  const already = model.inSet[0] ?? null;
  return (
    <div ref={card} className={styles.setCard} data-mix-set-card="">
      <div className={styles.setCardHead}>
        <span className={styles.headMeta}>Working set</span>
        <WorkingPicker model={model} />
      </div>
      {dropLine}
      {already !== null ? (
        // UX-7: nothing is added unasked; Add again is a quiet choice
        <p className={styles.setCardLine} data-mix-already="">
          Already in {ws.name} · #{already}
          {' · '}
          <button
            type="button"
            className={styles.inlineLink}
            disabled={model.busy}
            onClick={() => void model.addPlaying({ again: true })}
          >
            Add again
          </button>
        </p>
      ) : lead && step ? (
        <p className={styles.setCardLine}>
          {lead}:{' '}
          <span className={styles.stepWord} data-kind={step.kind}>
            {stepWord(step)}
          </span>{' '}
          · {step.reason}
        </p>
      ) : null}
      {already === null ? (
        <button
          type="button"
          className={styles.primary}
          title={`Add to ${ws.name} (A)`}
          disabled={model.busy || model.primaryDisabled || !model.subject}
          onClick={() => void model.addPlaying()}
          data-mix-primary=""
        >
          {model.primaryLabel}
        </button>
      ) : null}
      {/* fix/mix-stops: the working set isn't Up next; how ready it is, and Play it as a mix */}
      <WorkingSetMix model={model} />
      <SaveUpNext model={model} />
    </div>
  );
}

/* ── the tray (33b): Mix beside Up next ───────────────────────────────── */

/**
 * The tray in Mix (33b): the left column (modes, the set card, the record at
 * 56px) and Mixes well with in the middle; the right column is Up next
 * itself (index.html's list, shown beside these by static/player.css), with
 * Between tracks in its header. The working-set strip (29a) folds into the
 * set card and "Add as #5".
 */
export function MixTray({ model }: { model: MixModel }) {
  return (
    <>
      <div className={styles.left} data-mix-col="this-track">
        <MixLeft model={model} mode="mix" />
      </div>
      <section className={styles.middle} aria-label="Mixes well with" data-mix-col="matches">
        <MatchesColumn model={model} />
      </section>
    </>
  );
}

/* ── the working-set picker (29a, 295) ────────────────────────────────── */

function WorkingPicker({
  model,
  large = false,
  trigger = 'name',
}: {
  model: MixModel;
  large?: boolean;
  /** the first run's "Choose a set…" (33d, 33e) instead of the set's name */
  trigger?: 'name' | 'choose';
}) {
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
      window.showToast?.(err instanceof Error ? err.message : "The set wasn't made.", 'error');
    }
  };
  return (
    <Menu.Root modal={false}>
      {trigger === 'choose' ? (
        <Menu.Trigger className={styles.secondary} data-size={large ? 'lg' : undefined}>
          Choose a set…
        </Menu.Trigger>
      ) : (
        <Menu.Trigger
          className={styles.pickButton}
          data-size={large ? 'lg' : undefined}
          aria-label={ws ? `Working set: ${ws.name}. Choose another set` : 'Choose a working set'}
        >
          <span className={styles.pickName}>{ws ? ws.name : 'Choose a set'}</span>
          <span className={styles.pickMeta}>
            {meta ? `${meta} ` : ''}
            <span aria-hidden="true">▾</span>
          </span>
        </Menu.Trigger>
      )}
      <Menu.Portal>
        <Menu.Positioner className={styles.menu} align="end" sideOffset={6}>
          <Menu.Popup aria-label="Your sets">
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
            {sets.isPending ? <p className={styles.foot}>Loading your sets…</p> : null}
            <Menu.Separator className={styles.menuSeparator} />
            <Menu.Item
              className={styles.menuItem}
              onClick={() => void start()}
              disabled={!model.subject}
            >
              New set with {model.subject?.title || 'this track'}
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
  if (!p || (!ws && !p.set)) return null;
  const nextTitle = p.next?.track?.title || p.next?.title || '';
  return (
    <div className={styles.playing} data-mix-playing="">
      <p className={styles.playingTitle}>
        {compact
          ? trackOfWords(p.number, p.total)
          : `Playing ${p.set?.name ?? ws?.name ?? 'the set'} · ${trackOfWords(p.number, p.total).toLowerCase()}`}
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
      This is a stream preview. Mixes well with fills in once it&apos;s downloaded.
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
            : 'Add starts a set with the track.'}
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
  // first run (33d): "Start a set to mix into", and no other primary (292)
  if (!model.workingSet) return model.workingLoading ? null : <FirstRun model={model} phone />;
  return (
    <>
      <WorkingPicker model={model} large />
      <WorkingSetMix model={model} />
      <SetEnergy rows={rows} />
      <ol className={styles.setList} aria-label={`${model.workingSet.name}'s tracks`}>
        {rows.map((r, i) => {
          const t = r.track ?? r.gone_track ?? null;
          const step = into[i];
          // UX-26: a row whose file is gone says so, as the set's page does
          const missing = !r.track && Boolean(r.gone_track || r.track_id);
          return (
            <li
              key={`${i}-${r.track_id ?? r.title}`}
              className={styles.setRow}
              data-missing={missing ? '' : undefined}
            >
              <span className={styles.setNumber}>{numbered[i] ?? ''}</span>
              <span className={styles.rowText}>
                <span className={styles.rowTitle}>{t?.title || r.title}</span>
                {missing ? (
                  <span className={styles.setMeta}>
                    <StatusTag tone="warning">File missing</StatusTag> Skipped when played
                  </span>
                ) : (
                  <span className={styles.setMeta}>
                    {t?.dj?.key ? (
                      <KeyChip code={t.dj.key} uncertain={t.dj.key_uncertain} variant="text" />
                    ) : null}
                    {t?.dj?.key ? ' · ' : ''}
                    {t?.dj?.bpm ? bpmNumber(t.dj.bpm) : '— BPM'}
                    {' · '}
                    <span className={styles.stepWord} data-kind={step?.kind ?? 'start'}>
                      {step ? stepWord(step) : 'start'}
                    </span>
                  </span>
                )}
              </span>
              <SetRowMenu row={r} label={`More for ${t?.title || r.title || 'this track'}`} />
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className={styles.primary}
        disabled={model.busy || model.primaryDisabled || !model.subject}
        onClick={() => void model.addPlaying()}
      >
        {model.primaryLabel}
      </button>
      {model.inSet.length && !model.playingWorking ? (
        <button
          type="button"
          className={styles.textButton}
          disabled={model.busy}
          onClick={() => void model.addPlaying({ again: true })}
        >
          Add again
        </button>
      ) : null}
    </>
  );
}

/**
 * The phone's Mix (33d): the record in a line (title, "Tidewater · 124 · 8A
 * · E6"), the set's one line ("Sunday Set · track 4 of 12" with "Auto mix
 * on"), Mixes well with (Play and "…" on each row), and "Add Night Ferry
 * as #5".
 */
function MixTabPhone({ model }: { model: MixModel }) {
  const [refused, setRefused] = useState(false);
  const subject = model.subject;
  const prefs = usePrefs();
  if (!subject) return null;
  const p = model.playing;
  const setName = p?.set?.name ?? model.workingSet?.name ?? null;
  return (
    <>
      <div className={styles.compact} data-mix-record="">
        <span className={styles.compactArt} aria-hidden="true">
          {subject.image ? <img src={subject.image} alt="" /> : null}
        </span>
        <span className={styles.nowText}>
          <span className={styles.nowTitle}>{subject.title}</span>
          <RecordLine model={model} />
        </span>
        <span className={styles.star}>
          <StarButton id={subject.id} title={subject.title} variant="player" />
        </span>
      </div>
      {setName ? (
        <div className={styles.setStrip} data-mix-set-strip="">
          <span className={styles.setStripName}>
            {setName}
            {p ? ` · ${trackOfWords(p.number, p.total).toLowerCase()}` : ''}
          </span>
          <span className={styles.setStripMeta}>
            {p?.asMix || prefs.between === 'dj' ? 'Auto mix on' : 'Auto mix off'}
          </span>
        </div>
      ) : null}
      <NotAnalysedLine model={model} phone />
      <div className={styles.head}>
        <h3 className={`${styles.headTitle} ${styles.spacer}`}>Mixes well with</h3>
        <VibeSwitch model={model} large onRefused={() => setRefused(true)} />
        <MatchesMore model={model} />
      </div>
      <BackRow model={model} />
      <MatchesBody model={model} place="sheet" />
      <Foot model={model} refused={refused} place="sheet" />
      {model.workingSet ? (
        <button
          type="button"
          className={styles.primary}
          disabled={model.busy || model.primaryDisabled}
          onClick={() => void model.addPlaying()}
        >
          {model.primaryLabel}
        </button>
      ) : null}
    </>
  );
}

/**
 * The phone's sheet below its one tab row (33d, 291): Mix or Set. The tabs
 * are in the sheet's head (ModesSwitch with `phone`, under the handle): no
 * title, no back row, and a swipe down closes from any tab.
 */
export function MixSheet({
  model,
  tab,
  preview,
}: {
  model: MixModel;
  tab: 'mix' | 'set';
  preview: string | null;
}) {
  return (
    <div className={styles.sheet} data-mix-sheet="" data-tab={tab}>
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
