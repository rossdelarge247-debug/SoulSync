/**
 * The navigation shell (Shell A): the sidebar and its compact rail, the top
 * bar, and the phone tab bar with its bottom sheets. The markup is static in
 * webui/index.html (so it paints before any script runs); this module wires
 * it up. The route map and the badge readers are in nav-routes.ts, the look
 * in static/shell.css.
 *
 * What it owns:
 * - compact mode (the 72px rail), toggled from the wordmark / monogram and
 *   kept in localStorage under the old collapse toggle's key;
 * - the "Admin and help" fold (localStorage) and, on the rail, its popover;
 * - which row is current (aria-current="page"), from the shell bridge's
 *   setActivePageChrome and from the React router's location;
 * - the top bar: back / forward through browser history, the page name, the
 *   one search field (⌘K / Ctrl K), the live "N running" link;
 * - the phone tab bar: a group's tab opens its rows as a bottom sheet, which
 *   is the sidebar itself, filtered by CSS;
 * - the badges this shell adds: Activity's needs-you count and the running
 *   count (GET /api/activity/status, polled gently), and the Setup check dot
 *   (the setup check's own report).
 *
 * The legacy badges (Wanted, Discover, Chat, Issues, Requests) keep their
 * ids and their owners; this only reads them for the rail's labels.
 */

import type { ShellPageId } from '@/platform/shell/route-manifest';

import { MODULES_CHANGED_EVENT } from '@/features/modules/modules.helpers';

import {
  activityLabel,
  COUNT_NOUNS,
  countedLabel,
  NAV_GROUPS,
  NAV_TARGETS,
  navGroupFor,
  navRowFor,
  pageTitle,
  parseActivityStatus,
  runningCopy,
  setupProblemCount,
  setupProblemText,
  shortcutHint,
  UNKNOWN_ACTIVITY,
  videoPageTitle,
  type ActivityStatus,
  type NavGroupKey,
  type NavTargetKey,
} from './nav-routes';

/** Shared with the <head> script in index.html, which applies both before paint. */
export const COMPACT_KEY = 'sidebarCollapsed';
export const ADMIN_OPEN_KEY = 'ssNavAdminOpen';
/** The app's mobile layout switch (tokens.css); phones get the tab bar. */
export const PHONE_QUERY = '(max-width: 768px)';

export const ACTIVITY_STATUS_URL = '/api/activity/status';
export const ACTIVITY_POLL_MS = 30_000;
/** While the endpoint isn't there (404) there's no point asking every 30s. */
export const ACTIVITY_MISSING_POLL_MS = 5 * 60_000;
/** Socket-driven refreshes are coalesced to at most one per this long. */
export const ACTIVITY_EVENT_MIN_GAP_MS = 5_000;

export const SETUP_CHECK_URL = '/api/setup/check?scope=local';
/** The setup check page announces every report it gets (setup-check.api.ts). */
export const SETUP_CHECK_REPORT_EVENT = 'ss:setup-check-report';
const SETUP_CACHE_KEY = 'ssNavSetupCheck';
const SETUP_CACHE_MS = 10 * 60_000;
const SETUP_FIRST_DELAY_MS = 4_000;

/** The React router announces every location change (route-controllers ShellLocationReporter). */
export const SHELL_LOCATION_EVENT = 'ss:shell-location';
const PROFILE_CHANGED_EVENT = 'ss:webui-profile-context-changed';
const BRIDGE_READY_EVENT = 'ss:webui-shell-bridge-ready';
/** window events the app re-broadcasts from its socket that mean "activity changed". */
const ACTIVITY_SOCKET_EVENTS = ['ss:dashboard-activity', 'ss:automation-progress'] as const;

const SEARCH_PLACEHOLDER = {
  music: 'Search music, artists, playlists',
  video: 'Search movies, shows and YouTube',
} as const;

export interface NavShellOptions {
  doc?: Document;
  fetchImpl?: typeof fetch;
  /** Poll and fetch on their own. Off in tests that drive the shell by hand. */
  autoStart?: boolean;
}

