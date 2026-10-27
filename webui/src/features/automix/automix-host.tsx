/**
 * Auto-mix in the player (stage C; 26a–26h), rendered by the router's root
 * so it shares the app's queries, and placed into the shell's static markup
 * (webui/index.html) with portals:
 *
 * - `#ss-between-tracks-settings`: Player settings → Between tracks (26h);
 * - `[data-automix-gap]`: Up next's gaps (static/media-player.js makes one
 *   after each row from the playing one on, while DJ mix is on): the chip;
 * - `[data-automix-slot="mixnow-bar"]` / `="mixnow-deck"`: Mix now, beside
 *   Next in the bar and in the tray;
 * - `[data-automix-slot="bar"]`: the bar's middle while it counts down,
 *   mixes or crossfades in a mix's place (26e);
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
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal, flushSync } from 'react-dom';

import type { Transition } from '@/features/sets/sets.api';

import { postDjJob, DJ_QUERY_KEY } from '@/features/dj/dj.api';
import { Engine } from '@/features/engine/engine';
import { looksLikePhone } from '@/features/engine/lifecycle';
import { fetchGrids, fetchWindow } from '@/features/engine/loader';
import workletUrl from '@/features/engine/worklet/deck-processor.js?url';
import { useProfile } from '@/platform/shell/route-controllers';
import { appURL } from '@/platform/url-base';

import styles from './automix.module.css';
import { BetweenTracksSettings } from './between-tracks';
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
import { TransitionChip, type ChipLive } from './mix-chip';
import { AUTO_CHOICE, inWords, planFor, planKey, stepOf, type Choice } from './plans';
import { getPrefs, refreshPrefs, subscribePrefs, usePrefs } from './prefs';
import { saveTransitionToSet } from './set-play';
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
      next(): boolean;
      previous(): void;
      key(k: string): boolean;
      view(): AutomixView;
    };
  }
}

interface PlayerApi extends PlayerPort {
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
  crossfadeInto: (index, hint) => Boolean(playerApi()?.crossfadeInto(index, hint)),
  insertNext: (track) => playerApi()?.insertNext(track) ?? -1,
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
    plan: (from, to, choice) => qc.fetchQuery(planQuery(qc, from, to, choice)),
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
    async peaks(id) {
      const res = await fetch(appURL(`/api/library/tracks/${encodeURIComponent(id)}/peaks`), {
        credentials: 'same-origin',
      });
      if (!res.ok || res.status === 202) return null;
      const body = (await res.json()) as { peaks?: number[] | null };
      return Array.isArray(body.peaks) ? body.peaks : null;
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
  settings: HTMLElement | null;
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
    settings: document.getElementById('ss-between-tracks-settings'),
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
    a.settings === b.settings &&
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
  const choice = choiceOf(from);
  const plan = useQuery({
    ...planQuery(qc, fromId, toId, choice),
    enabled: ok,
    refetchInterval: (q) => (q.state.data?.status === 'waiting' ? 30_000 : false),
  });
  const auto = useQuery({
    ...planQuery(qc, fromId, toId, AUTO_CHOICE),
    enabled: ok && open && choice.style !== 'auto',
  });
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
  // a page that can't run the decks: the pair crossfades, saying why
  const data =
    plan.data && view.unsupported && plan.data.status === 'ok'
      ? {
          ...plan.data,
          status: 'crossfade',
          style: 'crossfade',
          length_s: 6,
          fallback: { kind: 'crossfade', code: 'unsupported', reason: view.unsupported },
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
      analyse={
        profile?.isAdmin
          ? () => {
              void postDjJob('start', waitingId)
                .then(() => qc.invalidateQueries({ queryKey: [...DJ_QUERY_KEY] }))
                .catch((e: unknown) =>
                  window.showToast?.(e instanceof Error ? e.message : "That didn't work.", 'error'),
                );
            }
          : null
      }
      saveTo={
        set
          ? {
              name: set.name,
              save: async (t) => {
                await saveTransitionToSet(set, String(from.id), String(to.id), t);
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
        from.automix = { style: t.style, bars: t.bars } as Choice;
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
  const [, setTick] = useState(0);

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
      view.fallback !== null
        ? 'fallback'
        : view.stage === 'counting' || (view.barsToGo !== null && !view.transition)
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
  const crossfadeSeconds = (st as { crossfadeSeconds?: number }).crossfadeSeconds ?? 6;
  const handing = ['counting', 'mixing', 'settling', 'handback', 'back'].includes(view.stage);
  const counting = view.barsToGo !== null && !view.transition;

  return (
    <>
      {slots.settings
        ? createPortal(
            <BetweenTracksSettings crossfadeSeconds={crossfadeSeconds} />,
            slots.settings,
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
      {slots.bar && (handing || counting || view.fallback)
        ? createPortal(<BarStatus view={view} actions={actions} />, slots.bar)
        : null}
      {slots.record && handing ? createPortal(<HandoverRecord view={view} />, slots.record) : null}
      {slots.deck && (handing || counting)
        ? createPortal(<HandoverDeck view={view} actions={actions} />, slots.deck)
        : null}
      <LiveWords view={view} />
    </>
  );
}

/** What a screen reader hears, once each (26e). */
function LiveWords({ view }: { view: AutomixView }) {
  const [words, setWords] = useState('');
  const key =
    view.fallback !== null
      ? `fallback:${view.fallback}`
      : view.stage === 'counting'
        ? `counting:${view.pair?.toId}`
        : view.stage === 'mixing'
          ? `mixing:${view.pair?.toId}`
          : view.stage === 'back'
            ? `back:${view.pair?.fromId}`
            : '';
  useEffect(() => {
    if (!key) return;
    const to = view.pair?.toTitle || 'the next track';
    const from = view.pair?.fromTitle || 'this track';
    if (key.startsWith('fallback')) setWords(`Couldn't beat-match: crossfading. ${view.fallback}`);
    else if (key.startsWith('counting')) setWords(`Mixing into ${to} on the next phrase`);
    else if (key.startsWith('mixing')) setWords(`Mixing ${from} into ${to}`);
    else if (key.startsWith('back')) setWords(`Back to ${from}`);
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
