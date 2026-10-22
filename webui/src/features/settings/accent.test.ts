import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  accentLight,
  accentLine,
  accentReport,
  contrastRatio,
  findPreset,
  formatRatio,
  nearestPreset,
  normaliseHex,
  storedAccent,
} from './accent';

describe('the presets', () => {
  it('are the design system’s seven, with Lilac and Pale Purple renamed', () => {
    expect(ACCENT_PRESETS.map((p) => [p.name, p.hex])).toEqual([
      ['Lilac', '#8b5cf6'],
      ['Spotify Green', '#1db954'],
      ['Ocean Blue', '#1d8ab9'],
      ['Pale Purple', '#a78bfa'],
      ['Sunset Orange', '#f59e0b'],
      ['Rose', '#f43f5e'],
      ['Teal', '#14b8a6'],
    ]);
    expect(DEFAULT_ACCENT).toBe('#1db954');
  });

  it('match the options of #accent-preset in index.html, value for value', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const select = html.split('<select id="accent-preset"')[1].split('</select>')[0];
    const options = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [
      m[2],
      m[1],
    ]);
    expect(options).toEqual([...ACCENT_PRESETS.map((p) => [p.name, p.hex]), ['Custom', 'custom']]);
    // what an install that chose "Boulder Purple" or "Purple" has saved is
    // the hex, which the renamed options still carry
    expect(html).not.toContain('Boulder Purple');
  });

  it('each give dark text 4.5:1 or more on their light shade (the DESIGN-SYSTEM table)', () => {
    const table = Object.fromEntries(
      ACCENT_PRESETS.map((p) => {
        const report = accentReport(p.hex);
        return [p.name, `${report.light} ${formatRatio(report.contrast)}`];
      }),
    );
    expect(table).toEqual({
      'Spotify Green': '#46e27d 11.6:1',
      'Ocean Blue': '#46b3e2 8.2:1',
      'Pale Purple': '#e2d9fd 14.6:1',
      Lilac: '#c2a9fa 9.7:1',
      'Sunset Orange': '#f8bd59 11.6:1',
      Rose: '#f88c9f 8.6:1',
      Teal: '#35e9d5 12.9:1',
    });
    expect(ACCENT_PRESETS.every((p) => accentReport(p.hex).passes)).toBe(true);
  });
});

describe('the light shade and the check', () => {
  it('adds 16% HSL lightness, capped at 95%, as applyAccentColor does', () => {
    expect(accentLight('#8b5cf6')).toBe('#c2a9fa');
    expect(accentLight('#ffffff')).toBe('#f2f2f2');
    expect(accentLight('#808080')).toBe('#a9a9a9');
  });

  it('reads hex the way people type it', () => {
    expect(normaliseHex('#8B5CF6')).toBe('#8b5cf6');
    expect(normaliseHex(' 8b5cf6 ')).toBe('#8b5cf6');
    expect(normaliseHex('#85f')).toBe('#8855ff');
    expect(normaliseHex('#8b5cf')).toBeNull();
    expect(normaliseHex('purple')).toBeNull();
    expect(normaliseHex(42)).toBeNull();
  });

  it('measures contrast as WCAG does', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('fails a colour too dark for dark text, and never shows 4.5 for a miss', () => {
    const navy = accentReport('#1e3a8a');
    expect(navy.passes).toBe(false);
    expect(formatRatio(navy.contrast)).toBe('3.1:1');
    expect(formatRatio(4.46)).toBe('4.4:1');
    expect(formatRatio(4.5)).toBe('4.5:1');
  });

  it('writes the preview’s mono line', () => {
    expect(accentLine(accentReport('#8b5cf6'))).toBe(
      '#8b5cf6 → light #c2a9fa · dark text on it 9.7:1',
    );
  });

  it('offers the preset with the nearest hue, and by colour distance for a grey', () => {
    expect(nearestPreset('#1e3a8a').name).toBe('Ocean Blue');
    expect(nearestPreset('#5b21b6').name).toBe('Lilac');
    expect(nearestPreset('#7f1d1d').name).toBe('Rose');
    expect(nearestPreset('#14532d').name).toBe('Spotify Green');
    expect(ACCENT_PRESETS.map((p) => p.hex)).toContain(nearestPreset('#333333').hex);
  });
});

describe('what’s stored', () => {
  it('is a preset’s hex or "custom", whatever the preset is called now', () => {
    expect(storedAccent('#8b5cf6', '#1db954')).toBe('#8b5cf6');
    expect(findPreset('#8b5cf6')?.name).toBe('Lilac');
    expect(findPreset('#A78BFA')?.name).toBe('Pale Purple');
    expect(storedAccent('custom', '#123abc')).toBe('#123abc');
    expect(storedAccent('custom', 'nonsense')).toBe(DEFAULT_ACCENT);
    expect(storedAccent(undefined, undefined)).toBe(DEFAULT_ACCENT);
  });
});
