/**
 * The chip in Up next and a set's steps with each status the planner sends
 * (core/dj/planner.py), in its own shape: a waiting plan has no places, a
 * a pair that can't be beat-matched echoes out. Closed, compact and with the
 * picker open.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PairPlan } from './plans';

import { TransitionChip } from './mix-chip';
import { chipWhy } from './plans';

const waiting = (over: Partial<PairPlan> = {}): PairPlan => ({
  status: 'waiting',
  style: null,
  bars: null,
  waiting_for: 'to',
  reason: 'analyzing',
  why: 'Waiting for the analysis',
  styles: [],
  pair: '8A → 9A',
  key: { from: '8A', to: '9A', relation: 'up' },
  tempo: null,
  ...over,
});
// a pair that can't be beat-matched (302: only the incoming track ready):
// echo out, the chip's line saying why, the picker the sentence
const echo: PairPlan = {
  status: 'ok',
  style: 'echo_out',
  bars: 4,
  beatmatch: false,
  why: "Couldn't beat-match: echo out · Night Ferry has no steady beat",
  pair: '8A → 9A',
  fallback: { kind: 'echo_out', code: 'no_beat', reason: 'Night Ferry has no steady beat' },
  out: { start: 250, bar: null, end: 250 },
  in: { start: 0, bar: null },
  length_s: 8,
  styles: [{ style: 'cut', label: 'Cut', available: false, why: 'no steady beat' }],
  key: { from: '8A', to: '9A', relation: 'up' },
  tempo: null,
};
const ok: PairPlan = {
  status: 'ok',
  style: 'long_blend',
  label: 'Long blend',
  bars: 32,
  beatmatch: true,
  why: '8A → 9A, +2 BPM: the keys mix',
  pair: '8A → 9A, +2 BPM',
  key: { from: '8A', to: '9A', relation: 'up' },
  tempo: { relation: 'same', rate: 0.98, speed_change_ok: true },
  out: { start: 155, bar: 80 },
  in: { start: 0.2, bar: 0 },
  length_s: 62,
  styles: [],
};

function chip(plan: PairPlan, compact = false) {
  return render(
    <TransitionChip
      transition={null}
      step={{ kind: 'smooth', reason: '' }}
      from="Night Ferry"
      to="Static Bloom"
      onChange={() => {}}
      plan={plan}
      autoPlan={plan}
      compact={compact}
    />,
  );
}

describe('[gauntlet lab] the chip with every plan status', () => {
  it.each([
    ['waiting', waiting(), /Waiting/, 'Static Bloom is being analysed'],
    [
      'echo out (no beat-match)',
      echo,
      /Echo out/,
      "auto · couldn't beat-match: Night Ferry has no steady beat",
    ],
    ['ok', ok, /Long blend · 32 bars/, 'auto · 8A → 9A, +2 BPM'],
  ])('%s: its words, compact too, and the picker opens', (_name, plan, words, why) => {
    const { unmount } = chip(plan);
    const button = screen.getByRole('button', {
      name: /^How Night Ferry goes into Static Bloom/,
    });
    expect(button).toHaveAccessibleName(words);
    expect(screen.getByText(why)).toBeInTheDocument();
    fireEvent.click(button);
    const picker = screen.getByRole('dialog', { name: 'How Night Ferry goes into Static Bloom' });
    expect(within(picker).getAllByRole('radio').length).toBeGreaterThan(0);
    unmount();
    chip(plan, true);
    expect(
      screen.getByRole('button', { name: /^How Night Ferry goes into Static Bloom/ }),
    ).toBeInTheDocument();
  });

  it('waiting names the track it waits for, and why', () => {
    expect(
      chipWhy(
        waiting({ waiting_for: 'from' }),
        { style: 'auto', bars: null },
        'Static Bloom',
        'Night Ferry',
      ),
    ).toBe('Night Ferry is being analysed');
    expect(
      chipWhy(
        waiting({ reason: 'not_analyzed' }),
        { style: 'auto', bars: null },
        'Static Bloom',
        'Night Ferry',
      ),
    ).toBe("Static Bloom isn't analysed yet");
  });
});

describe('analyse on demand: a Waiting chip shows its track in the analysis', () => {
  it('the bar and step of the track it waits for, and no Analyse now while it is in line', () => {
    render(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={waiting()}
        progress={{ state: 'working', step: 'grid', percent: 60 }}
        analyse={() => {}}
      />,
    );
    // 31c: the chip's line is the analysis, the bar filled to the step (5 of 6)
    const words = screen.getByText('Analysing Static Bloom · beat grid (5 of 6)');
    expect(
      words.closest('[data-analysis-marker]')!.querySelector('[data-step="5"]'),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Analyse now' })).toBeNull();
  });

  it('"2nd in line" and "Waiting for the library drive" in its place', () => {
    const { rerender } = render(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={waiting()}
        progress={{ state: 'queued', position: 2, asked_for: true }}
      />,
    );
    expect(screen.getByText('In line · 2nd')).toBeInTheDocument();
    rerender(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={waiting()}
        progress={{ state: 'waiting', reason: 'drive_away', position: 1, asked_for: true }}
      />,
    );
    expect(screen.getByText("Waiting · the drive's away")).toBeInTheDocument();
  });

  it('not in any line: Analyse now, for anyone', () => {
    let asked = 0;
    render(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={waiting({ reason: 'not_analyzed' })}
        progress={{ state: 'waiting', reason: 'not_queued', position: null, asked_for: false }}
        analyse={() => (asked += 1)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Analyse now' }));
    expect(asked).toBe(1);
    expect(document.querySelector('[data-analysis-progress]')).toBeNull();
  });
});

describe('no crossfade on a chip (Ross, 27 October)', () => {
  it('302 names "plays straight on" in Up next; a quiet play-on has no chip; a set keeps its own', () => {
    const playOn: PairPlan = {
      status: 'play_on',
      style: null,
      bars: null,
      beatmatch: false,
      why: "Couldn't beat-match: plays straight on · Night Ferry has no steady beat",
      fallback: { kind: 'play_on', code: 'no_beat', reason: 'Night Ferry has no steady beat' },
      styles: [],
    };
    const first = render(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={playOn}
        floating
      />,
    );
    // "The chip names it" (302): Straight on, amber, with why
    const named = screen.getByRole('button', { name: /^How Night Ferry goes into Static Bloom/ });
    expect(named).toHaveAccessibleName(/Straight on/);
    expect(named).toHaveAttribute('data-tone', 'warn');
    expect(
      screen.getByText("auto · couldn't beat-match: Night Ferry has no steady beat"),
    ).toBeInTheDocument();
    first.unmount();
    // an album in its order plays straight on quietly: no chip in Up next
    const { container, unmount } = render(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={{
          ...playOn,
          fallback: {
            kind: 'play_on',
            code: 'album_in_order',
            reason: "one album's tracks in their order",
          },
        }}
        floating
      />,
    );
    expect(container.textContent).toBe('');
    unmount();
    render(
      <TransitionChip
        transition={{ style: 'bass_swap', bars: 16 }}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={playOn}
      />,
    );
    expect(screen.getByRole('button', { name: /Straight on/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/crossfad/i);
  });

  it("the echo out says Echo out with why on its line, and 302's sentence in the picker", () => {
    render(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={echo}
        autoPlan={echo}
      />,
    );
    const button = screen.getByRole('button', { name: /^How Night Ferry goes into/ });
    expect(button).toHaveAccessibleName(/Echo out · 4 bars/);
    expect(button).toHaveAttribute('data-tone', 'warn');
    expect(document.body.textContent).not.toMatch(/crossfad/i);
    fireEvent.click(button);
    expect(screen.getByRole('dialog')).toHaveTextContent(
      "Couldn't beat-match: echo out · Night Ferry has no steady beat",
    );
  });

  it('a cut on the phrase (302) says Cut, and why, and the sentence on its title', () => {
    const cut: PairPlan = {
      ...echo,
      status: 'cut',
      style: 'cut',
      bars: null,
      why: "Couldn't beat-match: cutting on the phrase · the tempos are 9.7% apart",
      fallback: { kind: 'cut', code: 'tempo_gap', reason: 'the tempos are 9.7% apart' },
      out: { start: 250, bar: 112, end: 250 },
    };
    const { container } = render(
      <TransitionChip
        transition={null}
        step={{ kind: 'jump', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={cut}
        floating
      />,
    );
    expect(screen.getByRole('button', { name: /^How Night Ferry goes into/ })).toHaveAccessibleName(
      /: Cut, auto/,
    );
    expect(
      screen.getByText("auto · couldn't beat-match: the tempos are 9.7% apart"),
    ).toBeInTheDocument();
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(
      "Couldn't beat-match: cutting on the phrase · the tempos are 9.7% apart",
    );
  });

  it('304: an unsure one keeps its style with the warning dot and its words', () => {
    render(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={{ ...ok, unsure_bars: true }}
      />,
    );
    const button = screen.getByRole('button', { name: /^How Night Ferry goes into/ });
    expect(button).toHaveAccessibleName(/Long blend · 32 bars/);
    expect(button).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText('auto · Not sure where the bars start')).toBeInTheDocument();
  });

  it("a set's chip says who chose it on screen (UX-29); dimmed with Auto mix off, with no line of what plays (320)", () => {
    const { unmount } = render(
      <TransitionChip
        transition={{ style: 'bass_swap', bars: 16 }}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={{ ...ok, style: 'bass_swap', bars: 16 }}
        inSet
      />,
    );
    expect(document.querySelector('[data-chip-who]')?.textContent).toBe('yours');
    unmount();
    const { container } = render(
      <TransitionChip
        transition={null}
        step={{ kind: 'smooth', reason: '' }}
        from="Night Ferry"
        to="Static Bloom"
        onChange={() => {}}
        plan={ok}
        inSet
        dimmed
      />,
    );
    expect(container.querySelector('[data-dimmed]')).not.toBeNull();
    expect(container.querySelector('[data-chip-who]')?.textContent).toBe('auto');
    expect(container.textContent).not.toMatch(/Auto mix is off|plays straight on/);
  });
});
