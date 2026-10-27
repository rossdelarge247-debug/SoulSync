import { createMemoryHistory } from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { getShellRouteByPageId } from '@/platform/shell/route-manifest';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

import type { AiStatus, ListSuggestion } from './-automations.assistant';
import type { Automation, AutomationBlocks, PreviewResult, RunEntry } from './-automations.types';

import { _resetConversationsForTests } from './-automations.conversation';

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
  ai?: {
    status?: Partial<AiStatus>;
    suggestion?: ListSuggestion | null;
    assistant?: (body: unknown) => Response;
  };
}

const AI_READY: AiStatus = {
  configured: true,
  can_use: true,
  reason: null,
  model: 'fast',
  provider: 'anthropic',
  provider_name: 'Anthropic',
};
const AI_NOT_SET_UP: AiStatus = {
  ...AI_READY,
  configured: false,
  can_use: false,
  reason: 'not_configured',
};

/** A server-sent event stream, as POST /api/ai/assistant sends it. */
function sse(frames: [string, unknown][]): Response {
  const text = frames.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  return new HttpResponse(`: open\n\n${text.join('')}`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function mockApi({ list = LIST, previewResult, saveResponse, ai = {} }: MockOptions = {}) {
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
    http.get('/api/ai/status', () => HttpResponse.json({ ...AI_NOT_SET_UP, ...ai.status })),
    http.get('/api/ai/suggestion', () => HttpResponse.json({ suggestion: ai.suggestion ?? null })),
    http.post('/api/ai/suggestion/:key/dismiss', async ({ request }) => {
      await record(request);
      return HttpResponse.json({ success: true });
    }),
    http.post('/api/ai/assistant', async ({ request }) => {
      const body = await record(request);
      return ai.assistant
        ? ai.assistant(body)
        : sse([['done', { conversation_id: 'c1', usage: {} }]]);
    }),
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

/** Open the "/" menu on the empty follow-up line and pick one. */
function addFollowUp(label: string) {
  fireEvent.change(screen.getByRole('combobox', { name: /Add a follow-up/ }), {
    target: { value: '/' },
  });
  const menu = screen.getByRole('menu', { name: 'Add a follow-up' });
  fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(`^${label}`) }));
}

const card = (id: number) => screen.getByTestId(`automation-card-${id}`);
const search = (router: Awaited<ReturnType<typeof renderPage>>['router']) =>
  router.state.location.search as Record<string, unknown>;

beforeEach(() => {
  window.showToast = vi.fn();
});

