import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

import type { ActivityItem, ActivityResponse } from './-activity.types';

import { RANGE_STORAGE_KEY, localMidnight } from './-activity.helpers';

const NOW_S = Math.floor(Date.now() / 1000);
const HOUR = 3600;

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'lh:1',
    time: NOW_S - HOUR,
    kind: 'download',
    status: 'ok',
    title: 'Downloaded 12 tracks',
    detail: 'Lantern by Saltmarsh · Soulseek · FLAC',
    link: '/active-downloads',
    needs_you: false,
    ...over,
  };
}

const PREVIEW = item({
  id: 'safety:31',
  kind: 'safety',
  status: 'warning',
  title: 'Duplicate cleaner preview expired',
  detail: 'Nothing was changed. Preview again to recycle 214 duplicate files (3.2 GB).',
  link: '/tools',
  needs_you: true,
  ref: { tool: 'duplicate_cleaner', plan_id: 'p1' },
});

const DECISION = item({
  id: 'import:7',
  kind: 'import',
  status: 'warning',
  title: 'Import needs a decision: "Lantern (Deluxe)"',
  detail:
    '72% match to "Lantern" by Saltmarsh. The files stay in the import folder until you choose.',
  link: '/import',
  needs_you: true,
  ref: { auto_import_id: 7, import_status: 'pending_review' },
});

const RUN = item({
  id: 'automation:812',
  kind: 'automation',
  status: 'ok',
  title: 'Automation "Fill Wanted" ran',
  detail: '41 searched · 12 found · 4 min 02 s',
  link: '/automations',
  has_log: true,
  ref: { automation_id: 4, run_id: 812 },
});

const FAILED_IMPORT = item({
  id: 'import:9',
  kind: 'import',
  status: 'error',
  title: 'Import failed: "Night Ferry"',
  detail: 'The files are still in the import folder; retry it from Import.',
  link: '/import',
  ref: { auto_import_id: 9, import_status: 'failed' },
});

function response(over: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    success: true,
    items: [RUN, item({ id: 'lh:5120' }), FAILED_IMPORT],
    next_before: null,
    range: '7d',
    since: NOW_S - 7 * 86400,
    kind: 'all',
    counts: { download: 1, import: 1, automation: 1, sync: 0, safety: 0, radio: 0, needs_you: 2 },
    running_count: 0,
    needs_you: [PREVIEW, DECISION],
    generated_at: NOW_S,
    ...over,
  };
}

type Handler = (url: URL) => ActivityResponse | Promise<ActivityResponse> | Response;

function mockFeed(handler: Handler = () => response()) {
  const calls: URL[] = [];
  server.use(
    http.get('/api/activity', async ({ request }) => {
      const url = new URL(request.url);
      calls.push(url);
      const result = await handler(url);
      return result instanceof Response ? result : HttpResponse.json(result);
    }),
  );
  return calls;
}

/** Renders the app at `path` and waits for the page itself (the first route
 *  load in a worker can take longer than findBy's default second). */
async function renderPage(path = '/activity', isAdmin = true) {
  window.SoulSyncWebShellBridge = createShellBridge({
    getCurrentProfileContext: vi.fn(() => ({ profileId: isAdmin ? 1 : 3, isAdmin })),
  });
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, queryClient });
  const view = render(<AppRouterProvider router={router} queryClient={queryClient} />);
  await screen.findByRole('heading', { level: 1, name: 'Activity' }, { timeout: 5000 });
  return { ...view, router, history, queryClient };
}

const search = (router: Awaited<ReturnType<typeof renderPage>>['router']) =>
  router.state.location.search as Record<string, string>;

const pressed = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`^${name}`) }).getAttribute('aria-pressed');

