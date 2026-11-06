/**
 * DJ mode's level meters (Brief F step 5, S5): a thin one beside each deck's
 * Volume (after its fader: what the deck sends on; deck A's shows the
 * playing track on the element or on its deck) and one for what goes out,
 * with a clip light that holds for a moment when the mix went over 0 dBFS
 * before the limiter (the limiter caught it).
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
/** At or over this (linear, before the limiter) it's a clip. */
const CLIP = 0.999;

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
    const read = (n: AnalyserNode): number => {
      let b = bufs.get(n);
      if (!b) {
        b = new Float32Array(n.fftSize);
        bufs.set(n, b);
      }
      n.getFloatTimeDomainData(b);
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
        out: read(meters.out),
      };
      for (const key of Object.keys(peaks)) {
        const fill = meterFill(peaks[key]!);
        const fallen = shown[key]! - (FALL_DB_S * dt) / -METER_FLOOR_DB;
        shown[key] = Math.max(fill, fallen, 0);
        put(key, shown[key]!);
      }
      if (read(meters.pre) >= CLIP) clipUntil = now + CLIP_HOLD_MS;
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