export interface NavShell {
  /** Light the row for a page (the shell bridge's setActivePageChrome calls this). */
  markActive(pageId?: string | null): void;
  /** Re-read the DOM: rail labels, tab bar, page name. */
  refresh(): void;
  isCompact(): boolean;
  setCompact(on: boolean): void;
  toggleCompact(): void;
  isAdminOpen(): boolean;
  setAdminOpen(open: boolean): void;
  openSheet(group: NavGroupKey, opener?: HTMLElement | null): void;
  closeSheet(restoreFocus?: boolean): void;
  /** Go to Search (music, or Video's on the video side) with this query. */
  openSearch(query: string): void;
  /** The top bar's page name; null goes back to the current row's label. */
  setPageName(name: string | null): void;
  applyActivityStatus(status: ActivityStatus): void;
  refreshActivityStatus(): Promise<void>;
  applySetupReport(scope: string, summary: unknown): void;
  destroy(): void;
}

// ── small helpers ────────────────────────────────────────────────────────────

function writeStore(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice holds for this visit */
  }
}

function stripBase(pathname: string): string {
  return window.SoulSyncURL?.strip?.(pathname) ?? pathname;
}

/** A page id from a path, before the React router is up to ask. */
export function pageIdFromPath(pathname: string): string {
  const seg = stripBase(pathname).replace(/^\/+/, '').split('/')[0] ?? '';
  return seg || 'dashboard';
}

function isVisible(el: Element | null, view: Window): boolean {
  if (!el) return false;
  if ((el as HTMLElement).hidden) return false;
  return view.getComputedStyle(el).display !== 'none';
}

/** Shown, counting every ancestor up to (and including) root. */
function isShown(el: Element, root: Element, view: Window): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (!isVisible(node, view)) return false;
    if (node === root) return true;
  }
  return true;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), [role="button"][tabindex], input, [tabindex="0"]';

function firstFocusable(root: Element, view: Window): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (isShown(el, root, view)) return el;
  }
  return null;
}

function setOwnedAttr(el: Element, name: string, value: string | null): void {
  const mark = `data-ss-${name}`;
  if (value === null) {
    if (el.hasAttribute(mark)) {
      el.removeAttribute(name);
      el.removeAttribute(mark);
    }
    return;
  }
  // never overwrite a name someone else set (init.js names the profile button)
  if (el.hasAttribute(name) && !el.hasAttribute(mark)) return;
  el.setAttribute(name, value);
  el.setAttribute(mark, '');
}

function badgeCount(badge: Element | null): string | null {
  if (!badge || badge.classList.contains('hidden') || (badge as HTMLElement).hidden) return null;
  const value = (badge as HTMLElement).dataset.count ?? badge.textContent ?? '';
  const text = value.trim();
  return text && text !== '0' ? text : null;
}

function countNoun(row: string | undefined, count: string): string {
  const noun = (row && COUNT_NOUNS[row]) ?? '';
  return noun === 'need you' && count === '1' ? 'needs you' : noun;
}

function srSpan(doc: Document, text: string): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = 'ss-sr';
  span.textContent = text;
  return span;
}

// ── the shell ────────────────────────────────────────────────────────────────

