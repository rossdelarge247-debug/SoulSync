/**
 * DJ mode's outputs (Brief F 3b, 37r; 441, 444): the speakers and the
 * headphones.
 *
 * - **The speakers are the player's own output** (its Output button,
 *   `ssPlayerOutput`): the decks play on the player's AudioContext, so they
 *   go wherever the player does, and nothing about the player changes when
 *   DJ mode is off.
 * - **The headphones** hear the decks whose Headphones are on (each deck's
 *   cue send, graph.ts), through Cue mix (cue only ↔ what the speakers hear)
 *   and Cue volume: a MediaStream from the player's context into an
 *   `<audio>` element sent to the headphones' device with `setSinkId`
 *   (engine/outputs.ts `CueRouter`). Picked once in Player settings →
 *   Playback → DJ outputs (or "Outputs…"); remembered by id and name, found
 *   again when plugged in; by default the newest device that isn't the
 *   speakers.
 * - **One output** (no second device, or a browser without `setSinkId` on a
 *   media element): no Monitor block; the Headphones toggles say why.
 *   **Split cue** is offered (the cue in the left ear, the speakers in the
 *   right, mono each), off unless asked, as it changes what the room hears.
 * - **The headphones go** mid-blend: the cue is muted, never rerouted to the
 *   speakers; one announcement; it comes back when the device does.
 * - **The speakers go** (the player's chosen output disappears) while A is
 *   on its deck: both decks pause where they are (the player's Pause, so
 *   they pause together), and the headphones are never made the speakers.
 *
 * `decideOutputs` is the case from the devices; `MonitorRouter` is the
 * routing on the engine's graph.
 */
import type { OutputDevice } from '@/shell/player-output';

import { CueRouter } from '@/features/engine/outputs';

export const DJ_OUTPUTS_KEY = 'soulsync-dj-outputs';

export interface DjOutputPrefs {
  /** the headphones as chosen (or found by default): id and name, so a new id still matches */
  headphones: OutputDevice | null;
  /** "none": no headphones on purpose (Settings) */
  none: boolean;
  split: boolean;
}

