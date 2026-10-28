import { describe, expect, it, vi } from 'vitest';

import type { PairPlan } from './plans';

import { unavailableWords } from './mix-chip';
import {
  AUTO_CHOICE,
  autoLine,
  chipWhy,
  chipWhyShort,
  fallbackSentence,
  inWords,
  planFor,
  planWords,
  stepOf,
  playsOn,
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
  it('style and length; Cut has none; the moves with no beat-match; Waiting; never a crossfade', () => {
    expect(planWords(plan(), AUTO_CHOICE)).toBe('Long blend · 32 bars');
    expect(planWords(plan({ style: 'cut', bars: null }), AUTO_CHOICE)).toBe('Cut');
    expect(planWords(plan({ status: 'cut', style: 'cut', bars: null }), AUTO_CHOICE)).toBe('Cut');
    const echo = plan({
      style: 'echo_out',
      bars: 4,
      fallback: { kind: 'echo_out', code: 'no_beat', reason: 'Sand Script has no steady beat' },
    });
    expect(planWords(echo, AUTO_CHOICE)).toBe('Echo out · 4 bars');
    expect(autoLine(echo).why).toBe(
      "Couldn't beat-match: echo out · Sand Script has no steady beat",
    );
    expect(playsOn(plan({ status: 'play_on', style: null }))).toBe(true);
    // 302's "plays straight on" names itself on the chip
    expect(planWords(plan({ status: 'play_on', style: null }), AUTO_CHOICE)).toBe('Straight on');
    expect(playsOn(echo)).toBe(false);
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
    const echo = plan({
      style: 'echo_out',
      fallback: { kind: 'echo_out', code: 'no_beat', reason: 'Sand Script has no steady beat' },
    });
    // 302: the chip's line says what stood in the way (26g's fallback shape)
    expect(chipWhy(echo, AUTO_CHOICE, 'x')).toBe(
      "auto · couldn't beat-match: Sand Script has no steady beat",
    );
    expect(chipWhyShort(echo, AUTO_CHOICE)).toBe("auto · can't beat-match");
    // an album in its order isn't a failure: it plays straight on, quietly
    expect(
      chipWhy(
        plan({
          status: 'play_on',
          style: null,
          fallback: {
            kind: 'play_on',
            code: 'album_in_order',
            reason: "one album's tracks in their order",
          },
        }),
        AUTO_CHOICE,
        'x',
      ),
    ).toBe("plays straight on · one album's tracks in their order");
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

describe("302's fallback words (Design, 27 October; no crossfade)", () => {
  const f = (kind: string, code: string, reason: string) =>
    plan({
      status: kind === 'cut' ? 'cut' : kind === 'play_on' ? 'play_on' : 'ok',
      fallback: { kind, code, reason },
    });

  it("says the move and the reason, in Design's words", () => {
    expect(fallbackSentence(f('cut', 'tempo_gap', 'the tempos are 9.7% apart'))).toBe(
      "Couldn't beat-match: cutting on the phrase · the tempos are 9.7% apart",
    );
    expect(fallbackSentence(f('echo_out', 'no_beat', 'Sand Script has no steady beat'))).toBe(
      "Couldn't beat-match: echo out · Sand Script has no steady beat",
    );
    expect(fallbackSentence(f('play_on', 'not_4_4', "Sweet Waltz isn't in 4/4"))).toBe(
      "Couldn't beat-match: plays straight on · Sweet Waltz isn't in 4/4",
    );
    expect(fallbackSentence(f('play_on', 'too_long', 'A Mix is too long to analyse'))).toBe(
      "Couldn't beat-match: plays straight on · A Mix is too long to analyse",
    );
    expect(fallbackSentence(f('cut', 'unreachable', "Pad can't be opened"))).toBe(
      "Couldn't beat-match: cutting on the phrase · Pad can't be opened",
    );
    expect(fallbackSentence(f('play_on', 'error', "A Mix couldn't be analysed"))).toBe(
      "Couldn't beat-match: plays straight on · A Mix couldn't be analysed",
    );
  });

  it('says nothing for a beat-matched pair, an album in its order or a page without the decks', () => {
    expect(fallbackSentence(plan())).toBeNull();
    expect(
      fallbackSentence(f('play_on', 'album_in_order', "one album's tracks in their order")),
    ).toBeNull();
    expect(fallbackSentence(f('play_on', 'unsupported', 'needs https'))).toBeNull();
  });

  it("the chip names the move (Cut, Echo out, Straight on) and the picker's Auto line the sentence", () => {
    const cut = f('cut', 'tempo_gap', 'the tempos are 9.7% apart');
    expect(planWords({ ...cut, style: 'cut', bars: null }, AUTO_CHOICE)).toBe('Cut');
    expect(autoLine({ ...cut, style: 'cut' })).toEqual({
      name: 'Auto: Cut',
      why: "Couldn't beat-match: cutting on the phrase · the tempos are 9.7% apart",
    });
    const on = f('play_on', 'not_4_4', "Sweet Waltz isn't in 4/4");
    expect(autoLine({ ...on, style: null })).toEqual({
      name: 'Auto: Straight on',
      why: "Couldn't beat-match: plays straight on · Sweet Waltz isn't in 4/4",
    });
    for (const p of [cut, on])
      expect(JSON.stringify(autoLine(p)).toLowerCase()).not.toContain('crossfade');
  });

  it("303: a long blend that didn't fit says so; 304: an unsure one says so", () => {
    const short = plan({ style: 'short_blend', bars: 8, shortened: 'the outro is short' });
    expect(planWords(short, AUTO_CHOICE)).toBe('Short blend · 8 bars');
    expect(chipWhy(short, AUTO_CHOICE, 'x')).toBe('auto · the outro is short');
    expect(autoLine(short).why).toBe('Short blend: the outro is short');
    const unsure = plan({
      unsure_bars: true,
      note: 'Not sure where the bars start: the phrases may not line up.',
    });
    expect(planWords(unsure, AUTO_CHOICE)).toBe('Long blend · 32 bars');
    expect(chipWhy(unsure, { style: 'bass_swap', bars: 16 }, 'x')).toBe(
      'yours · Not sure where the bars start',
    );
  });
});
