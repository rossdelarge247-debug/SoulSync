/**
 * The overlay's ear: one analyser tapped off the player's (static/
 * media-player.js builds the graph on first play: element → EQ → analyser →
 * speakers). The tap has no output, so it adds nothing to what you hear, and
 * it's made once and kept. Before anything has played, or when the graph
 * can't be read, it reads silence.
 */

import { isSilent } from './visuals.logic';

export const TAP_FFT = 1024;

interface PlayerHooks {
  analyser?: () => AnalyserNode | null;
  outputTargets?: () => { context?: AudioContext | null };
  state?: () => { playing?: boolean; track?: unknown };
}

export interface AudioTap {
  /** Time-domain bytes (128 is silence), TAP_FFT long. */
  time(out: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  /** Frequency bytes, TAP_FFT / 2 long. */
  freq(out: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
  sampleRate(): number;
  /** True while the last TAP_FFT samples are silence (or nothing can be read). */
  silent(): boolean;
}

export function createAudioTap(win: Window = window): AudioTap {
  let tap: AnalyserNode | null = null;
  let source: AnalyserNode | null = null;
  let rate = 48000;
  const scratch = new Uint8Array(TAP_FFT);

  const player = () => (win as Window & { SoulSyncPlayer?: PlayerHooks }).SoulSyncPlayer;

  function ensure(): AnalyserNode | null {
    const shared = player()?.analyser?.() ?? null;
    if (!shared) return null;
    if (tap && source === shared) return tap;
    try {
      const ctx = shared.context as AudioContext;
      const node = ctx.createAnalyser();
      node.fftSize = TAP_FFT;
      node.smoothingTimeConstant = 0.6;
      shared.connect(node);
      tap = node;
      source = shared;
      rate = ctx.sampleRate || 48000;
      return tap;
    } catch {
      return null;
    }
  }

  return {
    time(out) {
      const node = ensure();
      if (!node) {
        out.fill(128);
        return out;
      }
      node.getByteTimeDomainData(out);
      return out;
    },
    freq(out) {
      const node = ensure();
      if (!node) {
        out.fill(0);
        return out;
      }
      node.getByteFrequencyData(out);
      return out;
    },
    sampleRate: () => rate,
    silent() {
      const node = ensure();
      if (!node) return true;
      node.getByteTimeDomainData(scratch);
      return isSilent(scratch);
    },
  };
}
