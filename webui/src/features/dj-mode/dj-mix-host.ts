/**
 * DJ mode's decks as the page makes them (step 3): one session, its engine
 * made on the player's AudioContext and into its analyser the first time B
 * is loaded (never behind the mixing setting, 425), its windows through the
 * engine's loader. Tests make their own `DjMixSession` with fakes.
 */
import { Engine } from '@/features/engine/engine';
import { fetchWindow } from '@/features/engine/loader';
import workletUrl from '@/features/engine/worklet/deck-processor.js?url';

import type { EngineLike, PlayerPort } from './dj-mix-session';

import { DjMixSession } from './dj-mix-session';
import { djModeStore } from './dj-mode-store';
import { browserOutputsEnv, DjOutputs } from './dj-outputs-host';

interface PlayerApi extends PlayerPort {
  audioGraph?: () => { context: AudioContext; analyser: AnalyserNode } | null;
}

function player(): PlayerApi | null {
  return ((window as Window & { SoulSyncPlayer?: PlayerApi }).SoulSyncPlayer ??
    null) as PlayerApi | null;
}

/**
 * Whether this page can run the decks (the engine's AudioWorklet): browsers
 * give it only to a secure page, https or the computer's own address
 * (automix/support.ts says the same for Auto mix).
 */
export function djDeckSupport(
  win: { isSecureContext?: boolean; AudioWorkletNode?: unknown } = window as unknown as {
    isSecureContext?: boolean;
    AudioWorkletNode?: unknown;
  },
): string | null {
  if (win.isSecureContext === false)
    return 'Play B needs SYNCHRO.S on https, or opened on its own computer: browsers only run the two decks on a secure page';
  if (typeof win.AudioWorkletNode === 'undefined')
    return 'This browser can’t run the two decks, so B can’t be played here';
  return null;
}

let shared: DjMixSession | null = null;
let sharedOutputs: DjOutputs | null = null;

/** The outputs (37r) for the page's session. */
export function djOutputs(): DjOutputs {
  sharedOutputs ??= new DjOutputs(browserOutputsEnv(), djMixSession(), (w) =>
    djModeStore().announce(w),
  );
  return sharedOutputs;
}

export function djMixSession(): DjMixSession {
  shared ??= new DjMixSession({
    player: {
      audio: () => player()?.audio?.() ?? null,
      state: () => player()?.state?.() ?? null,
      seek: (seconds) => player()?.seek?.(seconds),
      // Hand over (step 4, 414): B's row after the playing one, played joining deck B
      next: () => player()?.next?.(),
      playIndex: (index, options) =>
        player()?.playIndex?.(index, options) ?? Promise.resolve({ status: 'failed' }),
      insertNext: (track) => player()?.insertNext?.(track) ?? -1,
      remove: (index) => player()?.remove?.(index),
    },
    async engine(): Promise<EngineLike | null> {
      if (typeof AudioWorkletNode === 'undefined') return null;
      const g = player()?.audioGraph?.();
      if (!g) return null;
      return (await Engine.create({
        context: g.context,
        workletUrl,
        tap: g.analyser,
      })) as unknown as EngineLike;
    },
    fetchWindow: (ctx, id, start, dur, signal) => fetchWindow(ctx, id, start, dur, { signal }),
    // one voice for DJ mode: the store's (one announcement per change, 37p)
    say: (words) => djModeStore().announce(words),
    support: () => djDeckSupport(),
    // auto-mix (with the mixing features shown) is held while A is on DJ mode's deck (review H1)
    autoHold: (on) => {
      (
        window as Window & { SoulSyncAutomix?: { hold?: (on: boolean) => void } }
      ).SoulSyncAutomix?.hold?.(on);
    },
  });
  return shared;
}

/** @internal tests */
export function resetDjMixSession(): void {
  sharedOutputs?.stop();
  sharedOutputs = null;
  shared?.dispose();
  shared = null;
}
