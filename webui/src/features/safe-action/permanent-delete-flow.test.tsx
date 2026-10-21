/**
 * Empty recycle bin and Clear quarantine delete files for good, so neither
 * acts on the first click: it previews a plan (count, size, dates, a sample),
 * the shared dialog says plainly that this is permanent, and only its danger
 * button, named for the delete, sends the plan id. A refused plan shows the
 * backend's message and Preview again.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import type { PermanentDeleteTarget } from './permanent-delete';

import { permanentDeleteCopy, permanentDeleteOutcome } from './permanent-delete';
import { PermanentDeleteHost, usePermanentDelete } from './permanent-delete-flow';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const now = () => Math.floor(Date.now() / 1000);

function binPlan(over: Record<string, unknown> = {}) {
  const created = now();
  return {
    success: true,
    plan_id: 'bin-1',
    tool: 'recycle_bin_purge',
    total: 418,
    files: 418,
    info_files: 0,
    total_bytes: 5.1 * GB,
    oldest: '2026-01-02T03:04:05+00:00',
    newest: '2026-09-10T11:12:13+00:00',
    sample: [
      {
        id: 'deleted:Artist/Album/01 - Song.flac',
        name: '01 - Song.flac',
        path: '/music/Artist/Album/01 - Song.flac',
        size: 30 * MB,
        deleted_at: '2026-01-02T03:04:05+00:00',
        kind: 'file',
        action: 'delete_permanently',
        reason: 'in the recycle bin',
      },
    ],
    truncated: true,
    created_at: created,
    expires_at: created + 900,
    ...over,
  };
}

let toasts: { message: string; type?: string }[] = [];
let requests: { url: string; body: unknown }[] = [];

function record(url: string, reply: () => Response | Promise<Response>) {
  return async ({ request }: { request: Request }) => {
    const text = await request.text();
    requests.push({ url, body: text ? JSON.parse(text) : null });
    return reply();
  };
}

function posted(url: string) {
  return requests.filter((r) => r.url === url);
}

function Harness({ target, onDone }: { target: PermanentDeleteTarget; onDone?: () => void }) {
  const flow = usePermanentDelete();
  return (
    <>
      <button type="button" onClick={() => void flow.begin(target, onDone)}>
        Start
      </button>
      {flow.dialog}
    </>
  );
}

async function start(target: PermanentDeleteTarget, onDone = vi.fn()) {
  render(<Harness target={target} onDone={onDone} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  });
  return onDone;
}

beforeEach(() => {
  toasts = [];
  requests = [];
  window.showToast = vi.fn((message: string, type?: string) => {
    toasts.push({ message, type });
  });
});

afterEach(() => {
  cleanup();
  delete window.showToast;
});

describe('Empty recycle bin', () => {
  it('previews first, says it is permanent, and deletes only on the danger confirm', async () => {
    server.use(
      http.post(
        '/api/deleted-files/purge-preview',
        record('preview', () => HttpResponse.json(binPlan())),
      ),
      http.post(
        '/api/deleted-files/purge',
        record('purge', () =>
          HttpResponse.json({
            success: true,
            purged: Array.from({ length: 418 }, (_, i) => `deleted:${i}`),
            skipped: [],
            errors: [],
            freed_bytes: 5.1 * GB,
          }),
        ),
      ),
    );
    const onDone = await start({ kind: 'recycle-bin' });

    const dialog = await screen.findByRole('dialog');
    expect(posted('preview')).toEqual([{ url: 'preview', body: { all: true } }]);
    expect(posted('purge')).toEqual([]);
    expect(within(dialog).getByText('Permanently delete 418 files (5.1 GB)?')).toBeTruthy();
    expect(
      within(dialog).getByText(/^This can't be undone\. This empties the recycle bin\./),
    ).toBeTruthy();
    expect(within(dialog).getByText('Files')).toBeTruthy();
    expect(within(dialog).getByText('418')).toBeTruthy();
    expect(within(dialog).getByText('Oldest')).toBeTruthy();
    expect(within(dialog).getByText('01 - Song.flac')).toBeTruthy();
    expect(within(dialog).getByText('1 of 418 files shown')).toBeTruthy();

    const confirm = within(dialog).getByRole('button', { name: 'Delete 418 files permanently' });
    expect(confirm.getAttribute('data-tone')).toBe('danger');
    fireEvent.click(confirm);

    expect(await within(dialog).findByText('Deleted 418 files (5.1 GB) for good.')).toBeTruthy();
    expect(posted('purge')).toEqual([{ url: 'purge', body: { plan_id: 'bin-1' } }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a refused plan shows the backend's message and previews again", async () => {
    server.use(
      http.post(
        '/api/deleted-files/purge-preview',
        record('preview', () => HttpResponse.json(binPlan())),
      ),
      http.post(
        '/api/deleted-files/purge',
        record('purge', () =>
          HttpResponse.json(
            {
              success: false,
              code: 'plan_expired',
              error:
                'That preview is out of date. Preview again so you confirm what is on disk now.',
            },
            { status: 409 },
          ),
        ),
      ),
    );
    const onDone = await start({ kind: 'recycle-bin' });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 418 files permanently' }));

    expect(await within(dialog).findByText(/That preview is out of date/)).toBeTruthy();
    expect(within(dialog).getByText('Nothing was moved or deleted.')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(posted('preview')).toHaveLength(2));
    expect(posted('purge')).toHaveLength(1);
  });

  it('an empty bin says so and never asks', async () => {
    server.use(
      http.post(
        '/api/deleted-files/purge-preview',
        record('preview', () =>
          HttpResponse.json({ success: true, plan_id: null, total: 0, files: 0, sample: [] }),
        ),
      ),
    );
    const onDone = await start({ kind: 'recycle-bin' });
    await waitFor(() =>
      expect(toasts).toContainEqual({ message: 'The recycle bin is empty.', type: 'info' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDone).toHaveBeenCalled();
  });

  it('one binned file is named, and previewed by its id', async () => {
    server.use(
      http.post(
        '/api/deleted-files/purge-preview',
        record('preview', () =>
          HttpResponse.json(
            binPlan({ total: 1, files: 1, total_bytes: 30 * MB, truncated: false }),
          ),
        ),
      ),
    );
    await start({ kind: 'recycle-bin', ids: ['deleted:Artist/Album/01 - Song.flac'] });
    const dialog = await screen.findByRole('dialog');
    expect(posted('preview')[0].body).toEqual({ ids: ['deleted:Artist/Album/01 - Song.flac'] });
    expect(within(dialog).getByText('Permanently delete "01 - Song.flac" (30.0 MB)?')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Delete permanently' }).getAttribute('data-tone'),
    ).toBe('danger');
  });
});

describe('Clear quarantine', () => {
  it('previews the quarantine and clears exactly that plan', async () => {
    server.use(
      http.post(
        '/api/quarantine/clear-preview',
        record('preview', () =>
          HttpResponse.json(
            binPlan({
              plan_id: 'q-1',
              tool: 'quarantine_clear',
              total: 84,
              files: 42,
              info_files: 42,
              total_bytes: 900 * MB,
              sample: [
                {
                  name: '20260101_Song.flac.quarantined',
                  path: '/downloads/ss_quarantine/20260101_Song.flac.quarantined',
                  kind: 'file',
                  size: 30 * MB,
                  modified: '2026-01-01T00:00:00+00:00',
                },
              ],
            }),
          ),
        ),
      ),
      http.post(
        '/api/quarantine/clear',
        record('clear', () =>
          HttpResponse.json({
            success: true,
            removed: 84,
            files_removed: 42,
            freed_bytes: 900 * MB,
            skipped: 0,
            errors: [],
          }),
        ),
      ),
    );
    await start({ kind: 'quarantine' });
    const dialog = await screen.findByRole('dialog');
    expect(posted('clear')).toEqual([]);
    expect(within(dialog).getByText('Permanently delete 42 files (900 MB)?')).toBeTruthy();
    expect(within(dialog).getByText(/download quarantine is deleted for good/)).toBeTruthy();
    expect(within(dialog).getByText('Quarantined')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 42 files permanently' }));
    expect(await within(dialog).findByText('Deleted 42 files (900 MB) for good.')).toBeTruthy();
    expect(posted('clear')).toEqual([{ url: 'clear', body: { plan_id: 'q-1' } }]);
  });

  it('the classic Settings page opens the same dialog through the host', async () => {
    server.use(
      http.post(
        '/api/quarantine/clear-preview',
        record('preview', () => HttpResponse.json(binPlan({ plan_id: 'q-2', files: 3, total: 6 }))),
      ),
    );
    render(<PermanentDeleteHost />);
    expect(typeof window.openPermanentDelete).toBe('function');
    await act(async () => {
      await window.openPermanentDelete?.({ kind: 'quarantine' });
    });
    expect(await screen.findByText('Permanently delete 3 files (5.1 GB)?')).toBeTruthy();
    cleanup();
    expect(window.openPermanentDelete).toBeUndefined();
  });
});

describe('the copy', () => {
  it('always says this is permanent and names the count and size', () => {
    const preview = { files: 2, total_bytes: 3 * MB, sample: [] };
    for (const target of [
      { kind: 'quarantine' as const },
      { kind: 'recycle-bin' as const },
      { kind: 'recycle-bin' as const, ids: ['a', 'b'] },
    ]) {
      const copy = permanentDeleteCopy(target, preview);
      expect(copy.title).toBe('Permanently delete 2 files (3.0 MB)?');
      expect(copy.lead.startsWith("This can't be undone.")).toBe(true);
      expect(copy.confirm).toBe('Delete 2 files permanently');
    }
  });

  it('reports files kept because they changed, and failures', () => {
    const outcome = permanentDeleteOutcome(
      { kind: 'recycle-bin' },
      {
        purged: ['a'],
        skipped: ['b', 'c'],
        errors: [{ id: 'd', error: 'permission denied' }],
        freed_bytes: MB,
      },
    );
    expect(outcome.tone).toBe('warning');
    expect(outcome.body).toBe(
      'Deleted 1 file (1.0 MB) for good. 2 files changed since the preview and were kept. ' +
        '1 file could not be deleted: permission denied',
    );
  });
});
