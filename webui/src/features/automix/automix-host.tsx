/**
 * Auto-mix in the player (stage C; 26a–26h), rendered by the router's root
 * so it shares the app's queries, and placed into the shell's static markup
 * (webui/index.html) with portals:
 *
 * - `#ss-between-tracks-library`: Settings → Library → DJ's Between tracks
 *   (33e: the cards, the style, key lock and the note);
 * - `#ss-between-tracks-settings`: Player settings → Between tracks, the
 *   small control and the way to the rest (33e replaces 26h's cards);
 * - `[data-automix-slot="menu-between"]`: the same control in the player's "…";
 * - `[data-automix-slot="upnext-head"]`: Up next's head: Between tracks, and
 *   with Auto mix off "Auto mix is off: tracks play straight on · Turn it
 *   on", once (320, UX-21);
 * - `#ss-https-note`: Settings → Connections points at https (312);
 * - `[data-automix-gap]`: Up next's gaps (static/media-player.js makes one
 *   after each row from the playing one on, while DJ mix is on): the chip;
 * - `[data-automix-slot="mixnow-bar"]` / `="mixnow-deck"`: Mix now, beside
 *   Next in the bar and in the tray;
 * - `[data-automix-slot="bar"]`: the bar's middle while it counts down,
 *   or mixes (26e);
 * - `[data-automix-slot="record"]` / `="deck"`: the handover in the tray's
 *   record and in the waveform's place (26d; the phone's sheet, 26f).
 *
 * `#media-player[data-automix]` (counting, mixing, fallback) tells
 * static/player.css to step the waveform and the record aside, and each
 * `[data-player-wave]` gets a cyan marker where the mix will start
 * (`--automix-at`). `window.SoulSyncAutomix` is what media-player.js asks
 * (CONTRACTS "Auto-mix stage C").
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal, flushSync } from 'react-dom';

import type { Transition } from '@/features/sets/sets.api';

import { useAnalysis } from '@/features/dj/analysis-line';
import {
  DJ_ANALYSED_EVENT,
  askForAdded,
  requestAnalysis,
  requestAnalysisQuietly,
} from '@/features/dj/analysis.api';
import { addedAnalysisWords } from '@/features/dj/analysis.format';
import { DJ_QUERY_KEY } from '@/features/dj/dj.api';
import { Engine } from '@/features/engine/engine';
import { looksLikePhone } from '@/features/engine/lifecycle';
import { fetchGrids, fetchWindow } from '@/features/engine/loader';
import workletUrl from '@/features/engine/worklet/deck-processor.js?url';
import { SETS_QUERY_KEY } from '@/features/sets/sets.api';
import { useProfile } from '@/platform/shell/route-controllers';

import styles from './automix.module.css';
import { AutoMixOffLine, BetweenTracksSettings, BetweenTracksSwitch } from './between-tracks';
import {
  AutomixController,
  choiceOf,
  mixable,
  playedAsMix,
  type AutomixView,
  type CrossfadeHint,
  type PlayerPort,
  type QueueTrack,
} from './controller';
import {
  BarStatus,
  HandoverDeck,
  HandoverRecord,
  MixNowButton,
  type HandoverActions,
} from './handover';
import { HttpsNote } from './https-note';
import { TransitionChip, type ChipLive } from './mix-chip';
import { AUTO_CHOICE, inWords, planFor, planKey, stepOf, type Choice } from './plans';
import { getPrefs, refreshPrefs, subscribePrefs, usePrefs } from './prefs';
import { saveTransitionToDraft, saveTransitionToSet } from './set-play';
import { openBetweenTracksSettings } from './settings-link';
import { mixSupport } from './support';

declare global {
  interface Window {
    SoulSyncAutomix?: {
      gapsWanted(): boolean;
      ownsAdvance(): boolean;
      crossfade(
        current: QueueTrack | null,
        next: QueueTrack | null,
        index?: number,
      ): CrossfadeHint | null;
      beforeLoad(index: number, options?: { automix?: boolean }): void;
      /** other audio than the queue's next row is loading: the decks let go (H2) */
      stop(): void;
      next(): boolean;
      previous(): void;
      key(k: string): boolean;
      view(): AutomixView;
    };
  }
}

