/**
 * DJ mode's outputs as the page runs them (3b, 37r): the devices listed and
 * watched (`devicechange`), the case decided (dj-outputs.ts), the Monitor
 * routed on the engine's graph while the engine exists, and the two rules:
 * the headphones gone mutes the cue (never rerouted), the speakers gone
 * while A is on its deck pauses both decks. One announcement per change.
 */
import type { OutputDevice } from '@/shell/player-output';

import { cueSupport, cueEnv } from '@/features/engine/outputs';
import { listOutputs, readSavedOutput } from '@/shell/player-output';

import type { DjMixSession } from './dj-mix-session';
import type { DjOutputPrefs, MonitorGraph, OutputState } from './dj-outputs';

import { decideOutputs, MonitorRouter, readOutputPrefs, saveOutputPrefs } from './dj-outputs';

export interface OutputsEnv {
  /** every device the browser lists */
  enumerate(): Promise<MediaDeviceInfo[]>;
  onDeviceChange(fn: () => void): () => void;
  canDevice: boolean;
  /** the player's own output ('' the system's default) */
  speakersId(): string;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** the player's analyser, where the mix goes */
  tap(): AudioNode | null;
  /** makes the router (tests pass a fake) */
  makeRouter?: (g: MonitorGraph) => Pick<MonitorRouter, 'route' | 'set' | 'dispose' | 'isMuted'>;
}

export interface OutputsView {
  state: OutputState;
  devices: OutputDevice[];
  /** names hidden by the browser until it's allowed the microphone (Chrome) */
  unnamed: boolean;
  prefs: DjOutputPrefs;
}

export function browserOutputsEnv(win: Window = window): OutputsEnv {
  const md = win.navigator.mediaDevices as MediaDevices | undefined;
  const support = cueSupport(cueEnv(win));
  return {
    enumerate: async () => (md?.enumerateDevices ? md.enumerateDevices() : []),
    onDeviceChange: (fn) => {
      md?.addEventListener?.('devicechange', fn);
      return () => md?.removeEventListener?.('devicechange', fn);
    },
    canDevice: support.device,
    speakersId: () => {
      try {
        return readSavedOutput(win.localStorage);
      } catch {
        return '';
      }
    },
    storage: (() => {
      try {
        return win.localStorage;
      } catch {
        return null;
      }
    })(),
    tap: () => {
      try {
        return (
          (
            win as Window & { SoulSyncPlayer?: { analyser?: () => AudioNode | null } }
          ).SoulSyncPlayer?.analyser?.() ?? null
        );
      } catch {
        return null;
      }
    },
  };
}

export class DjOutputs {
  private v: OutputsView;
  private readonly listeners = new Set<() => void>();
  private router: Pick<MonitorRouter, 'route' | 'set' | 'dispose' | 'isMuted'> | null = null;
  private routedFor: BaseAudioContext | null = null;
  private off: (() => void)[] = [];
  private started = false;
  private lastMonitor = '';

