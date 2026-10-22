/**
 * The video and audiobook recycle bins empty the same way the music one does:
 * the preview first (count, size, dates, a sample), the shared dialog that
 * says plainly this is permanent, and only its danger button, named for the
 * delete, sends the plan id. A refused plan shows the backend's sentence and
 * Preview again.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import type { PermanentDeleteTarget } from './permanent-delete';

import { permanentDeleteCopy, permanentDeleteOutcome } from './permanent-delete';
import { usePermanentDelete } from './permanent-delete-flow';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const now = () => Math.floor(Date.now() / 1000);

function videoPlan(over: Record<string, unknown> = {}) {
  const created = now();
  return {
    success: true,
    plan_id: 'vbin-1',
    tool: 'video_recycle_purge',
    total: 3,
    files: 3,
    info_files: 0,
    total_bytes: 12.4 * GB,
    oldest: '2026-10-01T09:00:00',
    newest: '2026-10-20T21:30:00',
    recycle_enabled: true,
    sample: [
      {
        trash_dir: '/movies/ss_recycle',
        entry: '20261001_090000_Heat (1995).mkv',
        name: 'Heat (1995).mkv',
        path: '/movies/Heat (1995)/Heat (1995).mkv',
        size: 8 * GB,
        deleted_at: '2026-10-01T09:00:00',
        kind: 'file',
        action: 'delete_permanently',
        reason: 'watched cleanup',
      },
    ],
    truncated: true,
    created_at: created,
    expires_at: created + 900,
    ...over,
  };
}

function bookPlan(over: Record<string, unknown> = {}) {
  return videoPlan({
    plan_id: 'abin-1',
    tool: 'audiobook_recycle_purge',
    total: 2,
    files: 2,
    total_bytes: 1.5 * GB,
    sample: [
      {
        entry: '20261012_101500_Project Hail Mary',
        name: 'Project Hail Mary',
        path: '/audiobooks/Andy Weir/Project Hail Mary',
        size: 900 * MB,
        deleted_at: '2026-10-12T10:15:00',
        kind: 'folder',
        action: 'delete_permanently',
        reason: 'deleted from the library',
      },
    ],
    ...over,
  });
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

describe('Empty the video recycle bin', () => {
  it('previews first, says it is permanent, and deletes only on the danger confirm', async () => {
    server.use(
      http.post(
        '/api/video/downloads/recycle/purge-preview',
        record('preview', () => HttpResponse.json(videoPlan())),
      ),
      http.post(
        '/api/video/downloads/recycle/purge',
        record('purge', () =>
          HttpResponse.json({
            success: true,
            purged: ['a', 'b', 'c'],
            skipped: [],
            errors: [],
            freed_bytes: 12.4 * GB,
          }),
        ),
      ),
    );
    const onDone = await start({ kind: 'video-recycle-bin' });

    const dialog = await screen.findByRole('dialog');
    expect(posted('preview')).toEqual([{ url: 'preview', body: { all: true } }]);
    expect(posted('purge')).toEqual([]);
    expect(within(dialog).getByText('Permanently delete 3 files (12.4 GB)?')).toBeTruthy();
    expect(
      within(dialog).getByText(/^This can't be undone\. This empties the video recycle bin\./),
    ).toBeTruthy();
    expect(within(dialog).getByText('Files')).toBeTruthy();
    expect(within(dialog).getByText('3')).toBeTruthy();
    expect(within(dialog).getByText('Heat (1995).mkv')).toBeTruthy();
    expect(within(dialog).getByText('from movies/Heat (1995)/Heat (1995).mkv')).toBeTruthy();
    expect(within(dialog).getByText('1 of 3 files shown')).toBeTruthy();

    const confirm = within(dialog).getByRole('button', { name: 'Delete 3 files permanently' });
    expect(confirm.getAttribute('data-tone')).toBe('danger');
    fireEvent.click(confirm);

    expect(await within(dialog).findByText('Deleted 3 files (12.4 GB) for good.')).toBeTruthy();
    expect(posted('purge')).toEqual([{ url: 'purge', body: { plan_id: 'vbin-1' } }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('one entry is named, and previewed by its folder and name', async () => {
    server.use(
      http.post(
        '/api/video/downloads/recycle/purge-preview',
        record('preview', () =>
          HttpResponse.json(videoPlan({ total: 1, files: 1, total_bytes: 8 * GB })),
        ),
      ),
    );
    await start({
      kind: 'video-recycle-bin',
      entries: [{ trash_dir: '/movies/ss_recycle', name: '20261001_090000_Heat (1995).mkv' }],
    });
    const dialog = await screen.findByRole('dialog');
    expect(posted('preview')[0].body).toEqual({
      entries: [{ trash_dir: '/movies/ss_recycle', name: '20261001_090000_Heat (1995).mkv' }],
    });
    expect(within(dialog).getByText('Permanently delete "Heat (1995).mkv" (8.0 GB)?')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Delete permanently' }).getAttribute('data-tone'),
    ).toBe('danger');
  });

  it('an expired preview says so and previews again', async () => {
    server.use(
      http.post(
        '/api/video/downloads/recycle/purge-preview',
        record('preview', () => HttpResponse.json(videoPlan())),
      ),
      http.post(
        '/api/video/downloads/recycle/purge',
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
    const onDone = await start({ kind: 'video-recycle-bin' });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 3 files permanently' }));

    expect(await within(dialog).findByText('This preview has expired')).toBeTruthy();
    expect(within(dialog).getByText(/That preview is out of date/)).toBeTruthy();
    expect(within(dialog).getByText('Nothing was moved or deleted.')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(posted('preview')).toHaveLength(2));
    expect(posted('purge')).toHaveLength(1);
  });

  it('an empty bin says so and never asks', async () => {
    server.use(
      http.post('/api/video/downloads/recycle/purge-preview', () =>
        HttpResponse.json({ success: true, plan_id: null, total: 0, files: 0, sample: [] }),
      ),
    );
    await start({ kind: 'video-recycle-bin' });
    await waitFor(() =>
      expect(toasts).toContainEqual({ message: 'The video recycle bin is empty.', type: 'info' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Empty the audiobook recycle bin', () => {
  it('counts books, says each goes with all its files, and erases on the danger confirm', async () => {
    server.use(
      http.post(
        '/api/audiobooks/library/recycle/purge-preview',
        record('preview', () => HttpResponse.json(bookPlan())),
      ),
      http.post(
        '/api/audiobooks/library/recycle/purge',
        record('purge', () =>
          HttpResponse.json({
            success: true,
            purged: ['a', 'b'],
            skipped: [],
            errors: [],
            freed_bytes: 1.5 * GB,
          }),
        ),
      ),
    );
    await start({ kind: 'audiobook-recycle-bin' });
    const dialog = await screen.findByRole('dialog');
    expect(posted('preview')[0].body).toEqual({ all: true });
    expect(within(dialog).getByText('Permanently delete 2 books (1.5 GB)?')).toBeTruthy();
    expect(within(dialog).getByText(/with all its files/)).toBeTruthy();
    expect(within(dialog).getByText('Books')).toBeTruthy();
    expect(within(dialog).getByRole('columnheader', { name: 'Book' })).toBeTruthy();
    expect(within(dialog).getByText('1 of 2 books shown')).toBeTruthy();

    const confirm = within(dialog).getByRole('button', { name: 'Delete 2 books permanently' });
    expect(confirm.getAttribute('data-tone')).toBe('danger');
    fireEvent.click(confirm);
    expect(await within(dialog).findByText('Deleted 2 books (1.5 GB) for good.')).toBeTruthy();
    expect(posted('purge')).toEqual([{ url: 'purge', body: { plan_id: 'abin-1' } }]);
  });

  it('one book is previewed by its name in the bin', async () => {
    server.use(
      http.post(
        '/api/audiobooks/library/recycle/purge-preview',
        record('preview', () => HttpResponse.json(bookPlan({ total: 1, files: 1 }))),
      ),
    );
    await start({ kind: 'audiobook-recycle-bin', names: ['20261012_101500_Project Hail Mary'] });
    const dialog = await screen.findByRole('dialog');
    expect(posted('preview')[0].body).toEqual({ names: ['20261012_101500_Project Hail Mary'] });
    expect(within(dialog).getByText(/^Permanently delete "Project Hail Mary"/)).toBeTruthy();
  });
});

describe('the copy for the other bins', () => {
  it('names books and files, and the outcome says what stayed', () => {
    const copy = permanentDeleteCopy(
      { kind: 'audiobook-recycle-bin' },
      { files: 4, total_bytes: 2 * GB, sample: [] },
    );
    expect(copy.title).toBe('Permanently delete 4 books (2.0 GB)?');
    expect(copy.confirm).toBe('Delete 4 books permanently');
    expect(copy.countLabel).toBe('Books');
    const outcome = permanentDeleteOutcome(
      { kind: 'video-recycle-bin' },
      { purged: ['a'], skipped: ['b'], errors: [], freed_bytes: GB },
    );
    expect(outcome.body).toBe(
      'Deleted 1 file (1.0 GB) for good. 1 file changed since the preview and was kept.',
    );
  });
});
