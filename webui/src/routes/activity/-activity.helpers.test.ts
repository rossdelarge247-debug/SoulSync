import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActivityItem, ActivityResponse } from './-activity.types';

import {
  IDLE_REFRESH_MS,
  LIVE_REFRESH_MS,
  RANGE_STORAGE_KEY,
  activityParams,
  detailWithRetry,
  emptyCopy,
  endNote,
  flattenPages,
  formatPinnedWhen,
  groupByDay,
  localMidnight,
  logText,
  parseRange,
  parseShow,
  pinnedActions,
  pinnedFor,
  readRememberedRange,
  refreshInterval,
  rememberRange,
  rowAction,
  statusTag,
  toolDestination,
} from './-activity.helpers';

// vitest.setup.ts pins the suite to America/Los_Angeles, so "local" below is
// Los Angeles time, not UTC.
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);
const NOW = new Date(2026, 9, 21, 16, 30); // Wednesday 21 October 2026, 16:30 local

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: 'lh:1',
    time: at(2026, 10, 21, 14, 2),
    kind: 'download',
    status: 'ok',
    title: 'Downloaded 12 tracks',
    detail: 'Lantern by Saltmarsh · Soulseek · FLAC',
    link: '/active-downloads',
    needs_you: false,
    ...over,
  };
}

function page(over: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    success: true,
    items: [],
    next_before: null,
    range: '7d',
    since: 0,
    kind: 'all',
    counts: {
      download: 0,
      import: 0,
      automation: 0,
      library: 0,
      sync: 0,
      safety: 0,
      radio: 0,
      needs_you: 0,
    },
    running_count: 0,
    needs_you: [],
    generated_at: 0,
    ...over,
  };
}

describe('filter and range values', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('accepts only the known values', () => {
    expect(parseShow('downloads')).toBe('downloads');
    expect(parseShow('needs-you')).toBe('needs-you');
    expect(parseShow('safety')).toBeUndefined();
    expect(parseRange('30d')).toBe('30d');
    expect(parseRange('90d')).toBeUndefined();
    expect(parseRange(undefined)).toBeUndefined();
  });

  it('remembers the range per browser, 7 days by default', () => {
    expect(readRememberedRange()).toBe('7d');
    rememberRange('today');
    expect(localStorage.getItem(RANGE_STORAGE_KEY)).toBe('today');
    expect(readRememberedRange()).toBe('today');
    localStorage.setItem(RANGE_STORAGE_KEY, 'forever');
    expect(readRememberedRange()).toBe('7d');
  });

  it('falls back to 7 days when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => rememberRange('30d')).not.toThrow();
    expect(readRememberedRange()).toBe('7d');
  });
});

describe('request parameters', () => {
  it('sends the browser’s own midnight as since for Today', () => {
    const midnight = at(2026, 10, 21);
    expect(localMidnight(NOW)).toBe(midnight);
    // Los Angeles is UTC-7 in October: local midnight is 07:00 UTC
    expect(new Date(midnight * 1000).toISOString()).toBe('2026-10-21T07:00:00.000Z');
    expect(activityParams('all', 'today', null, NOW)).toEqual({
      range: 'today',
      since: String(midnight),
    });
  });

  it('maps each filter to the API kind and passes the cursor', () => {
    expect(activityParams('all', '7d', null, NOW)).toEqual({ range: '7d' });
    expect(activityParams('downloads', '30d', 'abc', NOW)).toEqual({
      range: '30d',
      kind: 'download',
      before: 'abc',
    });
    expect(activityParams('imports', '7d', null, NOW).kind).toBe('import');
    expect(activityParams('automations', '7d', null, NOW).kind).toBe('automation');
    expect(activityParams('playlists', '7d', null, NOW).kind).toBe('sync');
    expect(activityParams('needs-you', '7d', null, NOW).kind).toBe('needs_you');
  });
});