  constructor(
    private readonly env: OutputsEnv,
    private readonly session: DjMixSession,
    private readonly say: (words: string) => void,
  ) {
    const prefs = readOutputPrefs(env.storage);
    this.v = {
      state: decideOutputs({
        devices: [],
        speakersId: env.speakersId(),
        prefs,
        canDevice: env.canDevice,
      }),
      devices: [],
      unnamed: false,
      prefs,
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): OutputsView => this.v;

  private set(patch: Partial<OutputsView>): void {
    this.v = { ...this.v, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Watch the devices and the engine (DJ mode on). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.off.push(this.env.onDeviceChange(() => void this.refresh()));
    this.off.push(this.session.subscribe(() => this.follow()));
    void this.refresh();
  }

  /** Stop watching and put the speakers back as they always are (DJ mode off). */
  stop(): void {
    for (const f of this.off.splice(0)) f();
    this.started = false;
    this.dropRouter();
  }

  /** The devices again: the case, the routing, and what changed said once. */
  async refresh(): Promise<void> {
    let list: MediaDeviceInfo[] = [];
    try {
      list = await this.env.enumerate();
    } catch {
      list = [];
    }
    const { devices, unnamed } = listOutputs(list);
    const was = this.v.state;
    const state = decideOutputs({
      devices,
      speakersId: this.env.speakersId(),
      prefs: this.v.prefs,
      canDevice: this.env.canDevice,
    });
    // the headphones found by default are remembered (37r: "remembered by
    // name"), so they're missed when they go rather than quietly forgotten
    if (
      state.case === 'two' &&
      state.headphones &&
      !this.v.prefs.headphones &&
      !this.v.prefs.none
    ) {
      const prefs = { ...this.v.prefs, headphones: state.headphones };
      saveOutputPrefs(this.env.storage, prefs);
      this.set({ prefs });
    }
    this.set({ state, devices, unnamed });
    if (was.case !== state.case) this.sayChange(was, state);
    if (state.case === 'speakersLost' && was.case !== 'speakersLost') this.session.speakersLost();
    await this.route();
  }

  private sayChange(was: OutputState, now: OutputState): void {
    if (now.case === 'phonesLost') this.say('Headphones lost; the speakers are unchanged');
    else if (now.case === 'speakersLost')
      this.say('Speakers lost: both decks paused where they are');
    else if (was.case === 'phonesLost' && now.case === 'two')
      this.say(`Headphones back: ${now.headphones?.label ?? 'the headphones'}`);
    else if (was.case === 'speakersLost') this.say('Speakers back: Play carries on');
  }

  /** The engine came or went, or the Monitor's sliders moved. */
  private follow(): void {
    const parts = this.session.engineParts();
    if (!parts) {
      this.dropRouter();
      return;
    }
    if (parts.context !== this.routedFor) void this.route();
    const m = this.session.snapshot().monitor;
    const key = `${m.mix}|${m.volume}`;
    if (this.router && key !== this.lastMonitor) {
      this.lastMonitor = key;
      this.router.set(m.mix, m.volume);
    }
  }

  private async route(): Promise<void> {
    const parts = this.session.engineParts();
    const g = parts?.graph;
    const tap = this.env.tap();
    if (!parts || !g?.out || !g.cueBus || !tap) {
      this.dropRouter();
      return;
    }
    if (parts.context !== this.routedFor) {
      this.dropRouter();
      const graph: MonitorGraph = {
        context: parts.context as AudioContext,
        cueBus: g.cueBus,
        out: g.out,
        tap,
      };
      this.router = this.env.makeRouter ? this.env.makeRouter(graph) : new MonitorRouter(graph);
      this.routedFor = parts.context;
      const m = this.session.snapshot().monitor;
      this.lastMonitor = `${m.mix}|${m.volume}`;
      this.router.set(m.mix, m.volume);
    }
    const ok = await this.router!.route(this.v.state);
    if (!ok)
      this.say(
        `The headphones (${this.v.state.headphones?.label ?? 'their output'}) couldn’t be used: the speakers are unchanged`,
      );
  }

  private dropRouter(): void {
    try {
      this.router?.dispose();
    } catch {
      /* gone */
    }
    this.router = null;
    this.routedFor = null;
  }

  /** The headphones chosen in Settings (null: none on purpose). */
  setHeadphones(device: OutputDevice | null): void {
    const prefs: DjOutputPrefs = { ...this.v.prefs, headphones: device, none: device === null };
    this.save(prefs);
  }

  setSplit(on: boolean): void {
    this.save({ ...this.v.prefs, split: on });
    this.say(
      on ? 'Split cue on: the cue in the left ear, the speakers in the right' : 'Split cue off',
    );
  }

  private save(prefs: DjOutputPrefs): void {
    saveOutputPrefs(this.env.storage, prefs);
    this.set({ prefs });
    void this.refresh();
  }

  get muted(): boolean {
    return Boolean(this.router?.isMuted);
  }
}
