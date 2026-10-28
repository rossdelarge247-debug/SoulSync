import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
