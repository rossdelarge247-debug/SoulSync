/** The mixer's controls as data and what each sets on the engine (37g, 37h). */
import { describe, expect, it } from 'vitest';

import { HP_OPEN, KILL_DB, LP_OPEN } from '@/features/engine/score';

import {
  clampTo,
  DECK_CONTROLS,
  defaultMix,
  echoSeconds,
  ECHO_CONTROLS,
  engineTargets,
  eqWords,
  filterHz,
  filterWords,
  killWords,
  volumeGain,
  volumeWords,
  XF_CONTROL,
  xfGains,
  xfWords,
} from './dj-mixer.logic';

describe('the columns are a list (3b makes them faders)', () => {
  it('Volume, Hi, Mid, Low (each with KILL), Filter', () => {
    expect(DECK_CONTROLS.map((c) => [c.label, c.kill ?? null])).toEqual([
      ['Volume', null],
      ['Hi', 'high'],
      ['Mid', 'mid'],
      ['Low', 'low'],
      ['Filter', null],
      ['Tempo', null],
    ]);
    expect(ECHO_CONTROLS.map((c) => c.label)).toEqual(['Echo · Send A', 'Time', 'Feedback']);
  });

  it('the crossfader’s keys: 2%, ⇧ 10%', () => {
    expect(XF_CONTROL.step).toBe(2);
    expect(XF_CONTROL.bigStep).toBe(10);
    expect(clampTo(XF_CONTROL, 105)).toBe(100);
    expect(clampTo(XF_CONTROL, 61)).toBe(62);
  });
});

describe('the values in words (37g, 37h)', () => {
  it('volume, EQ, kill, filter, crossfader', () => {
    expect(volumeWords(100)).toBe('0 dB');
    expect(volumeWords(50)).toBe('−12 dB');
    expect(volumeWords(0)).toBe('off');
    expect(eqWords(0)).toBe('0');
    expect(eqWords(-3)).toBe('−3 dB');
    expect(eqWords(2)).toBe('+2 dB');
    expect(eqWords(-3, true)).toBe('kill');
    expect(filterWords(0)).toBe('off');
    expect(filterWords(1)).toBe('off');
    expect(filterWords(60)).toMatch(/^HP \d+$/);
    expect(filterWords(-60)).toMatch(/^LP [\d.]+k?$/);
    expect(xfWords(0)).toBe('A only');
    expect(xfWords(100)).toBe('B only');
    expect(xfWords(62)).toBe('B 62% · A 38%');
    expect(ECHO_CONTROLS[0]!.words(0)).toBe('off');
    expect(ECHO_CONTROLS[0]!.words(40)).toBe('40%');
    expect(ECHO_CONTROLS[1]!.words(2)).toBe('3/8');
    expect(ECHO_CONTROLS[2]!.words(35)).toBe('35%');
    expect(killWords('A', 'low', true)).toBe('Deck A Low killed');
  });
});

describe('the engine’s params', () => {
  it('at rest every param is the engine’s neutral, the fader on A', () => {
    const t = engineTargets(defaultMix(), 0.5);
    expect(t).toMatchObject({
      'A.volume': 1,
      'A.xf': 1,
      'B.xf': 0,
      'A.low': 0,
      'A.hp': HP_OPEN,
      'A.lp': LP_OPEN,
      'A.echoSend': 0,
      'B.echoSend': 0,
    });
  });

  it('EQ in dB, a kill at KILL_DB, the filter as HP or LP, the echo on A', () => {
    const v = defaultMix();
    v.A.high = -3;
    v.A.kill.low = true;
    v.A.low = 4; // a kill wins over the value under it
    v.B.filter = -100;
    v.A.filter = 100;
    v.echoSend = 40;
    v.echoTime = 3;
    v.echoFeedback = 35;
    const t = engineTargets(v, 0.484);
    expect(t['A.high']).toBe(-3);
    expect(t['A.low']).toBe(KILL_DB);
    expect(t['B.lp']).toBeCloseTo(200);
    expect(t['B.hp']).toBe(HP_OPEN);
    expect(t['A.hp']).toBeCloseTo(5000);
    expect(t['A.echoSend']).toBeCloseTo(0.4);
    expect(t['A.echoTime']).toBeCloseTo(0.242);
    expect(t['A.echoFeedback']).toBeCloseTo(0.35);
  });

  it('the crossfader is constant power; the volume an audio taper', () => {
    const mid = xfGains(50);
    expect(mid.A ** 2 + mid.B ** 2).toBeCloseTo(1);
    expect(xfGains(0)).toEqual({ A: 1, B: 0 });
    expect(xfGains(100)).toEqual({ A: 0, B: 1 });
    expect(volumeGain(50)).toBeCloseTo(0.25);
    expect(filterHz(0)).toEqual({ hp: HP_OPEN, lp: LP_OPEN });
  });

  it('the echo time follows A’s beat (0.5 s without one), never over 2 s', () => {
    expect(echoSeconds(2, null)).toBeCloseTo(0.1875);
    expect(echoSeconds(5, 3)).toBe(2);
  });
});

