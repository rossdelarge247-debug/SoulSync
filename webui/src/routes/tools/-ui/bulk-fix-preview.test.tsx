/**
 * The Lossy Converter's Convert previews first when a profile keeps the lossy
 * output only: the dialog counts the files to convert, the originals that go
 * and the space that frees, says where the originals go (the recycle bin, or
 * for good with "This can't be undone"), uses the danger button, and runs
 * only the plan it showed.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import type { BulkFixLossy, BulkFixPreview } from '../-tools.api';

import {
  bulkFixCopy,
  lossySentences,
  lossySpaceFreed,
  useBulkFixPreview,
} from './bulk-fix-preview';

const MB = 1024 ** 2;
const now = () => Math.floor(Date.now() / 1000);

function lossy(over: Partial<BulkFixLossy> = {}): BulkFixLossy {
  return {
    convert: 2,
    delete_originals: 2,
    originals_bytes: 60 * MB,
    estimated_freed_bytes: 44 * MB,
    labels: ['MP3-320'],
    recycle: true,
    ...over,
  };
}

function preview(over: Partial<BulkFixPreview> = {}): BulkFixPreview {
  const created = now();
  return {
    success: true,
    plan_id: 'lossy-1',
    tool: 'repair_bulk_fix',
    total: 2,
    destructive: 2,
    by_effect: { recycle: 2 },
    recycle_deletes: true,
    lossy: lossy(),
    sample: [
      {
        finding_id: 1,
        finding_type: 'missing_lossy_copy',
        path: '/music/Artist/Album/01 Song.flac',
        action: 'Convert',
        reason: 'No MP3-320 copy: Song',
        effect: 'Converts to MP3-320, then moves the lossless original to the recycle bin',
        effect_kind: 'recycle',
        destructive: true,
        size: 30 * MB,
      },
    ],
    truncated: true,
    created_at: created,
    expires_at: created + 900,
    ...over,
  };
}

const CTX = { findingType: 'missing_lossy_copy', fixAction: null, label: 'Missing Lossy Copy' };

describe('the Lossy Converter copy', () => {
  it('names the conversion and where the originals go', () => {
    const copy = bulkFixCopy(CTX, 2, preview());
    expect(copy.title).toBe('Convert 2 lossless files and delete the originals?');
    expect(copy.confirm).toBe('Convert 2 files');
    expect(copy.lead).toContain(
      '2 lossless files are converted to MP3-320, then their originals go to the recycle bin',
    );
    expect(copy.lead).toContain('That frees about 44.0 MB.');
    expect(copy.lead.startsWith("This can't be undone.")).toBe(false);
  });

  it('with recycling off, says it cannot be undone and that the delete is permanent', () => {
    const copy = bulkFixCopy(
      CTX,
      2,
      preview({ by_effect: { delete: 2 }, lossy: lossy({ recycle: false }) }),
    );
    expect(copy.title).toBe('Convert 2 lossless files and permanently delete the originals?');
    expect(copy.lead.startsWith("This can't be undone.")).toBe(true);
    expect(copy.lead).toContain('are deleted permanently');
  });

  it('keeping the originals says so, and a selection gets the same sentences', () => {
    expect(lossySentences(lossy({ delete_originals: 0 }))).toEqual([
      '2 lossless files are converted to MP3-320 and kept.',
    ]);
    const copy = bulkFixCopy({ ...CTX, findingType: '', selection: true }, 3, {
      ...preview({ total: 3, by_effect: { recycle: 2, write: 1 } }),
    });
    expect(copy.title).toBe('Fix 3 selected findings?');
    expect(copy.lead).toContain('2 lossless files are converted to MP3-320');
    expect(copy.lead).toContain('The other 1 only changes tags');
  });

  it("an album's Resolve all over lossy findings alone gets the same words", () => {
    const copy = bulkFixCopy(
      { ...CTX, findingType: '', selection: true, label: 'issues on "Ferry Songs"' },
      2,
      preview({ per_type: { missing_lossy_copy: 2 } }),
    );
    expect(copy.title).toBe('Convert 2 lossless files and delete the originals?');
  });

  it('the space freed is an estimate, or a ceiling when it cannot be estimated', () => {
    expect(lossySpaceFreed(lossy())).toBe('About 44.0 MB');
    expect(lossySpaceFreed(lossy({ estimated_freed_bytes: null }))).toBe('Up to 60.0 MB');
  });
});

let requests: { url: string; body: unknown }[] = [];

function record(url: string, reply: () => Response | Promise<Response>) {
  return async ({ request }: { request: Request }) => {
    const text = await request.text();
    requests.push({ url, body: text ? JSON.parse(text) : null });
    return reply();
  };
}

function Harness({ onStarted }: { onStarted: () => void }) {
  const flow = useBulkFixPreview(onStarted);
  return (
    <>
      <button
        type="button"
        onClick={() => void flow.begin({ findingType: 'missing_lossy_copy' }, CTX)}
      >
        Convert all
      </button>
      {flow.dialog}
    </>
  );
}

beforeEach(() => {
  requests = [];
  window.showToast = vi.fn();
});

afterEach(() => {
  cleanup();
  delete window.showToast;
});

describe('Convert all, when the originals would be deleted', () => {
  it('shows files, originals and space freed, and runs only on the danger confirm', async () => {
    server.use(
      http.post(
        '/api/repair/findings/bulk-fix-preview',
        record('preview', () => HttpResponse.json(preview())),
      ),
      http.post(
        '/api/repair/findings/bulk-fix-start',
        record('start', () => HttpResponse.json({ started: true, total: 2 })),
      ),
    );
    const onStarted = vi.fn();
    render(<Harness onStarted={onStarted} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Convert all' }));
    });

    const dialog = await screen.findByRole('dialog');
    expect(requests).toEqual([{ url: 'preview', body: { finding_type: 'missing_lossy_copy' } }]);
    expect(
      within(dialog).getByText('Convert 2 lossless files and delete the originals?'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Files to convert')).toBeTruthy();
    expect(within(dialog).getByText('Originals deleted')).toBeTruthy();
    expect(within(dialog).getByText('Space freed')).toBeTruthy();
    expect(within(dialog).getByText('About 44.0 MB')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Converts to MP3-320, then moves the lossless original to the recycle bin',
      ),
    ).toBeTruthy();

    const confirm = within(dialog).getByRole('button', { name: 'Convert 2 files' });
    expect(confirm.getAttribute('data-tone')).toBe('danger');
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(requests[1]).toEqual({ url: 'start', body: { plan_id: 'lossy-1' } });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
});
