/**
 * Preview, then confirm: the Tools page's destructive tools never act on the
 * first click.
 *
 * The backend refuses a move or delete that does not come with a fresh plan
 * id (409 plan_required / plan_unknown / plan_expired). These pin the UI half:
 * the first click only previews, the preview is shown before anything
 * destructive is sent, the confirm sends exactly the plan id, a refused plan
 * shows the backend's message and a way to preview again, and Deep Scan's
 * large-move guard keeps its move button disabled until the box is ticked.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DbUpdaterCard, DuplicateCleanerCard } from './scanning-cards';

type Reply = { status?: number; body: unknown };
type Route = Reply | ((init?: RequestInit) => Reply);

const fetchMock = vi.fn();
const toastSpy = vi.fn();
const confirmSpy = vi.fn();

/** Answer by the longest matching URL fragment; a function sees the request. */
function serve(map: Record<string, Route>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const key = Object.keys(map)
      .filter((k) => String(url).includes(k))
      .sort((a, b) => b.length - a.length)[0];
    const route = key ? map[key] : { body: {} };
    const reply = typeof route === 'function' ? route(init) : route;
    const status = reply.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body,
    } as never);
  });
}

function calls(fragment: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));
}

/** The JSON body of the last POST to exactly `url`. */
function bodyOf(url: string): unknown {
  const call = fetchMock.mock.calls
    .filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === 'POST')
    .at(-1);
  expect(call, `expected a POST to ${url}`).toBeDefined();
  return JSON.parse(((call?.[1] as RequestInit | undefined)?.body as string) ?? '{}');
}

async function flush() {
  await act(async () => {});
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  fetchMock.mockReset();
  toastSpy.mockReset();
  confirmSpy.mockReset().mockResolvedValue(true);
  serve({});
  vi.stubGlobal('fetch', fetchMock);
  Object.assign(window, { showToast: toastSpy, showConfirmDialog: confirmSpy });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Duplicate cleaner ────────────────────────────────────────────────────────

const MB = 1024 * 1024;

function dupPlan(over: Record<string, unknown> = {}) {
  const created = nowSeconds();
  return {
    plan_id: 'dup-1',
    tool: 'duplicate_cleaner',
    total: 3,
    counts: { recycle: 3 },
    total_bytes: 24 * MB,
    sample: [
      {
        path: '/music/Radiohead/OK Computer/01 Airbag.mp3',
        keep: '/music/Radiohead/OK Computer/01 Airbag.flac',
        action: 'recycle',
        reason: 'lower-quality duplicate of 01 Airbag.flac (mp3 vs flac)',
        size: 8 * MB,
        extension: '.mp3',
        keep_extension: '.flac',
        keep_size: 30 * MB,
      },
    ],
    truncated: true,
    created_at: created,
    expires_at: created + 900,
    meta: { transfer_folder: '/music', files_scanned: 120 },
    ...over,
  };
}

function finishedPreview(plan = dupPlan()) {
  return {
    status: 'finished',
    mode: 'plan',
    phase: 'Preview ready',
    files_scanned: 120,
    duplicates_found: plan.total,
    deleted: 0,
    space_freed_mb: 0,
    plan_id: plan.plan_id,
    plan,
  };
}

describe('Duplicate cleaner: preview, then confirm', () => {
  it('the button only ever previews: it posts /preview, never /start', async () => {
    serve({
      '/api/duplicate-cleaner/status': { body: { status: 'idle' } },
      '/api/duplicate-cleaner/preview': { body: { success: true, mode: 'plan' } },
    });
    const { container } = render(<DuplicateCleanerCard />);
    await flush();
    const button = container.querySelector('#duplicate-clean-button') as HTMLElement;
    expect(button.textContent).toBe('Preview Duplicates');
    expect(screen.getByText('No preview yet')).toBeTruthy();

    fireEvent.click(button);
    await flush();
    expect(calls('/api/duplicate-cleaner/preview')).toHaveLength(1);
    expect(calls('/api/duplicate-cleaner/start')).toHaveLength(0);
  });

  it('shows the preview — counts, keep vs move, where files go, expiry — before any move', async () => {
    serve({ '/api/duplicate-cleaner/status': { body: finishedPreview() } });
    render(<DuplicateCleanerCard />);
    expect(await screen.findByText('Preview ready · 3 files')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Review preview' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Move 3 duplicate files to the recycle bin?')).toBeTruthy();
    expect(within(dialog).getByText('24.0 MB')).toBeTruthy();
    expect(within(dialog).getByText('/music/.deleted')).toBeTruthy();
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeTruthy();
    expect(within(dialog).getByText('FLAC · 30.0 MB')).toBeTruthy();
    expect(within(dialog).getByText('MP3 · 8.0 MB')).toBeTruthy();
    expect(within(dialog).getByText('1 of 3 files shown')).toBeTruthy();
    expect(within(dialog).getByText(/This preview was made at .* and works until/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Download the full list' })).toBeTruthy();

    // looking is free: Cancel sends nothing destructive
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(calls('/api/duplicate-cleaner/start')).toHaveLength(0);
  });

  it('the confirm sends exactly the plan id, then reports what happened', async () => {
    let status: unknown = finishedPreview();
    serve({
      '/api/duplicate-cleaner/status': () => ({ body: status }),
      '/api/duplicate-cleaner/start': () => {
        status = { status: 'running', mode: 'apply', duplicates_found: 3, deleted: 1 };
        return { body: { success: true, mode: 'apply' } };
      },
    });
    render(<DuplicateCleanerCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review preview' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move 3 files' }));
    await flush();
    expect(bodyOf('/api/duplicate-cleaner/start')).toEqual({ plan_id: 'dup-1' });
    expect(await screen.findByText(/Moving 3 files to the recycle bin/)).toBeTruthy();

    status = {
      status: 'finished',
      mode: 'apply',
      duplicates_found: 3,
      deleted: 3,
      space_freed_mb: 24,
      refused: 0,
      skipped: 0,
    };
    expect(
      await screen.findByText('Moved 3 files to the recycle bin', undefined, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.getByText(/Nothing was deleted/)).toBeTruthy();
  });

  it("a used or expired plan shows the backend's message and Preview again", async () => {
    serve({
      '/api/duplicate-cleaner/status': { body: finishedPreview() },
      '/api/duplicate-cleaner/start': {
        status: 409,
        body: {
          success: false,
          code: 'plan_expired',
          error: 'That preview is out of date. Preview again so you confirm what is on disk now.',
        },
      },
      '/api/duplicate-cleaner/preview': { body: { success: true, mode: 'plan' } },
    });
    render(<DuplicateCleanerCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review preview' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move 3 files' }),
    );
    await flush();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/That preview is out of date/)).toBeTruthy();
    expect(within(dialog).getByText('Nothing was moved or deleted.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview again' }));
    await flush();
    expect(calls('/api/duplicate-cleaner/preview')).toHaveLength(1);
    expect(calls('/api/duplicate-cleaner/start')).toHaveLength(1);
  });

  it('a preview past its window stops reading as ready', async () => {
    const old = nowSeconds() - 3600;
    serve({
      '/api/duplicate-cleaner/status': {
        body: finishedPreview(dupPlan({ created_at: old, expires_at: old + 900 })),
      },
    });
    const { container } = render(<DuplicateCleanerCard />);
    expect(await screen.findByText('Preview out of date')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review preview' })).toBeNull();
    expect((container.querySelector('#duplicate-clean-button') as HTMLElement).textContent).toBe(
      'Preview Again',
    );
  });
});

