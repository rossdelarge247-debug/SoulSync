/**
 * The video Review pane and the audiobook bin open the shared
 * preview-then-confirm dialog for Delete and Empty: nothing is deleted on the
 * first click, and the routes are only ever posted with a plan id.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VdlReviewPane, type VdlReviewController } from '@/routes/active-downloads/-ui/vdl-review';
import { AudiobookReviewModal } from '@/routes/audiobooks/-ui/audiobook-review-modal';
import { HttpResponse, http, server } from '@/test/msw';

const now = () => Math.floor(Date.now() / 1000);

function planFor(tool: string, name: string) {
  const created = now();
  return {
    success: true,
    plan_id: `${tool}-1`,
    tool,
    total: 1,
    files: 1,
    total_bytes: 2048,
    oldest: '2026-10-01T09:00:00',
    newest: '2026-10-01T09:00:00',
    sample: [{ entry: `20261001_090000_${name}`, name, path: `/lib/${name}`, size: 2048 }],
    truncated: false,
    created_at: created,
    expires_at: created + 900,
  };
}

let requests: { url: string; body: unknown }[] = [];

function record(url: string, reply: () => Response | Promise<Response>) {
  return async ({ request }: { request: Request }) => {
    const text = await request.text();
    requests.push({ url, body: text ? JSON.parse(text) : null });
    return reply();
  };
}

beforeEach(() => {
  requests = [];
  window.showToast = vi.fn();
});

afterEach(() => {
  cleanup();
  delete window.showToast;
});

function review(): VdlReviewController {
  return {
    bin: {
      items: [
        {
          name: '20261001_090000_Heat (1995).mkv',
          trash_dir: '/movies/ss_recycle',
          original_path: '/movies/Heat (1995)/Heat (1995).mkv',
          reason: 'watched cleanup',
          size: 2048,
          age_seconds: 3600,
        },
      ],
      recycle_enabled: true,
      keep_days: 7,
    },
    binCount: 1,
    binError: null,
    blocklist: [],
    loadBadge: vi.fn(async () => {}),
    loadReview: vi.fn(async () => {}),
  };
}

describe('the video Review pane', () => {
  it('Empty bin previews the whole bin in the dialog', async () => {
    server.use(
      http.post(
        '/api/video/downloads/recycle/purge-preview',
        record('preview', () =>
          HttpResponse.json(planFor('video_recycle_purge', 'Heat (1995).mkv')),
        ),
      ),
      http.post(
        '/api/video/downloads/recycle/purge',
        record('purge', () => HttpResponse.json({})),
      ),
    );
    render(<VdlReviewPane review={review()} onChanged={vi.fn()} />);
    // Empty bin lives in the pane's "Review actions" menu
    fireEvent.click(screen.getByRole('button', { name: 'Review actions' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Empty bin' }));
    });
    const dialog = await screen.findByRole('dialog');
    expect(requests).toEqual([{ url: 'preview', body: { all: true } }]);
    expect(within(dialog).getByText(/^Permanently delete 1 file/)).toBeTruthy();
  });

  it("a row's Delete previews just that entry", async () => {
    server.use(
      http.post(
        '/api/video/downloads/recycle/purge-preview',
        record('preview', () =>
          HttpResponse.json(planFor('video_recycle_purge', 'Heat (1995).mkv')),
        ),
      ),
    );
    render(<VdlReviewPane review={review()} onChanged={vi.fn()} />);
    // a row's Delete forever lives in its own menu
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete forever' }));
    });
    await screen.findByRole('dialog');
    expect(requests).toEqual([
      {
        url: 'preview',
        body: {
          entries: [{ trash_dir: '/movies/ss_recycle', name: '20261001_090000_Heat (1995).mkv' }],
        },
      },
    ]);
  });
});

describe('the audiobook bin', () => {
  function serveBin() {
    server.use(
      http.get('/api/audiobooks/library/recycle', () =>
        HttpResponse.json({
          success: true,
          keep_days: 7,
          entries: [
            {
              name: '20261012_101500_Project Hail Mary',
              path: '/audiobooks/.deleted/20261012_101500_Project Hail Mary',
              original: 'Project Hail Mary',
              original_path: '/audiobooks/Andy Weir/Project Hail Mary',
              reason: 'deleted from the library',
              age_days: 1,
            },
          ],
        }),
      ),
      http.get('/api/audiobooks/blocklist', () =>
        HttpResponse.json({ success: true, blocked: [] }),
      ),
      http.post(
        '/api/audiobooks/library/recycle/purge-preview',
        record('preview', () =>
          HttpResponse.json(planFor('audiobook_recycle_purge', 'Project Hail Mary')),
        ),
      ),
    );
  }

  it('Empty previews the bin over the modal, and Escape there leaves the modal open', async () => {
    serveBin();
    const onClose = vi.fn();
    render(<AudiobookReviewModal onClose={onClose} />);
    const empty = await screen.findByRole('button', { name: 'Empty the bin and free the space' });
    await act(async () => {
      fireEvent.click(empty);
    });
    const dialog = await screen.findByRole('dialog', { name: /Permanently delete/ });
    expect(requests).toEqual([{ url: 'preview', body: { all: true } }]);
    expect(within(dialog).getByText('Permanently delete 1 book (2.0 KB)?')).toBeTruthy();

    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a book's Delete previews just that book", async () => {
    serveBin();
    render(<AudiobookReviewModal onClose={vi.fn()} />);
    const del = await screen.findByRole('button', { name: 'Delete' });
    await act(async () => {
      fireEvent.click(del);
    });
    await screen.findByRole('dialog', { name: /Permanently delete/ });
    expect(requests).toEqual([
      { url: 'preview', body: { names: ['20261012_101500_Project Hail Mary'] } },
    ]);
  });
});
