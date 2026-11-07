/**
 * DJ mode's level meters (Brief F step 5, S5): a thin one beside each deck's
 * Volume (after its fader: what the deck sends on; deck A's shows the
 * playing track on the element or on its deck) and one for what goes out,
 * with a clip light that holds for a moment when the decks summed went
 * past full scale and the limiter held them down, or what goes out went
 * past full scale (the element strip with a boost, step 6). The playing
 * track on its own at unity never lights it.
 *
 * Cheap: the engine's analysers are made on the first look (auto-mix never
 * has them), read once a frame only while the overlay shows and the page is
 * visible, and written straight to the page (a CSS variable, no render).
 * Silent for a screen reader: they're `aria-hidden`; the faders' values
 * say the levels.
 */
import { useEffect, type RefObject } from 'react';

import type { DjMixSession } from './dj-mix-session';

import styles from './dj-mixer.module.css';

/** The meter's floor (dB): below this it's empty. */
export const METER_FLOOR_DB = -48;
/** How fast a meter falls back (dB a second), as a DJM's peak meter. */
const FALL_DB_S = 24;
/** The clip light holds this long (ms). */
const CLIP_HOLD_MS = 1500;
/** The limiter holding the decks down by this much (dB) or more is a clip. */
const CLIP_DB = -0.5;
/**
 * What goes out past full scale is a clip too (step 6: the element strip
 * isn't limited, so a sum or a boost on it shows here), but not a lossy
 * file's own inter-sample overs at unity (review L7): it takes three
 * samples in a row over 1.0005, or one over 1.01 (+0.09 dB). A full-scale
 * track on its own at unity peaks at 1.0 and never lights it.
 */
export const CLIP_OUT = 1.0005;
export const CLIP_RUN = 3;
export const CLIP_HARD = 1.01;

/** Whether what goes out (an analyser's block) clips by that rule. */
export function clipsOut(buf: Float32Array): boolean {
  let run = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]!);
    if (v >= CLIP_HARD) return true;
    run = v >= CLIP_OUT ? run + 1 : 0;
    if (run >= CLIP_RUN) return true;
  }
  return false;
}

/** A clip: the limiter holding the decks down, or what goes out past full scale (`clipsOut`). */
export function clips(outClips: boolean, reductionDb: number): boolean {
  return outClips || reductionDb <= CLIP_DB;
}

/** A peak (linear) as the meter's fill, 0–1 over METER_FLOOR_DB … 0 dBFS. */
export function meterFill(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** The highest sample's size in an analyser's last block. */
export function peakOf(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]!);
    if (v > p) p = v;
  }
  return p;
}

export function DeckMeter({ deck }: { deck: 'a' | 'b' }) {
  return (
    <span className={styles.meter} data-dj-meter={deck} aria-hidden="true">
      <span className={styles.meterFill} />
    </span>
  );
}

export function MasterMeter() {
  return (
    <span className={styles.masterMeter} data-dj-meter="out" aria-hidden="true">
      <span className={styles.meterLabel}>Out</span>
      <span className={styles.meterBar}>
        <span className={styles.meterFill} />
      </span>
      <span className={styles.clip} data-dj-clip="">
        CLIP
      </span>
    </span>
  );
}

/**
 * Read the meters while `active` (the overlay shows) and the page is
 * visible; `root` holds them. Stops (and empties them) otherwise.
 */
export function useMeters(
  session: DjMixSession,
  active: boolean,
  root: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active) return;
    const doc = document;
    let id = 0;
    let running = false;
    let last = 0;
    let clipUntil = 0;
    const shown: Record<string, number> = { a: 0, b: 0, out: 0 };
    const bufs = new Map<AnalyserNode, Float32Array<ArrayBuffer>>();
    let outOver = false;
    const read = (n: AnalyserNode, over = false): number => {
      let b = bufs.get(n);
      if (!b) {
        b = new Float32Array(n.fftSize);
        bufs.set(n, b);
      }
      n.getFloatTimeDomainData(b);
      if (over) outOver = clipsOut(b);
      return peakOf(b);
    };
    const put = (key: string, fill: number) => {
      const el = root.current?.querySelector<HTMLElement>(`[data-dj-meter="${key}"]`);
      el?.style.setProperty('--level', fill.toFixed(3));
    };
    const empty = () => {
      for (const key of Object.keys(shown)) {
        shown[key] = 0;
        put(key, 0);
      }
      root.current?.querySelector('[data-dj-clip]')?.removeAttribute('data-on');
    };
    const tick = (now: number) => {
      id = window.requestAnimationFrame(tick);
      const meters = session.engineParts()?.graph.meters?.();
      if (!meters) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const peaks: Record<string, number> = {
        a: read(meters.A),
        b: read(meters.B),
        out: read(meters.out, true),
      };

      for (const key of Object.keys(peaks)) {
        const fill = meterFill(peaks[key]!);
        const fallen = shown[key]! - (FALL_DB_S * dt) / -METER_FLOOR_DB;
        shown[key] = Math.max(fill, fallen, 0);
        put(key, shown[key]!);
      }
      const reduction = session.engineParts()?.graph.limiter?.reduction ?? 0;
      if (clips(outOver, reduction)) clipUntil = now + CLIP_HOLD_MS;
      const led = root.current?.querySelector('[data-dj-clip]');
      if (now < clipUntil) led?.setAttribute('data-on', '');
      else led?.removeAttribute('data-on');
    };
    const start = () => {
      if (running || doc.hidden) return;
      running = true;
      last = 0;
      id = window.requestAnimationFrame(tick);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      window.cancelAnimationFrame(id);
      empty();
    };
    const visible = () => (doc.hidden ? stop() : start());
    doc.addEventListener('visibilitychange', visible);
    start();
    return () => {
      doc.removeEventListener('visibilitychange', visible);
      stop();
    };
  }, [session, active, root]);
}