// ── Deep Scan (SoulSync standalone) ─────────────────────────────────────────

function deepPreview(over: Record<string, unknown> = {}) {
  const created = nowSeconds();
  return {
    success: true,
    moves_files: true,
    server: 'soulsync',
    mode: 'preview',
    plan_id: 'deep-1',
    would_move: 3,
    total: 3,
    total_bytes: 3 * MB,
    library_files: 300,
    database_tracks: 297,
    untracked: 3,
    untracked_percent: 1,
    move_blocked: false,
    block_reason: '',
    needs_confirmation: false,
    message: '',
    staging_path: '/data/Staging',
    max_move_percent: 25,
    sample: [{ path: '/music/New/Album/a.flac', dest: '/data/Staging/New/Album/a.flac', size: MB }],
    truncated: true,
    created_at: created,
    expires_at: created + 900,
    ...over,
  };
}

const LARGE = {
  mode: 'blocked',
  plan_id: 'deep-big',
  would_move: 120,
  total: 120,
  untracked: 120,
  untracked_percent: 40,
  library_files: 300,
  move_blocked: true,
  block_reason: 'large_move',
  needs_confirmation: true,
};

async function previewDeepScan(
  preview: Record<string, unknown>,
  extra: Record<string, Route> = {},
) {
  serve({
    '/api/database/stats': {
      body: { artists: 1, albums: 1, tracks: 297, database_size_mb: 1, server_source: 'soulsync' },
    },
    '/api/database/update/status': { body: { status: 'idle' } },
    '/api/database/deep-scan/preview': { body: preview },
    '/api/database/update': { body: { success: true } },
    ...extra,
  });
  const result = render(<DbUpdaterCard />);
  await flush();
  fireEvent.change(result.container.querySelector('#db-refresh-type') as Element, {
    target: { value: 'deep' },
  });
  const button = result.container.querySelector('#db-update-button') as HTMLElement;
  await waitFor(() => expect(button.textContent).toBe('Preview Deep Scan'));
  fireEvent.click(button);
  await flush();
  return result;
}

