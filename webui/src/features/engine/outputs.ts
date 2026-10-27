/**
 * Where Decks plays (23b, Design's 175; Ross: "Outputs…"): the mix to the
 * room, the cue (a deck heard before it's in the mix) to headphones. Engine
 * level only; Decks draws the dialog.
 *
 * - "On another output": the cue goes through a MediaStream into an <audio>
 *   element sent to the headphones' device with `setSinkId` (Chrome, Edge,
 *   Firefox 116+, Safari 18.4+). Where the browser can't, it's said, not
 *   hidden: CUE_WHY_NOT.
 * - "Split one output": headphones in the main output, the mix in the left
 *   ear and the cue in the right (each summed to mono). For practice, not for
 *   a room. While it's on, everything the speakers got goes to the left ear
 *   (the player's analyser is rerouted after it, so the visualisers still
 *   hear the mix), and back when it's off.
 *
 * Kept per browser (CUE_KEY). Each test plays a short tone in one ear only,
 * so a swapped cable shows at once.
 */

import { listOutputs, type OutputDevice } from '@/shell/player-output';

export type CueMode = 'device' | 'split';

export interface CuePrefs {
  mode: CueMode;
  deviceId: string;
}

export const CUE_KEY = 'soulsync-dj-cue';

export const CUE_WHY_NOT =
  "This browser can't send sound to a second output. Chrome, Edge, Firefox and Safari 18.4 or later can.";

export interface CueEnv {
  mediaPrototype?: object | null;
  hasStreamDestination?: boolean;
  mediaDevices?: { enumerateDevices?: () => Promise<MediaDeviceInfo[]> } | null;
}

export function cueEnv(win: Window): CueEnv {
  const w = win as unknown as {
    HTMLMediaElement?: { prototype: object };
    MediaStreamAudioDestinationNode?: unknown;
    navigator: { mediaDevices?: CueEnv['mediaDevices'] };
  };
  return {
    mediaPrototype: w.HTMLMediaElement?.prototype ?? null,
    hasStreamDestination: typeof w.MediaStreamAudioDestinationNode === 'function',
    mediaDevices: w.navigator.mediaDevices ?? null,
  };
}

/** Whether the cue can go to another output here, and if not, why (23b says so). */
export function cueSupport(env: CueEnv): { device: boolean; why: string | null } {
  const ok =
    Boolean(env.hasStreamDestination) &&
    Boolean(env.mediaPrototype && 'setSinkId' in env.mediaPrototype) &&
    typeof env.mediaDevices?.enumerateDevices === 'function';
  return { device: ok, why: ok ? null : CUE_WHY_NOT };
}

/** The outputs a cue can go to (the player's own list rules). */
export async function cueDevices(
  env: CueEnv,
): Promise<{ devices: OutputDevice[]; unnamed: boolean }> {
  try {
    const all = (await env.mediaDevices?.enumerateDevices?.()) ?? [];
    return listOutputs(all);
  } catch {
    return { devices: [], unnamed: false };
  }
}

