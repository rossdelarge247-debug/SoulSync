import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CamelotWheel, wheelStates } from './camelot-wheel';
import { DjMeta } from './dj-meta';
import { EnergyMeter, energySteps } from './energy-meter';
import { KeyChip } from './key-chip';

/** The reusable DJ pieces: the key chip, the energy bar and the wheel (17a, 17b, 17e). */

describe('KeyChip', () => {
  it('carries the key’s hue for the chip’s fill and text', () => {
    render(<KeyChip code="9A" title="E minor (Em), from the file's tag" />);
    const chip = screen.getByText('9A');
    expect(chip.tagName).toBe('ABBR');
    expect(chip.getAttribute('data-key-hue')).toBe('30');
    expect(chip.style.getPropertyValue('--dj-key-h')).toBe('30');
    expect(chip.getAttribute('title')).toBe("E minor (Em), from the file's tag");
  });

  it('keeps no colour for an uncertain key, which reads "8B?"', () => {
    render(<KeyChip code="8B" uncertain />);
    const chip = screen.getByText('8B?');
    expect(chip.getAttribute('data-key-hue')).toBeNull();
    expect(chip.style.getPropertyValue('--dj-key-h')).toBe('');
    expect(chip.getAttribute('data-uncertain')).toBe('true');
  });

  it('draws as text in a meta line (17e)', () => {
    render(
      <DjMeta
        lead
        dj={{
          bpm: 124,
          bpm_source: 'tag',
          key: '8A',
          key_name: 'Am',
          key_long: 'A minor',
          key_source: 'tag',
          key_confidence: null,
          key_uncertain: false,
          energy: 7,
          analyzed: true,
        }}
      />,
    );
    const key = screen.getByText('8A');
    expect(key.className).toMatch(/keyText/);
    expect(key.getAttribute('data-key-hue')).toBe('0');
    expect(key.getAttribute('title')).toBe("A minor (Am), from the file's tag");
    // no energy outside Tracks
    expect(screen.queryByText(/7/)).toBeNull();
  });
});

describe('EnergyMeter', () => {
  it('shows the number and lights that many of ten steps', () => {
    const { container } = render(<EnergyMeter energy={7} />);
    expect(screen.getByText('7')).toBeTruthy();
    const steps = container.querySelectorAll('[aria-hidden="true"] > span');
    expect(steps).toHaveLength(10);
    expect(container.querySelectorAll('[data-lit="true"]')).toHaveLength(7);
  });

  it('is a dash with no energy', () => {
    render(<EnergyMeter energy={null} />);
    expect(screen.getByText('–')).toBeTruthy();
  });

  it('clamps to 1–10', () => {
    expect(energySteps(14)).toBe(10);
    expect(energySteps(0)).toBe(0);
    expect(energySteps(6.6)).toBe(7);
  });
});

describe('the Camelot wheel', () => {
  it('lights the seed and its three neighbours, and nothing else', () => {
    const states = wheelStates('8A');
    expect(Object.keys(states)).toHaveLength(24);
    expect(states['8A']).toBe('seed');
    expect(
      Object.entries(states)
        .filter(([, s]) => s === 'near')
        .map(([k]) => k)
        .sort(),
    ).toEqual(['7A', '8B', '9A']);
    expect(Object.values(states).filter((s) => s === 'off')).toHaveLength(20);
  });

  it('wraps round 12 and 1', () => {
    const states = wheelStates('12B');
    expect(['11B', '1B', '12A'].every((k) => states[k] === 'near')).toBe(true);
  });

  it('draws the lit segments as buttons that set Tracks’ key', () => {
    const onPick = vi.fn();
    render(<CamelotWheel size={148} seed="8A" onPick={onPick} />);
    const wheel = screen.getByRole('group', {
      name: 'Camelot wheel: 8A, with 7A, 9A and 8B lit',
    });
    expect(wheel.getAttribute('width')).toBe('148');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Show tracks in 7A',
      'Show tracks in 8A',
      'Show tracks in 8B',
      'Show tracks in 9A',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show tracks in 9A' }));
    expect(onPick).toHaveBeenCalledWith('9A');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Show tracks in 7A' }), { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('7A');
  });

  it('names only the lit keys at 148px, and every key at 240px', () => {
    const { container, rerender } = render(<CamelotWheel size={148} seed="8A" />);
    expect(container.querySelectorAll('text')).toHaveLength(4);
    rerender(<CamelotWheel size={240} seed="8A" />);
    expect(container.querySelectorAll('text')).toHaveLength(24);
  });

  it('outlines an uncertain seed instead of filling it', () => {
    const { container } = render(<CamelotWheel size={148} seed="8B" uncertain />);
    const seed = container.querySelector('[data-wheel-key="8B"] path')!;
    expect(seed.getAttribute('stroke')).toBe('oklch(0.86 0.1 0)');
    expect(seed.getAttribute('fill')).toBe('rgba(255,255,255,0.06)');
    const near = container.querySelector('[data-wheel-key="9B"] path')!;
    expect(near.getAttribute('fill')).toBe('oklch(0.7 0.12 30 / 0.4)');
  });
});