describe('Deep Scan: preview, then confirm', () => {
  it('previews first: nothing is started until the move is confirmed', async () => {
    await previewDeepScan(deepPreview());
    expect(calls('/api/database/deep-scan/preview')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/database/update')).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Move 3 files to Staging?')).toBeTruthy();
    expect(within(dialog).getByText('Staging/New/Album/a.flac')).toBeTruthy();
    expect(within(dialog).getByText('/data/Staging')).toBeTruthy();
    expect(within(dialog).getByText(/works until/)).toBeTruthy();
  });

  it('the confirm sends the plan id with the deep scan', async () => {
    await previewDeepScan(deepPreview());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move 3 files' }));
    await flush();
    expect(bodyOf('/api/database/update')).toEqual({ deep_scan: true, plan_id: 'deep-1' });
  });

  it('the card keeps the preview after the dialog closes', async () => {
    await previewDeepScan(deepPreview());
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await flush();
    expect(await screen.findByText('Preview ready · 3 files')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review preview' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('the ratio guard: the move stays disabled until the box is ticked', async () => {
    await previewDeepScan(deepPreview(LARGE));

    // in the dialog
    let dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('This would move 120 files, 40% of your library.'),
    ).toBeTruthy();
    expect(within(dialog).getByText(/more than the 25% safety limit/)).toBeTruthy();
    // disabled the neutral way: still focusable (aria-disabled), with the
    // reason written beside it and read out with it
    const dialogMove = within(dialog).getByRole('button', { name: 'Move 120 files' });
    expect(dialogMove).toHaveAttribute('aria-disabled', 'true');
    expect(dialogMove).toHaveAccessibleDescription('Tick "I checked the list" to move the files.');
    fireEvent.click(dialogMove);
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/database/update')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await flush();

    // and on the card
    const cardMove = await screen.findByRole('button', { name: 'Move 120 files' });
    expect(cardMove).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Tick "I checked the list" to move the files.')).toBeTruthy();
    fireEvent.click(cardMove);
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/database/update')).toBe(false);

    fireEvent.click(
      screen.getByLabelText('I checked the list and expected this many files to move'),
    );
    const ticked = screen.getByRole('button', { name: 'Move 120 files' });
    expect(ticked).not.toHaveAttribute('aria-disabled');
    expect((ticked as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Tick "I checked the list" to move the files.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move 120 files' }));
    await flush();
    expect(bodyOf('/api/database/update')).toEqual({
      deep_scan: true,
      plan_id: 'deep-big',
      confirm_large_move: true,
    });

    // the dialog follows the confirmed move
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Moving 120 files to Staging/)).toBeTruthy();
  });

  it("a refused plan shows the backend's message and previews again", async () => {
    await previewDeepScan(deepPreview(), {
      '/api/database/update': {
        status: 409,
        body: {
          success: false,
          code: 'plan_unknown',
          error:
            'That preview is no longer available (it was used already, or SYNCHRO.S restarted). Preview again.',
        },
      },
    });
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move 3 files' }),
    );
    await flush();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/That preview is no longer available/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview again' }));
    await flush();
    expect(calls('/api/database/deep-scan/preview')).toHaveLength(2);
  });

  it('a hard block says nothing will move and offers the scan alone', async () => {
    await previewDeepScan(
      deepPreview({
        mode: 'blocked',
        plan_id: null,
        move_blocked: true,
        block_reason: 'transfer_permanent',
        needs_confirmation: false,
        would_move: 0,
        created_at: null,
        expires_at: null,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText("Deep Scan won't move any files")).toBeTruthy();
    expect(within(dialog).getByText(/set as your permanent library/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run Deep Scan' }));
    await flush();
    expect(bodyOf('/api/database/update')).toEqual({ deep_scan: true });
  });

  it('a media server keeps the ordinary confirm: its deep scan never moves files', async () => {
    serve({
      '/api/database/stats': { body: { artists: 1, albums: 1, tracks: 1, server_source: 'plex' } },
      '/api/database/update/status': { body: { status: 'idle' } },
      '/api/database/deep-scan/preview': { body: { success: true, moves_files: false } },
      '/api/database/update': { body: { success: true } },
    });
    const { container } = render(<DbUpdaterCard />);
    await flush();
    fireEvent.change(container.querySelector('#db-refresh-type') as Element, {
      target: { value: 'deep' },
    });
    const button = container.querySelector('#db-update-button') as HTMLElement;
    expect(button.textContent).toBe('Update Database');
    fireEvent.click(button);
    await flush();
    await flush();
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deep Scan' }));
    expect(bodyOf('/api/database/update')).toEqual({ deep_scan: true });
  });
});