/** The saved choice; where a second output can't work, split. */
export function readCuePrefs(
  store: Pick<Storage, 'getItem'> | null | undefined,
  canDevice: boolean,
): CuePrefs {
  let raw: unknown = null;
  try {
    raw = JSON.parse(store?.getItem(CUE_KEY) || 'null');
  } catch {
    raw = null;
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CuePrefs>;
  const mode: CueMode =
    r.mode === 'device' && canDevice
      ? 'device'
      : r.mode === 'split'
        ? 'split'
        : canDevice
          ? 'device'
          : 'split';
  return { mode, deviceId: typeof r.deviceId === 'string' ? r.deviceId.slice(0, 256) : '' };
}

export function saveCuePrefs(
  store: Pick<Storage, 'setItem'> | null | undefined,
  prefs: CuePrefs,
): void {
  try {
    store?.setItem(CUE_KEY, JSON.stringify({ mode: prefs.mode, deviceId: prefs.deviceId }));
  } catch {
    /* blocked: the choice holds for this visit */
  }
}

interface SinkElement {
  srcObject: MediaStream | null;
  setSinkId?: (id: string) => Promise<void>;
  play(): Promise<void>;
  pause(): void;
}

export interface CueRouterOptions {
  context: AudioContext;
  /** the mix as it leaves the engine (graph.ts `out`) */
  mix: AudioNode;
  /** where the mix goes: the player's analyser (which goes on to the speakers), or the destination */
  mixTarget: AudioNode;
  cueBus: AudioNode;
  /** makes the <audio> element for "on another output" (tests pass a fake) */
  makeElement?: () => SinkElement;
}

/**
 * Routes the cue (and, split, the mix). `apply()` changes the routing;
 * `test()` plays a tone in one ear; `dispose()` puts the mix back.
 */
export class CueRouter {
  private readonly o: CueRouterOptions;
  private mode: CueMode | null = null;
  private merger: ChannelMergerNode | null = null;
  private mixMono: GainNode | null = null;
  private cueMono: GainNode | null = null;
  private stream: MediaStreamAudioDestinationNode | null = null;
  private element: SinkElement | null = null;
  private cuePan: StereoPannerNode | null = null;

  constructor(o: CueRouterOptions) {
    this.o = o;
  }

  /** The node whose output goes to the speakers. */
  private speakerFeed(): AudioNode {
    return this.o.mixTarget === this.o.context.destination ? this.o.mix : this.o.mixTarget;
  }

  get current(): CueMode | null {
    return this.mode;
  }

  /** Route the cue the chosen way. Resolves false when the device couldn't be set. */
  async apply(prefs: CuePrefs): Promise<boolean> {
    this.teardown();
    const ctx = this.o.context;
    if (prefs.mode === 'split') {
      const mono = () => {
        const g = ctx.createGain();
        g.channelCount = 1;
        g.channelCountMode = 'explicit';
        g.channelInterpretation = 'speakers';
        return g;
      };
      this.merger = ctx.createChannelMerger(2);
      this.mixMono = mono();
      this.cueMono = mono();
      // what reaches the speakers (the player's analyser, past which the
      // visualisers listen, or the mix itself) goes, as mono, to the left
      // ear only; the visualisers still hear the mix
      const point = this.speakerFeed();
      disconnect(point, ctx.destination);
      point.connect(this.mixMono).connect(this.merger, 0, 0);
      this.o.cueBus.connect(this.cueMono).connect(this.merger, 0, 1);
      this.merger.connect(ctx.destination);
      this.mode = 'split';
      return true;
    }
    this.stream = ctx.createMediaStreamDestination();
    this.cuePan = ctx.createStereoPanner();
    this.o.cueBus.connect(this.cuePan).connect(this.stream);
    const el = this.o.makeElement ? this.o.makeElement() : (new Audio() as unknown as SinkElement);
    el.srcObject = this.stream.stream;
    this.element = el;
    this.mode = 'device';
    let ok = true;
    if (prefs.deviceId && typeof el.setSinkId === 'function') {
      ok = await el.setSinkId(prefs.deviceId).then(
        () => true,
        () => false,
      );
    }
    await el.play().catch(() => undefined);
    return ok;
  }

  /** A short tone in one ear: left is the mix's side, right the cue's (split), or that ear of the headphones. */
  test(ear: 'left' | 'right'): void {
    const ctx = this.o.context;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = ear === 'left' ? 440 : 660;
    const t = ctx.currentTime + 0.02;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.25, t + 0.02);
    env.gain.setValueAtTime(0.25, t + 0.5);
    env.gain.linearRampToValueAtTime(0, t + 0.6);
    osc.connect(env);
    if (this.mode === 'split' && this.merger) {
      env.connect(this.merger, 0, ear === 'left' ? 0 : 1);
    } else if (this.mode === 'device' && this.stream) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = ear === 'left' ? -1 : 1;
      env.connect(pan).connect(this.stream);
    } else {
      const pan = ctx.createStereoPanner();
      pan.pan.value = ear === 'left' ? -1 : 1;
      env.connect(pan).connect(ctx.destination);
    }
    osc.start(t);
    osc.stop(t + 0.65);
  }

  private teardown(): void {
    if (this.mode === 'split') {
      const point = this.speakerFeed();
      disconnect(point, this.mixMono);
      disconnect(this.o.cueBus, this.cueMono);
      this.merger?.disconnect();
      point.connect(this.o.context.destination);
    } else if (this.mode === 'device') {
      disconnect(this.o.cueBus, this.cuePan);
      this.cuePan?.disconnect();
      this.element?.pause();
      if (this.element) this.element.srcObject = null;
    }
    this.mode = null;
    this.merger = null;
    this.mixMono = null;
    this.cueMono = null;
    this.stream = null;
    this.element = null;
    this.cuePan = null;
  }

  dispose(): void {
    this.teardown();
  }
}

function disconnect(from: AudioNode, to: AudioNode | null): void {
  if (!to) return;
  try {
    from.disconnect(to);
  } catch {
    /* not connected */
  }
}
