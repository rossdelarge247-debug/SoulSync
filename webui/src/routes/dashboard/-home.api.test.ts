import { describe, expect, it } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import {
  checkDownloadSource,
  fetchLatestActivity,
  fetchTargetsSummary,
  normalizeLatest,
  normalizeSummary,
} from './-home.api';

describe('normalizeSummary', () => {
  it('keeps the fixed order and fills a missing target in as not set up', () => {
    const summary = normalizeSummary({
      targets: [
        { key: 'quality', set_up: true, status: 'ok', name: 'FLAC or better', tracks_checked: 10 },
        { key: 'wanted', set_up: true, status: 'searching', items: 5, have: 1, in_progress: 4 },
      ],
      any_set_up: true,
      generated_at: 1792570000,
    });
    expect(summary.targets.map((t) => [t.key, t.status])).toEqual([
      ['wanted', 'searching'],
      ['mirrored', 'not_set_up'],
      ['followed', 'not_set_up'],
      ['quality', 'ok'],
    ]);
    expect(summary.targets[3].name).toBe('FLAC or better');
    expect(summary.targets[3].tracksChecked).toBe(10);
    expect(summary.anySetUp).toBe(true);
  });

  it('works any_set_up out without the flag, ignoring quality', () => {
    const summary = normalizeSummary({ targets: [{ key: 'quality', set_up: true, status: 'ok' }] });
    expect(summary.anySetUp).toBe(false);
  });

  it('only carries a reason while the target cannot search', () => {
    const summary = normalizeSummary({
      targets: [
        { key: 'wanted', set_up: true, status: 'cant_search', reason: 'Soulseek is down.' },
        { key: 'followed', set_up: true, status: 'ok', reason: 'stale' },
      ],
    });
    expect(summary.targets[0].reason).toBe('Soulseek is down.');
    expect(summary.targets[2].reason).toBeNull();
  });
});

describe('normalizeLatest', () => {
  it('keeps the newest three and a word-able status', () => {
    const items = normalizeLatest({
      items: [1, 2, 3, 4].map((n) => ({
        id: `i${n}`,
        time: n,
        status: n === 2 ? 'odd' : 'ok',
        title: `T${n}`,
        needs_you: n === 3,
      })),
    });
    expect(items.map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
    expect(items[1].status).toBe('info');
    expect(items[2].needsYou).toBe(true);
  });
});

describe('the requests', () => {
  it('reads the summary, and fails on success: false', async () => {
    server.use(
      http.get('/api/targets/summary', () =>
        HttpResponse.json({ success: true, targets: [], any_set_up: false }),
      ),
    );
    await expect(fetchTargetsSummary()).resolves.toMatchObject({ anySetUp: false });
    server.use(
      http.get('/api/targets/summary', () =>
        HttpResponse.json(
          { success: false, error: "Couldn't work out your targets" },
          { status: 500 },
        ),
      ),
    );
    await expect(fetchTargetsSummary()).rejects.toThrow();
  });

  it('asks the activity feed for 30 days, three items', async () => {
    let query = '';
    server.use(
      http.get('/api/activity', ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ success: true, items: [] });
      }),
    );
    await expect(fetchLatestActivity()).resolves.toEqual([]);
    expect(new URLSearchParams(query).get('range')).toBe('30d');
    expect(new URLSearchParams(query).get('limit')).toBe('3');
  });

  it('"Try now" runs the download source check and passes on what it said', async () => {
    let body: unknown;
    server.use(
      http.post('/api/test-connection', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: false, error: 'slskd is not connected.', message: '' });
      }),
    );
    await expect(checkDownloadSource()).resolves.toEqual({
      ok: false,
      message: 'slskd is not connected.',
    });
    expect(body).toEqual({ service: 'soulseek' });
  });
});
