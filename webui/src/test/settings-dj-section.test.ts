/**
 * Settings → Library → DJ (33e; UX-13, Ross 28 October): its own folded
 * section on the Library tab, not inside Organization, and the deep link
 * /settings?tab=library&section=dj (and every "Settings → Library → DJ"
 * link) opens the tab with it expanded and scrolled into view.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDjSettings } from '@/features/dj/dj-settings-link';
import { mixTabShown, resetMixTabForTests } from '@/features/mix/mix-visibility';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const source = readFileSync(resolve(process.cwd(), 'static/settings.js'), 'utf8');
const sectionBlock = source.slice(
  source.indexOf('let _requestedSettingsSection'),
  source.indexOf('function takeRequestedSettingsTab('),
);
const navBlock = source.slice(
  source.indexOf('function switchSettingsTab('),
  source.indexOf('window.filterSettings = filterSettings;'),
);

type Nav = {
  switchSettingsTab: (tab: string) => void;
  openSettingsSection: (section: string) => boolean;
  requestSettingsSection: (section: string) => void;
};

function load(url: string): Nav {
  window.history.replaceState(null, '', url);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(parsed.getElementById('settings-page')!);
  return new Function(
    'document',
    'window',
    'autoTestSourcesOnce',
    '_logViewerStop',
    '_logViewerInit',
    'switchLibraryMediaTab',
    `${sectionBlock}; ${navBlock}; return {switchSettingsTab, openSettingsSection, requestSettingsSection};`,
  )(document, window, vi.fn(), vi.fn(), vi.fn(), vi.fn()) as Nav;
}

const head = () =>
  document.querySelector<HTMLElement>('.settings-section-header[data-settings-section="dj"]')!;
const body = () => document.getElementById('settings-dj-section')!;

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
  const w = window as unknown as Record<string, unknown>;
  delete w.switchSettingsTab;
  delete w.openSettingsSection;
  delete w.requestSettingsSection;
  delete w.requestSettingsTab;
});

describe('Settings → Library → DJ', () => {
  it('is its own folded section on the Library tab, not inside Organization', () => {
    load('/settings');
    expect(head().dataset.stg).toBe('library');
    expect(head().querySelector('h3')?.textContent).toBe('DJ');
    expect(head().querySelector('.settings-section-hint')?.textContent).toBe(
      'Between tracks, BPM, key and energy, beat grids',
    );
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(body().classList.contains('collapsed')).toBe(true);
    // Between tracks and "BPM, key and energy" live in it (the Traktor card follows the latter)
    expect(
      body().querySelector('#dj-between-tracks-group #ss-between-tracks-library'),
    ).not.toBeNull();
    expect(body().querySelector('#dj-settings-group #dj-analysis')).not.toBeNull();
    expect(document.querySelector('#organization-music-panel #dj-settings-group')).toBeNull();
    expect(document.querySelector('#organization-music-panel #dj-between-tracks-group')).toBeNull();
  });

  it('opens expanded and scrolled into view from /settings?tab=library&section=dj', () => {
    const nav = load('/settings?tab=library&section=dj');
    nav.switchSettingsTab('library');
    vi.runAllTimers();
    expect(head().classList.contains('collapsed')).toBe(false);
    expect(body().classList.contains('collapsed')).toBe(false);
    expect(body().style.display).toBe('');
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(head().scrollIntoView).toHaveBeenCalled();
    // used up: another visit to Library doesn't open it again
    head().classList.add('collapsed');
    body().classList.add('collapsed');
    nav.switchSettingsTab('library');
    vi.runAllTimers();
    expect(body().classList.contains('collapsed')).toBe(true);
  });

  it('[gauntlet L6] another tab shown first does not use the request up', () => {
    const nav = load('/settings?tab=library&section=dj');
    // startup shows the default tab before the asked one
    nav.switchSettingsTab('connections');
    vi.runAllTimers();
    expect(body().classList.contains('collapsed')).toBe(true);
    expect(head().scrollIntoView).not.toHaveBeenCalled();
    nav.switchSettingsTab('library');
    vi.runAllTimers();
    expect(body().classList.contains('collapsed')).toBe(false);
    expect(head().scrollIntoView).toHaveBeenCalled();
  });

  it('a link asks for the section before going to Settings (requestSettingsSection)', () => {
    const nav = load('/settings');
    nav.requestSettingsSection('dj');
    nav.switchSettingsTab('library');
    vi.runAllTimers();
    expect(body().classList.contains('collapsed')).toBe(false);
  });

  it('openDjSettings, on the Settings page: Library, the section open, Between tracks focused', () => {
    const nav = load('/settings');
    const page = document.getElementById('settings-page')!;
    Object.defineProperty(page, 'offsetParent', { configurable: true, get: () => document.body });
    const w = window as unknown as Record<string, unknown>;
    const switched: string[] = [];
    w.switchSettingsTab = (tab: string) => {
      switched.push(tab);
      nav.switchSettingsTab(tab);
    };
    w.openSettingsSection = nav.openSettingsSection;
    // the card React puts in the slot
    const card = document.createElement('div');
    card.setAttribute('data-between-tracks', '');
    const radio = document.createElement('button');
    radio.setAttribute('aria-checked', 'true');
    card.appendChild(radio);
    document.getElementById('ss-between-tracks-library')!.appendChild(card);
    Object.defineProperty(card, 'offsetParent', {
      configurable: true,
      get: () => (body().classList.contains('collapsed') ? null : document.body),
    });
    openDjSettings('between');
    vi.runAllTimers();
    expect(switched).toEqual(['library']);
    expect(body().classList.contains('collapsed')).toBe(false);
    expect(document.activeElement).toBe(radio);
  });

  it('openDjSettings elsewhere: asks for Library and the DJ section, then goes to Settings', () => {
    const w = window as unknown as Record<string, unknown>;
    const asked: string[] = [];
    w.requestSettingsTab = (t: string) => asked.push(`tab:${t}`);
    w.requestSettingsSection = (s: string) => asked.push(`section:${s}`);
    const go = vi.fn(() => Promise.resolve());
    w.navigateToPage = go;
    try {
      openDjSettings();
      expect(asked).toEqual(['tab:library', 'section:dj']);
      expect(go).toHaveBeenCalledWith('settings');
    } finally {
      delete w.navigateToPage;
    }
  });
});

it('UX-28: the page has one <main> landmark, round the routed content', () => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const mains = doc.querySelectorAll('main');
  expect(mains).toHaveLength(1);
  expect(mains[0].querySelector('#webui-react-root')).not.toBeNull();
});

describe('Settings → Library → DJ: Show the Mix tab (off while Ross rethinks mixing)', () => {
  afterEach(() => resetMixTabForTests());

  it('is a switch in the DJ section, off until the settings load', () => {
    load('/settings');
    const box = body().querySelector<HTMLInputElement>('#dj-mix-tab-group #dj-show-mix-tab')!;
    expect(box).not.toBeNull();
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    expect(box.closest('label')?.textContent?.trim()).toBe('Show the Mix tab');
    expect(body().querySelector('#dj-mix-tab-group')!.textContent).toContain('Sets, Up next,');
  });

  it("is read from and saved to the server's library settings (library.dj_show_mix_tab)", () => {
    // only an explicit true ticks it: a missing key (an older config) is off
    expect(source).toContain(
      'if (_djMixTabEl) _djMixTabEl.checked = settings.library?.dj_show_mix_tab === true;',
    );
    expect(source).toContain("dj_show_mix_tab: _cfgBool('dj-show-mix-tab')");
    expect(source).toContain(
      'if (result.success) _applyMixTabSetting(settings.library?.dj_show_mix_tab);',
    );
  });

  it("once saved, this page's player follows at once", () => {
    const fn = source.slice(
      source.indexOf('function _applyMixTabSetting('),
      source.indexOf('async function saveSettings('),
    );
    const apply = new Function('window', `${fn}; return _applyMixTabSetting;`)(window) as (
      shown: unknown,
    ) => void;
    resetMixTabForTests();
    apply(true);
    expect(mixTabShown()).toBe(true);
    expect((window as unknown as Record<string, unknown>).SOULSYNC_MIX_TAB).toBe(true);
    apply(undefined);
    expect(mixTabShown()).toBe(true);
    apply(false);
    expect(mixTabShown()).toBe(false);
  });

  it("the page shell carries the server's value, as the module switches do", () => {
    expect(html).toContain(
      'window.SOULSYNC_MIX_TAB = {{ initial_mix_tab | default(false) | tojson }};',
    );
  });
});
