import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The guided tour (static/helper.js) after the redesign.
 *
 * Every step anchors to an element some page renders: a stable id in the
 * shell (index.html) or a data-tour attribute on a React page. A step whose
 * anchor isn't on screen is skipped, so an anchor lost in a later rebuild
 * would quietly shorten the tour instead of breaking it; these checks catch
 * that. The rendered side is checked by each page's own tests (home,
 * Wanted, Activity, Automations, Setup check, the Artist page).
 */

const WEBUI = process.cwd();
const HELPER = readFileSync(resolve(WEBUI, 'static/helper.js'), 'utf8');

/** index.html as the browser gets it, with the Jinja tags dropped. */
const SHELL = new DOMParser().parseFromString(
  readFileSync(resolve(WEBUI, 'index.html'), 'utf8')
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, ''),
  'text/html',
);

interface Step {
  page?: string;
  selector?: string;
  phoneSelector?: string;
  title: string;
  description: string;
  phoneTitle?: string;
  phoneDescription?: string;
  phone?: boolean;
  admin?: boolean;
}
interface Tour {
  title: string;
  description: string;
  icon?: string;
  onlyOn?: string;
  steps: Step[];
}
interface Helper {
  HELPER_TOURS: Record<string, Tour>;
  PAGE_TOUR_MAP: Record<string, string>;
  HelperState: { tourId: string | null; tourStep: number; tourSteps: Step[] };
  startTour: (id: string) => void;
  nextTourStep: () => void;
  prevTourStep: () => void;
  dismissTour: () => void;
  _tourStepsFor: (tour: Tour) => Step[];
  _tourStepView: (step: Step) => { selector?: string; title: string; description: string };
  _tourAvailableHere: (tour: Tour) => boolean;
}

/** helper.js is a plain script; run it here and hand back what it declares. */
function loadHelper(): Helper {
  const helper = new Function(
    `${HELPER}\n;return { HELPER_TOURS, PAGE_TOUR_MAP, HelperState, startTour, nextTourStep, prevTourStep, dismissTour, _tourStepsFor, _tourStepView, _tourAvailableHere };`,
  )() as Helper;
  return helper;
}

/** The React source of each page a step can name. */
const PAGE_DIRS: Record<string, string> = {
  dashboard: 'src/routes/dashboard',
  wanted: 'src/routes/wanted',
  activity: 'src/routes/activity',
  search: 'src/routes/search',
  automations: 'src/routes/automations',
  'setup-check': 'src/routes/setup-check',
  'artist-detail': 'src/routes/artist-detail',
};

function sourceOf(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
        out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(resolve(WEBUI, dir));
  return out.join('\n');
}

/** The tours rewritten for the redesign; the older page tours keep tests/test_helper_tours.py. */
const NEW_TOURS = ['welcome', 'search', 'automations', 'artist'];

const g = globalThis as unknown as Record<string, unknown>;
let phone = false;

beforeEach(() => {
  phone = false;
  g.currentPage = 'dashboard';
  g.currentProfile = { id: 1, is_admin: true };
  g.navigateToPage = vi.fn((page: string) => {
    g.currentPage = page;
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: phone && query.includes('768'), media: query })),
  );
});

