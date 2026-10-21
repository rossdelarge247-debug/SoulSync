import { describe, expect, it } from 'vitest';

import {
  activityLabel,
  countedLabel,
  NAV_ROWS,
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
} from './nav-routes';

describe('which row a page lights', () => {
  it.each([
    ['dashboard', '', 'home'],
    ['search', '', 'search'],
    ['discover', '', 'discover'],
    ['wishlist', '', 'wanted'],
    // Wanted will cover Followed artists too; until then the watchlist and the
    // label pages it links to keep Wanted lit
    ['watchlist', '', 'wanted'],
    ['label-detail', '', 'wanted'],
    ['sync', '', 'mirrored'],
    ['playlist-explorer', '', 'explorer'],
    ['chat', '', 'chat'],
    ['library', '', 'artists'],
    ['library', '?view=artists', 'artists'],
    ['library', '?view=albums', 'albums'],
    ['library', '?sort=name&view=albums', 'albums'],
    ['artist-detail', '', 'artists'],
    ['import', '', 'import'],
    ['stats', '', 'stats'],
    ['podcasts', '', 'podcasts'],
    ['audiobooks', '', 'audiobooks'],
    ['sample-studio', '', 'sample-studio'],
    ['automations', '', 'automations'],
    ['active-downloads', '', 'activity'],
    ['settings', '', 'settings'],
    ['setup-check', '', 'setup-check'],
    ['hydrabase', '', 'hydrabase'],
    ['tools', '', 'maintenance'],
    ['issues', '', 'issues'],
    ['requests', '', 'issues'],
    ['help', '', 'help'],
  ])('%s%s lights %s', (pageId, search, row) => {
    expect(navRowFor(pageId, search)).toBe(row);
  });

  it('lights nothing for a page no row owns', () => {
    expect(navRowFor('nowhere')).toBeNull();
    expect(navRowFor(null)).toBeNull();
    expect(navRowFor('')).toBeNull();
  });

  it('only ever lights a row that exists', () => {
    for (const page of ['dashboard', 'library', 'requests', 'tools', 'watchlist']) {
      expect(NAV_ROWS).toContain(navRowFor(page));
    }
  });

  it('the pages the two waiting rows point at light those rows', () => {
    expect(navRowFor(NAV_TARGETS.wanted.pageId)).toBe('wanted');
    expect(navRowFor(NAV_TARGETS.activity.pageId)).toBe('activity');
  });

  it('knows the group a page sits in, for the phone tab bar', () => {
    expect(navGroupFor('wishlist')).toBe('get-music');
    expect(navGroupFor('library', '?view=albums')).toBe('library');
    expect(navGroupFor('active-downloads')).toBe('automate');
    expect(navGroupFor('tools')).toBe('settings');
    expect(navGroupFor('dashboard')).toBeNull();
  });
});

describe('the top bar page name', () => {
  it("is the row's label unless the page has its own name", () => {
    expect(pageTitle('wishlist', 'Wanted')).toBe('Wanted');
    expect(pageTitle('watchlist', 'Wanted')).toBe('Watchlist');
    expect(pageTitle('requests', 'Requests and issues')).toBe('Requests');
    expect(pageTitle('dashboard', 'Home')).toBe('Home');
    expect(pageTitle('artist-detail', 'Artists')).toBe('Artist');
    expect(pageTitle('nowhere', null)).toBe('SoulSync');
  });

  it("names the video side's drill-in pages", () => {
    expect(videoPageTitle('video-movie-detail', null)).toBe('Movie');
    expect(videoPageTitle('video-library', 'Library')).toBe('Library');
    expect(videoPageTitle(null, null)).toBe('Video');
  });
});

describe('GET /api/activity/status', () => {
  it('reads the two counts', () => {
    expect(
      parseActivityStatus({
        success: true,
        running_count: 3,
        needs_you_count: 2,
        generated_at: 1792570000,
      }),
    ).toEqual({ running: 3, needsYou: 2 });
  });

  it('keeps zero as zero', () => {
    expect(parseActivityStatus({ success: true, running_count: 0, needs_you_count: 0 })).toEqual({
      running: 0,
      needsYou: 0,
    });
  });

  it('treats anything else as unknown, never as zero', () => {
    expect(parseActivityStatus(null)).toEqual(UNKNOWN_ACTIVITY);
    expect(parseActivityStatus('nope')).toEqual(UNKNOWN_ACTIVITY);
    expect(parseActivityStatus({ success: false, error: 'x' })).toEqual(UNKNOWN_ACTIVITY);
    expect(parseActivityStatus({})).toEqual(UNKNOWN_ACTIVITY);
    expect(parseActivityStatus({ running_count: -1, needs_you_count: 'two' })).toEqual(
      UNKNOWN_ACTIVITY,
    );
  });

  it('words the running link for unknown, nothing and some', () => {
    expect(runningCopy(null)).toEqual({ text: 'Activity', live: false });
    expect(runningCopy(0)).toEqual({ text: 'Nothing running', live: false });
    expect(runningCopy(3)).toEqual({ text: '3 running', live: true });
  });

  it('names the phone Activity button with what it knows', () => {
    expect(activityLabel(UNKNOWN_ACTIVITY)).toBe('Activity');
    expect(activityLabel({ running: 0, needsYou: 0 })).toBe('Activity');
    expect(activityLabel({ running: 3, needsYou: 1 })).toBe('Activity, 3 running, 1 needs you');
    expect(activityLabel({ running: null, needsYou: 2 })).toBe('Activity, 2 need you');
  });
});

describe('the setup check summary', () => {
  it('counts warnings and problems together', () => {
    expect(setupProblemCount({ ok: 7, warning: 1, error: 1, skipped: 0 })).toBe(2);
    expect(setupProblemCount({ ok: 9, warning: 0, error: 0 })).toBe(0);
  });

  it('is unknown without a summary', () => {
    expect(setupProblemCount(undefined)).toBeNull();
    expect(setupProblemCount({ ok: 3 })).toBeNull();
  });

  it('says it in words', () => {
    expect(setupProblemText(1)).toBe('1 problem');
    expect(setupProblemText(3)).toBe('3 problems');
  });
});

describe('labels', () => {
  it('reads a count the way the board writes it', () => {
    expect(countedLabel('Wanted', '312', '')).toBe('Wanted, 312');
    expect(countedLabel('Activity', '2', 'need you')).toBe('Activity, 2 need you');
    expect(countedLabel('Wanted', '312', '', ' · ')).toBe('Wanted · 312');
    expect(countedLabel('Search', null, '')).toBe('Search');
  });

  it('shows ⌘K on Apple keyboards and Ctrl K elsewhere', () => {
    expect(shortcutHint('MacIntel')).toBe('⌘K');
    expect(shortcutHint('iPhone')).toBe('⌘K');
    expect(shortcutHint('Win32')).toBe('Ctrl K');
    expect(shortcutHint('')).toBe('Ctrl K');
  });
});