interface PlayerApi extends Omit<PlayerPort, 'moveNext'> {
  moveNext?: (index: number) => number;
  audioGraph?: () => { context: AudioContext; analyser: AnalyserNode } | null;
  persistQueue?: () => void;
}

function playerApi(): PlayerApi | null {
  return (window as unknown as { SoulSyncPlayer?: PlayerApi }).SoulSyncPlayer ?? null;
}

const EMPTY_STATE = {
  track: null,
  kind: null,
  playing: false,
  queue: [],
  index: -1,
  shuffle: false,
  repeat: 'off',
  volume: 70,
  muted: false,
};

/** The player as auto-mix drives it (window.SoulSyncPlayer, made by media-player.js). */
const port: PlayerPort = {
  state: () => (playerApi()?.state() ?? EMPTY_STATE) as ReturnType<PlayerPort['state']>,
  audio: () => playerApi()?.audio() ?? null,
  playIndex: (index, options) =>
    playerApi()?.playIndex(index, options) ?? Promise.resolve({ status: 'failed' }),
  insertNext: (track) => playerApi()?.insertNext(track) ?? -1,
  moveNext: (index) => playerApi()?.moveNext?.(index) ?? index,
  renderQueue: () => playerApi()?.renderQueue(),
};

function planQuery(qc: QueryClient, from: string, to: string, choice: Choice) {
  const lean = getPrefs().lean;
  return {
    queryKey: planKey(from, to, choice, lean),
    queryFn: () => planFor(from, to, choice, lean),
    staleTime: 60_000,
    retry: false,
  } as const;
}

let shared: AutomixController | null = null;

function controllerFor(qc: QueryClient): AutomixController {
  if (shared) return shared;
  shared = new AutomixController(port, {
    plan: (from, to, choice, _lean, fresh) =>
      qc.fetchQuery(
        fresh
          ? { ...planQuery(qc, from, to, choice), staleTime: 0 }
          : planQuery(qc, from, to, choice),
      ),
    grids: (ids) => fetchGrids(ids),
    window: (ctx, id, start, dur) => fetchWindow(ctx, id, start, dur),
    async engine() {
      if (typeof AudioWorkletNode === 'undefined') return null;
      const g = playerApi()?.audioGraph?.();
      if (!g) return null;
      return Engine.create({
        context: g.context,
        workletUrl,
        tap: g.analyser,
        phone: looksLikePhone(typeof navigator === 'object' ? navigator : null),
      });
    },
    prefs: getPrefs,
    support: () => mixSupport(),
  });
  return shared;
}

function useView(ctl: AutomixController): AutomixView {
  return useSyncExternalStore(
    (fn) => ctl.subscribe(fn),
    () => ctl.getView(),
    () => ctl.getView(),
  );
}

interface Slots {
  /** the player itself: what a screen reader hears is said inside it */
  player: HTMLElement | null;
  settings: HTMLElement | null;
  library: HTMLElement | null;
  https: HTMLElement | null;
  menu: HTMLElement | null;
  upnextHead: HTMLElement | null;
  gaps: HTMLElement[];
  bar: HTMLElement | null;
  record: HTMLElement | null;
  deck: HTMLElement | null;
  mixNowBar: HTMLElement | null;
  mixNowDeck: HTMLElement | null;
}

function findSlots(): Slots {
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  return {
    player: document.getElementById('media-player'),
    settings: document.getElementById('ss-between-tracks-settings'),
    library: document.getElementById('ss-between-tracks-library'),
    https: document.getElementById('ss-https-note'),
    menu: q('[data-automix-slot="menu-between"]'),
    upnextHead: q('[data-automix-slot="upnext-head"]'),
    gaps: Array.from(document.querySelectorAll<HTMLElement>('[data-automix-gap]')),
    bar: q('[data-automix-slot="bar"]'),
    record: q('[data-automix-slot="record"]'),
    deck: q('[data-automix-slot="deck"]'),
    mixNowBar: q('[data-automix-slot="mixnow-bar"]'),
    mixNowDeck: q('[data-automix-slot="mixnow-deck"]'),
  };
}

function sameSlots(a: Slots, b: Slots): boolean {
  return (
    a.player === b.player &&
    a.settings === b.settings &&
    a.library === b.library &&
    a.https === b.https &&
    a.menu === b.menu &&
    a.upnextHead === b.upnextHead &&
    a.bar === b.bar &&
    a.record === b.record &&
    a.deck === b.deck &&
    a.mixNowBar === b.mixNowBar &&
    a.mixNowDeck === b.mixNowDeck &&
    a.gaps.length === b.gaps.length &&
    a.gaps.every((g, i) => g === b.gaps[i])
  );
}