afterEach(() => {
  delete g.currentPage;
  delete g.currentProfile;
  delete g.navigateToPage;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the tours rewritten for the redesign', () => {
  const { HELPER_TOURS } = loadHelper();

  it('are the welcome tour, Search, Automations and the Artist page', () => {
    for (const id of NEW_TOURS) expect(HELPER_TOURS[id], id).toBeDefined();
    // the old dashboard tour and the old Search and builder tours are gone
    for (const id of ['dashboard', 'first-download']) expect(HELPER_TOURS[id]).toBeUndefined();
  });

  it('anchor every step to the shell or to its own page', () => {
    for (const id of NEW_TOURS) {
      for (const step of HELPER_TOURS[id].steps) {
        for (const selector of [step.selector, step.phoneSelector]) {
          if (!selector) continue;
          if (SHELL.querySelector(selector)) continue; // the sidebar, top bar, tab bar, ? button
          // otherwise a page renders it: its data-tour attribute or id is in that page's source
          expect(step.page, `${id}: ${selector} needs a page`).toBeDefined();
          const source = sourceOf(PAGE_DIRS[step.page!]);
          const tour = /\[data-tour="([\w-]+)"\]/.exec(selector);
          const id_ = /^#([\w-]+)$/.exec(selector);
          expect(tour || id_, `${id}: ${selector} should be a data-tour or an id`).not.toBeNull();
          const needle = tour ? `data-tour="${tour[1]}"` : `id="${id_![1]}"`;
          const ternary = tour ? `'${tour[1]}'` : null; // data-tour={selected ? '…' : undefined}
          expect(
            source.includes(needle) || (ternary !== null && source.includes(ternary)),
            `${id}: nothing on ${step.page} renders ${selector}`,
          ).toBe(true);
        }
      }
    }
  });

  it('cover today’s app in the welcome tour', () => {
    const anchors = HELPER_TOURS.welcome.steps.map((s) => s.selector);
    for (const anchor of [
      '#app-sidebar .ss-music-nav', // Home, Get music, Library, Automate, Settings
      '#sidebar-collapse-toggle', // the compact rail
      '#ss-admin', // Admin and help
      '#ss-search', // ⌘K search
      '#ss-running', // the "N running" link
      '[data-tour="home-targets"]',
      '[data-tour="home-latest"]',
      '[data-tour="wanted-tabs"]',
      '[data-tour="activity-controls"]',
      '#enhanced-search-bar',
      '#app-sidebar [data-nav-row="artists"]', // the one Artist page
      '[data-tour="automation-card"]',
      '[data-tour="automation-preview"]',
      '[data-tour="automation-runs"]',
      '[data-tour="setup-check"]',
    ]) {
      expect(anchors, anchor).toContain(anchor);
    }
    const text = JSON.stringify(HELPER_TOURS.welcome);
    for (const words of ['Get music', 'Library', 'Automate', 'Settings', '⌘K', 'Soulseek']) {
      expect(text).toContain(words);
    }
  });

  it('follow the copy rules: sentence case, SoulSync, no emoji, no Music Dashboard', () => {
    for (const id of NEW_TOURS) {
      const tour = HELPER_TOURS[id];
      const titles = [tour.title, ...tour.steps.flatMap((s) => [s.title, s.phoneTitle ?? ''])];
      for (const title of titles.filter(Boolean)) {
        const rest = title.split(/\s+/).slice(1);
        expect(
          rest.filter((w) => /^[A-Z]/.test(w) && w !== 'SoulSync'),
          `${id}: "${title}" is in sentence case`,
        ).toEqual([]);
      }
      const words = JSON.stringify({ ...tour, icon: undefined });
      expect(words, id).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(words, id).not.toMatch(/Music Dashboard|Soulsync|Sync\.FM|Click /);
    }
  });

  it('give every step a title and a description', () => {
    for (const [id, tour] of Object.entries(HELPER_TOURS)) {
      for (const step of tour.steps) {
        expect(step.title, id).toBeTruthy();
        expect(step.description, `${id}: ${step.title}`).toBeTruthy();
        expect(step.selector, `${id}: ${step.title}`).toBeTruthy();
      }
    }
  });

  it('map each page to a tour that exists', () => {
    const { PAGE_TOUR_MAP } = loadHelper();
    for (const [page, id] of Object.entries(PAGE_TOUR_MAP)) {
      expect(HELPER_TOURS[id], `${page} -> ${id}`).toBeDefined();
    }
    expect(PAGE_TOUR_MAP.dashboard).toBe('welcome');
    expect(PAGE_TOUR_MAP['artist-detail']).toBe('artist');
  });
});

describe('on a phone', () => {
  it('points at the tab bar and the top bar’s icons, and leaves out the compact rail', () => {
    phone = true;
    const helper = loadHelper();
    const steps = helper._tourStepsFor(helper.HELPER_TOURS.welcome);
    expect(steps.map((s) => s.selector)).not.toContain('#sidebar-collapse-toggle');
    const anchors = steps.map((s) => helper._tourStepView(s).selector!);
    for (const anchor of [
      '#ss-tabbar',
      '#ss-tabbar [data-tab="settings"]',
      '#ss-phone-search',
      '#ss-phone-activity',
      '#ss-tabbar [data-tab="library"]',
      '[data-tour="automation-runs-link"]',
    ]) {
      expect(anchors, anchor).toContain(anchor);
    }
    // nothing on a phone points into the sidebar, which is a closed sheet there
    expect(anchors.filter((a) => a.startsWith('#app-sidebar'))).toEqual([]);
    expect(helper._tourStepView(steps[1]).title).toBe('The tab bar');
  });

  it('uses the wide-screen anchors otherwise', () => {
    const helper = loadHelper();
    const steps = helper._tourStepsFor(helper.HELPER_TOURS.welcome);
    expect(steps.map((s) => s.selector)).toContain('#sidebar-collapse-toggle');
    expect(helper._tourStepView(steps[1]).selector).toBe('#app-sidebar .ss-music-nav');
  });
});

