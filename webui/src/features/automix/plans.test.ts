import { describe, expect, it, vi } from 'vitest';

import type { PairPlan } from './plans';

import { unavailableWords } from './mix-chip';
import {
  AUTO_CHOICE,
  autoLine,
  chipWhy,
  chipWhyShort,
  inWords,
  planFor,
  planWords,
  stepOf,
} from './plans';

function plan(over: Partial<PairPlan> = {}): PairPlan {
  return {
    status: 'ok',
    style: 'long_blend',
    bars: 32,
    why: '8A → 9A, +2 BPM: the keys mix and the tempo is close',
    pair: '8A → 9A, +2 BPM',
    key: { from: '8A', to: '9A', relation: 'up' },
    tempo: { relation: 'same', rate: 0.98, speed_change_ok: true, from_bpm: 124, to_bpm: 126 },
    out: { start: 155 },
    in: { start: 0.2 },
    styles: [
      { style: 'long_blend', label: 'Long blend', available: true, why: null },
      { style: 'short_blend', label: 'Short blend', available: true, why: null },
    ],
    ...over,
  };
}

describe('the chip’s words (26g)', () => {
  it('style and length; Cut has none; the fallback and Waiting', () => {
    expect(planWords(plan(), AUTO_CHOICE)).toBe('Long blend · 32 bars');
    expect(planWords(plan({ style: 'cut', bars: null }), AUTO_CHOICE)).toBe('Cut');
    expect(
      planWords(plan({ status: 'crossfade', style: 'crossfade', length_s: 6 }), AUTO_CHOICE),
    ).toBe('Crossfade · 6 s');
    expect(planWords(plan({ status: 'waiting' }), AUTO_CHOICE)).toBe('Waiting');
    expect(planWords(null, { style: 'bass_swap', bars: 16 })).toBe('Bass swap · 16 bars');
  });

  it('who chose it and the step’s reason; a clash says so; the phone’s short line', () => {
    expect(chipWhy(plan(), AUTO_CHOICE, 'Static Bloom')).toBe('auto · 8A → 9A, +2 BPM');
    const clash = plan({
      key: { from: '9A', to: '4B', relation: 'clash' },
      pair: '9A → 4B, +1 BPM',
    });
    expect(chipWhy(clash, { style: 'echo_out', bars: 4 }, 'Brass Tide')).toBe(
      'yours · 9A → 4B, +1 BPM, keys clash',
    );
    expect(chipWhyShort(clash, AUTO_CHOICE)).toBe('auto · keys clash');
    expect(chipWhy(plan({ status: 'waiting' }), AUTO_CHOICE, 'Sand Script')).toBe(
      'Sand Script is being analysed',
    );
    expect(
      chipWhy(
        plan({
          status: 'crossfade',
          fallback: { kind: 'crossfade', code: 'no_beat', reason: 'live drums' },
        }),
        AUTO_CHOICE,
        'x',
      ),
    ).toBe("couldn't beat-match: live drums");
  });

  it('the step: a clash or more than 3 BPM is a jump, half time counts, no key is not known', () => {
    expect(stepOf(plan())).toBe('smooth');
    expect(stepOf(plan({ key: { from: '1A', to: '5B', relation: 'clash' } }))).toBe('jump');
    expect(
      stepOf(
        plan({
          tempo: { relation: 'same', rate: 1, speed_change_ok: true, from_bpm: 120, to_bpm: 126 },
        }),
      ),
    ).toBe('jump');
    expect(
      stepOf(
        plan({
          tempo: { relation: 'half', rate: 1, speed_change_ok: true, from_bpm: 124, to_bpm: 62.5 },
        }),
      ),
    ).toBe('smooth');
    expect(stepOf(plan({ key: { from: null, to: '1A', relation: 'unknown' } }))).toBe('unknown');
    expect(stepOf(null)).toBe('unknown');
  });

  it('Auto names its pick and why (26a); impossible styles say why', () => {
    expect(autoLine(plan())).toEqual({
      name: 'Auto: Long blend',
      why: 'Chosen because the keys mix and the tempo is close',
    });
    expect(autoLine(plan({ style: 'echo_out', why: '9A → 4B, +1 BPM: the keys clash' })).name).toBe(
      'Auto: Echo out',
    );
    expect(unavailableWords('no drop found in Brass Tide')).toBe(
      'Needs a drop: none found in Brass Tide',
    );
    expect(unavailableWords('no breakdown found in Night Ferry')).toBe(
      'Needs a breakdown: none found in Night Ferry',
    );
    expect(inWords(178.2)).toBe('in 2:58');
    expect(inWords(null)).toBeNull();
  });
});

describe('Auto’s lean (26h)', () => {
  it('Long blends moves a short blend to a long one the pair can do; the chip still says auto', async () => {
    const fetcher = vi.fn(async (_f: string, _t: string, style = 'auto') =>
      style === 'auto'
        ? plan({ style: 'short_blend', bars: 8 })
        : plan({ style, bars: 32, requested: style }),
    );
    const p = await planFor('1', '2', AUTO_CHOICE, 'long', fetcher);
    expect(p.style).toBe('long_blend');
    expect(p.chosen_by).toBe('auto');
    expect(p.leaned).toBe(true);
    expect(fetcher.mock.calls.map((c) => c[2])).toEqual(['auto', 'long_blend']);
  });

  it('leaves Auto alone when the pair can’t, when it’s Auto’s own, and a chosen style always', async () => {
    const fetcher = vi.fn(async () =>
      plan({
        style: 'short_blend',
        bars: 8,
        styles: [{ style: 'long_blend', label: 'Long blend', available: false, why: 'x' }],
      }),
    );
    expect((await planFor('1', '2', AUTO_CHOICE, 'long', fetcher)).style).toBe('short_blend');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const own = vi.fn(async () => plan());
    expect((await planFor('1', '2', AUTO_CHOICE, 'auto', own)).style).toBe('long_blend');
    expect((await planFor('1', '2', { style: 'cut', bars: null }, 'short', own)).style).toBe(
      'long_blend',
    );
    expect(own).toHaveBeenCalledTimes(2);
    // Auto takes its pick's own length: no bars sent
    expect(own.mock.calls[0]).toEqual(['1', '2', 'auto', undefined]);
  });
});