describe('day groups and times', () => {
  it('groups by local day, newest first, with Today and Yesterday', () => {
    const items = [
      item({ id: 'a', time: at(2026, 10, 21, 16, 2) }),
      item({ id: 'b', time: at(2026, 10, 21, 0, 5) }),
      // 23:50 local on the 20th is already the 21st in UTC: still yesterday here
      item({ id: 'c', time: at(2026, 10, 20, 23, 50) }),
      item({ id: 'd', time: at(2026, 10, 19, 9, 15) }),
    ];
    const groups = groupByDay(items, NOW, 'en-GB');
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(groups.map((g) => g.label)).toEqual([
      { lead: 'Today', date: 'Wednesday 21 October' },
      { lead: 'Yesterday', date: 'Tuesday 20 October' },
      { lead: null, date: 'Monday 19 October' },
    ]);
  });

  it('keeps one group per day across pages', () => {
    const items = flattenPages([
      page({ items: [item({ id: 'a' }), item({ id: 'b' })] }),
      // a refreshed first page can push an item onto the next page: shown once
      page({ items: [item({ id: 'b' }), item({ id: 'c' })] }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(groupByDay(items, NOW)).toHaveLength(1);
  });

  it('writes a pinned row’s time as the time, the weekday, or the date', () => {
    expect(formatPinnedWhen(at(2026, 10, 21, 13, 40), NOW, 'en-GB')).toBe('13:40');
    expect(formatPinnedWhen(at(2026, 10, 19, 13, 40), NOW, 'en-GB')).toBe('Mon');
    expect(formatPinnedWhen(at(2026, 10, 2, 13, 40), NOW, 'en-GB')).toBe('2 Oct');
    expect(formatPinnedWhen(at(2025, 12, 30, 9, 0), NOW, 'en-GB')).toBe('30 Dec 2025');
  });

  it('swaps the server’s "in about 2 hours" for the retry time in the browser’s locale', () => {
    const failed = item({
      kind: 'automation',
      status: 'error',
      detail: "Soulseek wasn't reachable. Next run in about 2 hours.",
      retry_at: at(2026, 10, 21, 18, 15),
    });
    expect(detailWithRetry(failed, NOW, 'en-GB')).toBe(
      "Soulseek wasn't reachable. Next run at 18:15.",
    );
    expect(detailWithRetry(failed, NOW, 'en-US')).toBe(
      "Soulseek wasn't reachable. Next run at 6:15 PM.",
    );
    const wishlist = item({
      detail:
        "2 weren't found. They stay on Wanted. Next search in 40 minutes (Auto-Process Wishlist).",
      retry_at: at(2026, 10, 22, 6, 0),
    });
    expect(detailWithRetry(wishlist, NOW, 'en-GB')).toBe(
      "2 weren't found. They stay on Wanted. Next search tomorrow at 06:00 (Auto-Process Wishlist).",
    );
  });

  it('adds the retry time when the sentence has no relative time, but never a past one', () => {
    const plain = item({ detail: 'It stopped part way', retry_at: at(2026, 10, 21, 18, 15) });
    expect(detailWithRetry(plain, NOW, 'en-GB')).toBe('It stopped part way. Next try at 18:15.');
    const past = item({ detail: 'Next run any moment now.', retry_at: at(2026, 10, 21, 16, 0) });
    expect(detailWithRetry(past, NOW, 'en-GB')).toBe('Next run any moment now.');
    expect(detailWithRetry(item(), NOW)).toBe(item().detail);
  });
});

describe('status words', () => {
  it('gives every status a word', () => {
    expect(statusTag(item({ status: 'running' }))).toEqual({
      label: 'Running',
      tone: 'info',
      live: true,
    });
    expect(statusTag(item({ status: 'ok' })).label).toBe('Done');
    expect(statusTag(item({ status: 'error' }))).toMatchObject({ label: 'Failed', tone: 'danger' });
    expect(statusTag(item({ status: 'warning', needs_you: true })).label).toBe('Needs you');
    expect(statusTag(item({ status: 'warning' }))).toMatchObject({
      label: 'Incomplete',
      tone: 'warning',
    });
    expect(statusTag(item({ status: 'info', kind: 'safety' })).label).toBe('Preview');
    expect(statusTag(item({ status: 'info', kind: 'import' }))).toMatchObject({
      label: 'Info',
      tone: 'neutral',
    });
  });
});

describe('row actions', () => {
  it('prefers the log, then a real retry, then Open', () => {
    expect(rowAction(item({ kind: 'automation', id: 'automation:5', has_log: true }))).toEqual({
      type: 'log',
    });
    expect(
      rowAction(
        item({
          kind: 'automation',
          id: 'automation:5',
          status: 'error',
          link: '/automations',
          ref: { automation_id: 4, run_id: 5 },
        }),
      ),
    ).toEqual({ type: 'retry', retry: { path: 'automations/4/run', label: 'Retry now' } });
    expect(
      rowAction(
        item({
          kind: 'import',
          id: 'import:9',
          status: 'error',
          link: '/import',
          ref: { auto_import_id: 9, import_status: 'failed' },
        }),
      ),
    ).toEqual({ type: 'retry', retry: { path: 'auto-import/retry/9', label: 'Retry now' } });
    expect(rowAction(item())).toEqual({ type: 'open', href: '/active-downloads' });
  });

  it('offers Stop on a running library job, only for its own route (HANDOFF 68)', () => {
    const job = item({
      kind: 'automation',
      id: 'library-job:3',
      status: 'running',
      link: '/library?show=incomplete',
      ref: { job_id: 3, stop_path: 'library/missing-releases/stop' },
    });
    expect(rowAction(job)).toEqual({
      type: 'stop',
      stop: { path: 'library/missing-releases/stop', label: 'Stop' },
    });
    expect(rowAction({ ...job, status: 'ok' })).toEqual({
      type: 'open',
      href: '/library?show=incomplete',
    });
    expect(rowAction({ ...job, ref: { stop_path: 'settings/../wipe' } })).toEqual({
      type: 'open',
      href: '/library?show=incomplete',
    });
  });

  it('offers no retry where the server has none', () => {
    // a failed download batch: no retry route, so it opens Downloads
    expect(
      rowAction(item({ id: 'batch:3', status: 'error', ref: { sync_history_id: 3 } })),
    ).toEqual({ type: 'open', href: '/active-downloads' });
    // a running automation, and a library import that isn't a folder
    expect(
      rowAction(
        item({
          id: 'automation-live:4',
          kind: 'automation',
          status: 'running',
          link: '/automations',
          ref: { automation_id: 4 },
        }),
      )?.type,
    ).toBe('open');
    expect(
      rowAction(item({ id: 'lh:7', kind: 'import', status: 'error', link: '/library' }))?.type,
    ).toBe('open');
    expect(rowAction(item({ link: '' }))).toBeNull();
  });

  it('pins Preview again and Dismiss for an expired preview, sent to its tool', () => {
    const preview = item({
      id: 'safety:31',
      kind: 'safety',
      status: 'warning',
      link: '/tools',
      ref: { tool: 'duplicate_cleaner', plan_id: 'p' },
    });
    expect(pinnedActions(preview)).toEqual([
      {
        type: 'preview-again',
        label: 'Preview again',
        destination: { href: '/tools', reveal: '#duplicate-cleaner-card' },
      },
      { type: 'dismiss', label: 'Dismiss' },
    ]);
    expect(toolDestination('deep_scan')).toEqual({ href: '/tools', reveal: '#db-updater-card' });
    expect(toolDestination('recycle_bin_purge')).toEqual({ href: '/active-downloads' });
    expect(toolDestination('quarantine_clear')).toEqual({ href: '/active-downloads' });
    expect(toolDestination('something_new')).toEqual({ href: '/tools' });
  });

  it('says Choose only for an import waiting on a choice', () => {
    const imp = (status: string) =>
      item({
        id: 'import:2',
        kind: 'import',
        status: 'warning',
        link: '/import',
        ref: { auto_import_id: 2, import_status: status },
      });
    expect(pinnedActions(imp('pending_review'))).toEqual([
      { type: 'link', label: 'Choose', href: '/import' },
    ]);
    expect(pinnedActions(imp('needs_identification'))[0].label).toBe('Choose');
    expect(pinnedActions(imp('partial'))[0].label).toBe('Open');
    expect(pinnedActions(item({ kind: 'automation', link: '/automations' }))).toEqual([
      { type: 'link', label: 'Open', href: '/automations' },
    ]);
  });

  it('keeps a filter’s own kind in the pinned list', () => {
    const pinned = [item({ id: 'a', kind: 'safety' }), item({ id: 'b', kind: 'import' })];
    expect(pinnedFor(pinned, 'all')).toHaveLength(2);
    expect(pinnedFor(pinned, 'needs-you')).toHaveLength(2);
    expect(pinnedFor(pinned, 'imports').map((i) => i.id)).toEqual(['b']);
    expect(pinnedFor(pinned, 'downloads')).toEqual([]);
  });
});

describe('live refresh', () => {
  it('polls every 10 s while something runs, every minute otherwise', () => {
    expect(refreshInterval(undefined)).toBe(false);
    expect(refreshInterval(page())).toBe(IDLE_REFRESH_MS);
    expect(refreshInterval(page({ running_count: 2 }))).toBe(LIVE_REFRESH_MS);
    expect(refreshInterval(page({ items: [item({ status: 'running' })] }))).toBe(LIVE_REFRESH_MS);
  });
});

describe('copy', () => {
  it('writes the log as type and text columns', () => {
    expect(
      logText([
        { type: 'info', text: 'Starting Fill Wanted' },
        { type: 'error', text: "Soulseek wasn't reachable" },
        { text: 'no type' },
      ]),
    ).toBe("info     Starting Fill Wanted\nerror    Soulseek wasn't reachable\ninfo     no type");
  });

  it('names the range and the filter in the empty title', () => {
    expect(emptyCopy('all', '7d').title).toBe('Nothing in the last 7 days');
    expect(emptyCopy('all', 'today').title).toBe('Nothing today');
    expect(emptyCopy('downloads', '30d').title).toBe('No downloads in the last 30 days');
    expect(emptyCopy('needs-you', '7d')).toMatchObject({ title: 'Nothing needs you', link: null });
    expect(endNote('7d')).toBe('That’s everything from the last 7 days.');
    expect(endNote('today')).toBe('That’s everything from today.');
  });
});