export function readOutputPrefs(store: Pick<Storage, 'getItem'> | null | undefined): DjOutputPrefs {
  let raw: unknown = null;
  try {
    raw = JSON.parse(store?.getItem(DJ_OUTPUTS_KEY) || 'null');
  } catch {
    raw = null;
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DjOutputPrefs>;
  const h = r.headphones as Partial<OutputDevice> | null | undefined;
  return {
    headphones:
      h && typeof h.id === 'string' && typeof h.label === 'string'
        ? { id: h.id.slice(0, 256), label: h.label.slice(0, 200) }
        : null,
    none: r.none === true,
    split: r.split === true,
  };
}

export function saveOutputPrefs(
  store: Pick<Storage, 'setItem'> | null | undefined,
  prefs: DjOutputPrefs,
): void {
  try {
    store?.setItem(DJ_OUTPUTS_KEY, JSON.stringify(prefs));
  } catch {
    /* blocked: the choice holds for this visit */
  }
}

export type OutputCase =
  /** speakers and headphones on two devices (37r, the default) */
  | 'two'
  /** one output: no Monitor block; split cue offered */
  | 'one'
  /** the headphones were chosen and aren't connected: the cue is muted */
  | 'phonesLost'
  /** the player's output isn't connected: the decks pause */
  | 'speakersLost';

export interface OutputState {
  case: OutputCase;
  speakers: { id: string; label: string; connected: boolean };
  /** the headphones' device, when there is (or was) one */
  headphones: OutputDevice | null;
  split: boolean;
  /** why there's no second output, in words, or null */
  why: string | null;
}

export const NO_SECOND_OUTPUT =
  'This browser can’t send sound to a second output (Chrome, Edge, Firefox and Safari 18.4 or later can)';

/**
 * The case from what's plugged in. `devices` are the outputs as the player
 * lists them (the "default" aliases folded away), oldest first;
 * `speakersId` is the player's own choice ('' is the system's default).
 */
export function decideOutputs({
  devices,
  speakersId,
  prefs,
  canDevice,
}: {
  devices: readonly OutputDevice[];
  speakersId: string;
  prefs: DjOutputPrefs;
  canDevice: boolean;
}): OutputState {
  const speakerDevice = speakersId ? devices.find((d) => d.id === speakersId) : null;
  const speakers = {
    id: speakersId,
    label: speakerDevice?.label ?? (speakersId ? 'The chosen output' : 'This device'),
    connected: !speakersId || Boolean(speakerDevice),
  };
  const base = { speakers, split: prefs.split };
  if (!speakers.connected) return { ...base, case: 'speakersLost', headphones: pick(), why: null };
  if (!canDevice) return { ...base, case: 'one', headphones: null, why: NO_SECOND_OUTPUT };
  if (prefs.none) return { ...base, case: 'one', headphones: null, why: null };
  const found = pick();
  if (prefs.headphones && !found)
    return { ...base, case: 'phonesLost', headphones: prefs.headphones, why: null };
  if (!found) return { ...base, case: 'one', headphones: null, why: null };
  return { ...base, case: 'two', headphones: found, why: null };

  function pick(): OutputDevice | null {
    const others = devices.filter((d) => d.id && d.id !== speakersId);
    if (prefs.headphones) {
      const h = prefs.headphones;
      return (
        others.find((d) => d.id === h.id) ??
        others.find((d) => d.label && d.label === h.label) ??
        null
      );
    }
    // the newest device that isn't the speakers (the list is oldest first)
    return others.length ? others[others.length - 1]! : null;
  }
}

/** The Monitor block's line (37g): "Scarlett 2i2 · speakers on Built-in Output". */
export function monitorLine(s: OutputState): string {
  switch (s.case) {
    case 'two':
      return `${s.headphones!.label} · speakers on ${s.speakers.label}`;
    case 'phonesLost':
      return `${s.headphones?.label ?? 'The headphones'} isn’t connected · speakers unchanged`;
    case 'speakersLost':
      return `${s.speakers.label} isn’t connected · the decks are paused`;
    default:
      return s.split
        ? `Split cue · the cue left, the speakers right, on ${s.speakers.label}`
        : `No headphones output · speakers on ${s.speakers.label}`;
  }
}

/** Is the Monitor block drawn (37r: not with one output, unless split is on)? */
export function monitorShown(s: OutputState): boolean {
  return s.case !== 'one' || s.split;
}

/** Can a deck's Headphones be heard now, and if not, why (the toggle's title). */
export function headphonesWhy(s: OutputState): string | null {
  if (s.case === 'two') return null;
  if (s.case === 'one' && s.split) return null;
  if (s.case === 'phonesLost') return `${s.headphones?.label ?? 'The headphones'} isn’t connected`;
  if (s.case === 'speakersLost') return 'The speakers aren’t connected';
  return 'No headphones output · Outputs…';
}

/* ── the monitor on the graph ──────────────────────────────────────── */

export interface MonitorGraph {
  context: AudioContext;
  /** the decks' cue sends summed (graph.ts cueBus) */
  cueBus: AudioNode;
  /** the mix as it leaves the engine (graph.ts out) */
  out: AudioNode;
  /** where the mix goes: the player's analyser */
  tap: AudioNode;
}

/** Cue mix 0–100 as the two gains (constant power): 0 the cue alone, 100 the speakers alone. */
export function cueMixGains(mix: number): { cue: number; speakers: number } {
  const u = Math.max(0, Math.min(100, mix)) / 100;
  const cue = Math.cos((u * Math.PI) / 2);
  const speakers = Math.sin((u * Math.PI) / 2);
  return { cue: cue < 1e-6 ? 0 : cue, speakers: speakers < 1e-6 ? 0 : speakers };
}

export function cueMixWords(mix: number, cued: string): string {
  const v = Math.round(mix);
  if (v <= 0) return `Cue only${cued ? ` · ${cued}` : ''}`;
  if (v >= 100) return 'What the speakers hear';
  if (v === 50) return 'Half cue, half speakers';
  return `Cue ${100 - v}% · speakers ${v}%`;
}

export function cueVolumeWords(db: number): string {
  const v = Math.round(db);
  return v === 0 ? '0 dB' : `${v < 0 ? '−' : '+'}${Math.abs(v)} dB`;
}

/**
 * The headphones' feed: cue bus and mix through Cue mix into Cue volume,
 * sent by CueRouter to the headphones (or, split, the left ear). `mute` is
 * the lost-headphones rule: silence, never rerouted.
 */
export class MonitorRouter {
  private readonly cueAmt: GainNode;
  private readonly mixAmt: GainNode;
  private readonly volume: GainNode;
  private readonly router: CueRouter;
  private mode: 'device' | 'split' | null = null;
  private deviceId = '';
  private level = 1;
  private muted = false;

  constructor(private readonly g: MonitorGraph) {
    const ctx = g.context;
    this.cueAmt = ctx.createGain();
    this.mixAmt = ctx.createGain();
    this.volume = ctx.createGain();
    g.cueBus.connect(this.cueAmt).connect(this.volume);
    g.out.connect(this.mixAmt).connect(this.volume);
    this.router = new CueRouter({
      context: ctx,
      mix: g.out,
      mixTarget: g.tap,
      cueBus: this.volume,
    });
  }

  /** Route as the outputs say: to the headphones' device, split, or nowhere. Resolves false when the device refused. */
  async route(s: OutputState): Promise<boolean> {
    if (s.case === 'two' && s.headphones) {
      if (this.mode === 'device' && this.deviceId === s.headphones.id) {
        this.setMuted(false);
        return true;
      }
      this.mode = 'device';
      this.deviceId = s.headphones.id;
      const ok = await this.router.apply({ mode: 'device', deviceId: s.headphones.id });
      this.setMuted(!ok);
      return ok;
    }
    if (s.case === 'one' && s.split) {
      if (this.mode !== 'split') {
        this.mode = 'split';
        this.deviceId = '';
        await this.router.apply({ mode: 'split', deviceId: '' });
      }
      this.setMuted(false);
      return true;
    }
    if (s.case === 'phonesLost' || s.case === 'speakersLost') {
      // muted where it is: nothing that wasn't on the speakers goes there
      this.setMuted(true);
      return true;
    }
    this.off();
    return true;
  }

  set(mix: number, volumeDb: number): void {
    const { cue, speakers } = cueMixGains(mix);
    const t = this.g.context.currentTime;
    this.cueAmt.gain.setTargetAtTime(cue, t, 0.01);
    this.mixAmt.gain.setTargetAtTime(speakers, t, 0.01);
    this.level = Math.pow(10, volumeDb / 20);
    this.apply();
  }

  private setMuted(on: boolean): void {
    this.muted = on;
    this.apply();
  }

  private apply(): void {
    this.volume.gain.setTargetAtTime(this.muted ? 0 : this.level, this.g.context.currentTime, 0.01);
  }

  get current(): 'device' | 'split' | null {
    return this.mode;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** No headphones: the speakers as they always are. */
  off(): void {
    if (this.mode) this.router.dispose();
    this.mode = null;
    this.deviceId = '';
  }

  dispose(): void {
    this.off();
    for (const n of [this.cueAmt, this.mixAmt, this.volume]) {
      try {
        n.disconnect();
      } catch {
        /* gone */
      }
    }
    try {
      this.g.cueBus.disconnect(this.cueAmt);
      this.g.out.disconnect(this.mixAmt);
    } catch {
      /* gone */
    }
  }
}
