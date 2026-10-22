/**
 * Settings → Appearance: the accent radio cards over the page's real markup
 * (index.html), the custom colour's contrast check and the preview line.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetAppearanceForTests,
  ACCENT_APPLIED_EVENT,
  initAppearanceSettings,
  syncAppearanceSettings,
  waveHeights,
} from './appearance';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
let parsed: Document | null = null;

/** The Appearance groups as the page renders them, the way settings.js fills them. */
function mount(preset = '#8b5cf6', custom = '#8b5cf6') {
  parsed ??= new DOMParser().parseFromString(html, 'text/html');
  const settings = document.createElement('div');
  settings.id = 'settings-page';
  settings.append(document.importNode(parsed.getElementById('appearance-settings')!, true));
  document.body.replaceChildren(settings);
  select().value = preset;
  store().value = custom;
}

const select = () => document.getElementById('accent-preset') as HTMLSelectElement;
const store = () => document.getElementById('accent-custom-color') as HTMLInputElement;
const hexField = () => document.getElementById('accent-custom-hex') as HTMLInputElement;
const customGroup = () => document.getElementById('custom-color-group')!;
const check = () => document.getElementById('accent-custom-check')!;
const group = () => document.querySelector<HTMLElement>('[role="radiogroup"]')!;
const radios = () => Array.from(group().querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const radio = (name: string) => radios().find((r) => r.textContent?.includes(name))!;
const checked = () => radios().filter((r) => r.getAttribute('aria-checked') === 'true');

let applied: string[] = [];
let changes = 0;

beforeEach(() => {
  applied = [];
  changes = 0;
  window.applyAccentColor = vi.fn((hex: string) => {
    applied.push(hex);
    window.dispatchEvent(new CustomEvent(ACCENT_APPLIED_EVENT, { detail: { hex } }));
  });
  _resetAppearanceForTests();
});

afterEach(() => {
  delete window.applyAccentColor;
  document.body.replaceChildren();
});

function start(preset?: string, custom?: string) {
  mount(preset, custom);
  select().addEventListener('change', () => (changes += 1));
  initAppearanceSettings();
}

describe('the radio cards', () => {
  it('draws a card per preset and Custom, as a labelled radio group', () => {
    start();
    expect(group()).toHaveAccessibleName('Accent colour');
    expect(radios().map((r) => r.querySelector('.accent-card-name')?.textContent)).toEqual([
      'Lilac',
      'Spotify Green',
      'Ocean Blue',
      'Pale Purple',
      'Sunset Orange',
      'Rose',
      'Teal',
      'Custom…',
    ]);
    // each preset shows the pair the app will use: the accent and its light shade
    const lilac = radio('Lilac').querySelectorAll<HTMLElement>('.accent-swatch > span');
    expect(lilac[0].style.background).toBe('rgb(139, 92, 246)');
    expect(lilac[1].style.background).toBe('rgb(194, 169, 250)');
  });

  it('an install that chose "Boulder Purple" sees Lilac selected, with its colour unchanged', () => {
    start('#8b5cf6');
    expect(checked()).toEqual([radio('Lilac')]);
    expect(radio('Lilac').querySelector('.accent-card-note')).toHaveTextContent(
      'Selected · the default',
    );
    expect(radio('Spotify Green').querySelector('.accent-card-note')).toHaveTextContent(/^$/);
    expect(applied).toEqual([]);
    expect(changes).toBe(0);
    expect(document.getElementById('accent-preview-label')).toHaveTextContent('With Lilac');
    expect(document.getElementById('accent-preview-line')).toHaveTextContent(
      '#8b5cf6 → light #c2a9fa · dark text on it 9.7:1',
    );
  });

  it('Lilac is the default; an install that saved Spotify Green keeps it as a normal preset', () => {
    start('#1db954');
    expect(radios()[0]).toBe(radio('Lilac'));
    expect(checked()).toEqual([radio('Spotify Green')]);
    expect(radio('Spotify Green').querySelector('.accent-card-note')).toHaveTextContent(
      /^Selected$/,
    );
    expect(radio('Lilac').querySelector('.accent-card-note')).toHaveTextContent(/^The default$/);
    expect(applied).toEqual([]);
    expect(changes).toBe(0);
    expect(document.getElementById('accent-preview-label')).toHaveTextContent('With Spotify Green');
  });

  it('the page’s own markup starts on Lilac, before settings.js fills it', () => {
    parsed ??= new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.getElementById('accent-custom-color')?.getAttribute('value')).toBe('#8b5cf6');
    expect(parsed.getElementById('accent-custom-picker')?.getAttribute('value')).toBe('#8b5cf6');
    expect(parsed.getElementById('accent-preview-label')?.textContent).toBe('With Lilac');
  });

  it('"Purple" is Pale Purple now, by the same hex', () => {
    start('#a78bfa');
    expect(checked()).toEqual([radio('Pale Purple')]);
  });

  it('only the checked card is in the tab order', () => {
    start('#1d8ab9');
    expect(radios().filter((r) => r.tabIndex === 0)).toEqual([radio('Ocean Blue')]);
  });

  it('a click picks a preset, applies it and lets the page save it', () => {
    start();
    radio('Rose').click();
    expect(select().value).toBe('#f43f5e');
    expect(applied).toEqual(['#f43f5e']);
    expect(changes).toBe(1);
    expect(checked()).toEqual([radio('Rose')]);
    expect(document.getElementById('accent-preview-label')).toHaveTextContent('With Rose');
  });

  it('the arrow keys move the choice and the focus, and wrap', () => {
    start('#8b5cf6');
    radio('Lilac').focus();
    radio('Lilac').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(select().value).toBe('#1db954');
    expect(document.activeElement).toBe(radio('Spotify Green'));
    radio('Spotify Green').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    radio('Lilac').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(radio('Custom'));
    expect(checked()).toEqual([radio('Custom')]);
    radio('Custom').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(select().value).toBe('#8b5cf6');
  });
});

