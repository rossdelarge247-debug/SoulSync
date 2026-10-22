import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { getShellRouteByPageId } from '@/platform/shell/route-manifest';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

import type { Automation, AutomationBlocks, PreviewResult, RunEntry } from './-automations.types';

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sql = (offsetMs: number) =>
  new Date(NOW + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const FILL: Automation = {
  id: 4,
  name: 'Fill Wanted',
  enabled: 1,
  trigger_type: 'schedule',
  trigger_config: { interval: 6, unit: 'hours' },
  action_type: 'process_wishlist',
  action_config: {},
  then_actions: [
    {
      type: 'discord_webhook',
      config: { webhook_url: 'https://discord.example/x', message: 'hi' },
    },
  ],
  last_run: sql(-3 * HOUR),
  next_run: sql(2 * HOUR),
  last_result: { status: 'completed' },
  is_system: 0,
  profile_id: 1,
};
const CHECK: Automation = {
  id: 5,
  name: 'Check followed artists',
  enabled: 1,
  trigger_type: 'daily_time',
  trigger_config: { time: '06:00' },
  action_type: 'scan_watchlist',
  action_config: {},
  then_actions: [],
  last_run: sql(-6 * HOUR),
  last_result: { status: 'completed', artists_scanned: 18, tracks_added_to_wishlist: 1 },
  is_system: 0,
};
const UPGRADE: Automation = {
  id: 6,
  name: 'Upgrade to FLAC',
  enabled: 0,
  trigger_type: 'weekly_time',
  trigger_config: { time: '02:00', days: ['tue'] },
  action_type: 'apply_quality_upgrades',
  action_config: { limit: 100 },
  then_actions: [],
  last_run: sql(-2 * DAY),
  is_system: 0,
};
const QUARANTINE: Automation = {
  id: 8,
  name: 'Clear quarantine',
  enabled: 1,
  trigger_type: 'schedule',
  trigger_config: { interval: 7, unit: 'days' },
  action_type: 'clear_quarantine',
  action_config: { confirm: false },
  then_actions: [],
  last_run: sql(-DAY),
  is_system: 0,
};
const BACKUP: Automation = {
  id: 9,
  name: 'Auto-Backup Database',
  enabled: 1,
  trigger_type: 'schedule',
  trigger_config: { interval: 3, unit: 'days' },
  action_type: 'backup_database',
  then_actions: [],
  last_run: sql(-DAY),
  is_system: 1,
};
const WEEKLY: Automation = {
  id: 10,
  name: 'Weekly Cleanup',
  enabled: 1,
  trigger_type: 'schedule',
  trigger_config: { interval: 7, unit: 'days' },
  action_type: 'library_cleanup',
  action_config: {},
  then_actions: [],
  last_run: null,
  is_system: 1,
};
const LIST = [BACKUP, WEEKLY, FILL, CHECK, UPGRADE, QUARANTINE];

const run = (id: number, agoMs: number, over: Partial<RunEntry> = {}): RunEntry => ({
  id,
  automation_id: 4,
  started_at: iso(agoMs + 240_000),
  finished_at: iso(agoMs),
  duration_seconds: 240,
  status: 'completed',
  summary: 'Done',
  log_lines: [],
  ...over,
});

const FILL_RUNS: RunEntry[] = [
  run(105, HOUR, {
    summary: '12 found',
    log_lines: [{ type: 'success', text: '12 downloads started' }],
  }),
  run(104, 2 * HOUR, {
    status: 'preview',
    summary: 'Would search 44 · nothing changed',
    duration_seconds: 0.2,
  }),
  run(103, DAY, { status: 'error', summary: "Soulseek wasn't reachable" }),
  run(102, 2 * DAY, { summary: '2 found', duration_seconds: 180 }),
  run(101, 40 * DAY),
];

const BLOCKS: AutomationBlocks = {
  triggers: [
    { type: 'schedule', label: 'Schedule', category: 'Timing' },
    { type: 'daily_time', label: 'Daily Time', category: 'Timing' },
    { type: 'weekly_time', label: 'Weekly Schedule', category: 'Timing' },
    { type: 'monthly_time', label: 'Monthly Schedule', category: 'Timing' },
    {
      type: 'track_downloaded',
      label: 'Track Downloaded',
      category: 'Downloads',
      description: 'When a track finishes downloading',
      has_conditions: true,
      condition_fields: ['artist', 'title'],
      variables: ['artist', 'title'],
    },
  ],
  actions: [
    {
      type: 'process_wishlist',
      label: 'Process Wishlist',
      category: 'Wishlist',
      description: 'Retry failed downloads from wishlist',
      config_fields: [
        { key: 'category', type: 'select', options: [{ value: 'all', label: 'All' }] },
      ],
    },
    { type: 'scan_watchlist', label: 'Scan Watchlist', category: 'Watchlist' },
    { type: 'scan_library', label: 'Scan Library', category: 'Library' },
    {
      type: 'clear_quarantine',
      label: 'Clear Quarantine',
      category: 'Maintenance',
      config_fields: [
        { key: 'confirm', type: 'checkbox', label: 'Act without a preview', default: false },
      ],
    },
    {
      type: 'apply_quality_upgrades',
      label: 'Apply Quality Upgrades',
      category: 'Maintenance',
      config_fields: [{ key: 'limit', type: 'number', label: 'Most per run', default: 100 }],
    },
  ],
  notifications: [{ type: 'discord_webhook', label: 'Discord Webhook' }],
  category_order: ['Timing', 'Downloads', 'Library', 'Wishlist', 'Watchlist', 'Maintenance'],
  known_signals: [],
};

function preview(over: Partial<PreviewResult> = {}): PreviewResult {
  return {
    success: true,
    automation_id: 4,
    action_type: 'process_wishlist',
    available: true,
    files: false,
    summary:
      'A run now would search for 41 tracks on Wanted (this turn is albums). Nothing was searched, downloaded, moved or changed.',
    counts: [
      { key: 'would_search', label: 'Would search', value: 41 },
      { key: 'waiting', label: 'Waiting to retry', value: 23 },
      { key: 'unreleased', label: 'Not out yet', value: 2 },
    ],
    sample: [
      { title: 'Harbour Light', detail: 'Pale Harbour · Tidewater · 6 tries' },
      { title: 'Ferry Songs', detail: 'Saltmarsh · Ferry Songs · not tried yet' },
    ],
    sample_total: 41,
    sample_noun: 'track',
    steps: [
      { position: 1, kind: 'action', type: 'process_wishlist', previewed: true, note: null },
      {
        position: 2,
        kind: 'then',
        type: 'discord_webhook',
        previewed: false,
        note: "A preview doesn't send notifications.",
      },
    ],
    previewed_at: Math.floor(NOW / 1000),
    duration_ms: 120,
    recorded: true,
    run_id: 106,
    ...over,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface MockOptions {
  list?: Automation[] | (() => Response | Promise<Response>);
  previewResult?: (id: string) => PreviewResult | Response;
  saveResponse?: () => Response;
}

function mockApi({ list = LIST, previewResult, saveResponse }: MockOptions = {}) {
  const calls: Call[] = [];
  const record = async (request: Request) => {
    const url = new URL(request.url);
    let body: unknown = null;
    if (request.method !== 'GET') body = await request.json().catch(() => null);
    calls.push({ method: request.method, path: url.pathname, body });
    return body;
  };
  const byId = (id: string) => LIST.find((a) => String(a.id) === id);
  server.use(
    http.get('/api/automations/master', () => HttpResponse.json({ music: true, video: true })),
    http.get('/api/automations/progress', () => HttpResponse.json({})),
    http.get('/api/automations/blocks', () => HttpResponse.json(BLOCKS)),
    http.post('/api/automations/preview', async ({ request }) => {
      await record(request);
      return HttpResponse.json(preview({ automation_id: null, recorded: false, run_id: null }));
    }),
    http.post('/api/automations/bulk-toggle', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, updated: 1 });
    }),
    http.get('/api/automations/:id/history', ({ params }) =>
      HttpResponse.json({
        history: params.id === '4' ? FILL_RUNS : [],
        total: params.id === '4' ? FILL_RUNS.length : 0,
        automation_id: Number(params.id),
      }),
    ),
    http.post('/api/automations/:id/preview', async ({ request, params }) => {
      await record(request);
      const result = previewResult
        ? previewResult(String(params.id))
        : preview({ automation_id: Number(params.id) });
      return result instanceof Response ? result : HttpResponse.json(result);
    }),
    http.post('/api/automations/:id/:verb', async ({ request, params }) => {
      await record(request);
      if (params.verb === 'duplicate') return HttpResponse.json({ success: true, id: 99 });
      return HttpResponse.json({ success: true });
    }),
    http.get('/api/automations/:id', ({ params }) => {
      const a = byId(String(params.id));
      return a
        ? HttpResponse.json(a)
        : HttpResponse.json({ error: 'Automation not found' }, { status: 404 });
    }),
    http.put('/api/automations/:id', async ({ request }) => {
      await record(request);
      return saveResponse ? saveResponse() : HttpResponse.json({ success: true });
    }),
    http.delete('/api/automations/:id', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
    http.get('/api/automations', () =>
      typeof list === 'function' ? list() : HttpResponse.json(list),
    ),
    http.post('/api/automations', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, id: 42 });
    }),
    http.get('/api/mirrored-playlists/list', () =>
      HttpResponse.json({ playlists: [], spotify_authenticated: false }),
    ),
    http.get('/api/scripts', () =>
      HttpResponse.json({ scripts: [{ name: 'tidy.sh', extension: '.sh' }] }),
    ),
    http.post('/api/quarantine/clear-preview', async ({ request }) => {
      await record(request);
      return HttpResponse.json({
        success: true,
        plan_id: 'plan-q',
        tool: 'quarantine_clear',
        total: 3,
        files: 2,
        info_files: 1,
        total_bytes: 2048,
        sample: [{ name: 'a.flac.quarantined', path: '/q/a.flac.quarantined', modified: iso(DAY) }],
        created_at: Math.floor(NOW / 1000),
        expires_at: Math.floor(NOW / 1000) + 900,
      });
    }),
    http.post('/api/deleted-files/purge-preview', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, plan_id: null, total: 0, files: 0, sample: [] });
    }),
    http.post('/api/quarantine/clear', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true, removed: 3, files_removed: 2, freed_bytes: 2048 });
    }),
  );
  return calls;
}