const PHONE_QUERY = '(max-width: 768px)';

function usePhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE_QUERY).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(PHONE_QUERY);
    if (!list) return;
    const on = () => setPhone(list.matches);
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, []);
  return phone;
}

/** One gap's chip in Up next (26a, 26b, 26g). */
function GapChip({
  index,
  view,
  ctl,
  phone,
}: {
  index: number;
  view: AutomixView;
  ctl: AutomixController;
  phone: boolean;
}) {
  const qc = useQueryClient();
  const prefs = usePrefs();
  const profile = useProfile();
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  const st = port.state();
  const from = st.queue[index];
  const to = st.queue[index + 1];
  // DJ mix's chips; a set played as a mix has its own whatever the setting (28e)
  const ok = mixable(from) && mixable(to) && (prefs.between === 'dj' || playedAsMix(from, to));
  const fromId = ok ? String(from.id) : '';
  const toId = ok ? String(to.id) : '';
  const choice = choiceOf(from, to);
  const plan = useQuery({
    ...planQuery(qc, fromId, toId, choice),
    enabled: ok,
    refetchInterval: (q) => (q.state.data?.status === 'waiting' ? 30_000 : false),
  });
  const auto = useQuery({
    ...planQuery(qc, fromId, toId, AUTO_CHOICE),
    enabled: ok && open && choice.style !== 'auto',
  });
  // Waiting (26g): the track the plan waits for shows its step and bar
  const waitsFor =
    ok && plan.data?.status === 'waiting'
      ? plan.data.waiting_for === 'from'
        ? fromId
        : toId
      : null;
  const progressOf = useAnalysis([waitsFor]);
  const progress = waitsFor ? (progressOf[waitsFor] ?? null) : null;
  if (!ok) return null;
  const fromTitle = from.title || 'this track';
  const toTitle = to.title || 'the next track';
  const mine = view.pair && view.pair.fromId === fromId && view.pair.toIndex === index + 1;
  let live: ChipLive | null = null;
  if (mine && ['mixing', 'settling', 'handback'].includes(view.stage))
    live = { kind: 'mixing', words: `${fromTitle} → ${toTitle}` };
  else if (
    mine &&
    view.barsToGo !== null &&
    (view.stage === 'counting' || view.manual || view.barsToGo <= 16)
  )
    live = { kind: 'counting', bars: view.barsToGo, onCancel: () => ctl.cancel() };
  const set = from.mix_set && to.mix_set && from.mix_set.id === to.mix_set.id ? from.mix_set : null;
  // a page that can't run the decks: the pair plays on (no crossfade, no
  // chip; Mix now and Between tracks say why). A cut needs no decks.
  const data =
    plan.data && view.unsupported && plan.data.status === 'ok'
      ? {
          ...plan.data,
          status: 'play_on',
          style: null,
          out: undefined,
          in: undefined,
          fallback: { kind: 'play_on', code: 'unsupported', reason: view.unsupported },
        }
      : (plan.data ?? null);
  const waitingId = data?.waiting_for === 'from' ? fromId : toId;
  return (
    <TransitionChip
      transition={choice as Transition}
      step={{ kind: stepOf(data), reason: data?.why ?? '' }}
      from={fromTitle}
      to={toTitle}
      plan={data}
      autoPlan={choice.style === 'auto' ? data : (auto.data ?? null)}
      live={live}
      when={mine && index === st.index && !live ? inWords(view.inSeconds) : null}
      compact={phone}
      floating
      onOpenChange={setOpen}
      progress={progress}
      // anyone can ask for their own tracks now (analyse on demand)
      analyse={() => {
        void requestAnalysis([waitingId], { force: true, source: 'up_next' })
          .then(() => qc.invalidateQueries({ queryKey: [...DJ_QUERY_KEY, 'status'] }))
          .catch((e: unknown) =>
            window.showToast?.(e instanceof Error ? e.message : "That didn't work.", 'error'),
          );
      }}
      saveTo={
        set
          ? {
              name: set.name,
              save: async (t) => {
                if (set.draft) {
                  // a draft played as a mix (319): saved to it in this browser
                  saveTransitionToDraft(profile?.profileId ?? 0, String(from.id), String(to.id), t);
                  for (const q of st.queue)
                    if (q.mix_set?.draft && q.mix_set.row === set.row)
                      q.mix_set = { ...q.mix_set, transition: { style: t.style, bars: t.bars } };
                  playerApi()?.persistQueue?.();
                  return;
                }
                await saveTransitionToSet(set, String(from.id), String(to.id), t);
                // the set's page reads it again (L2)
                void qc.invalidateQueries({
                  queryKey: [...SETS_QUERY_KEY, 'set', profile?.profileId ?? 0, set.id],
                });
                for (const q of st.queue)
                  if (q.mix_set?.id === set.id && q.mix_set.row === set.row)
                    q.mix_set = { ...q.mix_set, transition: { style: t.style, bars: t.bars } };
                playerApi()?.persistQueue?.();
              },
            }
          : null
      }
      onChange={(t) => {
        // kept on the row (the step out of it) for this queue; Up next isn't
        // drawn again, so the picker stays open for the length
        // the pair it describes (283: another next track is Auto again)
        from.automix = { style: t.style, bars: t.bars, to: toId } as Choice & { to: string };
        playerApi()?.persistQueue?.();
        bump((n) => n + 1);
        ctl.poke();
      }}
    />
  );
}