describe('Custom…', () => {
  it('starts from the accent in use, and changes nothing until another hex passes', () => {
    start('#8b5cf6');
    radio('Custom').click();
    expect(customGroup().hidden).toBe(false);
    expect(checked()).toEqual([radio('Custom')]);
    expect(hexField().value).toBe('#8b5cf6');
    expect(check()).toHaveTextContent('Dark text on its light shade, #c2a9fa, is 9.7:1');
    expect(select().value).toBe('#8b5cf6');
    expect(applied).toEqual([]);
    expect(changes).toBe(0);
  });

  it('uses and saves a hex that passes as it’s typed', () => {
    start();
    radio('Custom').click();
    hexField().value = '#3B82F6';
    hexField().dispatchEvent(new Event('input'));
    expect(store().value).toBe('#3b82f6');
    expect(select().value).toBe('custom');
    expect(applied.at(-1)).toBe('#3b82f6');
    expect(hexField()).toHaveAttribute('aria-invalid', 'false');
    expect(radio('Custom')).toHaveTextContent('#3b82f6');
    expect(document.getElementById('accent-preview-label')).toHaveTextContent(
      'With your custom colour',
    );
  });

  it('a hex that fails says so in words, keeps the accent, and offers the nearest preset', () => {
    start('#8b5cf6');
    radio('Custom').click();
    const before = applied.length;
    const savesBefore = changes;
    hexField().value = '#1e3a8a';
    hexField().dispatchEvent(new Event('input'));
    expect(hexField()).toHaveAttribute('aria-invalid', 'true');
    expect(check()).toHaveTextContent(
      '#1e3a8a is too dark for an accent. Dark text on its light shade, #2d56cd, is 3.1:1, and buttons need 4.5:1.',
    );
    expect(applied.length).toBe(before);
    expect(changes).toBe(savesBefore);
    expect(select().value).toBe('#8b5cf6');
    expect(store().value).toBe('#8b5cf6');

    const offer = check().querySelector('button')!;
    expect(offer).toHaveTextContent('Use Ocean Blue instead');
    expect(check()).toHaveTextContent('Your accent stays Lilac.');
    // leaving the field to click the offer must not redraw it away
    hexField().dispatchEvent(new Event('blur'));
    expect(check().querySelector('button')).toBe(offer);
    offer.click();
    expect(select().value).toBe('#1d8ab9');
    expect(customGroup().hidden).toBe(true);
    expect(document.activeElement).toBe(radio('Ocean Blue'));
  });

  it('a half-typed hex is a hint until you leave the field', () => {
    start();
    radio('Custom').click();
    hexField().value = '#8b';
    hexField().dispatchEvent(new Event('input'));
    expect(check()).toHaveTextContent('Type # and six digits or letters a–f, like #8b5cf6.');
    expect(hexField()).toHaveAttribute('aria-invalid', 'false');
    hexField().value = '#8b5c';
    hexField().dispatchEvent(new Event('blur'));
    expect(check()).toHaveTextContent("“#8b5c” isn't a hex colour.");
    expect(hexField()).toHaveAttribute('aria-invalid', 'true');
  });

  it('a saved custom colour that fails today’s check is shown as it is, not changed', () => {
    start('custom', '#1e3a8a');
    expect(checked()).toEqual([radio('Custom')]);
    expect(hexField().value).toBe('#1e3a8a');
    expect(check()).toHaveTextContent('#1e3a8a is too dark for an accent.');
    expect(check()).toHaveTextContent('It’s in use now');
    expect(applied).toEqual([]);
  });
});

describe('settings.js loading the saved values', () => {
  it('re-syncs the cards after the form is filled', () => {
    start();
    select().value = '#14b8a6';
    syncAppearanceSettings();
    expect(checked()).toEqual([radio('Teal')]);
    expect(customGroup().hidden).toBe(true);
  });

  it('an unknown preset value falls back to the default card', () => {
    start('purple');
    expect(checked()).toEqual([radio('Lilac')]);
  });
});

describe('the preview strip', () => {
  it('draws a played waveform: the first ten bars in accent-light', () => {
    start();
    const bars = document.querySelectorAll<HTMLElement>('#accent-preview-wave > span');
    expect(bars).toHaveLength(24);
    expect([...bars].filter((b) => b.dataset.played)).toHaveLength(10);
    expect(waveHeights().every((b) => b.height >= 4 && b.height <= 24)).toBe(true);
  });

  it('follows an accent applied elsewhere (Home’s quick swatches)', () => {
    start('#1db954');
    select().value = '#f59e0b';
    window.dispatchEvent(new CustomEvent(ACCENT_APPLIED_EVENT, { detail: { hex: '#f59e0b' } }));
    expect(document.getElementById('accent-preview-line')).toHaveTextContent(
      '#f59e0b → light #f8bd59',
    );
  });
});