async function renderPage(path = '/automations', isAdmin = true) {
  window.SoulSyncWebShellBridge = createShellBridge({
    getCurrentProfileContext: vi.fn(() => ({ profileId: 1, isAdmin })),
  });
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, queryClient });
  const view = render(<AppRouterProvider router={router} queryClient={queryClient} />);
  return { ...view, router, queryClient };
}

async function openMenu(label: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  const button = await screen.findByRole('button', { name: label });
  fireEvent.click(button);
  return waitFor(() => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    return menu!;
  });
}

const card = (id: number) => screen.getByTestId(`automation-card-${id}`);
const search = (router: Awaited<ReturnType<typeof renderPage>>['router']) =>
  router.state.location.search as Record<string, unknown>;

beforeEach(() => {
  window.showToast = vi.fn();
});

afterEach(() => {
  window.SoulSyncWebShellBridge = undefined;
  window.showToast = undefined;
});

describe('automations list', () => {
  it('is owned by React in the manifest', () => {
    expect(getShellRouteByPageId('automations')?.kind).toBe('react');
  });

  it('lists yours first, selects the first, and shows its steps and runs', async () => {
    mockApi();
    await renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Automations' }, { timeout: 5000 });
    await screen.findByTestId('automation-card-4');
    const cards = screen.getAllByTestId(/^automation-card-/).map((el) => el.dataset.testid);
    expect(cards).toEqual([
      'automation-card-4',
      'automation-card-5',
      'automation-card-6',
      'automation-card-8',
      'automation-card-9',
      'automation-card-10',
    ]);
    expect(card(4)).toHaveAttribute('aria-current', 'true');
    expect(
      within(card(4)).getByText("Search for what's due on Wanted, albums and singles in turn"),
    ).toBeInTheDocument();
    expect(within(card(4)).getByText('Send a Discord message')).toBeInTheDocument();
    expect(
      within(card(4)).getByText(/^Every 6 hours · next at \d\d:\d\d · 2 steps$/),
    ).toBeInTheDocument();
    expect(within(card(4)).getByText('On')).toBeInTheDocument();
    expect(within(card(6)).getByText('Paused')).toBeInTheDocument();

    const runs = await screen.findByTestId('runs-panel');
    expect(within(runs).getByRole('heading', { name: 'Runs: Fill Wanted' })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(runs).getByTestId('runs-count')).toHaveTextContent('4 in 30 days'),
    );
    const numbers = within(runs).getByTestId('runs-numbers');
    expect(numbers).toHaveTextContent('Done2');
    expect(numbers).toHaveTextContent('Failed runs1');
    expect(numbers).toHaveTextContent('Typical4 min');
    expect(within(runs).getAllByText('Done').length).toBeGreaterThan(1);
    expect(within(runs).getByText('Failed')).toBeInTheDocument();
    expect(within(runs).getByText('Preview')).toBeInTheDocument();
    expect(
      within(runs).getByText('Preview · Would search 44 · nothing changed'),
    ).toBeInTheDocument();
    expect(within(runs).getByRole('link', { name: 'All runs in Activity' })).toHaveAttribute(
      'href',
      expect.stringContaining('/activity?show=automations'),
    );
    // a run's log opens under it
    fireEvent.click(
      within(runs).getByRole('button', { name: /12 found · 4\smin, Done\. Show its log/ }),
    );
    expect(within(runs).getByText('12 downloads started')).toBeInTheDocument();
  });

  it('carries the anchors the guided tour points at', async () => {
    mockApi();
    await renderPage();
    await screen.findByTestId('automation-card-4');
    await screen.findByTestId('runs-panel');
    expect(document.querySelector('[data-tour="automations-filters"]')).not.toBeNull();
    // only the selected card is the tour's card, with its Preview a run
    expect(document.querySelectorAll('[data-tour="automation-card"]')).toHaveLength(1);
    expect(document.querySelector('[data-tour="automation-card"]')).toBe(card(4));
    expect(within(card(4)).getByRole('button', { name: 'Preview a run' })).toHaveAttribute(
      'data-tour',
      'automation-preview',
    );
    expect(document.querySelector('[data-tour="automation-runs"]')).toBe(
      screen.getByTestId('runs-panel'),
    );
    expect(screen.getByRole('button', { name: 'New automation' })).toHaveAttribute(
      'data-tour',
      'automation-new',
    );
  });

  it('selecting a card puts it in the URL, and a link opens with it selected', async () => {
    mockApi();
    const { router } = await renderPage();
    await screen.findByTestId('automation-card-5', undefined, { timeout: 5000 });
    fireEvent.click(
      screen.getByRole('button', { name: 'Check followed artists: show its steps and runs' }),
    );
    await waitFor(() => expect(search(router).automation).toBe(5));
    expect(card(5)).toHaveAttribute('aria-current', 'true');
    expect(
      await screen.findByRole('heading', { name: 'Runs: Check followed artists' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Added to Wanted')).toBeInTheDocument();
  });

  it('opens on the automation a link names', async () => {
    mockApi();
    await renderPage('/automations?automation=6');
    await screen.findByTestId('automation-card-6', undefined, { timeout: 5000 });
    await waitFor(() => expect(card(6)).toHaveAttribute('aria-current', 'true'));
    expect(within(card(6)).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(within(card(6)).queryByRole('button', { name: 'Run now' })).toBeNull();
  });

  it('pauses from the menu and resumes from a paused card', async () => {
    const calls = mockApi();
    await renderPage();
    await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
    const menu = await openMenu('More for Fill Wanted');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Pause this automation' }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/api/automations/4/toggle' }),
      ),
    );
    expect(window.showToast).toHaveBeenCalledWith('“Fill Wanted” is paused.', 'success');
    fireEvent.click(within(card(6)).getByRole('button', { name: 'Resume Upgrade to FLAC' }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/api/automations/6/toggle' }),
      ),
    );
  });

  it('shows a run in progress live, with what it is doing', async () => {
    mockApi();
    await renderPage();
    await screen.findByTestId('runs-panel', undefined, { timeout: 5000 });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('ss:automation-progress', {
          detail: {
            4: {
              status: 'running',
              phase: 'Searching albums',
              progress: 40,
              log: [{ type: 'info', text: '35 tracks to search' }],
            },
          },
        }),
      );
    });
    expect(within(card(4)).getByText('Running')).toBeInTheDocument();
    expect(within(card(4)).getByText('Running now · Searching albums · 40%')).toBeInTheDocument();
    const runs = screen.getByTestId('runs-panel');
    fireEvent.click(
      within(runs).getByRole('button', { name: /Running now: Searching albums · 40%/ }),
    );
    expect(within(runs).getByText('35 tracks to search')).toBeInTheDocument();
  });

  it('Run now starts the automation', async () => {
    const calls = mockApi();
    await renderPage();
    await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
    fireEvent.click(within(card(4)).getByRole('button', { name: 'Run now' }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'POST', path: '/api/automations/4/run' }),
      ),
    );
    expect(window.showToast).toHaveBeenCalledWith(
      expect.stringContaining('“Fill Wanted” is running.'),
      'success',
    );
  });

  it('Run now on a step that deletes files previews first and confirms against the plan', async () => {
    const calls = mockApi();
    await renderPage('/automations?automation=8');
    await waitFor(() => expect(card(8)).toHaveAttribute('aria-current', 'true'), { timeout: 5000 });
    expect(
      within(card(8)).getByText(/Run now shows the list and asks before anything changes/),
    ).toBeInTheDocument();
    fireEvent.click(within(card(8)).getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Permanently delete 2 files/)).toBeInTheDocument();
    expect(within(dialog).getByText(/This can't be undone/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/automations/8/run')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 files permanently' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/api/quarantine/clear',
        body: { plan_id: 'plan-q' },
      }),
    );
    expect(await within(dialog).findByText('Deleted for good')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/automations/8/run')).toBe(false);
  });

  it('Weekly Cleanup runs its two halves through preview-then-confirm, one after the other', async () => {
    const calls = mockApi();
    await renderPage('/automations?automation=10');
    await waitFor(() => expect(card(10)).toHaveAttribute('aria-current', 'true'), {
      timeout: 5000,
    });
    fireEvent.click(within(card(10)).getByRole('button', { name: 'Run now' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 files permanently' }));
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Next: empty the recycle bin' }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/api/deleted-files/purge-preview',
        body: { retention: true },
      }),
    );
    expect(calls.some((c) => c.path === '/api/automations/10/run')).toBe(false);
  });

  it('puts an automation in a group and deletes one after asking', async () => {
    const calls = mockApi();
    await renderPage();
    await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
    let menu = await openMenu('More for Fill Wanted');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Put in a group…' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Group name'), { target: { value: 'Nightly' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: '/api/automations/4',
        body: { group_name: 'Nightly' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    menu = await openMenu('More for Fill Wanted');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete…' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete “Fill Wanted”?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete automation' }));
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'DELETE', path: '/api/automations/4' }),
      ),
    );
  });

  it('Preview a run shows what a run would do, and records it as a run', async () => {
    const calls = mockApi();
    await renderPage();
    await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
    fireEvent.click(within(card(4)).getByRole('button', { name: 'Preview a run' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Preview: Fill Wanted')).toBeInTheDocument();
    expect(await within(dialog).findByText('Would search')).toBeInTheDocument();
    expect(within(dialog).getByText('41')).toBeInTheDocument();
    expect(within(dialog).getByText('Harbour Light')).toBeInTheDocument();
    expect(within(dialog).getByText('2 of 41 tracks shown')).toBeInTheDocument();
    expect(
      within(dialog).getByText("Step 2: A preview doesn't send notifications."),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({ method: 'POST', path: '/api/automations/4/preview', body: {} });
  });

  it('says when a preview isn’t available, and when it failed', async () => {
    mockApi({
      previewResult: (id) =>
        id === '5'
          ? preview({
              automation_id: 5,
              available: false,
              reason: 'The metadata source isn’t ready.',
              counts: undefined,
              sample: undefined,
            })
          : HttpResponse.json({ success: false, error: 'database is locked' }, { status: 500 }),
    });
    await renderPage('/automations?automation=5');
    await waitFor(() => expect(card(5)).toHaveAttribute('aria-current', 'true'), { timeout: 5000 });
    fireEvent.click(within(card(5)).getByRole('button', { name: 'Preview a run' }));
    let dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText("Can't be previewed")).toBeInTheDocument();
    expect(within(dialog).getByText('The metadata source isn’t ready.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Fill Wanted: show its steps and runs' }));
    await waitFor(() => expect(card(4)).toHaveAttribute('aria-current', 'true'));
    fireEvent.click(within(card(4)).getByRole('button', { name: 'Preview a run' }));
    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText("Couldn't preview this run")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/database is locked\. Nothing was changed\./),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps the filter in the URL', async () => {
    mockApi();
    const { router } = await renderPage();
    await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /^Paused/ }));
    await waitFor(() => expect(search(router).show).toBe('paused'));
    expect(screen.getAllByTestId(/^automation-card-/).map((el) => el.dataset.testid)).toEqual([
      'automation-card-6',
    ]);
  });

  it('lands an old ?health= link on the matching filter', async () => {
    mockApi();
    await renderPage('/automations?health=off');
    await screen.findByTestId('automation-card-6', undefined, { timeout: 5000 });
    expect(screen.getByRole('button', { name: /^Paused/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says it is loading, and a failed load offers Try again over faded placeholders', async () => {
    let fail = true;
    mockApi({
      list: () =>
        fail
          ? HttpResponse.json({ error: 'database is locked' }, { status: 500 })
          : HttpResponse.json(LIST),
    });
    await renderPage();
    const notice = await screen.findByText('Couldn’t load your automations', undefined, {
      timeout: 5000,
    });
    expect(notice.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Run Setup check' })).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('automation-card-4')).toBeInTheDocument();
  });

  it('shows the loading state in words', async () => {
    mockApi({ list: () => new Promise<Response>(() => {}) });
    await renderPage();
    expect(
      await screen.findByText('Loading your automations…', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Automations' })).toBeInTheDocument();
  });

  it('still respects the page permission gate', async () => {
    mockApi();
    window.SoulSyncWebShellBridge = createShellBridge({ isPageAllowed: vi.fn(() => false) });
    const queryClient = createTestQueryClient();
    const history = createMemoryHistory({ initialEntries: ['/automations'] });
    const router = createAppRouter({ history, queryClient });
    render(<AppRouterProvider router={router} queryClient={queryClient} />);
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/automations'));
  });
});

describe('automation editor', () => {
  it('loads the automation and saves a new schedule onto the engine trigger', async () => {
    const calls = mockApi();
    const { router } = await renderPage('/automations/4/edit');
    const name = await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    expect(name).toHaveValue('Fill Wanted');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Automations›Edit',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Daily at…' }));
    fireEvent.change(screen.getByLabelText('At'), { target: { value: '06:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/api/automations/4');
    expect(put.body).toMatchObject({
      name: 'Fill Wanted',
      trigger_type: 'daily_time',
      trigger_config: { time: '06:15' },
      action_type: 'process_wishlist',
      then_actions: [{ type: 'discord_webhook' }],
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/automations'));
    expect(search(router).automation).toBe(4);
  });

  it('edits the steps: add, move, duplicate and remove, saved in order', async () => {
    const calls = mockApi();
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Fire a signal' }));
    const signal = await screen.findByLabelText('Signal name');
    fireEvent.change(signal, { target: { value: 'Library Ready' } });
    fireEvent.blur(signal);
    expect(signal).toHaveValue('library_ready');
    let menu = await openMenu('More for step 3');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() =>
      expect(screen.getByTestId('step-2')).toContainElement(screen.getByLabelText('Signal name')),
    );
    menu = await openMenu('More for step 3');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }));
    await screen.findByTestId('step-4');
    menu = await openMenu('More for step 4');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('step-4')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as {
      then_actions: { type: string; config: Record<string, unknown> }[];
    };
    expect(body.then_actions.map((t) => t.type)).toEqual(['fire_signal', 'discord_webhook']);
    expect(body.then_actions[0].config).toEqual({ signal_name: 'library_ready' });
  });

  it('stops a save that misses something, and says what', async () => {
    const calls = mockApi();
    await renderPage('/automations/4/edit');
    const name = await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Notify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Give the automation a name.')).toBeInTheDocument();
    expect(screen.getByText('Add the webhook URL.')).toBeInTheDocument();
    expect(screen.getByText('Fix the 2 things marked below, then save.')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('says a failed save didn’t change anything', async () => {
    mockApi({
      saveResponse: () => HttpResponse.json({ error: 'database is locked' }, { status: 500 }),
    });
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Couldn’t save the automation')).toBeInTheDocument();
    expect(screen.getByText(/database is locked\. Nothing was changed\./)).toBeInTheDocument();
  });

  it('previews the unsaved steps in the panel, or says why it can’t', async () => {
    const calls = mockApi({
      previewResult: (id) => {
        const last = calls[calls.length - 1]?.body as { action_type?: string } | null;
        return last?.action_type === 'scan_library'
          ? preview({
              automation_id: Number(id),
              available: false,
              reason: 'It asks your media server to rescan.',
            })
          : preview({ automation_id: Number(id) });
      },
    });
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    const panel = screen.getByTestId('preview-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview a run' }));
    expect(await within(panel).findByText('Would search')).toBeInTheDocument();
    expect(within(panel).getByText('Harbour Light')).toBeInTheDocument();
    const sent = calls.find((c) => c.path === '/api/automations/4/preview')!;
    expect(sent.body).toMatchObject({
      action_type: 'process_wishlist',
      then_actions: [{ type: 'discord_webhook' }],
    });

    fireEvent.change(screen.getByLabelText('Step 1: what it does'), {
      target: { value: 'scan_library' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview a run' })[0]);
    expect(await within(panel).findByText("Can't be previewed")).toBeInTheDocument();
    expect(within(panel).getByText('It asks your media server to rescan.')).toBeInTheDocument();
    // unsaved changes: Run this now runs the saved steps, so it waits for a save
    expect(within(panel).getByRole('button', { name: 'Run this now' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      within(panel).getByText('Save first: Run this now runs the steps as saved.'),
    ).toBeInTheDocument();
  });

  it('says when a preview failed', async () => {
    mockApi({
      previewResult: () =>
        HttpResponse.json({ success: false, error: 'database is locked' }, { status: 500 }),
    });
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    const panel = screen.getByTestId('preview-panel');
    fireEvent.click(within(panel).getByRole('button', { name: 'Preview a run' }));
    expect(await within(panel).findByText("Couldn't preview this run")).toBeInTheDocument();
  });

  it('makes a new automation', async () => {
    const calls = mockApi();
    const { router } = await renderPage('/automations/new');
    const name = await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    expect(screen.getByRole('heading', { level: 1, name: 'New automation' })).toBeInTheDocument();
    fireEvent.change(name, { target: { value: 'Night search' } });
    fireEvent.change(screen.getByLabelText('Step 1: what it does'), {
      target: { value: 'process_wishlist' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/automations')).toBe(true),
    );
    expect(calls.find((c) => c.path === '/api/automations')!.body).toMatchObject({
      name: 'Night search',
      trigger_type: 'schedule',
      trigger_config: { interval: 6, unit: 'hours' },
      action_type: 'process_wishlist',
      then_actions: [],
      group_name: null,
    });
    await waitFor(() => expect(search(router).automation).toBe(42));
  });
});
