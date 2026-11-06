/**
 * Measured, not assumed (Brief F step 5, M3): the decks' isolator EQ
 * rendered in a real OfflineAudioContext (node-web-audio-api, as
 * sync.offline.test.ts), one sine at a time through a deck's chain exactly
 * as graph.ts builds it, its level read after the settle. The figures
 * printed are HANDOFF's ("Dev, Traktor parity (step 5)").
 *
 * - all three bands at 0 dB: within ±0.5 dB of unity from 30 Hz to 15 kHz;
 * - each KILL: at least 60 dB down inside its band, the other two untouched;
 * - the knob's dB is the band's dB (−6 is −6) and a kill is silence;
 * - the element strip (DJ mode) sounds exactly as deck A at the same values.
 */
import { OfflineAudioContext } from 'node-web-audio-api';
import { describe, expect, it } from 'vitest';

import { bandGain, buildGraph, EQ_FLOOR_DB } from './graph';
import { KILL_DB, type ParamName } from './score';

const SR = 48000;
const SECONDS = 0.5;

type Settings = Partial<Record<ParamName, number>>;

/** The level (dB, against the sine's own) of a sine at `hz` through deck A (or the element strip). */
async function levelDb(hz: number, settings: Settings, via: 'A' | 'E' = 'A'): Promise<number> {
  const ctx = new OfflineAudioContext(1, Math.round(SR * SECONDS), SR);
  const g = buildGraph(ctx as unknown as BaseAudioContext, {
    limiter: false,
    element: via === 'E',
  });
  const params =
    via === 'E'
      ? g.element!.params
      : (Object.fromEntries(
          Object.entries(g.params)
            .filter(([k]) => k.startsWith('A.'))
            .map(([k, v]) => [k.slice(2), v]),
        ) as typeof g.element extends null ? never : NonNullable<typeof g.element>['params']);
  for (const [name, value] of Object.entries(settings) as [ParamName, number][])
    params[name].reset(0, value);
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  if (via === 'E') {
    g.element!.input.gain.value = 1;
    osc.connect(g.element!.input);
  } else {
    g.master.gain.value = 1;
    osc.connect(g.decks.A.input);
  }
  osc.start();
  const buf = await ctx.startRendering();
  const x = buf.getChannelData(0);
  // the last 0.2 s: every filter has settled
  let sum = 0;
  const from = x.length - Math.round(0.2 * SR);
  for (let i = from; i < x.length; i++) sum += x[i]! * x[i]!;
  const rms = Math.sqrt(sum / (x.length - from));
  return 20 * Math.log10(Math.max(1e-12, rms / Math.SQRT1_2));
}

/** the deck's filters opened past the band: the isolator alone */
const OPEN: Settings = { hp: 2, lp: 23900 };

const FLAT_HZ = [30, 60, 100, 150, 200, 250, 400, 700, 1000, 1500, 2500, 4000, 7000, 10000, 15000];

describe('the isolator EQ, measured (M3)', () => {
  it('the gain curve: exact dB to the knob’s floor, then down to a true 0 at the kill', () => {
    expect(20 * Math.log10(bandGain(-6))).toBeCloseTo(-6, 6);
    expect(20 * Math.log10(bandGain(6))).toBeCloseTo(6, 6);
    expect(20 * Math.log10(bandGain(EQ_FLOOR_DB))).toBeCloseTo(EQ_FLOOR_DB, 6);
    expect(bandGain(-33)).toBeLessThan(bandGain(EQ_FLOOR_DB));
    expect(bandGain(KILL_DB)).toBe(0);
    expect(bandGain(-80)).toBe(0);
  });

  it('flat: all three bands at 0 dB are unity within 0.5 dB, 30 Hz – 15 kHz', async () => {
    // the isolator alone (at rest the deck's filters sit at 12 Hz and 20 kHz
    // with a little resonance, as before step 5: printed for the record)
    const iso: string[] = [];
    const chain: string[] = [];
    for (const hz of FLAT_HZ) {
      const db = await levelDb(hz, OPEN);
      iso.push(`${hz}: ${db.toFixed(2)}`);
      chain.push(`${hz}: ${(await levelDb(hz, {})).toFixed(2)}`);
      expect(Math.abs(db)).toBeLessThan(0.5);
    }
    console.info(`isolator flat (dB): ${iso.join(' · ')}`);
    console.info(`the deck at rest, filters included (dB): ${chain.join(' · ')}`);
  }, 60_000);

  it('each KILL is at least 60 dB down inside its band and leaves the others alone', async () => {
    const rows: Record<string, string[]> = { low: [], mid: [], high: [] };
    const inBand: Record<'low' | 'mid' | 'high', number[]> = {
      low: [30, 40, 60],
      mid: [600, 700, 900],
      high: [7000, 10000, 15000],
    };
    const others: Record<'low' | 'mid' | 'high', number[]> = {
      low: [1000, 7000],
      mid: [40, 12000],
      high: [40, 700],
    };
    for (const band of ['low', 'mid', 'high'] as const) {
      for (const hz of [...inBand[band], ...others[band]]) {
        const db = await levelDb(hz, { ...OPEN, [band]: KILL_DB });
        rows[band]!.push(`${hz}: ${db.toFixed(1)}`);
        if (inBand[band].includes(hz)) expect(db).toBeLessThan(-60);
        else expect(Math.abs(db)).toBeLessThan(0.5);
      }
    }
    // the whole response with each kill, for the record
    for (const band of ['low', 'mid', 'high'] as const) {
      const curve: string[] = [];
      for (const hz of FLAT_HZ)
        curve.push(`${hz}: ${(await levelDb(hz, { ...OPEN, [band]: KILL_DB })).toFixed(1)}`);
      console.info(`${band} KILL (dB): ${curve.join(' · ')}`);
    }
    console.info(`kills in and out of band: ${JSON.stringify(rows)}`);
  }, 120_000);

  it('all three killed: silence (under −60 dB) across the range', async () => {
    const all = { low: KILL_DB, mid: KILL_DB, high: KILL_DB };
    for (const hz of [60, 200, 700, 2500, 10000]) {
      expect(await levelDb(hz, all)).toBeLessThan(-60);
    }
  }, 60_000);

  it('a cut is the knob’s dB in the middle of its band', async () => {
    expect(await levelDb(50, { low: -6 })).toBeCloseTo(-6, 0);
    expect(await levelDb(700, { mid: -12 })).toBeCloseTo(-12, 0);
    expect(await levelDb(10000, { high: 4 })).toBeCloseTo(4, 0);
  }, 60_000);

  it('the element strip is deck A’s chain: the same level at the same values', async () => {
    for (const settings of [
      {},
      { low: -10, high: 3 },
      { mid: KILL_DB },
      { volume: 0.5, lp: 800 },
    ] as Settings[]) {
      for (const hz of [80, 700, 5000]) {
        const deck = await levelDb(hz, settings, 'A');
        const el = await levelDb(hz, settings, 'E');
        if (deck < -60) expect(el).toBeLessThan(-60);
        else expect(Math.abs(deck - el)).toBeLessThan(0.01);
      }
    }
  }, 120_000);
});
