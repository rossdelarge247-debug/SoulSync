import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const source = readFileSync(resolve(process.cwd(), 'static/settings.js'), 'utf8');
const block = source.slice(
  source.indexOf('function switchSettingsTab('),
  source.indexOf('window.filterSettings = filterSettings;'),
);
let nav: { switchSettingsTab: (tab: string) => void; filterSettings: (query: string) => void };
beforeEach(() => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.replaceChildren(parsed.getElementById('settings-page')!);
  Element.prototype.scrollIntoView = vi.fn();
  nav = new Function(
    'document',
    'window',
    'autoTestSourcesOnce',
    '_logViewerStop',
    '_logViewerInit',
    'switchLibraryMediaTab',
    `${block}; return {switchSettingsTab, filterSettings};`,
  )(document, window, vi.fn(), vi.fn(), vi.fn(), vi.fn());
});
it('uses one category bar instead of a second sidebar', () => {
  expect(document.querySelectorAll('.stg-category-nav .stg-tabbar')).toHaveLength(1);
  expect(document.querySelectorAll('.stg-category-nav .stg-tab')).toHaveLength(9);
  expect(document.querySelector('.stg-nav-rail')).toBeNull();
});
it('search leaves mounted forms and their visibility unchanged until selecting a result', () => {
  nav.switchSettingsTab('connections');
  const input = document.getElementById('video-movies-path') as HTMLInputElement;
  input.value = '/unsaved';
  const section = input.closest('[data-stg]') as HTMLElement;
  const display = section.style.display;
  nav.filterSettings('Additional Movie Libraries');
  expect(section.style.display).toBe(display);
  expect(document.getElementById('video-movies-path')).toBe(input);
  const shown = vi.fn();
  document.addEventListener('soulsync:library-settings-shown', shown, { once: true });
  (document.querySelector('#stg-search-results button') as HTMLButtonElement).click();
  expect(shown).toHaveBeenCalledOnce();
  expect(document.querySelector('.stg-tab[aria-current="page"]')?.getAttribute('data-tab')).toBe(
    'library',
  );
  expect(input.value).toBe('/unsaved');
});
it('has an empty state and clearing search does not switch categories', () => {
  nav.switchSettingsTab('library');
  nav.filterSettings('no-such-setting-xyz');
  expect(document.querySelector('#stg-search-results [role="status"]')?.textContent).toContain(
    'No settings found',
  );
  nav.filterSettings('');
  expect((document.getElementById('stg-search-results') as HTMLElement).hidden).toBe(true);
  expect(document.querySelector('.stg-tab.active')?.getAttribute('data-tab')).toBe('library');
});
it('the Modules tab shows its section and loads fresh module states', () => {
  const load = vi.fn();
  (window as Window & { loadModulesSettings?: () => void }).loadModulesSettings = load;
  nav.switchSettingsTab('modules');
  expect(load).toHaveBeenCalledOnce();
  expect(document.getElementById('stg-active-title')?.textContent).toBe('Modules');
  expect((document.getElementById('modules-settings') as HTMLElement).style.display).toBe('');
  expect(document.getElementById('modules-settings-list')).not.toBeNull();
  delete (window as Window & { loadModulesSettings?: () => void }).loadModulesSettings;
});
it('Settings opens on a requested tab for one visit, then on Connections again', async () => {
  const helpers = source.slice(
    source.indexOf('let _requestedSettingsTab ='),
    source.indexOf('function switchSettingsTab('),
  );
  const load = (pathname: string, search: string) =>
    new Function(
      'document',
      'window',
      `${helpers}; return {requestSettingsTab, takeRequestedSettingsTab};`,
    )(document, { location: { pathname, search } });
  const page = document.getElementById('settings-page')!;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const tabs = load('/dashboard', '?tab=modules');
  expect(tabs.takeRequestedSettingsTab()).toBe('connections');
  tabs.requestSettingsTab('no-such-tab');
  expect(tabs.takeRequestedSettingsTab()).toBe('connections');

  tabs.requestSettingsTab('modules');
  page.classList.add('active');
  await flush();
  // startup can load the page twice for one arrival
  expect(tabs.takeRequestedSettingsTab()).toBe('modules');
  expect(tabs.takeRequestedSettingsTab()).toBe('modules');
  // leaving Settings uses it up
  page.classList.remove('active');
  await flush();
  expect(tabs.takeRequestedSettingsTab()).toBe('connections');

  // so does picking a tab
  tabs.requestSettingsTab('modules');
  (document.querySelector('#settings-page .stg-tab[data-tab="library"]') as HTMLElement).click();
  expect(tabs.takeRequestedSettingsTab()).toBe('connections');

  // opened from a link to /settings?tab=modules
  const linked = load('/settings', '?tab=modules');
  expect(linked.takeRequestedSettingsTab()).toBe('modules');
});