describe('the decks need a secure page', () => {
  it('says why on plain http elsewhere, or without AudioWorklet', async () => {
    const { djDeckSupport } = await import('./dj-mix-host');
    expect(djDeckSupport({ isSecureContext: false, AudioWorkletNode: class {} })).toMatch(/https/);
    expect(djDeckSupport({ isSecureContext: true })).toMatch(/can’t run the two decks/);
    expect(djDeckSupport({ isSecureContext: true, AudioWorkletNode: class {} })).toBeNull();
  });
});

describe('step 5: Tempo to a hundredth (S1) and the BPM that plays (M2)', () => {
  it('words, steps and BPM', async () => {
    const { tempoWords, tempoStep, bpmWords, ratePctWords } = await import('./dj-mixer.logic');
    expect(tempoWords(0)).toBe('0.00%');
    expect(tempoWords(1.26)).toBe('+1.26%');
    expect(tempoWords(-0.02)).toBe('−0.02%');
    expect(tempoStep(6)).toBe(0.02);
    expect(tempoStep(8)).toBe(0.02);
    expect(tempoStep(10)).toBe(0.05);
    expect(tempoStep(16)).toBe(0.05);
    expect(bpmWords(124, 1)).toBe('124.0');
    expect(bpmWords(124, null)).toBe('124.0');
    expect(bpmWords(124, 1.04)).toBe('128.96');
    expect(ratePctWords(1)).toBe('');
    expect(ratePctWords(0.984)).toBe('−1.60%');
    expect(ratePctWords(1.0002)).toBe('+0.02%');
  });
});

describe('step 5: the mixer’s words (S6, M6) and the meters (S5)', () => {
  it('Auto-gain in words; why deck A’s channel waits; a meter’s fill', async () => {
    const { gainWords, channelWhy } = await import('./dj-mixer');
    const { meterFill, peakOf } = await import('./dj-meters');
    expect(gainWords(0)).toBe('Gain 0 dB');
    expect(gainWords(2.46)).toBe('Gain +2.5 dB');
    expect(gainWords(-9)).toBe('Gain −9.0 dB');
    expect(channelWhy({ aOnDeck: false, elementLive: true, solo: false })).toBeNull();
    expect(channelWhy({ aOnDeck: true, elementLive: false, solo: false })).toBeNull();
    expect(channelWhy({ aOnDeck: false, elementLive: false, solo: false })).toMatch(/Play B/);
    expect(meterFill(1)).toBe(1);
    expect(meterFill(0)).toBe(0);
    expect(meterFill(Math.pow(10, -24 / 20))).toBeCloseTo(0.5, 6);
    expect(peakOf(new Float32Array([0.1, -0.7, 0.3]))).toBeCloseTo(0.7, 6);
  });
});

describe('step 6: CLIP from the out peak too', () => {
  it('a full-scale element on its own never lights it; past full scale or the limiter working does', async () => {
    const { clips } = await import('./dj-meters');
    expect(clips(1, 0)).toBe(false);
    expect(clips(0.9995, 0)).toBe(false);
    expect(clips(1.02, 0)).toBe(true);
    expect(clips(0.8, -1)).toBe(true);
    expect(clips(0.8, -0.2)).toBe(false);
  });
});
