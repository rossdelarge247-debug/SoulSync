/**
 * Video Library Maintenance's bulk fix previews first when it moves or
 * deletes files: the dialog lists each finding with "What happens", the
 * counts, the danger button when files leave, "This can't be undone" when a
 * delete is permanent, and fixes only the plan it showed. A refused plan says
 * so and previews again; a selection that touches no files runs at once.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import { useVideoRepairFix, VideoRepairFixHost } from './video-repair-fix-flow';

const now = () => Math.floor(Date.now() / 1000);

function plan(over: Record<string, unknown> = {}) {
  const created = now();
  return {
    success: true,
    plan_id: 'vfix-1',
    tool: 'video_repair_bulk_fix',
    total: 3,
    destructive: 2,
    by_effect: { recycle: 1, move: 1, write: 1 },
    recycle_deletes: true,
    sample: [
      {
        finding_id: 11,
        finding_type: 'watched_cleanup',
        path: '/movies/Heat (1995)/Heat (1995).mkv',
        size: 8_000_000_000,
        reason: 'Heat (1995) — watched 90 days ago (7.5 GB)',
        effect:
          "Moves the movie's file to the recycle bin and marks the movie as not in your library",
        effect_kind: 'recycle',
        destructive: true,
      },
      {
        finding_id: 12,
        finding_type: 'naming_mismatch',
        path: '/movies/old/Ronin.mkv',
        size: 4_000_000_000,
        reason: 'Ronin: name differs',
        effect: 'Renames the file to Ronin (1998).mkv, with its sidecars. Nothing is deleted',
        effect_kind: 'move',
        destructive: true,
      },
      {
        finding_id: 13,
        finding_type: 'incomplete_collection',
        path: '',
        size: 0,
        reason: 'The Matrix Collection: 2 missing',
        effect: 'Adds the missing films to the wishlist',
        effect_kind: 'write',
        destructive: false,
      },
    ],
    truncated: false,
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

function Harness({ onDone }: { onDone?: () => void }) {
  const flow = useVideoRepairFix();
  return (
    <>
      <button type="button" onClick={() => void flow.begin({ ids: [11, 12, 13] }, onDone)}>
        Approve
      </button>
      {flow.dialog}
    </>
  );
}

async function start(onDone = vi.fn()) {
  render(<Harness onDone={onDone} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
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

describe('Video repair: Approve selected', () => {
  it('opens with the counts and what happens to each file, then fixes only the plan', async () => {
    server.use(
      http.post(
        '/api/video/repair/findings/bulk-fix-preview',
        record('preview', () => HttpResponse.json(plan())),
      ),
      http.post(
        '/api/video/repair/findings/bulk-fix',
        record('fix', () =>
          HttpResponse.json({ success: true, fixed: 3, failed: 0, total: 3, errors: [] }),
        ),
      ),
    );
    const onDone = await start();

    const dialog = await screen.findByRole('dialog');
    expect(posted('preview')).toEqual([{ url: 'preview', body: { ids: [11, 12, 13] } }]);
    expect(posted('fix')).toEqual([]);
    expect(within(dialog).getByText('Fix 3 findings?')).toBeTruthy();
    expect(within(dialog).getByText('Findings')).toBeTruthy();
    expect(within(dialog).getByText('Move or delete a file')).toBeTruthy();
    expect(within(dialog).queryByText('Deleted for good')).toBeNull();
    expect(within(dialog).getByRole('columnheader', { name: 'What happens' })).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Moves the movie's file to the recycle bin and marks the movie as not in your library",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/1 fix moves a movie's files to the recycle bin/)).toBeTruthy();
    expect(within(dialog).getByText(/1 fix renames files\. Nothing is deleted\./)).toBeTruthy();
    expect(within(dialog).queryByText(/This can't be undone/)).toBeNull();
    expect(within(dialog).getByText('All 3 findings shown')).toBeTruthy();

    const confirm = within(dialog).getByRole('button', { name: 'Fix 3 findings' });
    expect(confirm.getAttribute('data-tone')).toBe('danger');
    fireEvent.click(confirm);

    expect(await within(dialog).findByText('Fixed 3 findings.')).toBeTruthy();
    expect(posted('fix')).toEqual([{ url: 'fix', body: { plan_id: 'vfix-1' } }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a permanent delete says it cannot be undone and counts what goes for good', async () => {
    server.use(
      http.post('/api/video/repair/findings/bulk-fix-preview', () =>
        HttpResponse.json(
          plan({
            total: 1,
            destructive: 1,
            by_effect: { delete: 1 },
            recycle_deletes: false,
            sample: [
              {
                ...plan().sample[0],
                effect:
                  "Deletes the movie's file permanently (recycling is off) and marks the movie as not in your library",
                effect_kind: 'delete',
              },
            ],
          }),
        ),
      ),
    );
    await start();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/^This can't be undone\. 1 fix deletes/)).toBeTruthy();
    expect(within(dialog).getByText('Deleted for good')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Fix 1 finding' }).getAttribute('data-tone'),
    ).toBe('danger');
  });

  it('renames alone keep the primary button', async () => {
    server.use(
      http.post('/api/video/repair/findings/bulk-fix-preview', () =>
        HttpResponse.json(plan({ total: 1, destructive: 1, by_effect: { move: 1 } })),
      ),
    );
    await start();
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: 'Fix 1 finding' }).getAttribute('data-tone'),
    ).toBe('primary');
  });

  it('an expired plan says so, changes nothing, and previews again', async () => {
    server.use(
      http.post(
        '/api/video/repair/findings/bulk-fix-preview',
        record('preview', () => HttpResponse.json(plan())),
      ),
      http.post(
        '/api/video/repair/findings/bulk-fix',
        record('fix', () =>
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
    const onDone = await start();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fix 3 findings' }));

    expect(await within(dialog).findByText('This preview has expired')).toBeTruthy();
    expect(within(dialog).getByText('Nothing was moved or deleted.')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(posted('preview')).toHaveLength(2));
  });

  it('a selection that touches no files runs straight away, with its plan', async () => {
    server.use(
      http.post('/api/video/repair/findings/bulk-fix-preview', () =>
        HttpResponse.json(
          plan({ total: 1, destructive: 0, by_effect: { write: 1 }, sample: [plan().sample[2]] }),
        ),
      ),
      http.post(
        '/api/video/repair/findings/bulk-fix',
        record('fix', () =>
          HttpResponse.json({ success: true, fixed: 1, failed: 0, total: 1, errors: [] }),
        ),
      ),
    );
    const onDone = await start();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posted('fix')).toEqual([{ url: 'fix', body: { plan_id: 'vfix-1' } }]);
    expect(toasts).toContainEqual({ message: 'Fixed 1 finding.', type: 'success' });
  });

  it('the host gives the legacy page window.openVideoRepairBulkFix', async () => {
    server.use(
      http.post('/api/video/repair/findings/bulk-fix-preview', () => HttpResponse.json(plan())),
    );
    render(<VideoRepairFixHost />);
    expect(typeof window.openVideoRepairBulkFix).toBe('function');
    await act(async () => {
      await window.openVideoRepairBulkFix?.({ ids: [11, 12, 13] });
    });
    expect(await screen.findByText('Fix 3 findings?')).toBeTruthy();
  });
});
