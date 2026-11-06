/**
 * Measured, not assumed (Brief F step 5, M4–M6): the playing track's level
 * at every switch between the player's element and deck A, through the
 * real engine (its worklet and graph) in an OfflineAudioContext
 * (node-web-audio-api, as sync.offline.test.ts), with a player's chain after
 * it as media-player-v2.js builds it (a 10-band EQ's band, then Normalize's
 * compressor).
 *
 * - With no engine, the player's graph is bit for bit what it was (the
 *   element's way in is a unity gain).
 * - The element routed through the strip at rest sounds as it did straight
 *   (within 0.5 dB), and the switch onto the strip is a crossfade, no dip.
 * - Play B (the element out, deck A in, as the session does it) and Back:
 *   the level after is the level before, with deck A's channel moved first
 *   (a cut and a kill): within 0.1 dB; and through the 80 ms cross-over
 *   within the session's step fade.
 *
 * The figures printed are HANDOFF's ("Dev, Traktor parity (step 5)").
 */
import { AudioWorkletNode as NodeWorkletNode, OfflineAudioContext } from 'node-web-audio-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AutomatedParam } from './automation';
import type { ParamName } from './score';

import { Engine, prepareDeck, ROUTE_S } from './engine';
import { LIMIT_DELAY_S } from './graph';
import { KILL_DB } from './score';
import { WORKLET_PATH } from './worklet/run-worklet';

const SR = 48000;
const HZ = 440;
const g = globalThis as unknown as { AudioWorkletNode?: unknown };
const saved = g.AudioWorkletNode;

beforeAll(() => {
  g.AudioWorkletNode = NodeWorkletNode;
});
afterAll(() => {
  g.AudioWorkletNode = saved;
});

/** The track: a 440 Hz sine at full scale, as the element's oscillator is, and in phase with it. */
function sineTrack(seconds: number) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * HZ * i) / SR);
  return { numberOfChannels: 2, sampleRate: SR, length: n, getChannelData: () => x };
}

/** The player's chain as v2 builds it: a band of its EQ (+4 dB at 440 Hz here), Normalize on. */
function playerChain(ctx: OfflineAudioContext) {
  const band = ctx.createBiquadFilter();
  band.type = 'peaking';
  band.frequency.value = HZ;
  band.Q.value = 1;
  band.gain.value = 4;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  band.connect(comp).connect(ctx.destination);
  return band;
}

/** RMS in dB over [a, b) seconds. */
function rmsDb(x: Float32Array, a: number, b: number): number {
  let s = 0;
  const i0 = Math.round(a * SR);
  const i1 = Math.round(b * SR);
  for (let i = i0; i < i1; i++) s += x[i]! * x[i]!;
  return 10 * Math.log10(Math.max(1e-24, s / (i1 - i0)));
}

/** The level in 20 ms steps over [a, b): its lowest and highest. */
function spread(x: Float32Array, a: number, b: number) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = a; t + 0.02 <= b + 1e-9; t += 0.01) {
    const v = rmsDb(x, t, t + 0.02);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { lo, hi };
}

function setAll(
  params: Record<ParamName, AutomatedParam>,
  values: Partial<Record<ParamName, number>>,
) {
  for (const [k, v] of Object.entries(values) as [ParamName, number][]) params[k].reset(0, v);
}

