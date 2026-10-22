/**
 * The navigation shell against the real markup from index.html: the current
 * row, module rows, compact mode and the admin fold (and that both persist),
 * the badges' unknown / zero / count states, ⌘K, and the phone sheets.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { navGuardCss, normalizeModules } from '@/features/modules/modules.helpers';

import { NAV_TARGETS } from './nav-routes';
import {
  ACTIVITY_MISSING_POLL_MS,
  ADMIN_OPEN_KEY,
  COMPACT_KEY,
  initNavShell,
  PHONE_QUERY,
  SETUP_CHECK_REPORT_EVENT,
  SHELL_LOCATION_EVENT,
  type NavShell,
  type NavShellOptions,
} from './nav-shell';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
let parsed: Document | null = null;

function mount() {
  parsed ??= new DOMParser().parseFromString(html, 'text/html');
  const take = (id: string) => document.importNode(parsed!.getElementById(id)!, true);
  document.body.replaceChildren(
    take('app-sidebar'),
    take('ss-topbar'),
    take('ss-sheet-catcher'),
    take('ss-tabbar'),
  );
  document.body.removeAttribute('data-side');
  document.body.removeAttribute('data-video-page');
  document.body.className = '';
  for (const attr of ['data-sidebar', 'data-admin-open', 'data-sheet']) {
    document.documentElement.removeAttribute(attr);
  }
  document.getElementById('soulsync-module-guard')?.remove();
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const row = (key: string) => $(`#app-sidebar [data-nav-row="${key}"]`);
const tab = (key: string) => $(`#ss-tabbar button[data-tab="${key}"]`);
const current = () =>
  [...document.querySelectorAll('#app-sidebar [aria-current="page"]')].map(
    (el) => (el as HTMLElement).dataset.navRow,
  );

let shell: NavShell | null = null;
function start(options: NavShellOptions = {}) {
  shell = initNavShell({ autoStart: false, fetchImpl: vi.fn(), ...options });
  return shell!;
}

function phone(matches: boolean) {
  const listeners: Array<() => void> = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === PHONE_QUERY ? matches : false,
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    }),
  });
  return listeners;
}

beforeEach(() => {
  mount();
  localStorage.clear();
  window.history.replaceState(null, '', '/dashboard');
  phone(false);
});

afterEach(() => {
  shell?.destroy();
  shell = null;
  Reflect.deleteProperty(window, 'navigateToPage');
  Reflect.deleteProperty(window, 'matchMedia');
  Reflect.deleteProperty(window, 'navigation');
  delete window.SoulSyncWebShellBridge;
  vi.restoreAllMocks();
});

describe('the current row', () => {
  it('lights the row the page belongs to, once, with aria-current', () => {
    const nav = start();
    nav.markActive('search');
    expect(current()).toEqual(['search']);
    expect(row('search').classList.contains('active')).toBe(true);
  });

  it('keeps Wanted lit on the watchlist, and names the page', () => {
    const nav = start();
    nav.markActive('watchlist');
    expect(current()).toEqual(['wanted']);
    expect($('#ss-page-name').textContent).toBe('Watchlist');
    nav.markActive('wishlist');
    expect($('#ss-page-name').textContent).toBe('Wanted');
  });

  it('lights Albums on the library album view and Artists otherwise', () => {
    window.history.replaceState(null, '', '/library?view=albums');
    const nav = start();
    nav.markActive('library');
    expect(current()).toEqual(['albums']);
    window.history.replaceState(null, '', '/library');
    window.dispatchEvent(new CustomEvent(SHELL_LOCATION_EVENT));
    expect(current()).toEqual(['artists']);
    nav.markActive('artist-detail');
    expect(current()).toEqual(['artists']);
  });

  it('lights "Requests and issues" for both pages', () => {
    const nav = start();
    nav.markActive('requests');
    expect(current()).toEqual(['issues']);
    expect($('#ss-page-name').textContent).toBe('Requests');
    nav.markActive('issues');
    expect(current()).toEqual(['issues']);
  });

  it('lights the phone tab of the current group, and the Home tab on Home', () => {
    const nav = start();
    nav.markActive('automations');
    expect(tab('automate').getAttribute('aria-current')).toBe('true');
    expect(tab('get-music').hasAttribute('aria-current')).toBe(false);
    nav.markActive('dashboard');
    expect(
      $('#ss-tabbar [data-tab="home"][data-page="dashboard"]').getAttribute('aria-current'),
    ).toBe('page');
  });

  it('starts from the URL before the bridge says anything', () => {
    window.history.replaceState(null, '', '/stats');
    start();
    expect(current()).toEqual(['stats']);
  });

  it('points Wanted and Activity where the route map says', () => {
    start();
    expect(row('wanted').getAttribute('href')).toBe(NAV_TARGETS.wanted.path);
    expect(row('wanted').getAttribute('data-page')).toBe(NAV_TARGETS.wanted.pageId);
    expect(row('activity').getAttribute('href')).toBe(NAV_TARGETS.activity.path);
    expect($('#ss-running').getAttribute('href')).toBe(NAV_TARGETS.activity.path);
    // the phone's Activity icon opens the notifications, which lead to Activity
    expect($('#ss-phone-activity').tagName).toBe('BUTTON');
  });

  it('names the page from the video sidebar on the video side', async () => {
    start();
    document.body.setAttribute('data-side', 'video');
    $('#app-sidebar .video-nav [data-video-page="video-calendar"]').classList.add('active');
    await Promise.resolve();
    await Promise.resolve();
    expect($('#ss-page-name').textContent).toBe('Calendar');
    expect(
      $('#app-sidebar .video-nav [data-video-page="video-calendar"]').getAttribute('aria-current'),
    ).toBe('page');
    expect(tab('get-music').getAttribute('aria-current')).toBe('true');
  });
});

describe('settling', () => {
  it('a refresh never queues another (the page would hang)', async () => {
    const nav = start();
    nav.applySetupReport('local', { ok: 3, warning: 0, error: 0 });
    nav.refresh();
    nav.markActive('search');
    // an observer that re-triggers itself starves macrotasks: this would time out
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(current()).toEqual(['search']);
  });
});

describe('module rows', () => {
  function turnOff(names: string[]) {
    const modules = normalizeModules(
      names.map((name) => ({
        name,
        display_name: name,
        enabled: false,
        pages: name === 'sample_studio' ? ['sample-studio'] : [name],
      })),
    );
    const style = document.createElement('style');
    style.id = 'soulsync-module-guard';
    style.textContent = navGuardCss(modules);
    document.head.appendChild(style);
  }

  it('a module that is off removes its row and nothing else', () => {
    start();
    const before = [...document.querySelectorAll('#app-sidebar .ss-music-nav [data-nav-row]')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => (el as HTMLElement).dataset.navRow);
    turnOff(['podcasts', 'chat']);
    const after = [...document.querySelectorAll('#app-sidebar .ss-music-nav [data-nav-row]')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => (el as HTMLElement).dataset.navRow);
    expect(after).toEqual(before.filter((key) => key !== 'podcasts' && key !== 'chat'));
    // the groups keep their order and their labels
    const groups = [...document.querySelectorAll('#app-sidebar .ss-music-nav .ss-group-label')].map(
      (el) => el.textContent,
    );
    expect(groups).toEqual(['Get music', 'Library', 'Automate', 'Settings']);
  });

  it('a phone tab hides when nothing in its group is left to open', async () => {
    const nav = start();
    for (const el of document.querySelectorAll<HTMLElement>(
      '#app-sidebar .ss-group[data-group="automate"] .nav-button',
    )) {
      el.style.display = 'none'; // profile gating, as init.js does it
    }
    nav.refresh();
    expect(tab('automate').hidden).toBe(true);
    expect(tab('library').hidden).toBe(false);
    // Settings always holds Admin and help and the profile
    for (const el of document.querySelectorAll<HTMLElement>(
      '#app-sidebar .ss-group[data-group="settings"] .nav-button',
    )) {
      el.style.display = 'none';
    }
    nav.refresh();
    expect(tab('settings').hidden).toBe(false);
  });
});

describe('compact mode', () => {
  it('the wordmark folds the sidebar to the rail and the choice is kept', () => {
    start();
    const wordmark = $<HTMLButtonElement>('#sidebar-collapse-toggle');
    expect(wordmark.getAttribute('aria-label')).toBe('Collapse navigation');
    wordmark.click();
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('collapsed');
    expect(localStorage.getItem(COMPACT_KEY)).toBe('1');
    expect(wordmark.getAttribute('aria-label')).toBe('Expand navigation');
    expect(wordmark.getAttribute('aria-expanded')).toBe('false');
    wordmark.click();
    expect(document.documentElement.hasAttribute('data-sidebar')).toBe(false);
    expect(localStorage.getItem(COMPACT_KEY)).toBeNull();
  });

  it('comes back compact (the <head> script applies the stored choice)', () => {
    localStorage.setItem(COMPACT_KEY, '1');
    document.documentElement.setAttribute('data-sidebar', 'collapsed');
    const nav = start();
    expect(nav.isCompact()).toBe(true);
    expect(row('search').getAttribute('title')).toBe('Search');
  });

  it('gives each rail icon its name and count as title and aria-label', () => {
    const badge = $('#wishlist-nav-badge');
    badge.textContent = '312';
    badge.classList.remove('hidden');
    const nav = start();
    nav.setCompact(true);
    expect(row('wanted').getAttribute('aria-label')).toBe('Wanted, 312');
    expect(row('wanted').getAttribute('title')).toBe('Wanted · 312');
    nav.applyActivityStatus({ running: 1, needsYou: 2 });
    expect(row('activity').getAttribute('aria-label')).toBe('Activity, 2 need you');
    nav.setCompact(false);
    expect(row('wanted').hasAttribute('aria-label')).toBe(false);
    expect(row('wanted').hasAttribute('title')).toBe(false);
  });

  it('leaves names it did not set alone', () => {
    const button = $('#profile-indicator-button');
    button.setAttribute('aria-label', 'Ross, switch profile');
    const nav = start();
    nav.setCompact(true);
    nav.setCompact(false);
    expect(button.getAttribute('aria-label')).toBe('Ross, switch profile');
  });

  it('still works when the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const nav = start();
    nav.toggleCompact();
    expect(nav.isCompact()).toBe(true);
  });

  it('does nothing on a phone, where the tab bar is the compact form', () => {
    phone(true);
    start();
    $<HTMLButtonElement>('#sidebar-collapse-toggle').click();
    expect(document.documentElement.hasAttribute('data-sidebar')).toBe(false);
  });
});

describe('Admin and help', () => {
  it('unfolds in place and the choice is kept', () => {
    start();
    const toggle = $<HTMLButtonElement>('#ss-admin-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('ss-admin-panel');
    toggle.click();
    expect(document.documentElement.getAttribute('data-admin-open')).toBe('true');
    expect(localStorage.getItem(ADMIN_OPEN_KEY)).toBe('1');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(document.documentElement.hasAttribute('data-admin-open')).toBe(false);
    expect(localStorage.getItem(ADMIN_OPEN_KEY)).toBeNull();
  });

  it('reads the stored state the <head> script applied', () => {
    document.documentElement.setAttribute('data-admin-open', 'true');
    const nav = start();
    expect(nav.isAdminOpen()).toBe(true);
    expect($('#ss-admin-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('opens as a popover beside the rail; Escape closes it and returns focus', () => {
    const nav = start();
    nav.setCompact(true);
    const toggle = $<HTMLButtonElement>('#ss-admin-toggle');
    toggle.click();
    expect($('#ss-admin').classList.contains('is-popover-open')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // the popover doesn't touch the fold's stored state
    expect(localStorage.getItem(ADMIN_OPEN_KEY)).toBeNull();
    expect($('#ss-admin-panel').contains(document.activeElement)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('#ss-admin').classList.contains('is-popover-open')).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it('a click outside the popover closes it', () => {
    const nav = start();
    nav.setCompact(true);
    $<HTMLButtonElement>('#ss-admin-toggle').click();
    $('#ss-page-name').click();
    expect($('#ss-admin').classList.contains('is-popover-open')).toBe(false);
  });

  it('the setup check dot shows through the fold, in words too', () => {
    const nav = start();
    nav.applySetupReport('local', { ok: 3, warning: 1, error: 0 });
    expect($('#ss-setup-dot').hidden).toBe(false);
    expect($('#ss-setup-note').textContent).toBe(', 1 problem');
    expect($('#ss-admin-dot').hidden).toBe(false);
    expect($('#ss-admin-note').textContent).toContain('1 problem');
    // the full run is the better answer once it's in
    nav.applySetupReport('all', { ok: 9, warning: 0, error: 0 });
    expect($('#ss-setup-dot').hidden).toBe(true);
    expect($('#ss-admin-dot').hidden).toBe(true);
    expect($('#ss-admin-note').textContent).toBe('');
  });

  it('a service that is down lights the fold and says so on the Connections row', () => {
    start();
    const status = (detail: unknown) =>
      window.dispatchEvent(new CustomEvent('ss:service-status', { detail }));
    const healthy = {
      metadata_source: { source: 'deezer', connected: true },
      media_server: { type: 'plex', connected: true, configured: true },
      soulseek: { source: 'soulseek', connected: true },
    };
    status(healthy);
    expect($('#ss-connections-word').hidden).toBe(true);
    expect($('#ss-admin-dot').hidden).toBe(true);

    status({ ...healthy, media_server: { type: 'plex', connected: false, configured: true } });
    expect($('#ss-connections-word').hidden).toBe(false);
    expect($('#ss-connections-word').textContent).toBe('Plex is down');
    expect($('#ss-admin-dot').hidden).toBe(false);
    expect($('#ss-admin-note').textContent).toBe(', Plex is down');

    // with a setup problem too, both are in the fold's words
    shell!.applySetupReport('local', { ok: 3, warning: 1, error: 0 });
    expect($('#ss-admin-note').textContent).toBe(', setup check: 1 problem, Plex is down');
    shell!.applySetupReport('local', { ok: 4, warning: 0, error: 0 });

    // a media server that was never set up isn't down (Home says no library is chosen)
    status({ ...healthy, media_server: { type: 'plex', connected: false, configured: false } });
    expect($('#ss-connections-word').hidden).toBe(true);
    expect($('#ss-admin-dot').hidden).toBe(true);
    expect($('#ss-admin-note').textContent).toBe('');

    status({
      ...healthy,
      soulseek: { source: 'soulseek', connected: false },
      metadata_source: { source: 'deezer', connected: false },
    });
    expect($('#ss-connections-word').textContent).toBe('Soulseek and Deezer are down');
  });

  it('keeps the music services off the video side', () => {
    start();
    window.dispatchEvent(
      new CustomEvent('ss:service-status', {
        detail: { media_server: { type: 'plex', connected: false, configured: true } },
      }),
    );
    expect($('#ss-admin-dot').hidden).toBe(false);
    document.body.setAttribute('data-side', 'video');
    shell!.refresh();
    expect($('#ss-admin-dot').hidden).toBe(true);
  });

  it('follows the reports the Setup check page announces', () => {
    start();
    window.dispatchEvent(
      new CustomEvent(SETUP_CHECK_REPORT_EVENT, {
        detail: { scope: 'all', summary: { ok: 5, warning: 0, error: 2 } },
      }),
    );
    expect($('#ss-setup-note').textContent).toBe(', 2 problems');
  });

  it('asks the quick local check once, for admins only', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
        Response.json({ success: true, summary: { ok: 4, warning: 0, error: 1 } }),
      );
      window.SoulSyncWebShellBridge = {
        getCurrentProfileContext: () => ({ profileId: 2, isAdmin: false }),
        isPageAllowed: () => true,
      } as unknown as NonNullable<typeof window.SoulSyncWebShellBridge>;
      start({ autoStart: true, fetchImpl: fetchImpl as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchImpl.mock.calls.map((c) => String(c[0]))).not.toContain(
        '/api/setup/check?scope=local',
      );
      shell!.destroy();
      sessionStorage.clear();
      window.SoulSyncWebShellBridge = {
        getCurrentProfileContext: () => ({ profileId: 1, isAdmin: true }),
        isPageAllowed: () => true,
      } as unknown as NonNullable<typeof window.SoulSyncWebShellBridge>;
      start({ autoStart: true, fetchImpl: fetchImpl as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(10_000);
      const setupCalls = fetchImpl.mock.calls.filter(
        (c) => String(c[0]) === '/api/setup/check?scope=local',
      );
      expect(setupCalls).toHaveLength(1);
      expect($('#ss-setup-dot').hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the activity badges', () => {
  it('unknown: no count, no needs-you badge, no dot', () => {
    const nav = start();
    nav.applyActivityStatus({ running: null, needsYou: null });
    expect($('#ss-running-text').textContent).toBe('Activity');
    expect($('#ss-running').dataset.state).toBe('unknown');
    expect($('#ss-needs-you-badge').hidden).toBe(true);
    expect($('#ss-phone-activity-dot').hidden).toBe(true);
    expect($('#ss-phone-activity').getAttribute('aria-label')).toBe('Activity and notifications');
  });

  it('zero: says nothing is running and shows no badge', () => {
    const nav = start();
    nav.applyActivityStatus({ running: 0, needsYou: 0 });
    expect($('#ss-running-text').textContent).toBe('Nothing running');
    expect($('#ss-running').dataset.state).toBe('idle');
    expect($('#ss-needs-you-badge').hidden).toBe(true);
    expect($('#ss-phone-activity-dot').hidden).toBe(true);
  });

  it('counts: the live link, the warning badge and the phone dot', () => {
    const nav = start();
    nav.applyActivityStatus({ running: 3, needsYou: 2 });
    expect($('#ss-running-text').textContent).toBe('3 running');
    expect($('#ss-running').dataset.state).toBe('live');
    const badge = $('#ss-needs-you-badge');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('2 need you');
    expect(row('activity').textContent).toContain('2');
    expect($('#ss-phone-activity-dot').hidden).toBe(false);
    expect($('#ss-phone-activity').getAttribute('aria-label')).toBe(
      'Activity and notifications, 3 running, 2 need you',
    );
  });

  it('reads the endpoint, and treats a 404 or an error as unknown', async () => {
    const answers: Array<() => Promise<Response>> = [
      async () =>
        Response.json({ success: true, running_count: 4, needs_you_count: 1, generated_at: 1 }),
      async () => new Response('not here', { status: 404 }),
      async () => {
        throw new TypeError('offline');
      },
      async () => Response.json({ success: false, error: "Couldn't load activity" }),
    ];
    const fetchImpl = vi.fn(() => answers.shift()!());
    const nav = start({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await nav.refreshActivityStatus();
    expect(fetchImpl).toHaveBeenCalledWith('/api/activity/status', expect.anything());
    expect($('#ss-running-text').textContent).toBe('4 running');
    expect($('#ss-needs-you-badge').hidden).toBe(false);
    for (let i = 0; i < 3; i++) {
      await nav.refreshActivityStatus();
      expect($('#ss-running-text').textContent).toBe('Activity');
      expect($('#ss-needs-you-badge').hidden).toBe(true);
    }
  });

  it('polls gently, pauses while the tab is hidden, backs off from a 404', async () => {
    vi.useFakeTimers();
    try {
      let status = 200;
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
        status === 200
          ? Response.json({ success: true, running_count: 1, needs_you_count: 0 })
          : new Response('', { status }),
      );
      window.SoulSyncWebShellBridge = {
        getCurrentProfileContext: () => ({ profileId: 2, isAdmin: false }),
        isPageAllowed: () => true,
      } as unknown as NonNullable<typeof window.SoulSyncWebShellBridge>;
      start({ autoStart: true, fetchImpl: fetchImpl as unknown as typeof fetch });
      const calls = () =>
        fetchImpl.mock.calls.filter((c) => String(c[0]) === '/api/activity/status').length;
      await vi.advanceTimersByTimeAsync(0);
      expect(calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls()).toBe(2);

      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(calls()).toBe(2);
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls()).toBe(3);

      status = 404;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls()).toBe(4);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls()).toBe(4);
      await vi.advanceTimersByTimeAsync(ACTIVITY_MISSING_POLL_MS);
      expect(calls()).toBe(5);
    } finally {
      Reflect.deleteProperty(document, 'hidden');
      vi.useRealTimers();
    }
  });

  it("refreshes soon after the app's activity socket events", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
        Response.json({ success: true, running_count: 0, needs_you_count: 0 }),
      );
      window.SoulSyncWebShellBridge = {
        getCurrentProfileContext: () => ({ profileId: 2, isAdmin: false }),
        isPageAllowed: () => true,
      } as unknown as NonNullable<typeof window.SoulSyncWebShellBridge>;
      start({ autoStart: true, fetchImpl: fetchImpl as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(0);
      const calls = () =>
        fetchImpl.mock.calls.filter((c) => String(c[0]) === '/api/activity/status').length;
      expect(calls()).toBe(1);
      window.dispatchEvent(new CustomEvent('ss:automation-progress', { detail: {} }));
      window.dispatchEvent(new CustomEvent('ss:dashboard-activity', { detail: {} }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('phones: no floating buttons (HANDOFF 25)', () => {
  const unread = (count: number) =>
    window.dispatchEvent(new CustomEvent('ss:notifications-unread', { detail: { count } }));

  afterEach(() => {
    delete window.toggleNotifPanel;
    delete window.openHelperMenu;
    delete window.ServerActivity;
    document.getElementById('notif-panel')?.remove();
  });

  /** downloads.js's panel, as far as the shell sees it: a div and two events. */
  function fakePanel() {
    let panel: HTMLElement | null = null;
    const toggle = vi.fn((anchor?: Element | null) => {
      if (panel) {
        const closing = panel;
        panel.remove();
        panel = null;
        window.dispatchEvent(
          new CustomEvent('ss:notif-panel', { detail: { open: false, panel: closing } }),
        );
        return;
      }
      panel = document.createElement('div');
      panel.id = 'notif-panel';
      panel.innerHTML = '<div class="notif-panel-header">Notifications</div>';
      document.body.append(panel);
      window.dispatchEvent(new CustomEvent('ss:notif-panel', { detail: { open: true, panel } }));
      return anchor;
    });
    window.toggleNotifPanel = toggle;
    return { toggle, panel: () => panel };
  }

  it('the Activity icon carries the notifications: one dot for either, in words too', () => {
    const nav = start();
    nav.applyActivityStatus({ running: 0, needsYou: 0 });
    expect($('#ss-phone-activity-dot').hidden).toBe(true);
    unread(3);
    expect($('#ss-phone-activity-dot').hidden).toBe(false);
    expect($('#ss-phone-activity').getAttribute('aria-label')).toBe(
      'Activity and notifications, 3 new notifications',
    );
    unread(0);
    expect($('#ss-phone-activity-dot').hidden).toBe(true);
    nav.applyActivityStatus({ running: 1, needsYou: 1 });
    expect($('#ss-phone-activity-dot').hidden).toBe(false);
  });

  it('opens the notifications, with Activity at the top of them', () => {
    phone(true);
    const { toggle, panel } = fakePanel();
    const nav = start();
    nav.applyActivityStatus({ running: 2, needsYou: 1 });
    const button = $<HTMLButtonElement>('#ss-phone-activity');
    button.click();
    expect(toggle).toHaveBeenCalledWith(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe('notif-panel');
    const link = panel()!.querySelector<HTMLAnchorElement>('.ss-notif-links a')!;
    expect(link.getAttribute('href')).toBe(NAV_TARGETS.activity.path);
    expect(link.textContent).toContain('Activity');
    expect(link.textContent).toContain('2 running · 1 needs you');
    // it's first, before the notifications' own header
    expect(panel()!.firstElementChild?.classList.contains('ss-notif-links')).toBe(true);

    // Activity: the panel closes and the page opens
    const navigateToPage = vi.fn();
    window.navigateToPage = navigateToPage as unknown as typeof window.navigateToPage;
    link.click();
    expect(navigateToPage).toHaveBeenCalledWith(NAV_TARGETS.activity.pageId);
    expect(panel()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    delete window.navigateToPage;
  });

  it('offers Server activity there while the media server reports live streams', () => {
    phone(true);
    const { panel } = fakePanel();
    const streams = document.createElement('button');
    streams.id = 'activity-float-btn';
    document.body.append(streams);
    const serverActivity = { toggle: vi.fn() };
    window.ServerActivity = serverActivity as unknown as typeof window.ServerActivity;
    start();
    $<HTMLButtonElement>('#ss-phone-activity').click();
    const rows = [...panel()!.querySelectorAll('.ss-notif-link')].map((el) => el.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('Server activity');
    panel()!.querySelectorAll<HTMLElement>('.ss-notif-link')[1].click();
    expect(serverActivity.toggle).toHaveBeenCalled();
    streams.remove();
  });

  it('Escape closes the panel and goes back to the icon', () => {
    phone(true);
    const { panel } = fakePanel();
    start();
    $<HTMLButtonElement>('#ss-phone-activity').click();
    expect(panel()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe($('#ss-phone-activity'));
  });

  it('leaves the bell alone on wide screens: no Activity row in its panel', () => {
    phone(false);
    const { toggle, panel } = fakePanel();
    start();
    toggle(null);
    expect(panel()!.querySelector('.ss-notif-links')).toBeNull();
  });

  it("the Settings sheet's Help row opens the help menu instead of the Help page", () => {
    phone(true);
    const openHelperMenu = vi.fn();
    window.openHelperMenu = openHelperMenu;
    const nav = start();
    nav.openSheet('settings', tab('settings'));
    const help = row('help');
    const pressed = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    const reached = vi.fn();
    document.addEventListener('pointerdown', reached, true);
    help.dispatchEvent(pressed);
    document.removeEventListener('pointerdown', reached, true);
    // the shell bridge navigates a mouse press on pointerdown: it never hears this one
    expect(reached).not.toHaveBeenCalled();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    help.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openHelperMenu).toHaveBeenCalledWith(null);
    expect(document.documentElement.hasAttribute('data-sheet')).toBe(false);
  });

  it('keeps the Help row a link on wide screens', () => {
    phone(false);
    const openHelperMenu = vi.fn();
    window.openHelperMenu = openHelperMenu;
    start();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    row('help').dispatchEvent(click);
    expect(openHelperMenu).not.toHaveBeenCalled();
  });
});

describe('the search field', () => {
  it('⌘K and Ctrl K focus it from anywhere', () => {
    start();
    const input = $<HTMLInputElement>('#ss-search-input');
    const meta = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(meta);
    expect(document.activeElement).toBe(input);
    expect(meta.defaultPrevented).toBe(true);
    input.blur();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(input);
  });

  it('says which shortcut this keyboard has', () => {
    start();
    expect(['⌘K', 'Ctrl K']).toContain($('#ss-search-kbd').textContent);
  });

  it('Enter opens Search with the query', async () => {
    const navigateToPage = vi.fn();
    window.navigateToPage = navigateToPage;
    const pageInput = document.createElement('input');
    pageInput.id = 'enhanced-search-input';
    const typed: string[] = [];
    pageInput.addEventListener('input', () => typed.push(pageInput.value));
    document.body.append(pageInput);
    start();
    const input = $<HTMLInputElement>('#ss-search-input');
    input.value = 'aphex twin';
    $<HTMLFormElement>('#ss-search').requestSubmit();
    expect(navigateToPage).toHaveBeenCalledWith('search');
    await Promise.resolve();
    await Promise.resolve();
    expect(typed).toEqual(['aphex twin']);
    expect(document.activeElement).toBe(pageInput);
    expect(input.value).toBe('');
  });

  it('on a phone ⌘K goes to the Search page itself', () => {
    phone(true);
    const navigateToPage = vi.fn();
    window.navigateToPage = navigateToPage;
    start();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(navigateToPage).toHaveBeenCalledWith('search');
  });
});

describe('back and forward', () => {
  it('follow browser history, disabled where there is nowhere to go', () => {
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: Object.assign(new EventTarget(), { canGoBack: true, canGoForward: false }),
    });
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const forward = vi.spyOn(window.history, 'forward').mockImplementation(() => {});
    start();
    expect($('#ss-back').hasAttribute('aria-disabled')).toBe(false);
    expect($('#ss-forward').getAttribute('aria-disabled')).toBe('true');
    $('#ss-back').click();
    $('#ss-forward').click();
    expect(back).toHaveBeenCalledTimes(1);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('the phone tab bar and its sheets', () => {
  beforeEach(() => {
    phone(true);
  });

  it('a group tab opens its sheet; tapping it again closes it', () => {
    start();
    const getMusic = tab('get-music');
    getMusic.click();
    expect(document.documentElement.getAttribute('data-sheet')).toBe('get-music');
    expect(getMusic.getAttribute('aria-expanded')).toBe('true');
    expect(getMusic.getAttribute('aria-controls')).toBe('app-sidebar');
    expect(document.body.classList.contains('mobile-nav-open')).toBe(true);
    expect($('#ss-sheet-title').textContent).toBe('Get music');
    expect($('#ss-sheet-catcher').hidden).toBe(false);
    expect($('#app-sidebar').contains(document.activeElement)).toBe(true);
    getMusic.click();
    expect(document.documentElement.hasAttribute('data-sheet')).toBe(false);
    expect(getMusic.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.classList.contains('mobile-nav-open')).toBe(false);
  });

  it('another tab swaps the sheet', () => {
    start();
    tab('get-music').click();
    tab('library').click();
    expect(document.documentElement.getAttribute('data-sheet')).toBe('library');
    expect(tab('get-music').getAttribute('aria-expanded')).toBe('false');
    expect(tab('library').getAttribute('aria-expanded')).toBe('true');
  });

  it('Escape closes the sheet and puts focus back on its tab', () => {
    start();
    const library = tab('library');
    library.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.documentElement.hasAttribute('data-sheet')).toBe(false);
    expect(document.activeElement).toBe(library);
  });

  it('a tap outside the sheet closes it', () => {
    start();
    tab('automate').click();
    $('#ss-sheet-catcher').click();
    expect(document.documentElement.hasAttribute('data-sheet')).toBe(false);
  });

  it('choosing a page closes the sheet; unfolding Admin and help does not', () => {
    start();
    tab('settings').click();
    $('#ss-admin-toggle').click();
    expect(document.documentElement.getAttribute('data-sheet')).toBe('settings');
    expect(document.documentElement.getAttribute('data-admin-open')).toBe('true');
    row('settings').addEventListener('click', (e) => e.preventDefault());
    row('settings').click();
    expect(document.documentElement.hasAttribute('data-sheet')).toBe(false);
  });

  it('the Settings sheet ends with Admin and help, the Video switch and the profile', () => {
    start();
    const bottom = $('#app-sidebar .ss-nav-bottom');
    const order = [...bottom.children].map((el) => el.id || el.className.split(' ')[0]);
    expect(order).toEqual(['ss-admin', 'side-toggle', 'profile-indicator']);
    expect(bottom.querySelector('[data-side-target="video"]')?.textContent).toContain(
      'Switch to Video',
    );
  });

  it('leaving the phone layout closes an open sheet', () => {
    const listeners = phone(true);
    start();
    tab('library').click();
    listeners.forEach((fn) => fn());
    expect(document.documentElement.hasAttribute('data-sheet')).toBe(false);
  });

  it('there is no "More" tab', () => {
    start();
    const tabs = [...document.querySelectorAll('#ss-tabbar .ss-tab')].map(
      (el) => (el as HTMLElement).dataset.tab,
    );
    expect([...new Set(tabs)]).toEqual(['home', 'get-music', 'library', 'automate', 'settings']);
  });
});

describe('the markup', () => {
  it('is one nav landmark with real links and buttons', () => {
    start();
    const nav = $('#app-sidebar');
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('Main');
    for (const el of nav.querySelectorAll('[data-nav-row]')) {
      expect(el.tagName).toBe('A');
      expect(el.getAttribute('href')).toMatch(/^\//);
    }
    for (const el of document.querySelectorAll('#ss-tabbar .ss-tab, #ss-topbar .ss-icon-btn')) {
      expect(['A', 'BUTTON']).toContain(el.tagName);
    }
  });

  it('keeps the groups and rows in the order the board and the route map give', () => {
    const rows = [...document.querySelectorAll('#app-sidebar .ss-music-nav [data-nav-row]')].map(
      (el) => (el as HTMLElement).dataset.navRow,
    );
    expect(rows).toEqual([
      'home',
      'search',
      'discover',
      'wanted',
      'mirrored',
      'radio',
      'explorer',
      'chat',
      'artists',
      'albums',
      'import',
      'stats',
      'podcasts',
      'audiobooks',
      'sample-studio',
      'automations',
      'activity',
      'settings',
    ]);
    const admin = [...document.querySelectorAll('#ss-admin-panel [data-nav-row]')].map(
      (el) => (el as HTMLElement).dataset.navRow,
    );
    expect(admin).toEqual(['setup-check', 'hydrabase', 'maintenance', 'issues', 'help']);
  });

  it('pins three rows at the foot: Admin and help, the side switch and the profile', () => {
    const bottom = $('#app-sidebar .ss-nav-bottom');
    const pinned = [...bottom.children].map((el) => el.id || el.className);
    expect(pinned).toEqual(['ss-admin', 'side-toggle', 'profile-indicator']);
    // the profile row is the avatar and name alone; its menu has the rest
    const profile = $('#profile-indicator');
    expect(profile.querySelectorAll('button')).toHaveLength(1);
    expect(profile.querySelector('#profile-indicator-avatar')).not.toBeNull();
    expect(profile.querySelector('#profile-indicator-name')).not.toBeNull();
    // Connections, What's new and Support live in Admin and help only
    const panel = $('#ss-admin-panel');
    expect(panel.querySelector('.ss-connections')).not.toBeNull();
    expect(panel.querySelector('.ss-version-row')).not.toBeNull();
    expect(panel.textContent).toContain('Support SoulSync');
    expect(bottom.querySelectorAll('.ss-connections')).toHaveLength(
      panel.querySelectorAll('.ss-connections').length,
    );
  });

  it('names the app SYNCHRO.S, with SS on the rail', () => {
    expect($('.ss-wordmark-name').textContent).toBe('SYNCHRO.S');
    expect($('.ss-wordmark-name').getAttribute('aria-label')).toBe('SYNCHRO.S');
    expect($('.ss-monogram').textContent).toBe('SS');
    expect(html).not.toContain('Sync.FM');
  });
});
