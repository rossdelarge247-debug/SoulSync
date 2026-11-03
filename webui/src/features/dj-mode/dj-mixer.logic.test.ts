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
