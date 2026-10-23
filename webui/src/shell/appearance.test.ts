/**
 * The accent picker: Settings → Appearance over the page's real markup
 * (index.html) and a member's My Account. Each profile picks its own accent
 * (HANDOFF 35, PUT /api/profiles/me/appearance); the install's accent in
 * Settings' form is the default for profiles that haven't picked.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetProfileAccentForTests, accentStore } from '@/features/settings/profile-accent';

import {
  _resetAppearanceForTests,
  ACCENT_APPLIED_EVENT,
  initAppearanceSettings,
  mountAccentPicker,
  syncAppearanceSettings,
  waveHeights,
} from './appearance';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
let parsed: Document | null = null;

interface Server {
  accent: string | null;
  install: string;
  isAdmin: boolean;
  refuse?: string;
}

let server: Server;
let puts: Array<{ accent: string | null }>;
let applied: string[];
let changes: number;
let toasts: Array<[string, string | undefined]>;

function payload() {
  return {
    success: true,
    accent: server.accent,
    install_accent: server.install,
    effective_accent: server.accent ?? server.install,
    is_admin: server.isAdmin,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  server = { accent: null, install: '#8b5cf6', isAdmin: true };
  puts = [];
  applied = [];
  changes = 0;
  toasts = [];
  _resetProfileAccentForTests();
  _resetAppearanceForTests();
  window.applyAccentColor = vi.fn((hex: string) => {
    applied.push(hex);
    window.dispatchEvent(new CustomEvent(ACCENT_APPLIED_EVENT, { detail: { hex } }));
  });
  window.showToast = vi.fn((message: string, tone?: string) => {
    toasts.push([message, tone]);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/profiles/me/appearance');
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as { accent: string | null };
        puts.push(body);
        if (server.refuse) return json({ success: false, error: server.refuse }, 400);
        server.accent = body.accent;
      }
      return json(payload());
    }),
  );
});

afterEach(() => {
  delete window.applyAccentColor;
  delete window.showToast;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** Settings → Appearance as the page renders it, filled the way settings.js fills it. */