export function AutomixHost() {
  const qc = useQueryClient();
  const ctl = useMemo(() => controllerFor(qc), [qc]);
  const view = useView(ctl);
  const prefs = usePrefs();
  const phone = usePhone();
  const [slots, setSlots] = useState<Slots>(() => findSlots());
  const [tick, setTick] = useState(0);
  /** the pair last asked for as Up next's next transition */
  const soonAsked = useRef<string | null>(null);

  // analyse on demand: with DJ mix on (or a set played as a mix), the queue's
  // coming tracks jump the analysis queue, so their chips stop Waiting; the
  // server skips the ones already done, and each is asked once in a while
  useEffect(() => {
    const st = port.state();
    if (st.shuffle) return;
    const dj = prefs.between === 'dj';
    const from = Math.max(0, st.index);
    const ids = st.queue
      .slice(from, from + 50)
      .filter((t) => mixable(t) && (dj || Boolean(t.mix_set)))
      .map((t) => String(t.id));
    if (ids.length < 2) return;
    // the next transition's pair goes ahead of every other ask, so a
    // member's long Analyse mine doesn't hold up the mix (review L10); asked
    // once each time the pair changes, whatever was asked before
    const pair = ids.slice(0, 2);
    const key = pair.join(',');
    if (soonAsked.current !== key) {
      soonAsked.current = key;
      // turned away (a Stop holds the sweeps: null) or failed: asked again
      // as soon next time, so after Resume the pair still goes first (re-review L10)
      requestAnalysis(pair, { force: true, reason: 'auto', source: 'up_next', soon: true })
        .then((answer) => {
          if (answer === null && soonAsked.current === key) soonAsked.current = null;
        })
        .catch(() => {
          if (soonAsked.current === key) soonAsked.current = null;
        });
    }
    // "Up next" is why they're in line (the popover's words, HANDOFF 325)
    if (ids.length > 2) requestAnalysisQuietly(ids.slice(2), 'auto', { source: 'up_next' });
  }, [tick, prefs.between]);

  // the player's Added toast (Play next, Add to Up next) says once where a
  // track is in the analysis line while Auto mix is on (Brief A, 31b)
  useEffect(() => {
    const dj = prefs.between === 'dj';
    window.ssAnalysisToastWords = (ids) =>
      dj
        ? askForAdded(ids, { source: 'up_next' }).then((a) => addedAnalysisWords(a))
        : Promise.resolve('');
    return () => {
      delete window.ssAnalysisToastWords;
    };
  }, [prefs.between]);

  // a track finished its analysis: a pair waiting for it is planned again
  useEffect(() => {
    const again = () => ctl.replanWaiting();
    window.addEventListener(DJ_ANALYSED_EVENT, again);
    return () => window.removeEventListener(DJ_ANALYSED_EVENT, again);
  }, [ctl]);

  useEffect(() => {
    ctl.start();
    const onPlayer = (e: Event) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
      if (reason === 'settings') refreshPrefs();
      // Up next was just drawn again: fill its new gaps before the browser
      // paints (a microtask, so never inside React's own render or effects)
      queueMicrotask(() => {
        const next = findSlots();
        flushSync(() => {
          setSlots((prev) => (sameSlots(prev, next) ? prev : next));
          if (reason === 'queue' || reason === 'track' || reason === 'init') setTick((n) => n + 1);
        });
      });
      ctl.poke();
    };
    window.addEventListener('ss:player', onPlayer);
    // the settings panel and the slots exist once the shell has drawn
    const late = window.setTimeout(() => setSlots(findSlots()), 500);
    window.SoulSyncAutomix = {
      gapsWanted: () => {
        const st = port.state();
        if (st.shuffle) return false;
        if (getPrefs().between === 'dj') return true;
        // a set played as a mix shows its chips whatever the setting (28e)
        return st.queue.some((t) => t.mix_set);
      },
      ownsAdvance: () => ctl.ownsAdvance(),
      crossfade: (current, next) => ctl.crossfade(current, next),
      beforeLoad: (index, options) => ctl.beforeLoad(index, options),
      stop: () => ctl.otherAudio(),
      next: () => ctl.next(),
      previous: () => ctl.previous(),
      key: (k) => ctl.key(k),
      view: () => ctl.getView(),
    };
    // Up next draws its gaps once we're here
    port.renderQueue();
    return () => {
      window.removeEventListener('ss:player', onPlayer);
      window.clearTimeout(late);
      delete window.SoulSyncAutomix;
      ctl.stop();
    };
  }, [ctl]);

  // the setting changed: Up next's gaps come or go
  useEffect(() => subscribePrefs(() => ctl.poke()), [ctl]);

  // #media-player says what's happening; the waveforms mark the mix's start
  useEffect(() => {
    const root = document.getElementById('media-player');
    const stage =
      view.stage === 'counting' || (view.barsToGo !== null && !view.transition)
        ? 'counting'
        : ['mixing', 'settling', 'handback', 'back'].includes(view.stage)
          ? 'mixing'
          : null;
    if (root) {
      if (stage) root.dataset.automix = stage;
      else delete root.dataset.automix;
    }
    const el = port.audio();
    const duration = el && Number.isFinite(el.duration) ? el.duration : 0;
    const at = view.outStart !== null && duration > 0 ? (view.outStart / duration) * 100 : null;
    for (const w of document.querySelectorAll<HTMLElement>('[data-player-wave]')) {
      if (at !== null && at > 0 && at < 100 && view.dj) {
        w.style.setProperty('--automix-at', `${at.toFixed(2)}%`);
        w.dataset.automixMark = '';
      } else {
        w.style.removeProperty('--automix-at');
        delete w.dataset.automixMark;
      }
    }
  }, [view]);

  const actions: HandoverActions = useMemo(
    () => ({
      mixNow: () => void ctl.mixNow(),
      cancel: () => ctl.cancel(),
      finishNow: () => ctl.finishNow(),
      back: () => ctl.back(),
    }),
    [ctl],
  );

  const st = port.state();
  const handing = ['counting', 'mixing', 'settling', 'handback', 'back'].includes(view.stage);
  const counting = view.barsToGo !== null && !view.transition;

  // Up next's head (33e, 320): Between tracks, while the queue holds a
  // library track auto-mix could take; with Auto mix off, said once, unless
  // every coming pair is a set played as a mix (its chips play whatever)
  const upcoming = st.queue.slice(Math.max(0, st.index));
  const anyMixable = upcoming.some((t) => mixable(t));
  let offPairs = false;
  for (let i = 0; i + 1 < upcoming.length; i++)
    if (
      mixable(upcoming[i]) &&
      mixable(upcoming[i + 1]) &&
      !playedAsMix(upcoming[i], upcoming[i + 1])
    )
      offPairs = true;
  return (
    <>
      {slots.library ? createPortal(<BetweenTracksSettings />, slots.library) : null}
      {slots.settings ? createPortal(<PlayerSettingsBetween />, slots.settings) : null}
      {slots.https ? createPortal(<HttpsNote />, slots.https) : null}
      {slots.menu ? createPortal(<BetweenTracksSwitch showLabel />, slots.menu) : null}
      {slots.upnextHead && anyMixable && !st.shuffle
        ? createPortal(
            <div className={styles.upnextHead} data-upnext-head="">
              <div className={styles.upnextHeadRow}>
                <BetweenTracksSwitch showLabel />
              </div>
              {offPairs ? <AutoMixOffLine besideSwitch /> : null}
            </div>,
            slots.upnextHead,
          )
        : null}
      {prefs.between === 'dj' || st.queue.some((t) => t.mix_set)
        ? slots.gaps.map((gap) => {
            const index = Number(gap.dataset.automixGap);
            if (!Number.isInteger(index)) return null;
            return createPortal(
              <div className={styles.gap} data-gap-index={index}>
                <GapChip index={index} view={view} ctl={ctl} phone={phone} />
              </div>,
              gap,
              `gap-${index}`,
            );
          })
        : null}
      {slots.mixNowBar
        ? createPortal(
            <MixNowButton view={view} onMixNow={actions.mixNow} compact />,
            slots.mixNowBar,
          )
        : null}
      {slots.mixNowDeck
        ? createPortal(<MixNowButton view={view} onMixNow={actions.mixNow} />, slots.mixNowDeck)
        : null}
      {slots.bar && (handing || counting)
        ? createPortal(<BarStatus view={view} actions={actions} />, slots.bar)
        : null}
      {slots.record && handing ? createPortal(<HandoverRecord view={view} />, slots.record) : null}
      {slots.deck && (handing || counting)
        ? createPortal(<HandoverDeck view={view} actions={actions} phone={phone} />, slots.deck)
        : null}
      {slots.player ? createPortal(<LiveWords view={view} />, slots.player) : null}
    </>
  );
}