describe('who sees which steps', () => {
  it('leaves the Setup check out for a profile that isn’t an admin', () => {
    g.currentProfile = { id: 3, is_admin: false };
    const helper = loadHelper();
    const anchors = helper._tourStepsFor(helper.HELPER_TOURS.welcome).map((s) => s.selector);
    expect(anchors).not.toContain('[data-tour="setup-check"]');
    g.currentProfile = { id: 2, is_admin: true };
    expect(helper._tourStepsFor(helper.HELPER_TOURS.welcome).map((s) => s.selector)).toContain(
      '[data-tour="setup-check"]',
    );
  });

  it('offers the Artist page tour on an artist page only', () => {
    const helper = loadHelper();
    expect(helper._tourAvailableHere(helper.HELPER_TOURS.artist)).toBe(false);
    helper.startTour('artist');
    expect(helper.HelperState.tourId).toBeNull();
    g.currentPage = 'artist-detail';
    expect(helper._tourAvailableHere(helper.HELPER_TOURS.artist)).toBe(true);
  });
});

describe('the tour engine', () => {
  // jsdom has no layout: give the anchors a box so the tour can see them
  function anchor(attrs: Record<string, string>) {
    const el = document.createElement('div');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    Object.defineProperty(el, 'offsetParent', { get: () => document.body });
    el.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    el.getBoundingClientRect = () =>
      ({ top: 10, left: 10, right: 20, bottom: 20, width: 10, height: 10 }) as DOMRect;
    el.scrollIntoView = () => {};
    document.body.appendChild(el);
    return el;
  }
  const popover = () => document.querySelector('.helper-tour-popover');
  const title = () => popover()?.querySelector('.helper-popover-title')?.textContent;
  const buttons = () =>
    [...(popover()?.querySelectorAll('.helper-tour-btn') ?? [])].map((b) => b.textContent);

  function testTour(helper: Helper) {
    helper.HELPER_TOURS['test-tour'] = {
      title: 'Test',
      description: 'A tour for the engine',
      steps: [
        { selector: '[data-tour="one"]', title: 'One', description: 'First' },
        { selector: '[data-tour="missing"]', title: 'Missing', description: 'Not on the page' },
        { selector: '[data-tour="three"]', title: 'Three', description: 'Last' },
      ],
    };
  }

  it('skips a step whose anchor isn’t there, counts what shows, and ends on Done', async () => {
    vi.useFakeTimers();
    const helper = loadHelper();
    testTour(helper);
    anchor({ 'data-tour': 'one' });
    anchor({ 'data-tour': 'three' });

    helper.startTour('test-tour');
    await vi.advanceTimersByTimeAsync(50);
    expect(title()).toBe('One');
    expect(popover()?.textContent).toContain('Step 1 of 2');
    expect(buttons()).toEqual(['Skip tour', 'Next']);

    helper.nextTourStep();
    await vi.advanceTimersByTimeAsync(1500);
    expect(title()).toBe('Three');
    expect(popover()?.textContent).toContain('Step 2 of 2');
    expect(buttons()).toEqual(['Back', 'Skip tour', 'Done']);

    // Back skips the missing step the other way
    helper.prevTourStep();
    await vi.advanceTimersByTimeAsync(1500);
    expect(title()).toBe('One');
  });

  it('Skip tour and Escape end it and take the box and the dimming away', async () => {
    vi.useFakeTimers();
    const helper = loadHelper();
    testTour(helper);
    anchor({ 'data-tour': 'one' });
    anchor({ 'data-tour': 'three' });

    helper.startTour('test-tour');
    await vi.advanceTimersByTimeAsync(50);
    // the button calls dismissTour() by name; jsdom doesn't run inline handlers
    // against this test's globals, so call what it names
    const skip = popover()?.querySelector('.helper-tour-btn-skip') as HTMLButtonElement;
    expect(skip.textContent).toBe('Skip tour');
    expect(skip.getAttribute('onclick')).toBe('dismissTour()');
    helper.dismissTour();
    expect(helper.HelperState.tourId).toBeNull();
    expect(popover()).toBeNull();
    expect(document.querySelector('.helper-tour-overlay')).toBeNull();

    helper.startTour('test-tour');
    await vi.advanceTimersByTimeAsync(50);
    expect(popover()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(helper.HelperState.tourId).toBeNull();
    expect(document.querySelector('.helper-tour-overlay')).toBeNull();
  });

  it('goes to a step’s page first', async () => {
    vi.useFakeTimers();
    const helper = loadHelper();
    helper.HELPER_TOURS['test-pages'] = {
      title: 'Pages',
      description: 'Two pages',
      steps: [
        { page: 'wanted', selector: '[data-tour="w"]', title: 'Wanted', description: 'Tabs' },
      ],
    };
    anchor({ 'data-tour': 'w' });
    helper.startTour('test-pages');
    await vi.advanceTimersByTimeAsync(50);
    expect(g.navigateToPage).toHaveBeenCalledWith('wanted');
    expect(title()).toBe('Wanted');
  });
});