describe('the element and deck A: one level at every switch (M4–M6), measured', () => {
  it('with no engine the player’s graph is bit for bit the plain source (the unity way in)', async () => {
    const render = async (unity: boolean) => {
      const ctx = new OfflineAudioContext(1, SR / 2, SR);
      const osc = ctx.createOscillator();
      osc.frequency.value = HZ;
      const into = playerChain(ctx);
      if (unity) {
        const sourceOut = ctx.createGain();
        osc.connect(sourceOut).connect(into);
      } else osc.connect(into);
      osc.start();
      return (await ctx.startRendering()).getChannelData(0);
    };
    const plain = await render(false);
    const now = await render(true);
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(plain[i]! - now[i]!));
    expect(diff).toBe(0);
  });

  it('routed through the strip at rest it sounds as it did (within 0.5 dB)', async () => {
    const render = async (routed: boolean) => {
      const ctx = new OfflineAudioContext(1, SR, SR);
      const osc = ctx.createOscillator();
      osc.frequency.value = HZ;
      const elVolume = ctx.createGain();
      elVolume.gain.value = 0.7;
      const sourceOut = ctx.createGain();
      const into = playerChain(ctx);
      osc.connect(elVolume).connect(sourceOut).connect(into);
      osc.start();
      if (routed) {
        const engine = await Engine.create({
          context: ctx as unknown as BaseAudioContext,
          workletUrl: WORKLET_PATH,
          tap: into as unknown as AudioNode,
          element: {
            source: elVolume as unknown as AudioNode,
            sourceOut: sourceOut as unknown as GainNode,
          },
          watch: false,
        });
        expect(engine.elementParams()).not.toBeNull();
        await engine.sync();
      }
      return (await ctx.startRendering()).getChannelData(0);
    };
    const straight = rmsDb(await render(false), 0.5, 0.95);
    const routed = rmsDb(await render(true), 0.5, 0.95);
    console.info(
      `the element at rest: ${straight.toFixed(2)} dB straight, ${routed.toFixed(2)} dB through the strip`,
    );
    expect(Math.abs(routed - straight)).toBeLessThan(0.5);
  }, 60_000);

  for (const [name, vol, channel] of [
    ['deck A’s channel moved first', 0.7, { volume: 0.64, mid: -6, high: KILL_DB, lp: 9000 }],
    ['at full scale, the channel at rest (review M2)', 1, {}],
  ] as const) {
    it(`Play B and Back, ${name}: the same level before and after, no dead air through`, async () => {
      const seconds = 3;
      const ctx = new OfflineAudioContext(1, seconds * SR, SR);
      const osc = ctx.createOscillator();
      osc.frequency.value = HZ;
      // the element's volume (the player's level, 0.7), as MediaElementSource has it applied
      const elVolume = ctx.createGain();
      elVolume.gain.value = vol;
      const sourceOut = ctx.createGain();
      const into = playerChain(ctx);
      osc.connect(elVolume).connect(sourceOut).connect(into);
      osc.start(0);
      const engine = await Engine.create({
        context: ctx as unknown as BaseAudioContext,
        workletUrl: WORKLET_PATH,
        tap: into as unknown as AudioNode,
        element: {
          source: elVolume as unknown as AudioNode,
          sourceOut: sourceOut as unknown as GainNode,
        },
        watch: false,
      });
      // deck A's channel as set before Play B (live on the element)
      setAll(engine.elementParams()!, channel);
      setAll(engine.params('A'), channel);
      engine.load('A', prepareDeck(sineTrack(seconds), 0));
      const master = engine.graph.master.gain;
      master.value = 0;
      // Play B at 1 s (the session's takeOverNow): deck A in over 80 ms as the
      // element's volume falls in six steps; Back at 2 s, the other way
      const T = 1;
      const FADE = 0.08;
      // the decks are heard through the limiter's lookahead, the element isn't:
      // deck A starts that much further on (as the session's takeOverNow)
      engine.play('A', T, T + LIMIT_DELAY_S);
      master.setValueAtTime(0, T);
      master.linearRampToValueAtTime(vol, T + FADE);
      for (let n = 1; n <= 6; n++)
        elVolume.gain.setValueAtTime(vol * (1 - n / 6), T + (n * FADE) / 6);
      const B = 2;
      for (let n = 0; n <= 6; n++) elVolume.gain.setValueAtTime(vol * (n / 6), B + (n * FADE) / 6);
      master.setValueAtTime(vol, B);
      master.linearRampToValueAtTime(0, B + FADE);
      engine.stop('A', Math.round((B + FADE + 0.05) * SR));
      await engine.sync();
      const x = (await ctx.startRendering()).getChannelData(0);
      const onElement = rmsDb(x, 0.6, 0.95);
      const onDeck = rmsDb(x, 1.3, 1.95);
      const back = rmsDb(x, 2.3, 2.9);
      const playB = spread(x, 0.95, 1.2);
      const backS = spread(x, 1.95, 2.2);
      console.info(
        `Play B and Back, ${name} (dB): element ${onElement.toFixed(2)} · deck A ${onDeck.toFixed(2)} · ` +
          `element again ${back.toFixed(2)} · through Play B ${playB.lo.toFixed(2)}…${playB.hi.toFixed(2)} · ` +
          `through Back ${backS.lo.toFixed(2)}…${backS.hi.toFixed(2)}`,
      );
      expect(Math.abs(onDeck - onElement)).toBeLessThan(0.1);
      expect(Math.abs(back - onElement)).toBeLessThan(0.1);
      // through the cross-overs: the element's steps against the master's ramp
      // (in phase here, the worst case for a step), never near silence
      for (const s of [playB, backS]) {
        expect(onElement - s.lo).toBeLessThan(3);
        expect(s.hi - onElement).toBeLessThan(1.5);
      }
    }, 60_000);
  }

  it('a full-scale element passes untouched: not limited, no gain reduction (review M2)', async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const osc = ctx.createOscillator();
    osc.frequency.value = HZ;
    const sourceOut = ctx.createGain();
    const tap = ctx.createGain();
    tap.connect(ctx.destination);
    osc.connect(sourceOut).connect(tap);
    osc.start();
    const engine = await Engine.create({
      context: ctx as unknown as BaseAudioContext,
      workletUrl: WORKLET_PATH,
      tap: tap as unknown as AudioNode,
      element: { source: osc as unknown as AudioNode, sourceOut: sourceOut as unknown as GainNode },
      watch: false,
    });
    await engine.sync();
    const x = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    for (let i = SR / 2; i < SR; i++) peak = Math.max(peak, Math.abs(x[i]!));
    const level = rmsDb(x, 0.5, 0.95);
    console.info(
      `a full-scale element through the strip: ${level.toFixed(2)} dB RMS, peak ${peak.toFixed(3)}`,
    );
    // a full-scale sine is −3.01 dB RMS
    expect(Math.abs(level - -3.01)).toBeLessThan(0.5);
    expect(peak).toBeGreaterThan(0.97);
    expect(engine.graph.limiter!.reduction).toBe(0);
  }, 60_000);

  it('an engine made again within the old one’s let-go: the element heard once, not twice (review M1)', async () => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const osc = ctx.createOscillator();
    osc.frequency.value = HZ;
    const half = ctx.createGain();
    half.gain.value = 0.5;
    const sourceOut = ctx.createGain();
    const tap = ctx.createGain();
    tap.connect(ctx.destination);
    osc.connect(half).connect(sourceOut).connect(tap);
    osc.start();
    const make = () =>
      Engine.create({
        context: ctx as unknown as BaseAudioContext,
        workletUrl: WORKLET_PATH,
        tap: tap as unknown as AudioNode,
        element: {
          source: half as unknown as AudioNode,
          sourceOut: sourceOut as unknown as GainNode,
        },
        watch: false,
      });
    const first = await make();
    first.dispose();
    const second = await make();
    // the first one's late cut comes and goes
    await new Promise((r) => setTimeout(r, (ROUTE_S + 0.12) * 1000));
    await second.sync();
    const x = (await ctx.startRendering()).getChannelData(0);
    const level = rmsDb(x, 0.5, 0.95);
    console.info(`made, let go, made again: ${level.toFixed(2)} dB (one way is −9.03)`);
    expect(Math.abs(level - -9.03)).toBeLessThan(0.3);
  }, 60_000);

  it('an engine that fails as it’s made gives the element straight back (review L2)', async () => {
    const ctx = new OfflineAudioContext(1, SR / 4, SR);
    const osc = ctx.createOscillator();
    const sourceOut = ctx.createGain();
    osc.connect(sourceOut).connect(ctx.destination);
    const broken = {
      addEventListener: () => {
        throw new Error('no events here');
      },
      removeEventListener: () => undefined,
    };
    await expect(
      Engine.create({
        context: ctx as unknown as BaseAudioContext,
        workletUrl: WORKLET_PATH,
        element: {
          source: osc as unknown as AudioNode,
          sourceOut: sourceOut as unknown as GainNode,
        },
        watch: true,
        doc: broken as unknown as Document,
        win: broken as unknown as Window,
      }),
    ).rejects.toThrow();
    expect(sourceOut.gain.value).toBe(1);
  }, 60_000);
});
