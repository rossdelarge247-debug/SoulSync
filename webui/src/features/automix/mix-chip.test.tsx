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
// a pair that can't be beat-matched: echo out, with the reason only in the picker
const echo: PairPlan = {
  status: 'ok',
  style: 'echo_out',
  bars: 4,
  beatmatch: false,
  why: 'Echo out: no steady beat',
  pair: '8A → 9A',
  fallback: { kind: 'echo_out', code: 'no_beat', reason: 'no steady beat' },
  out: { start: 250, bar: 96, end: 258 },
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
    ['echo out (no beat-match)', echo, /Echo out/, 'auto · 8A → 9A'],
    ['ok', ok, /Long blend · 32 bars/, 'auto · 8A → 9A, +2 BPM'],
  ])('%s: its words, compact too, and the picker opens', (_name, plan, words, why) => {
    const { unmount } = chip(plan);
    const button = screen.getByRole('button', {
      name: /^Transition from Night Ferry to Static Bloom/,
    });
    expect(button).toHaveAccessibleName(words);
    expect(screen.getByText(why)).toBeInTheDocument();
    fireEvent.click(button);
    const picker = screen.getByRole('dialog', { name: 'How Night Ferry goes into Static Bloom' });
    expect(within(picker).getAllByRole('radio').length).toBeGreaterThan(0);
    unmount();
    chip(plan, true);
    expect(
      screen.getByRole('button', { name: /^Transition from Night Ferry to Static Bloom/ }),
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
    const bar = screen.getByRole('progressbar', { name: 'Analysis of Static Bloom' });
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText('Finding the beat grid · 60%')).toBeInTheDocument();
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
    expect(screen.getByText('2nd in line')).toBeInTheDocument();
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
    expect(screen.getByText('Waiting for the library drive')).toBeInTheDocument();
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
  it('a pair that plays on has no chip in Up next; a set keeps its own, saying it plays on', () => {
    const playOn: PairPlan = {
      status: 'play_on',
      style: null,
      bars: null,
      beatmatch: false,
      why: 'Plays on: Night Ferry has no steady beat',
      fallback: { kind: 'play_on', code: 'no_beat', reason: 'Night Ferry has no steady beat' },
      styles: [],
    };
    const { container, unmount } = render(
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
    expect(screen.getByRole('button', { name: /Bass swap · 16 bars/ })).toBeInTheDocument();
    expect(screen.getByText('plays on')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/crossfad/i);
  });

  it('a cut plan says Cut, the echo out says Echo out; the reason only in the picker', () => {
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
    const button = screen.getByRole('button', { name: /^Transition from Night Ferry/ });
    expect(button).toHaveAccessibleName(/Echo out · 4 bars/);
    expect(document.body.textContent).not.toMatch(/no steady beat|crossfad/i);
    fireEvent.click(button);
    expect(screen.getByRole('dialog')).toHaveTextContent('No beat-match: no steady beat');
  });
});