afterEach(() => {
  _resetConversationsForTests();
  window.localStorage.clear();
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
      // "next tomorrow at …" once the next run is past midnight (the suite runs in Los Angeles time)
      within(card(4)).getByText(/^Every 6 hours · next (tomorrow )?at \d\d:\d\d · 2 steps$/),
    ).toBeInTheDocument();
    expect(within(card(4)).getByText('On')).toBeInTheDocument();
    expect(within(card(6)).getByText('Paused')).toBeInTheDocument();
    // the built-in ones say so on their schedule line, so they stand out under All
    expect(within(card(9)).getByText('Built-in · Every 3 days · 1 step')).toBeInTheDocument();
    expect(within(card(10)).getByText(/^Built-in · Every 7 days/)).toBeInTheDocument();
    expect(within(card(4)).queryByText(/Built-in/)).toBeNull();

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
    fireEvent.change(screen.getByRole('combobox', { name: 'When' }), {
      target: { value: 'daily' },
    });
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

  it('edits the follow-ups: add from the / menu, move, duplicate and remove, saved in order', async () => {
    const calls = mockApi();
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    // one When, one Do, then the Then blocks
    expect(screen.getAllByRole('combobox', { name: 'When' })).toHaveLength(1);
    expect(screen.getAllByLabelText('Do: what it does')).toHaveLength(1);
    expect(screen.getByTestId('block-then-1')).toBeInTheDocument();
    addFollowUp('Fire a signal');
    const signal = await screen.findByLabelText('Signal name');
    fireEvent.change(signal, { target: { value: 'Library Ready' } });
    fireEvent.blur(signal);
    expect(signal).toHaveValue('library_ready');
    let menu = await openMenu('More for Then 2');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() =>
      expect(screen.getByTestId('block-then-1')).toContainElement(
        screen.getByLabelText('Signal name'),
      ),
    );
    menu = await openMenu('More for Then 2');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }));
    await screen.findByTestId('block-then-3');
    // three is the most: the / line says so and offers nothing
    expect(
      screen.getByText(
        'Three follow-ups is the most an automation can have. Remove one to add another.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Add a follow-up/ })).toBeNull();
    menu = await openMenu('More for Then 3');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('block-then-3')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as {
      then_actions: { type: string; config: Record<string, unknown> }[];
    };
    expect(body.then_actions.map((t) => t.type)).toEqual(['fire_signal', 'discord_webhook']);
    expect(body.then_actions[0].config).toEqual({ signal_name: 'library_ready' });
    expect(body).not.toHaveProperty('assistant_draft');
    // the whole editor mounts and every block is typed into: on a slow or
    // busy runner it can pass 15 s, so this one has more time; the steps and
    // what's saved are checked the same
  }, 45_000);

  it('reorders the Then blocks by dragging, and from the handle with the keyboard', async () => {
    const calls = mockApi();
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    addFollowUp('Fire a signal');
    fireEvent.change(await screen.findByLabelText('Signal name'), {
      target: { value: 'ready' },
    });
    // drag Then 2 onto Then 1
    const handle = screen.getByRole('button', { name: 'Move Then 2 (2 of 2)' });
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('block-then-1'), { dataTransfer });
    expect(screen.getByTestId('block-then-1')).toHaveAttribute('data-drop', 'true');
    fireEvent.drop(screen.getByTestId('block-then-1'), { dataTransfer });
    await waitFor(() =>
      expect(screen.getByTestId('block-then-1')).toContainElement(
        screen.getByLabelText('Signal name'),
      ),
    );
    // and back down from the handle's own menu
    const menu = await openMenu('Move Then 1 (1 of 2)');
    expect(within(menu).getByRole('menuitem', { name: 'Move up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() =>
      expect(screen.getByTestId('block-then-2')).toContainElement(
        screen.getByLabelText('Signal name'),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as {
      then_actions: { type: string }[];
    };
    expect(body.then_actions.map((t) => t.type)).toEqual(['discord_webhook', 'fire_signal']);
  });

  it('the / menu narrows as you type, works from the keyboard, and closes on Escape', async () => {
    mockApi();
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    const line = screen.getByRole('combobox', { name: /Add a follow-up/ });
    expect(line).toHaveAttribute('placeholder', 'Type / to add a follow-up · 2 of 3 left');
    fireEvent.change(line, { target: { value: '/' } });
    let menu = screen.getByRole('menu', { name: 'Add a follow-up' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.firstChild?.textContent),
    ).toEqual(['Notify', 'Fire a signal', 'Run a script']);
    fireEvent.keyDown(line, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Add a follow-up' })).toBeNull();
    fireEvent.change(line, { target: { value: '/scr' } });
    menu = screen.getByRole('menu', { name: 'Add a follow-up' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.keyDown(line, { key: 'Enter' });
    expect(await screen.findByLabelText('Then 2: what it does')).toHaveValue('run_script');
  });

  it('keeps admin-only steps away from members', async () => {
    mockApi();
    await renderPage('/automations/new', false);
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    const doSelect = screen.getByLabelText('Do: what it does');
    await waitFor(() => expect(within(doSelect).getAllByRole('option').length).toBeGreaterThan(1));
    const actions = within(doSelect)
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(actions).toContain('process_wishlist');
    expect(actions).not.toContain('clear_quarantine');
    expect(actions).not.toContain('apply_quality_upgrades');
    fireEvent.change(screen.getByRole('combobox', { name: /Add a follow-up/ }), {
      target: { value: '/' },
    });
    const menu = screen.getByRole('menu', { name: 'Add a follow-up' });
    expect(within(menu).queryByText('Run a script')).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Notify/ }));
    const then = await screen.findByLabelText('Then 1: what it does');
    expect(within(then).queryByRole('option', { name: /script/i })).toBeNull();
  });

  it('keeps the full builder in the header’s … menu only', async () => {
    mockApi();
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    const menu = await openMenu('More for this automation');
    expect(within(menu).getByRole('menuitem', { name: 'Open in the full builder' })).toBeTruthy();
  });

  it('stops a save that misses something, and says what', async () => {
    const calls = mockApi();
    await renderPage('/automations/4/edit');
    const name = await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    fireEvent.change(name, { target: { value: '   ' } });
    addFollowUp('Notify');
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

    fireEvent.change(screen.getByLabelText('Do: what it does'), {
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
    fireEvent.change(screen.getByLabelText('Do: what it does'), {
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

const OFFER = {
  draft: {
    name: 'Morning Wanted search',
    trigger_type: 'daily_time',
    trigger_config: { time: '07:00' },
    action_type: 'process_wishlist',
    action_config: {},
    then_actions: [{ type: 'fire_signal', config: { signal_name: 'wanted_done' } }],
  },
  summary: 'Search Wanted every morning at 07:00, then fire wanted_done.',
  why: 'Your downloads are quiet in the morning.',
  facts: [],
  notes: ['I left out “Run a script”: only admins can add it.'],
  automation_id: null,
};

async function openAssistant() {
  await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
  fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
  return screen.findByTestId('assistant-panel');
}

describe('the Assistant', () => {
  it('says what to do when it isn’t set up, to admins and to members', async () => {
    mockApi();
    const { unmount } = await renderPage();
    let panel = await openAssistant();
    // the panel takes the Runs column's place
    expect(screen.queryByTestId('runs-panel')).toBeNull();
    expect(await within(panel).findByText('Set up the Assistant')).toBeInTheDocument();
    expect(within(panel).getByText('Open Settings → AI')).toBeInTheDocument();
    expect(within(panel).queryByLabelText('Message the Assistant')).toBeNull();
    // no suggestion card, and no Explain, while it can't be used
    expect(screen.queryByTestId('suggestion-card')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Explain Fill Wanted' })).toBeNull();
    unmount();
    _resetConversationsForTests();

    mockApi();
    await renderPage('/automations', false);
    panel = await openAssistant();
    expect(await within(panel).findByText('Ask an admin to set this up')).toBeInTheDocument();
    expect(within(panel).queryByText('Open Settings → AI')).toBeNull();
  });

  it('drafts from a sentence, and the draft opens in the editor unsaved', async () => {
    const calls = mockApi({
      ai: {
        status: AI_READY,
        assistant: () =>
          sse([
            ['status', { reading: 'your automations' }],
            ['text', { delta: 'Here is a draft.' }],
            ['draft', OFFER],
            ['done', { conversation_id: 'c1', usage: { input_tokens: 1, output_tokens: 1 } }],
          ]),
      },
    });
    const { router } = await renderPage();
    const panel = await openAssistant();
    // the first-use notice says what is sent where, until Got it
    const notice = await within(panel).findByTestId('assistant-first-use');
    expect(notice).toHaveTextContent('Anthropic');
    fireEvent.click(within(notice).getByRole('button', { name: 'Got it' }));
    expect(within(panel).queryByTestId('assistant-first-use')).toBeNull();
    expect(
      within(panel).getByText(
        'Writes drafts only. Sends your message, your automations and the library facts it uses to Anthropic (Settings → AI).',
      ),
    ).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText('Message the Assistant'), {
      target: { value: 'Search Wanted every morning' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    const card = await within(panel).findByTestId('draft-card');
    expect(within(card).getByText('Draft ready')).toBeInTheDocument();
    expect(within(card).getByText(OFFER.summary)).toBeInTheDocument();
    expect(within(card).getByText(OFFER.notes[0])).toBeInTheDocument();
    // a new automation's draft may suggest the name (HANDOFF 38)
    expect(within(card).getByText('Morning Wanted search (you can change it)')).toBeInTheDocument();
    expect(within(panel).getByText('Here is a draft.')).toBeInTheDocument();
    const sent = calls.find((c) => c.path === '/api/ai/assistant')!.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      message: 'Search Wanted every morning',
      context: { page: 'list' },
    });
    // nothing was saved by asking
    expect(calls.some((c) => c.path === '/api/automations' && c.method === 'POST')).toBe(false);

    fireEvent.click(within(card).getByRole('button', { name: 'Open in the editor' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/automations/new'));
    expect(await screen.findByLabelText('Name', undefined, { timeout: 5000 })).toHaveValue(
      'Morning Wanted search',
    );
    expect(screen.getByText('Draft from the Assistant.')).toBeInTheDocument();
    expect(screen.getByLabelText('Signal name')).toHaveValue('wanted_done');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/automations')).toBe(true),
    );
    expect(calls.find((c) => c.path === '/api/automations')!.body).toMatchObject({
      name: 'Morning Wanted search',
      trigger_type: 'daily_time',
      trigger_config: { time: '07:00' },
      action_type: 'process_wishlist',
      then_actions: [{ type: 'fire_signal', config: { signal_name: 'wanted_done' } }],
      assistant_draft: true,
    });
  });

  it('keeps the message in the box when the provider refuses, and says why', async () => {
    mockApi({
      ai: {
        status: AI_READY,
        assistant: () =>
          sse([['error', { code: 'bad_key', message: 'Anthropic refused the key.' }]]),
      },
    });
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage();
    const panel = await openAssistant();
    const box = await within(panel).findByLabelText('Message the Assistant');
    fireEvent.change(box, { target: { value: 'Explain my automations' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await within(panel).findByText('The AI key didn’t work')).toBeInTheDocument();
    expect(within(panel).getByRole('alert')).toHaveTextContent('Open Settings → AI');
    await waitFor(() => expect(box).toHaveValue('Explain my automations'));
  });

  it('Stop ends the answer and says nothing changed', async () => {
    mockApi({
      ai: {
        status: AI_READY,
        assistant: () =>
          new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: status\ndata: {"reading":"your runs"}\n\n'),
                );
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      },
    });
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage();
    const panel = await openAssistant();
    fireEvent.click(await within(panel).findByRole('button', { name: 'What’s worth automating?' }));
    expect(await within(panel).findByText('Thinking… reading your runs.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Send' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop' }));
    expect(await within(panel).findByText('Stopped. Nothing was changed.')).toBeInTheDocument();
  });

  it('shows one suggestion first in the list, and Not now puts it away', async () => {
    const calls = mockApi({
      ai: {
        status: AI_READY,
        suggestion: {
          key: 'paused:6',
          title: 'Upgrade to FLAC has been paused for 21 days',
          reason: 'Paused since 1 Oct; 21 days without a run.',
          draft_prompt: 'Should Upgrade to FLAC run again?',
          automation_id: 6,
        },
      },
    });
    await renderPage();
    const suggestion = await screen.findByTestId('suggestion-card', undefined, { timeout: 5000 });
    const cards = screen.getByTestId('automation-card-4').parentElement!;
    expect(cards.firstElementChild).toBe(suggestion);
    expect(
      within(suggestion).getByText('Upgrade to FLAC has been paused for 21 days'),
    ).toBeInTheDocument();
    fireEvent.click(within(suggestion).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByTestId('suggestion-card')).toBeNull());
    expect(calls.some((c) => c.path === '/api/ai/suggestion/paused%3A6/dismiss')).toBe(true);
  });

  it('explains an automation and a failed run, sending what is on screen', async () => {
    const calls = mockApi({
      ai: {
        status: AI_READY,
        assistant: (body) =>
          (body as { context: { run_id?: number } }).context.run_id
            ? sse([
                ['quote', { run_id: 103, started_at: null, lines: ["Soulseek wasn't reachable"] }],
                ['text', { delta: 'Soulseek was down.' }],
                ['done', { conversation_id: 'c1', usage: {} }],
              ])
            : sse([
                ['text', { delta: 'It searches Wanted every 6 hours.' }],
                ['done', { conversation_id: 'c1', usage: {} }],
              ]),
      },
    });
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Explain Fill Wanted' }, { timeout: 5000 }),
    );
    const panel = await screen.findByTestId('assistant-panel');
    expect(await within(panel).findByText('It searches Wanted every 6 hours.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/ai/assistant')!.body).toMatchObject({
      context: { page: 'list', automation_id: 4 },
    });

    // close the panel: the Runs come back, and a failed run offers the question
    fireEvent.click(within(panel).getByRole('button', { name: 'Close the Assistant' }));
    const runs = await screen.findByTestId('runs-panel');
    fireEvent.click(
      await within(runs).findByRole('button', { name: 'Ask the Assistant why it failed' }),
    );
    const again = await screen.findByTestId('assistant-panel');
    expect(await within(again).findByText('Soulseek was down.')).toBeInTheDocument();
    expect(within(again).getByLabelText('The run’s log')).toHaveTextContent(
      "Soulseek wasn't reachable",
    );
    const asked = calls.filter((c) => c.path === '/api/ai/assistant');
    expect(asked[1].body).toMatchObject({ context: { automation_id: 4, run_id: 103 } });
  });
});

describe('the Assistant in the editor', () => {
  it('sits beside Preview, sends the draft on screen, and asks before replacing changes', async () => {
    const calls = mockApi({
      ai: {
        status: AI_READY,
        assistant: () =>
          sse([
            ['draft', { ...OFFER, automation_id: 4 }],
            ['done', { conversation_id: 'c1', usage: {} }],
          ]),
      },
    });
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage('/automations/4/edit');
    const name = await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    // closed, the column is Preview; the header's Assistant opens the tabs
    expect(screen.queryByRole('tablist', { name: 'Assistant and Preview' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    const panel = await screen.findByTestId('assistant-panel');
    const tabs = screen.getByRole('tablist', { name: 'Assistant and Preview' });
    expect(within(tabs).getByRole('tab', { name: 'Assistant' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      within(panel).getByText(
        'Writes drafts only. Sends your message, this draft and the library facts it uses to Anthropic (Settings → AI).',
      ),
    ).toBeInTheDocument();
    fireEvent.change(name, { target: { value: 'Fill Wanted nightly' } });
    fireEvent.change(within(panel).getByLabelText('Message the Assistant'), {
      target: { value: 'Run it every morning instead' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    const card = await within(panel).findByTestId('draft-card');
    expect(calls.find((c) => c.path === '/api/ai/assistant')!.body).toMatchObject({
      context: {
        page: 'editor',
        automation_id: 4,
        draft: { name: 'Fill Wanted nightly', action_type: 'process_wishlist' },
      },
    });
    // an existing automation's name is yours: the card says so (HANDOFF 38)
    expect(within(card).getByText('Keeps your name')).toBeInTheDocument();
    expect(within(card).queryByText(/Morning Wanted search/)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Put it in the editor' }));
    const dialog = await screen.findByRole('dialog', { name: 'Put the draft in the editor?' });
    expect(dialog).toHaveTextContent('Put the draft in the editor?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use the draft' }));
    expect(await screen.findByText('Draft from the Assistant.')).toBeInTheDocument();
    // the blocks are the draft's; the name on screen stays
    expect(screen.getByLabelText('Name')).toHaveValue('Fill Wanted nightly');
    expect(screen.getByLabelText('Signal name')).toHaveValue('wanted_done');
    // nothing saved until Save
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      name: 'Fill Wanted nightly',
      trigger_type: 'daily_time',
      then_actions: [{ type: 'fire_signal' }],
      assistant_draft: true,
    });
  });
});

describe('the Assistant and the name (HANDOFF 38)', () => {
  const ready = () =>
    mockApi({
      ai: {
        status: AI_READY,
        assistant: () =>
          sse([
            ['draft', OFFER],
            ['done', { conversation_id: 'c1', usage: {} }],
          ]),
      },
    });
  const askAndUse = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    const panel = await screen.findByTestId('assistant-panel');
    fireEvent.change(within(panel).getByLabelText('Message the Assistant'), {
      target: { value: 'Search Wanted every morning' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    const card = await within(panel).findByTestId('draft-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Put it in the editor' }));
    // it asks first only when there are changes to replace
    const dialog = screen.queryByRole('dialog', { name: 'Put the draft in the editor?' });
    if (dialog) fireEvent.click(within(dialog).getByRole('button', { name: 'Use the draft' }));
    await screen.findByText('Draft from the Assistant.');
  };

  it('fills an empty Name on a new automation, and it stays editable', async () => {
    ready();
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage('/automations/new');
    const name = await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    fireEvent.change(screen.getByLabelText('Do: what it does'), {
      target: { value: 'process_wishlist' },
    });
    await askAndUse();
    expect(name).toHaveValue('Morning Wanted search');
    fireEvent.change(name, { target: { value: 'Mine' } });
    expect(name).toHaveValue('Mine');
  });

  it('never replaces a name you typed on a new automation', async () => {
    ready();
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage('/automations/new');
    const name = await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    fireEvent.change(name, { target: { value: 'Early search' } });
    await askAndUse();
    expect(name).toHaveValue('Early search');
  });
});

describe('the / line asks the Assistant (HANDOFF 40)', () => {
  it('sends what was typed after "/" straight away', async () => {
    const calls = mockApi({
      ai: {
        status: AI_READY,
        assistant: () => sse([['done', { conversation_id: 'c1', usage: {} }]]),
      },
    });
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    const line = screen.getByRole('combobox', { name: /Add a follow-up/ });
    fireEvent.change(line, { target: { value: '/tells me on discord when it finds 5' } });
    const menu = screen.getByRole('menu', { name: 'Add a follow-up' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Ask the Assistant/ }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/ai/assistant')).toBe(true));
    expect(calls.find((c) => c.path === '/api/ai/assistant')!.body).toMatchObject({
      message: 'Add a follow-up that tells me on discord when it finds 5',
      context: { page: 'editor', automation_id: 4 },
    });
    const panel = await screen.findByTestId('assistant-panel');
    expect(within(panel).getByLabelText('Message the Assistant')).toHaveValue('');
  });

  it('opens the panel with the start in the box for a bare "/"', async () => {
    const calls = mockApi({ ai: { status: AI_READY } });
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    fireEvent.change(screen.getByRole('combobox', { name: /Add a follow-up/ }), {
      target: { value: '/' },
    });
    const menu = screen.getByRole('menu', { name: 'Add a follow-up' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Ask the Assistant/ }));
    const panel = await screen.findByTestId('assistant-panel');
    expect(within(panel).getByLabelText('Message the Assistant')).toHaveValue(
      'Add a follow-up that ',
    );
    expect(calls.some((c) => c.path === '/api/ai/assistant')).toBe(false);
  });

  it('waits for the first-use note before sending anything', async () => {
    const calls = mockApi({ ai: { status: AI_READY } });
    await renderPage('/automations/4/edit');
    await screen.findByLabelText('Name', undefined, { timeout: 5000 });
    fireEvent.change(screen.getByRole('combobox', { name: /Add a follow-up/ }), {
      target: { value: '/pings me' },
    });
    const menu = screen.getByRole('menu', { name: 'Add a follow-up' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Ask the Assistant/ }));
    const panel = await screen.findByTestId('assistant-panel');
    expect(within(panel).getByLabelText('Message the Assistant')).toHaveValue(
      'Add a follow-up that pings me',
    );
    expect(calls.some((c) => c.path === '/api/ai/assistant')).toBe(false);
  });
});

describe('automations on a phone', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    // @ts-expect-error jsdom has none; the tests above run without it
    delete window.matchMedia;
  });

  it('folds the search into a button at the end of the filter row', async () => {
    mockApi();
    await renderPage();
    await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
    expect(screen.queryByRole('searchbox', { name: 'Find an automation' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Find an automation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('searchbox', { name: 'Find an automation' })).toBeInTheDocument();
  });

  it('opens the Assistant as a full-screen sheet', async () => {
    mockApi({ ai: { status: AI_READY } });
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage();
    await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveAttribute('data-variant', 'sheet');
    expect(within(sheet).getByText('Drafts only · sent to Anthropic (Settings → AI)')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('puts New chat in the sheet’s header as a 44px icon button (HANDOFF 37)', async () => {
    mockApi({
      ai: {
        status: AI_READY,
        assistant: () =>
          sse([
            ['text', { delta: 'Hello.' }],
            ['done', { conversation_id: 'c1', usage: {} }],
          ]),
      },
    });
    window.localStorage.setItem('soulsync.assistant.firstUse.1', '1');
    await renderPage();
    await screen.findByTestId('automation-card-4', undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText('Message the Assistant'), {
      target: { value: 'Hi' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Send' }));
    await within(sheet).findByText('Hello.');
    const newChat = within(sheet).getByRole('button', { name: 'New chat' });
    // an icon, not the word: between the title and Close
    expect(newChat.textContent).toBe('');
    expect(newChat.querySelector('svg')).not.toBeNull();
    const head = newChat.closest('div')!.parentElement!;
    const order = [...head.querySelectorAll('h2, button')].map(
      (el) => el.getAttribute('aria-label') ?? el.textContent,
    );
    expect(order).toEqual(['Assistant', 'New chat', 'Close the Assistant']);
    fireEvent.click(newChat);
    await waitFor(() => expect(within(sheet).queryByText('Hello.')).toBeNull());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