/**
 * What a screen reader hears, once each (26e, UX-15): "Mixing into Static
 * Bloom in 16 bars" (or "Cutting to …") when the countdown starts, "Mixing
 * now", then "Now playing Static Bloom", "Mix cancelled" or "Back to Night
 * Ferry". The bar count itself stays visual (it changed every bar, and
 * flooded the polite region).
 */
export function liveKey(view: AutomixView): string {
  const to = view.pair?.toId ?? '';
  if (view.cancelled) return `cancelled:${to}`;
  if (view.stage === 'back') return `back:${view.pair?.fromId ?? ''}`;
  if (view.stage === 'mixing') return `mixing:${to}`;
  if (view.stage === 'settling' || view.stage === 'handback') return `done:${to}`;
  if (view.stage === 'counting' || (view.barsToGo !== null && !view.transition))
    return `counting:${to}`;
  return '';
}

export function liveWords(key: string, view: AutomixView): string {
  const to = view.pair?.toTitle || 'the next track';
  const from = view.pair?.fromTitle || 'this track';
  if (key.startsWith('counting')) {
    const n = view.barsToGo ?? 0;
    const bars = `${n} bar${n === 1 ? '' : 's'}`;
    return view.plan?.status === 'cut'
      ? `Cutting to ${to} in ${bars}`
      : `Mixing into ${to} in ${bars}`;
  }
  if (key.startsWith('mixing')) return 'Mixing now';
  if (key.startsWith('done')) return `Now playing ${to}`;
  if (key.startsWith('cancelled')) return 'Mix cancelled';
  if (key.startsWith('back')) return `Back to ${from}`;
  return '';
}

function LiveWords({ view }: { view: AutomixView }) {
  const [words, setWords] = useState('');
  const key = liveKey(view);
  useEffect(() => {
    if (!key) return;
    setWords(liveWords(key, view));
    // the words are read once for each change of what's happening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
        clip: 'rect(0 0 0 0)',
      }}
      data-automix-live=""
    >
      {words}
    </span>
  );
}

/**
 * Player settings → Between tracks (33e replaces 26h's cards there): the
 * same small control, and the way to the style and key lock in Settings →
 * Library → DJ.
 */
function PlayerSettingsBetween() {
  return (
    <div className={styles.playerSettingsBetween} data-player-between="">
      <BetweenTracksSwitch showLabel />
      <p className={styles.offLine}>
        Style when Auto can choose and key lock:{' '}
        <button type="button" className={styles.textButton} onClick={openBetweenTracksSettings}>
          Settings → Library → DJ
        </button>
      </p>
    </div>
  );
}