describe('activity route', () => {
  beforeEach(() => {
    localStorage.clear();
    window.showToast = vi.fn();
  });

  afterEach(() => {
    window.SoulSyncWebShellBridge = undefined;
    window.showToast = undefined;
    localStorage.clear();
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  // ── filter and range ──────────────────────────────────────────────────────

  it('starts on 7 days and writes the range into the URL', async () => {
    const calls = mockFeed();
    const { router } = await renderPage();

    expect(await screen.findByText('Automation "Fill Wanted" ran')).toBeInTheDocument();
    expect(search(router)).toEqual({ range: '7d' });
    expect(calls[0].searchParams.get('range')).toBe('7d');
    expect(calls[0].searchParams.has('kind')).toBe(false);
    expect(calls[0].searchParams.has('since')).toBe(false);
    expect(pressed('7 days')).toBe('true');
    expect(pressed('All')).toBe('true');
  });

  it('carries the guided tour’s anchor round its filters and range', async () => {
    mockFeed();
    await renderPage();
    await screen.findByText('Automation "Fill Wanted" ran');
    const controls = document.querySelector('[data-tour="activity-controls"]');
    expect(controls).not.toBeNull();
    expect(
      within(controls as HTMLElement).getByRole('group', { name: 'Show' }),
    ).toBeInTheDocument();
    expect(
      within(controls as HTMLElement).getByRole('group', { name: 'Range' }),
    ).toBeInTheDocument();
  });

  it('opens on the range this browser picked last, and sends its own midnight for Today', async () => {
    localStorage.setItem(RANGE_STORAGE_KEY, 'today');
    const calls = mockFeed(() => response({ range: 'today' }));
    const { router } = await renderPage();

    await screen.findByText('Automation "Fill Wanted" ran');
    expect(search(router)).toEqual({ range: 'today' });
    expect(calls[0].searchParams.get('range')).toBe('today');
    expect(calls[0].searchParams.get('since')).toBe(String(localMidnight()));
    expect(pressed('Today')).toBe('true');
  });

  it('puts filter and range in the URL, remembers the range, and follows back', async () => {
    const calls = mockFeed();
    const { router, history } = await renderPage();
    await screen.findByText('Automation "Fill Wanted" ran');

    fireEvent.click(screen.getByRole('button', { name: 'Downloads' }));
    await waitFor(() => expect(search(router)).toEqual({ range: '7d', show: 'downloads' }));
    await waitFor(() => expect(calls.at(-1)?.searchParams.get('kind')).toBe('download'));
    expect(pressed('Downloads')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(search(router)).toEqual({ range: '30d', show: 'downloads' }));
    await waitFor(() => expect(calls.at(-1)?.searchParams.get('range')).toBe('30d'));
    expect(localStorage.getItem(RANGE_STORAGE_KEY)).toBe('30d');

    // filter changes aren't remembered, only the range
    act(() => history.back());
    await waitFor(() => expect(search(router)).toEqual({ range: '7d', show: 'downloads' }));
    expect(pressed('7 days')).toBe('true');
    act(() => history.back());
    await waitFor(() => expect(search(router)).toEqual({ range: '7d' }));
    expect(pressed('All')).toBe('true');
  });

  it('opens a shared link as it says, without changing the remembered range', async () => {
    localStorage.setItem(RANGE_STORAGE_KEY, 'today');
    const calls = mockFeed();
    await renderPage('/activity?show=automations&range=30d');
    await screen.findByText('Automation "Fill Wanted" ran');
    expect(calls[0].searchParams.get('kind')).toBe('automation');
    expect(calls[0].searchParams.get('range')).toBe('30d');
    expect(localStorage.getItem(RANGE_STORAGE_KEY)).toBe('today');
  });

  // ── populated ─────────────────────────────────────────────────────────────

  it('shows what is running, the Needs you count, and rows with a status word', async () => {
    mockFeed(() =>
      response({
        running_count: 3,
        items: [
          item({
            id: 'batch:2',
            status: 'running',
            title: 'Downloading 3 tracks for Wanted',
            detail: '2 of 3 done',
          }),
          RUN,
          FAILED_IMPORT,
        ],
      }),
    );
    await renderPage();

    expect(await screen.findByTestId('activity-running')).toHaveTextContent('3 running now');
    expect(screen.getByRole('button', { name: /^Needs you/ })).toHaveTextContent('Needs you2');

    const rows = screen.getAllByTestId('activity-row');
    expect(within(rows[0]).getByText('Running')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/active-downloads',
    );
    expect(within(rows[1]).getByText('Done')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: 'Show log' })).toBeInTheDocument();
    expect(within(rows[2]).getByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /^Today/ })).toBeInTheDocument();
  });

  it('pins Needs you above the timeline with its actions', async () => {
    mockFeed();
    await renderPage();

    const pinned = await screen.findByTestId('needs-you');
    const rows = within(pinned).getAllByTestId('needs-you-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: 'Preview again' })).toHaveAttribute(
      'href',
      '/tools',
    );
    expect(within(rows[0]).getByRole('button', { name: /Dismiss/ })).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link', { name: 'Choose' })).toHaveAttribute(
      'href',
      '/import',
    );
    expect(within(rows[1]).queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
    // pinned before the first day of the timeline
    const timeline = screen.getByTestId('timeline');
    expect(
      pinned.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps only the filter’s own kind pinned, and the Needs you filter lists them all', async () => {
    mockFeed((url) =>
      url.searchParams.get('kind') === 'needs_you'
        ? response({ kind: 'needs_you', items: [PREVIEW, DECISION] })
        : response(),
    );
    const { router } = await renderPage('/activity?show=imports&range=7d');
    const pinned = await screen.findByTestId('needs-you');
    expect(within(pinned).getAllByTestId('needs-you-row')).toHaveLength(1);
    expect(pinned).toHaveTextContent('Import needs a decision');

    fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    await waitFor(() => expect(search(router).show).toBe('needs-you'));
    await waitFor(() =>
      expect(within(screen.getByTestId('needs-you')).getAllByTestId('needs-you-row')).toHaveLength(
        2,
      ),
    );
    // the list isn't repeated as a timeline
    expect(screen.queryByTestId('timeline')).not.toBeInTheDocument();
  });

  it('dismisses an expired preview', async () => {
    let dismissed = false;
    mockFeed(() =>
      dismissed
        ? response({ needs_you: [DECISION], counts: { ...response().counts, needs_you: 1 } })
        : response(),
    );
    const posted: unknown[] = [];
    server.use(
      http.post('/api/activity/dismiss', async ({ request }) => {
        posted.push(await request.json());
        dismissed = true;
        return HttpResponse.json({ success: true, id: 'safety:31' });
      }),
    );
    await renderPage();

    const pinned = await screen.findByTestId('needs-you');
    fireEvent.click(
      within(pinned).getByRole('button', { name: 'Dismiss: Duplicate cleaner preview expired' }),
    );
    await waitFor(() => expect(posted).toEqual([{ id: 'safety:31' }]));
    await waitFor(() => expect(within(pinned).getAllByTestId('needs-you-row')).toHaveLength(1));
    expect(within(pinned).queryByText('Duplicate cleaner preview expired')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Needs you/ })).toHaveTextContent('1');
  });

  it('says so when a dismiss doesn’t go through', async () => {
    mockFeed();
    server.use(
      http.post('/api/activity/dismiss', () =>
        HttpResponse.json({ success: false, error: 'Database is locked' }, { status: 500 }),
      ),
    );
    await renderPage();
    const pinned = await screen.findByTestId('needs-you');
    fireEvent.click(within(pinned).getByRole('button', { name: /^Dismiss/ }));
    expect(await within(pinned).findByRole('alert')).toHaveTextContent(
      'Couldn’t dismiss it: Database is locked. Try again in a moment.',
    );
    expect(within(pinned).getAllByTestId('needs-you-row')).toHaveLength(2);
  });

  // ── logs ──────────────────────────────────────────────────────────────────

  it('loads a run’s log under its row, with Open this automation and Copy log', async () => {
    mockFeed();
    const logCalls: string[] = [];
    server.use(
      http.get('/api/activity/log/:id', ({ params }) => {
        logCalls.push(String(params.id));
        return HttpResponse.json({
          success: true,
          id: params.id,
          log_lines: [
            { type: 'info', text: 'Starting Fill Wanted' },
            { type: 'success', text: '12 downloaded' },
          ],
        });
      }),
    );
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await renderPage();

    const toggle = await screen.findByRole('button', { name: 'Show log' });
    expect(screen.queryByTestId('activity-log')).not.toBeInTheDocument();
    expect(logCalls).toEqual([]);
    fireEvent.click(toggle);

    const log = await screen.findByTestId('activity-log');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Hide log');
    await waitFor(() =>
      expect(log.querySelector('pre')).toHaveTextContent('info Starting Fill Wanted'),
    );
    expect(logCalls).toEqual(['automation:812']);
    expect(within(log).getByRole('link', { name: 'Open this automation' })).toHaveAttribute(
      'href',
      '/automations',
    );

    fireEvent.click(within(log).getByRole('button', { name: 'Copy log' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'info     Starting Fill Wanted\nsuccess  12 downloaded',
      ),
    );
    expect(await within(log).findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('activity-log')).not.toBeInTheDocument();
    expect(toggle).toHaveTextContent('Show log');
  });

  it('says when a log can’t be loaded', async () => {
    mockFeed();
    server.use(
      http.get('/api/activity/log/:id', () =>
        HttpResponse.json({ success: false, error: 'No log for that item' }, { status: 404 }),
      ),
    );
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show log' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load the log: No log for that item.',
    );
  });

  // ── retry ─────────────────────────────────────────────────────────────────

  it('retries a failed import folder where the server can', async () => {
    const calls = mockFeed();
    const posted: string[] = [];
    server.use(
      http.post('/api/auto-import/retry/:id', ({ params }) => {
        posted.push(String(params.id));
        return HttpResponse.json({ success: true });
      }),
    );
    await renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Retry now: Import failed: "Night Ferry"' }),
    );
    await waitFor(() => expect(posted).toEqual(['9']));
    expect(await screen.findByText('Retry started')).toBeInTheDocument();
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
  });

  // ── paging ────────────────────────────────────────────────────────────────

  it('shows earlier days with next_before, then says it has everything', async () => {
    const calls = mockFeed((url) =>
      url.searchParams.get('before') === 'CURSOR1'
        ? response({
            items: [item({ id: 'lh:4000', time: NOW_S - 3 * 86400, title: 'Downloaded 3 tracks' })],
            next_before: null,
          })
        : response({ next_before: 'CURSOR1' }),
    );
    await renderPage();

    const more = await screen.findByRole('button', { name: 'Show earlier days' });
    expect(screen.queryByText('That’s everything from the last 7 days.')).not.toBeInTheDocument();
    fireEvent.click(more);

    expect(await screen.findByText('Downloaded 3 tracks')).toBeInTheDocument();
    expect(calls.at(-1)?.searchParams.get('before')).toBe('CURSOR1');
    expect(calls.at(-1)?.searchParams.get('range')).toBe('7d');
    expect(screen.queryByRole('button', { name: 'Show earlier days' })).not.toBeInTheDocument();
    expect(screen.getByText('That’s everything from the last 7 days.')).toBeInTheDocument();
    // the earlier page's day is its own group
    expect(screen.getAllByTestId('activity-day')).toHaveLength(2);
  });

  // ── live refresh ──────────────────────────────────────────────────────────

  it('refreshes every 10 seconds while something runs, and pauses while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = mockFeed(() => response({ running_count: 1 }));
    await renderPage();
    await screen.findByText('Automation "Fill Wanted" ran');
    const first = calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    await waitFor(() => expect(calls.length).toBe(first + 1));

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(calls.length).toBe(first + 1);

    // back on the tab: catches up at once
    Reflect.deleteProperty(document, 'visibilityState');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    await waitFor(() => expect(calls.length).toBe(first + 2));
  });

  it('only polls once a minute when nothing runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = mockFeed();
    await renderPage();
    await screen.findByText('Automation "Fill Wanted" ran');
    const first = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(calls.length).toBe(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await waitFor(() => expect(calls.length).toBe(first + 1));
  });

  // ── loading, empty, failure ───────────────────────────────────────────────

  it('says what it is loading, with the controls usable meanwhile', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFeed(async () => {
      await gate;
      return response();
    });
    await renderPage();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading the last 7 days…');
    expect(screen.getByTestId('activity-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30 days' })).toBeEnabled();
    expect(screen.queryByTestId('activity-running')).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('Automation "Fill Wanted" ran')).toBeInTheDocument();
    expect(screen.queryByTestId('activity-skeleton')).not.toBeInTheDocument();
  });

  it('shows the empty panel for the range, with a wider range one click away', async () => {
    const calls = mockFeed(() =>
      response({ items: [], needs_you: [], counts: { ...response().counts, needs_you: 0 } }),
    );
    const { router } = await renderPage();

    const empty = await screen.findByTestId('activity-empty');
    expect(
      within(empty).getByRole('heading', { name: 'Nothing in the last 7 days' }),
    ).toBeInTheDocument();
    expect(within(empty).getByRole('link', { name: 'Open Automations' })).toHaveAttribute(
      'href',
      '/automations',
    );
    expect(screen.getByRole('button', { name: /^Needs you/ })).toHaveTextContent('0');
    expect(screen.queryByTestId('needs-you')).not.toBeInTheDocument();

    fireEvent.click(within(empty).getByRole('button', { name: 'Show 30 days' }));
    await waitFor(() => expect(search(router).range).toBe('30d'));
    await waitFor(() => expect(calls.at(-1)?.searchParams.get('range')).toBe('30d'));
    expect(
      await screen.findByRole('heading', { name: 'Nothing in the last 30 days' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show 30 days' })).not.toBeInTheDocument();
  });

  it('keeps the header and controls when it can’t load, with faded placeholders and Try again', async () => {
    let fail = true;
    mockFeed(() =>
      fail
        ? HttpResponse.json({ success: false, error: 'Couldn’t load activity' }, { status: 500 })
        : response(),
    );
    await renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load activity');
    expect(alert).toHaveTextContent('this is a display problem');
    expect(within(alert).getByRole('link', { name: 'Run Setup check' })).toHaveAttribute(
      'href',
      '/setup-check',
    );
    expect(screen.getByTestId('activity-skeleton-faded')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Show' })).toBeInTheDocument();

    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Automation "Fill Wanted" ran')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('doesn’t offer the Setup check to a profile that can’t run it', async () => {
    mockFeed(() => HttpResponse.json({ success: false }, { status: 500 }));
    await renderPage('/activity', false);
    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByRole('link', { name: 'Run Setup check' })).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