async function openSettings(install = server.install, custom = '#8b5cf6') {
  parsed ??= new DOMParser().parseFromString(html, 'text/html');
  const settings = document.createElement('div');
  settings.id = 'settings-page';
  settings.append(document.importNode(parsed.getElementById('appearance-settings')!, true));
  document.body.replaceChildren(settings);
  initAppearanceSettings();
  select().value = install;
  store().value = custom;
  select().addEventListener('change', () => (changes += 1));
  syncAppearanceSettings();
  await settle();
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const select = () => document.getElementById('accent-preset') as HTMLSelectElement;
const store = () => document.getElementById('accent-custom-color') as HTMLInputElement;
const root = () => document.getElementById('accent-picker')!;
const within = (el: HTMLElement = root()) => ({
  group: () => el.querySelector<HTMLElement>('[role="radiogroup"]')!,
  radios: () => Array.from(el.querySelectorAll<HTMLButtonElement>('[role="radio"]')),
  radio: (name: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((r) =>
      r.textContent?.includes(name),
    )!,
  checked: () =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter(
      (r) => r.getAttribute('aria-checked') === 'true',
    ),
  source: () => el.querySelector<HTMLElement>('.accent-source')!,
  reset: () => el.querySelector<HTMLButtonElement>('.accent-source .appearance-btn')!,
  defaults: () => el.querySelector<HTMLElement>('.accent-default'),
  hex: () => el.querySelector<HTMLInputElement>('.accent-custom-hex')!,
  custom: () => el.querySelector<HTMLElement>('.accent-custom')!,
  check: () => el.querySelector<HTMLElement>('.accent-check')!,
  label: () => el.querySelector<HTMLElement>('.accent-preview-label')!,
  line: () => el.querySelector<HTMLElement>('.accent-preview-line')!,
});

describe('the markup', () => {
  it('says the accent is yours, not everyone’s', () => {
    parsed ??= new DOMParser().parseFromString(html, 'text/html');
    const intro = parsed.querySelector('#appearance-accent .appearance-intro')!.textContent!;
    expect(intro.replace(/\s+/g, ' ')).toContain('Yours only; each profile picks its own.');
    expect(intro).not.toContain('applies to everyone');
    // the install's default still lives in the form settings.js saves
    expect(parsed.getElementById('accent-custom-color')?.getAttribute('value')).toBe('#8b5cf6');
    expect(parsed.getElementById('accent-picker')).not.toBeNull();
  });
});

describe('the radio cards', () => {
  it('draws a card per preset and Custom, as a labelled radio group', async () => {
    await openSettings();
    const w = within();
    expect(w.group()).toHaveAccessibleName('Accent colour');
    expect(w.radios().map((r) => r.querySelector('.accent-card-name')?.textContent)).toEqual([
      'Lilac',
      'Spotify Green',
      'Ocean Blue',
      'Pale Purple',
      'Sunset Orange',
      'Rose',
      'Teal',
      'Custom…',
    ]);
    const lilac = w.radio('Lilac').querySelectorAll<HTMLElement>('.accent-swatch > span');
    expect(lilac[0].style.background).toBe('rgb(139, 92, 246)');
    expect(lilac[1].style.background).toBe('rgb(194, 169, 250)');
    expect(w.radios().filter((r) => r.tabIndex === 0)).toEqual([w.radio('Lilac')]);
  });

  it('on upgrade a profile without a pick sees the install’s accent, unchanged', async () => {
    server.install = '#1d8ab9';
    await openSettings('#1d8ab9');
    const w = within();
    expect(w.checked()).toEqual([w.radio('Ocean Blue')]);
    expect(w.radio('Ocean Blue').querySelector('.accent-card-note')).toHaveTextContent(
      'Selected · the default',
    );
    expect(w.radio('Lilac').querySelector('.accent-card-note')).toHaveTextContent(/^$/);
    expect(w.source()).toHaveTextContent('You’re using this SYNCHRO.S’s default, Ocean Blue.');
    expect(w.reset().hidden).toBe(true);
    expect(w.label()).toHaveTextContent('With Ocean Blue, the default');
    expect(w.line()).toHaveTextContent('#1d8ab9 → light');
    expect(applied).toEqual([]);
    expect(puts).toEqual([]);
    expect(changes).toBe(0);
  });

  it('a click saves the pick as this profile’s and leaves the install’s default alone', async () => {
    await openSettings();
    const w = within();
    w.radio('Rose').click();
    await settle();
    expect(puts).toEqual([{ accent: '#f43f5e' }]);
    expect(applied.at(-1)).toBe('#f43f5e');
    expect(select().value).toBe('#8b5cf6');
    expect(changes).toBe(0);
    expect(w.checked()).toEqual([w.radio('Rose')]);
    expect(w.radio('Lilac').querySelector('.accent-card-note')).toHaveTextContent('The default');
    expect(w.source()).toHaveTextContent(
      'Yours: Rose. Profiles that haven’t picked their own use Lilac.',
    );
    expect(w.label()).toHaveTextContent('With Rose, yours');
  });

  it('“Use the default” goes back to following the install’s accent', async () => {
    server.accent = '#14b8a6';
    await openSettings();
    const w = within();
    expect(w.checked()).toEqual([w.radio('Teal')]);
    expect(w.reset()).toHaveTextContent('Use the default, Lilac');
    w.reset().click();
    await settle();
    expect(puts).toEqual([{ accent: null }]);
    expect(applied.at(-1)).toBe('#8b5cf6');
    expect(w.checked()).toEqual([w.radio('Lilac')]);
    expect(accentStore().mine).toBeNull();
  });

  it('a refused save puts the colour back and says why', async () => {
    server.refuse = 'Couldn’t save your accent.';
    await openSettings();
    const w = within();
    w.radio('Teal').click();
    await settle();
    await settle();
    expect(w.checked()).toEqual([w.radio('Lilac')]);
    expect(applied.at(-1)).toBe('#8b5cf6');
    expect(toasts).toEqual([['Couldn’t save your accent.', 'error']]);
  });

  it('the arrow keys move the choice and the focus, and wrap', async () => {
    await openSettings();
    const w = within();
    w.radio('Lilac').focus();
    w.radio('Lilac').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(document.activeElement).toBe(w.radio('Spotify Green'));
    expect(w.checked()).toEqual([w.radio('Spotify Green')]);
    w.radio('Spotify Green').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    w.radio('Lilac').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(w.radio('Custom'));
    expect(w.checked()).toEqual([w.radio('Custom')]);
  });
});

describe('the install’s default (admins)', () => {
  it('admins see the default and can make their accent it; the form autosaves', async () => {
    server.accent = '#f59e0b';
    await openSettings();
    const w = within();
    const defaults = w.defaults()!;
    expect(defaults.hidden).toBe(false);
    expect(defaults).toHaveTextContent('Default for profiles that haven’t picked: Lilac.');
    const make = defaults.querySelector<HTMLButtonElement>('.appearance-btn')!;
    expect(make).toHaveTextContent('Make Sunset Orange the default');
    make.click();
    expect(select().value).toBe('#f59e0b');
    expect(changes).toBe(1);
    expect(defaults).toHaveTextContent('Default for profiles that haven’t picked: Sunset Orange.');
    expect(make.hidden).toBe(true);
    expect(puts).toEqual([]);
  });

  it('a custom accent becomes the default as "custom" and its hex', async () => {
    server.accent = '#3b82f6';
    await openSettings();
    within().defaults()!.querySelector<HTMLButtonElement>('.appearance-btn')!.click();
    expect(select().value).toBe('custom');
    expect(store().value).toBe('#3b82f6');
  });

  it('members don’t get the default line', async () => {
    server.isAdmin = false;
    await openSettings();
    expect(within().defaults()!.hidden).toBe(true);
  });
});

describe('Custom…', () => {
  it('starts from the accent in use, and saves nothing until another hex passes', async () => {
    await openSettings();
    const w = within();
    w.radio('Custom').click();
    expect(w.custom().hidden).toBe(false);
    expect(w.checked()).toEqual([w.radio('Custom')]);
    expect(w.hex().value).toBe('#8b5cf6');
    expect(w.check()).toHaveTextContent('Dark text on its light shade, #c2a9fa, is 9.7:1');
    expect(puts).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('shows a passing hex as it’s typed and saves it when typing pauses', async () => {
    await openSettings();
    const w = within();
    w.radio('Custom').click();
    vi.useFakeTimers();
    w.hex().value = '#3B82F6';
    w.hex().dispatchEvent(new Event('input'));
    expect(applied.at(-1)).toBe('#3b82f6');
    expect(puts).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(puts).toEqual([{ accent: '#3b82f6' }]);
    vi.useRealTimers();
    await settle();
    expect(w.radio('Custom')).toHaveTextContent('#3b82f6');
    expect(w.label()).toHaveTextContent('With your custom colour');
  });

  it('a hex that fails says so in words, keeps the accent, and offers the nearest preset', async () => {
    await openSettings();
    const w = within();
    w.radio('Custom').click();
    w.hex().value = '#1e3a8a';
    w.hex().dispatchEvent(new Event('input'));
    expect(w.hex()).toHaveAttribute('aria-invalid', 'true');
    expect(w.check()).toHaveTextContent(
      '#1e3a8a is too dark for an accent. Dark text on its light shade, #2d56cd, is 3.1:1, and buttons need 4.5:1.',
    );
    expect(w.check()).toHaveTextContent('Your accent stays Lilac.');
    expect(applied).toEqual([]);
    const offer = w.check().querySelector('button')!;
    expect(offer).toHaveTextContent('Use Ocean Blue instead');
    // leaving the field to click the offer must not redraw it away
    w.hex().dispatchEvent(new Event('blur'));
    expect(w.check().querySelector('button')).toBe(offer);
    offer.click();
    await settle();
    expect(puts).toEqual([{ accent: '#1d8ab9' }]);
    expect(w.custom().hidden).toBe(true);
    expect(document.activeElement).toBe(w.radio('Ocean Blue'));
  });

  it('a half-typed hex is a hint until you leave the field', async () => {
    await openSettings();
    const w = within();
    w.radio('Custom').click();
    w.hex().value = '#8b';
    w.hex().dispatchEvent(new Event('input'));
    expect(w.check()).toHaveTextContent('Type # and six digits or letters a–f, like #8b5cf6.');
    w.hex().value = '#8b5c';
    w.hex().dispatchEvent(new Event('blur'));
    expect(w.check()).toHaveTextContent("“#8b5c” isn't a hex colour.");
    expect(w.hex()).toHaveAttribute('aria-invalid', 'true');
  });

  it('a custom install default that fails today’s check is shown as it is, not changed', async () => {
    server.install = '#1e3a8a';
    await openSettings('custom', '#1e3a8a');
    const w = within();
    expect(w.checked()).toEqual([w.radio('Custom')]);
    expect(w.hex().value).toBe('#1e3a8a');
    expect(w.check()).toHaveTextContent('It’s in use now');
    expect(applied).toEqual([]);
    expect(puts).toEqual([]);
  });
});

describe('My Account (members)', () => {
  it('draws the same picker, and agrees with Settings after a pick', async () => {
    server.isAdmin = false;
    const box = document.createElement('div');
    document.body.append(box);
    mountAccentPicker(box, { prefix: 'ma-accent' });
    await settle();
    const w = within(box);
    expect(w.radios()).toHaveLength(8);
    expect(w.defaults()).toBeNull();
    expect(box.querySelector('#ma-accent-custom-hex')).not.toBeNull();
    w.radio('Teal').click();
    await settle();
    expect(puts).toEqual([{ accent: '#14b8a6' }]);
    expect(w.source()).toHaveTextContent('Yours: Teal.');
  });
});

describe('the preview strip', () => {
  it('draws a played waveform: the first ten bars in accent-light', async () => {
    await openSettings();
    const bars = document.querySelectorAll<HTMLElement>('#accent-preview-wave > span');
    expect(bars).toHaveLength(24);
    expect([...bars].filter((b) => b.dataset.played)).toHaveLength(10);
    expect(waveHeights().every((b) => b.height >= 4 && b.height <= 24)).toBe(true);
  });
});