export function initNavShell(options: NavShellOptions = {}): NavShell | null {
  const doc = options.doc ?? document;
  const view = doc.defaultView ?? window;
  const html = doc.documentElement;
  const sidebar = doc.getElementById('app-sidebar');
  if (!sidebar) return null;
  const fetchImpl =
    options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => view.fetch(...args));
  const autoStart = options.autoStart ?? true;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T | null;
  const wordmark = $<HTMLButtonElement>('sidebar-collapse-toggle');
  const admin = $('ss-admin');
  const adminToggle = $<HTMLButtonElement>('ss-admin-toggle');
  const adminPanel = $('ss-admin-panel');
  const adminDot = $('ss-admin-dot');
  const adminNote = $('ss-admin-note');
  const setupDot = $('ss-setup-dot');
  const setupNote = $('ss-setup-note');
  const needsYouBadge = $('ss-needs-you-badge');
  const pageName = $('ss-page-name');
  const back = $<HTMLButtonElement>('ss-back');
  const forward = $<HTMLButtonElement>('ss-forward');
  const searchForm = $<HTMLFormElement>('ss-search');
  const searchInput = $<HTMLInputElement>('ss-search-input');
  const searchKbd = $('ss-search-kbd');
  const running = $<HTMLAnchorElement>('ss-running');
  const runningText = $('ss-running-text');
  const phoneSearch = $<HTMLButtonElement>('ss-phone-search');
  const phoneActivity = $<HTMLAnchorElement>('ss-phone-activity');
  const phoneActivityDot = $('ss-phone-activity-dot');
  const tabbar = $('ss-tabbar');
  const sheetTitle = $('ss-sheet-title');
  const catcher = $('ss-sheet-catcher');

  const cleanups: Array<() => void> = [];
  const on = <K extends string>(
    target: EventTarget | null | undefined,
    type: K,
    handler: (event: Event) => void,
    opts?: AddEventListenerOptions | boolean,
  ) => {
    if (!target) return;
    target.addEventListener(type, handler, opts);
    cleanups.push(() => target.removeEventListener(type, handler, opts));
  };

  const phoneQuery = view.matchMedia?.(PHONE_QUERY) ?? null;
  const isPhone = () => !!phoneQuery?.matches;
  const side = () => (doc.body?.getAttribute('data-side') === 'video' ? 'video' : 'music');

  let observer: MutationObserver | null = null;
  let activePage: string | null = pageIdFromPath(view.location.pathname);
  let pageNameOverride: string | null = null;
  let popoverOpen = false;
  let sheet: NavGroupKey | null = null;
  let sheetOpener: HTMLElement | null = null;
  const setupReports: Record<string, unknown> = {};

  // ── targets: Wanted and Activity point where NAV_TARGETS says ─────────────
  function applyTargets(): void {
    for (const key of Object.keys(NAV_TARGETS) as NavTargetKey[]) {
      const target = NAV_TARGETS[key];
      for (const row of doc.querySelectorAll<HTMLAnchorElement>(`[data-nav-row="${key}"]`)) {
        row.setAttribute('href', target.path);
        row.setAttribute('data-page', target.pageId);
      }
      for (const link of doc.querySelectorAll<HTMLAnchorElement>(`[data-nav-target="${key}"]`)) {
        link.setAttribute('href', target.path);
      }
    }
  }

  // ── current row ───────────────────────────────────────────────────────────
  function markActive(pageId: string | null = activePage): void {
    if (pageId !== activePage) pageNameOverride = null;
    activePage = pageId;
    const search = view.location.search;
    const row = navRowFor(pageId, search);
    for (const el of doc.querySelectorAll<HTMLElement>('[data-nav-row]')) {
      const current = !!row && el.dataset.navRow === row;
      el.classList.toggle('active', current);
      if (current) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
    // anything else the old chrome lit (the requests count, say) goes dark
    for (const el of doc.querySelectorAll('.nav-button[data-page].active:not([data-nav-row])')) {
      el.classList.remove('active');
      el.removeAttribute('aria-current');
    }
    refresh();
  }

  function currentGroup(): NavGroupKey | null {
    if (side() === 'video') {
      const group = doc
        .querySelector<HTMLElement>('#app-sidebar .video-nav .nav-button.active')
        ?.getAttribute('data-group');
      return (NAV_GROUPS as readonly string[]).includes(group ?? '')
        ? (group as NavGroupKey)
        : null;
    }
    return navGroupFor(activePage, view.location.search);
  }

  // ── page name ─────────────────────────────────────────────────────────────
  function updatePageName(): void {
    if (!pageName) return;
    let text: string;
    if (side() === 'video') {
      const label = doc.querySelector('#app-sidebar .video-nav .nav-button.active .ss-label');
      text = videoPageTitle(
        doc.body?.getAttribute('data-video-page') ?? null,
        label?.textContent?.trim() ?? null,
      );
    } else {
      const label = doc.querySelector(
        '#app-sidebar .ss-music-nav [data-nav-row].active .ss-label, #app-sidebar .ss-admin-panel [data-nav-row].active .ss-label',
      );
      text = pageNameOverride || pageTitle(activePage, label?.textContent?.trim() ?? null);
    }
    if (pageName.textContent !== text) pageName.textContent = text;
  }

  function setPageName(name: string | null): void {
    pageNameOverride = name && name.trim() ? name.trim() : null;
    updatePageName();
  }

  // ── compact rail ──────────────────────────────────────────────────────────
  const isCompact = () => html.getAttribute('data-sidebar') === 'collapsed';
  const isPopoverMode = () => isCompact() && !isPhone();

  function syncWordmark(): void {
    if (!wordmark) return;
    const compact = isCompact();
    const label = compact ? 'Expand navigation' : 'Collapse navigation';
    wordmark.setAttribute('aria-label', label);
    wordmark.title = label;
    wordmark.setAttribute('aria-expanded', compact ? 'false' : 'true');
  }

  /** On the rail, each row says its name (and count) in title + aria-label. */
  function syncRailLabels(): void {
    const rail = isCompact() && !isPhone();
    const rows = sidebar!.querySelectorAll<HTMLElement>(
      '.ss-music-nav .ss-item, .video-nav .ss-item, .ss-nav-bottom > .side-toggle .ss-item, #ss-admin-toggle, #profile-indicator-button',
    );
    for (const el of rows) {
      if (!rail) {
        setOwnedAttr(el, 'title', null);
        setOwnedAttr(el, 'aria-label', null);
        continue;
      }
      const label = el.querySelector('.ss-label')?.textContent?.trim() ?? '';
      if (!label) continue;
      const row = el.dataset.navRow;
      const badge = el.querySelector(':scope > .ss-badge');
      const count = badgeCount(badge);
      const noun = count ? countNoun(row, count) : '';
      setOwnedAttr(el, 'title', countedLabel(label, count, noun, ' · '));
      // the toggle and the profile button keep the names their text gives them
      if (el.id !== 'ss-admin-toggle' && el.id !== 'profile-indicator-button') {
        setOwnedAttr(el, 'aria-label', countedLabel(label, count, noun));
      }
    }
  }

  function setCompact(compact: boolean): void {
    if (compact) html.setAttribute('data-sidebar', 'collapsed');
    else html.removeAttribute('data-sidebar');
    writeStore(COMPACT_KEY, compact ? '1' : null);
    closePopover(false);
    syncWordmark();
    syncAdmin();
    syncRailLabels();
  }

  // ── Admin and help ────────────────────────────────────────────────────────
  const isAdminOpen = () => html.getAttribute('data-admin-open') === 'true';

  function syncAdmin(): void {
    if (!adminToggle) return;
    const expanded = isPopoverMode() ? popoverOpen : isAdminOpen();
    adminToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function setAdminOpen(open: boolean): void {
    if (open) html.setAttribute('data-admin-open', 'true');
    else html.removeAttribute('data-admin-open');
    writeStore(ADMIN_OPEN_KEY, open ? '1' : null);
    syncAdmin();
  }

  function openPopover(): void {
    if (!admin || !adminPanel) return;
    popoverOpen = true;
    admin.classList.add('is-popover-open');
    syncAdmin();
    firstFocusable(adminPanel, view)?.focus();
  }

  function closePopover(restoreFocus: boolean): void {
    if (!popoverOpen) return;
    popoverOpen = false;
    admin?.classList.remove('is-popover-open');
    syncAdmin();
    if (restoreFocus) adminToggle?.focus();
  }

  function onAdminToggle(): void {
    if (isPopoverMode()) {
      if (popoverOpen) closePopover(false);
      else openPopover();
      return;
    }
    setAdminOpen(!isAdminOpen());
  }

  // ── phone sheets ──────────────────────────────────────────────────────────
  function tabs(): HTMLElement[] {
    return tabbar ? [...tabbar.querySelectorAll<HTMLElement>('button.ss-tab[data-tab]')] : [];
  }

  function tabLabel(tab: HTMLElement): string {
    for (const label of tab.querySelectorAll('.ss-tab-label')) {
      if (isVisible(label, view)) return label.textContent?.trim() ?? '';
    }
    return tab.querySelector('.ss-tab-label')?.textContent?.trim() ?? '';
  }

  function openSheet(group: NavGroupKey, opener: HTMLElement | null = null): void {
    closePopover(false);
    sheet = group;
    sheetOpener = opener;
    html.setAttribute('data-sheet', group);
    doc.body?.classList.add('mobile-nav-open');
    if (catcher) catcher.hidden = false;
    for (const tab of tabs()) {
      tab.setAttribute('aria-expanded', tab.dataset.tab === group ? 'true' : 'false');
    }
    const tab = tabs().find((t) => t.dataset.tab === group);
    if (sheetTitle) sheetTitle.textContent = tab ? tabLabel(tab) : '';
    firstFocusable(sidebar!, view)?.focus();
  }

  function closeSheet(restoreFocus = false): void {
    if (!sheet) return;
    sheet = null;
    html.removeAttribute('data-sheet');
    doc.body?.classList.remove('mobile-nav-open');
    if (catcher) catcher.hidden = true;
    for (const tab of tabs()) tab.setAttribute('aria-expanded', 'false');
    const opener = sheetOpener;
    sheetOpener = null;
    if (restoreFocus) opener?.focus();
  }

  /** A group's tab hides when the profile can't open anything in it. */
  function syncTabs(): void {
    const group = currentGroup();
    const video = side() === 'video';
    for (const tab of tabs()) {
      const key = tab.dataset.tab as NavGroupKey;
      if (key === group) tab.setAttribute('aria-current', 'true');
      else tab.removeAttribute('aria-current');
      if (key === 'settings') continue; // ends with Admin and help and the profile
      const rows = video
        ? sidebar!.querySelectorAll(`.video-nav .ss-item[data-group="${key}"]`)
        : sidebar!.querySelectorAll(`.ss-music-nav .ss-group[data-group="${key}"] .nav-button`);
      const any = [...rows].some((row) => isVisible(row, view));
      tab.hidden = !any;
      if (!any && sheet === key) closeSheet(false);
    }
  }

  // ── the search field ──────────────────────────────────────────────────────
  function waitFor<T extends Element>(selector: string, timeoutMs = 3000): Promise<T | null> {
    const found = doc.querySelector<T>(selector);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const el = doc.querySelector<T>(selector);
        if (el || Date.now() - started > timeoutMs) {
          resolve(el);
          return;
        }
        view.setTimeout(tick, 50);
      };
      view.setTimeout(tick, 50);
    });
  }

  function handOver(input: HTMLInputElement | null, query: string): void {
    if (!input) return;
    if (query) {
      // the search page's input is controlled; it honours a native input event
      // (search-page.tsx), the same handoff the old global widget used
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.focus();
  }

  function openSearch(query: string): void {
    const q = query.trim();
    closeSheet(false);
    if (side() === 'video') {
      doc.dispatchEvent(new CustomEvent('soulsync:video-navigate', { detail: 'video-search' }));
      void waitFor<HTMLInputElement>('[data-video-search-input]').then((input) =>
        handOver(input, q),
      );
      return;
    }
    if (typeof view.navigateToPage === 'function') {
      void view.navigateToPage('search');
    } else {
      view.location.assign(`/search`);
      return;
    }
    void waitFor<HTMLInputElement>('#enhanced-search-input').then((input) => handOver(input, q));
  }

  function syncSearchField(): void {
    if (!searchInput) return;
    const placeholder = SEARCH_PLACEHOLDER[side()];
    if (searchInput.placeholder !== placeholder) {
      searchInput.placeholder = placeholder;
      searchInput.setAttribute('aria-label', placeholder);
    }
  }

  // ── back / forward ────────────────────────────────────────────────────────
  type NavigationLike = { canGoBack?: boolean; canGoForward?: boolean };
  const navigationApi = () => (view as unknown as { navigation?: NavigationLike }).navigation;

  function setDisabled(button: HTMLButtonElement | null, disabled: boolean): void {
    if (!button) return;
    if (disabled) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }

  function syncHistoryButtons(): void {
    const nav = navigationApi();
    if (nav && typeof nav.canGoBack === 'boolean') {
      setDisabled(back, !nav.canGoBack);
      setDisabled(forward, !nav.canGoForward);
      return;
    }
    // no Navigation API: only "is there anything to go back to" is knowable
    setDisabled(back, view.history.length <= 1);
    setDisabled(forward, false);
  }

  // ── navigation to a shell page ────────────────────────────────────────────
  function goToPage(pageId: string, path: string, event?: Event): void {
    if (event instanceof MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
    }
    closeSheet(false);
    if (typeof view.navigateToPage === 'function') void view.navigateToPage(pageId);
    else view.location.assign(path);
  }

  function syncTargetVisibility(): void {
    const bridge = view.SoulSyncWebShellBridge;
    const allowed = bridge?.isPageAllowed
      ? bridge.isPageAllowed(NAV_TARGETS.activity.pageId as ShellPageId)
      : true;
    if (running) running.hidden = !allowed;
    if (phoneActivity) phoneActivity.hidden = !allowed;
  }

  // ── badges ────────────────────────────────────────────────────────────────
  function applyActivityStatus(status: ActivityStatus): void {
    const copy = runningCopy(status.running);
    if (running) {
      running.dataset.state = status.running === null ? 'unknown' : copy.live ? 'live' : 'idle';
      running.title = activityLabel(status);
    }
    if (runningText && runningText.textContent !== copy.text) runningText.textContent = copy.text;
    if (needsYouBadge) {
      const n = status.needsYou ?? 0;
      needsYouBadge.hidden = n <= 0;
      needsYouBadge.dataset.count = n > 0 ? String(n) : '';
      needsYouBadge.replaceChildren(
        ...(n > 0 ? [String(n), srSpan(doc, ` need${n === 1 ? 's' : ''} you`)] : []),
      );
    }
    if (phoneActivityDot) phoneActivityDot.hidden = !(status.needsYou && status.needsYou > 0);
    phoneActivity?.setAttribute('aria-label', activityLabel(status));
    syncRailLabels();
  }

  let pollTimer: number | null = null;
  let pollMs = ACTIVITY_POLL_MS;
  let lastFetch = 0;
  let inFlight: Promise<void> | null = null;
  let eventTimer: number | null = null;
  let polling = false;

  async function fetchActivityStatus(): Promise<void> {
    lastFetch = Date.now();
    try {
      const res = await fetchImpl(ACTIVITY_STATUS_URL, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        pollMs = res.status === 404 ? ACTIVITY_MISSING_POLL_MS : ACTIVITY_POLL_MS;
        applyActivityStatus(UNKNOWN_ACTIVITY);
        return;
      }
      pollMs = ACTIVITY_POLL_MS;
      applyActivityStatus(parseActivityStatus(await res.json()));
    } catch {
      applyActivityStatus(UNKNOWN_ACTIVITY);
    }
  }

  function refreshActivityStatus(): Promise<void> {
    inFlight ??= fetchActivityStatus().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function schedulePoll(): void {
    if (!polling) return;
    if (pollTimer !== null) view.clearTimeout(pollTimer);
    pollTimer = view.setTimeout(() => {
      pollTimer = null;
      // paused while the tab is hidden; visibilitychange picks it back up
      if (doc.hidden) return;
      void refreshActivityStatus().then(schedulePoll);
    }, pollMs);
  }

  function startPolling(): void {
    polling = true;
    void refreshActivityStatus().then(schedulePoll);
  }

  function onVisibility(): void {
    if (!polling || doc.hidden) return;
    if (pollTimer === null || Date.now() - lastFetch >= pollMs) {
      void refreshActivityStatus().then(schedulePoll);
    }
  }

  /** Something happened (a socket push): ask soon, at most once per gap. */
  function refreshSoon(): void {
    if (!polling || eventTimer !== null) return;
    const wait = Math.max(0, lastFetch + ACTIVITY_EVENT_MIN_GAP_MS - Date.now());
    eventTimer = view.setTimeout(() => {
      eventTimer = null;
      if (!doc.hidden) void refreshActivityStatus().then(schedulePoll);
    }, wait);
  }

  let lastActiveDownloads: unknown;
  function onServiceStatus(event: Event): void {
    const detail = (event as CustomEvent<{ active_downloads?: unknown }>).detail;
    const value = detail?.active_downloads;
    if (value === undefined || value === lastActiveDownloads) return;
    const first = lastActiveDownloads === undefined;
    lastActiveDownloads = value;
    if (!first) refreshSoon();
  }

  // the Setup check dot
  let setupProblems: number | null = null;
  function applySetupProblem(problems: number | null): void {
    setupProblems = problems;
    const show = problems !== null && problems > 0;
    const text = show ? setupProblemText(problems) : '';
    if (setupDot) setupDot.hidden = !show;
    if (setupNote) setupNote.textContent = show ? `, ${text}` : '';
    syncAdminDot();
  }

  /** The fold's dot speaks for the Setup check row, which is music-side only. */
  function syncAdminDot(): void {
    const show = setupProblems !== null && setupProblems > 0 && side() === 'music';
    const text = show ? `, setup check: ${setupProblemText(setupProblems!)}` : '';
    if (adminDot && adminDot.hidden === show) adminDot.hidden = !show;
    if (adminNote && adminNote.textContent !== text) adminNote.textContent = text;
  }

  function applySetupReport(scope: string, summary: unknown): void {
    setupReports[scope === 'all' ? 'all' : 'local'] = summary;
    applySetupProblem(setupProblemCount(setupReports.all ?? setupReports.local));
  }

  function isAdminProfile(): boolean {
    const ctx = view.SoulSyncWebShellBridge?.getCurrentProfileContext?.() ?? null;
    return !!ctx && (ctx.isAdmin || ctx.profileId === 1);
  }

  let setupTimer: number | null = null;
  let setupAsked = false;
  /** One quick local check per visit, for admins, once things have settled. */
  function scheduleSetupCheck(): void {
    if (setupAsked || setupTimer !== null || !isAdminProfile()) return;
    const ctx = view.SoulSyncWebShellBridge?.getCurrentProfileContext?.();
    const cacheKey = `${SETUP_CACHE_KEY}:${ctx?.profileId ?? ''}`;
    try {
      const cached = JSON.parse(view.sessionStorage.getItem(cacheKey) || 'null') as {
        at: number;
        summary: unknown;
      } | null;
      if (cached && Date.now() - cached.at < SETUP_CACHE_MS) {
        setupAsked = true;
        if (!setupReports.all) applySetupReport('local', cached.summary);
        return;
      }
    } catch {
      /* no cache */
    }
    setupTimer = view.setTimeout(async () => {
      setupTimer = null;
      setupAsked = true;
      try {
        const res = await fetchImpl(SETUP_CHECK_URL, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const body = (await res.json()) as { success?: boolean; summary?: unknown };
        if (body.success === false) return;
        if (!setupReports.all) applySetupReport('local', body.summary);
        try {
          view.sessionStorage.setItem(
            cacheKey,
            JSON.stringify({ at: Date.now(), summary: body.summary }),
          );
        } catch {
          /* fine */
        }
      } catch {
        /* the dot just stays off */
      }
    }, SETUP_FIRST_DELAY_MS);
  }

  function onProfileReady(): void {
    syncTargetVisibility();
    refresh();
    if (!autoStart) return;
    if (!view.SoulSyncWebShellBridge?.getCurrentProfileContext?.()) return;
    if (polling) void refreshActivityStatus();
    else startPolling();
    scheduleSetupCheck();
  }

  // ── refresh: everything derived from the DOM ──────────────────────────────
  let refreshQueued = false;
  function refresh(): void {
    // video rows: video-side.js marks .active; give it the aria-current too
    const video = side() === 'video';
    for (const el of sidebar!.querySelectorAll<HTMLElement>('.video-nav .nav-button')) {
      if (video && el.classList.contains('active')) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
    syncRailLabels();
    syncTabs();
    syncAdminDot();
    syncSearchField();
    updatePageName();
    syncHistoryButtons();
    // what this wrote isn't news: never let a refresh queue another one
    observer?.takeRecords();
  }
  function queueRefresh(): void {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      refresh();
    });
  }

  // ── events ────────────────────────────────────────────────────────────────
  on(wordmark, 'click', () => {
    if (!isPhone()) setCompact(!isCompact());
  });
  on(adminToggle, 'click', onAdminToggle);

  // a choice in the popover or the sheet closes it (the bridge has navigated)
  on(sidebar, 'click', (event) => {
    const target = (event.target as Element | null)?.closest('a[href], button, [role="button"]');
    if (!target) return;
    if (popoverOpen && adminPanel?.contains(target)) closePopover(false);
    if (!sheet) return;
    if (
      target.matches(
        '#ss-admin-toggle, .ss-section-toggle, #profile-indicator-button, #sidebar-weather-line',
      )
    ) {
      return;
    }
    closeSheet(false);
  });

  on(doc, 'click', (event) => {
    if (!popoverOpen) return;
    const target = event.target as Node | null;
    if (target && (adminPanel?.contains(target) || adminToggle?.contains(target))) return;
    closePopover(false);
  });

  on(catcher, 'click', (event) => {
    event.preventDefault();
    closeSheet(false);
  });

  on(tabbar, 'click', (event) => {
    const tab = (event.target as Element | null)?.closest<HTMLElement>('.ss-tab[data-tab]');
    if (!tab) return;
    const key = tab.dataset.tab;
    if (tab.tagName !== 'BUTTON' || !key || key === 'home') {
      closeSheet(false);
      return;
    }
    if (sheet === key) closeSheet(false);
    else openSheet(key as NavGroupKey, tab);
  });

  on(
    doc,
    'keydown',
    (event) => {
      const e = event as KeyboardEvent;
      if (e.key === 'Escape') {
        if (popoverOpen) {
          e.preventDefault();
          closePopover(true);
        } else if (sheet) {
          e.preventDefault();
          closeSheet(true);
        }
        return;
      }
      // ⌘K / Ctrl K: the one search field (helper.js gave up this shortcut)
      if (
        (e.key === 'k' || e.key === 'K') &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!isPhone() && searchInput && isVisible(searchForm, view)) {
          searchInput.focus();
          searchInput.select();
        } else {
          openSearch('');
        }
      }
    },
    true,
  );

  on(searchForm, 'submit', (event) => {
    event.preventDefault();
    const q = searchInput?.value ?? '';
    if (searchInput) {
      searchInput.value = '';
      searchInput.blur();
    }
    openSearch(q);
  });
  on(searchInput, 'keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape' && searchInput) {
      searchInput.value = '';
      searchInput.blur();
    }
  });
  on(phoneSearch, 'click', () => openSearch(''));

  on(back, 'click', () => {
    if (back?.getAttribute('aria-disabled') === 'true') return;
    view.history.back();
  });
  on(forward, 'click', () => {
    if (forward?.getAttribute('aria-disabled') === 'true') return;
    view.history.forward();
  });

  const toActivity = (event: Event) =>
    goToPage(NAV_TARGETS.activity.pageId, NAV_TARGETS.activity.path, event);
  on(running, 'click', toActivity);
  on(phoneActivity, 'click', toActivity);

  // the music Home tab is a .nav-button, the bridge routes it; the video one
  // is wired by video-side.js (data-video-goto)

  on(view, 'popstate', () => {
    const router = view.SoulSyncWebRouter;
    const resolved = router?.resolvePageId?.(stripBase(view.location.pathname));
    markActive(resolved ?? activePage);
  });
  on(view, SHELL_LOCATION_EVENT, () => {
    const router = view.SoulSyncWebRouter;
    const resolved = router?.resolvePageId?.(stripBase(view.location.pathname));
    markActive(resolved ?? activePage);
  });
  on(view, PROFILE_CHANGED_EVENT, onProfileReady);
  on(view, BRIDGE_READY_EVENT, onProfileReady);
  on(view, MODULES_CHANGED_EVENT, queueRefresh);
  on(view, SETUP_CHECK_REPORT_EVENT, (event) => {
    const detail = (event as CustomEvent<{ scope?: string; summary?: unknown }>).detail;
    if (detail) applySetupReport(detail.scope ?? 'local', detail.summary);
  });
  for (const name of ACTIVITY_SOCKET_EVENTS) on(view, name, refreshSoon);
  on(view, 'ss:service-status', onServiceStatus);
  on(doc, 'visibilitychange', onVisibility);
  const navApi = (view as unknown as { navigation?: EventTarget }).navigation;
  on(navApi, 'currententrychange', syncHistoryButtons);

  const onBreakpoint = () => {
    closeSheet(false);
    closePopover(false);
    syncAdmin();
    syncRailLabels();
  };
  if (phoneQuery) {
    phoneQuery.addEventListener?.('change', onBreakpoint);
    cleanups.push(() => phoneQuery.removeEventListener?.('change', onBreakpoint));
  }

  // rows hidden or shown (profile gating, modules, idle requests), badges
  // repainted, the side switched: re-derive the rail labels, tabs and name
  observer = typeof MutationObserver === 'function' ? new MutationObserver(queueRefresh) : null;
  observer?.observe(sidebar, {
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
    childList: true,
    characterData: true,
  });
  if (doc.body) {
    observer?.observe(doc.body, {
      attributes: true,
      attributeFilter: ['data-side', 'data-video-page'],
    });
  }
  cleanups.push(() => observer?.disconnect());

  // ── boot ──────────────────────────────────────────────────────────────────
  if (searchKbd) searchKbd.textContent = shortcutHint(view.navigator?.platform ?? '');
  applyTargets();
  syncWordmark();
  syncAdmin();
  applyActivityStatus(UNKNOWN_ACTIVITY);
  applySetupProblem(null);
  markActive(activePage);
  onProfileReady();

  return {
    markActive,
    refresh,
    isCompact,
    setCompact,
    toggleCompact: () => setCompact(!isCompact()),
    isAdminOpen,
    setAdminOpen,
    openSheet,
    closeSheet,
    openSearch,
    setPageName,
    applyActivityStatus,
    refreshActivityStatus,
    applySetupReport,
    destroy() {
      polling = false;
      if (pollTimer !== null) view.clearTimeout(pollTimer);
      if (eventTimer !== null) view.clearTimeout(eventTimer);
      if (setupTimer !== null) view.clearTimeout(setupTimer);
      while (cleanups.length) cleanups.pop()!();
    },
  };
}

// ── the shell bundle's handle ────────────────────────────────────────────────

let shell: NavShell | null = null;

/** Boot once (src/shell/index.ts) and publish window.SoulSyncShellNav. */
export function bootNavShell(): NavShell | null {
  if (shell) return shell;
  shell = initNavShell();
  if (shell) window.SoulSyncShellNav = shell;
  return shell;
}

/** library-globals' artist page names itself in the top bar. */
export function setShellPageName(name: string | null): void {
  shell?.setPageName(name);
}

/** my-accounts opens a modal from the Settings sheet: the sheet steps aside. */
export function closeShellSheet(): void {
  shell?.closeSheet(false);
}
