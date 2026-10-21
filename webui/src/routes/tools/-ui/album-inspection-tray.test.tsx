import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepairFinding } from '../-tools.types';

import { bulkFixWithPlan, fetchRepairFindings, previewBulkFix, startBulkFix } from '../-tools.api';
import { AlbumInspectionTray } from './album-inspection-tray';

vi.mock('../-tools.api', () => ({
  fetchRepairFindings: vi.fn(),
  fixFinding: vi.fn(async () => ({ success: true })),
  dismissFinding: vi.fn(),
  reopenFinding: vi.fn(),
  previewBulkFix: vi.fn(),
  bulkFixWithPlan: vi.fn(async () => ({ success: true, fixed: 1, failed: 0, total: 1 })),
  startBulkFix: vi.fn(),
}));

/** A bulk-fix preview of one album's findings. */
function albumPlan(destructive: number, over: Record<string, unknown> = {}) {
  return {
    success: true,
    plan_id: 'album-plan',
    total: 2,
    destructive,
    by_effect: destructive ? { recycle: destructive, write: 2 - destructive } : { write: 2 },
    recycle_deletes: true,
    sample: [
      {
        finding_id: 8,
        finding_type: 'duplicate_tracks',
        path: '/music/Aphex Twin/SAW/02 Tha.flac',
        action: 'Keep Best',
        reason: 'Duplicate: Tha',
        effect: 'Keeps the best copy and moves the others to the recycle bin',
        effect_kind: 'recycle',
        destructive: destructive > 0,
      },
      {
        finding_id: 9,
        finding_type: 'missing_lyrics',
        path: '/music/Aphex Twin/SAW/01 Xtal.flac',
        action: 'Apply Lyrics',
        reason: 'Missing lyrics: Xtal',
        effect: 'Apply Lyrics',
        effect_kind: 'write',
        destructive: false,
      },
    ],
    truncated: false,
    created_at: 1_800_000_000,
    expires_at: 1_800_000_900,
    ...over,
  };
}

const GROUP = {
  group_by: 'album' as const,
  key: 'Aphex Twin SAW',
  artist: 'Aphex Twin',
  album: 'SAW',
  count: 2,
  worst_score: null,
  best_score: null,
  worst_quality: '',
  best_quality: '',
  album_thumb_url: null,
  artist_thumb_url: null,
  artist_id: null,
  first_seen: null,
  last_seen: null,
};

function finding(patch: Partial<RepairFinding> & { id: number; finding_type: string }) {
  return {
    job_id: 'job',
    severity: 'warning',
    status: 'pending',
    title: 'Xtal',
    entity_type: 'track',
    entity_id: null,
    details: { album_title: 'SAW', artist_name: 'Aphex Twin', track_title: 'Xtal' },
    ...patch,
  } as RepairFinding;
}

function renderTray(findings: RepairFinding[]) {
  vi.mocked(fetchRepairFindings).mockResolvedValue({
    items: findings,
    total: findings.length,
    page: 0,
  });
  const onInspectRedownload = vi.fn();
  render(
    <AlbumInspectionTray
      group={GROUP}
      status="pending"
      onClose={() => {}}
      onFixFinding={async () => {}}
      onDismissFinding={async () => {}}
      onInspectRedownload={onInspectRedownload}
      onRefresh={() => {}}
    />,
  );
  return onInspectRedownload;
}

afterEach(() => vi.clearAllMocks());

describe('the album inspection tray', () => {
  it('offers a re-download only for a finding with a track behind it', async () => {
    // A fake-lossless finding reports a FILE (entity_id null). Its finding id is
    // not a track id: opening the re-download dialog with it searched for, and
    // replaced, the file of whichever track happened to have that id.
    const onInspectRedownload = renderTray([
      finding({ id: 7, finding_type: 'fake_lossless', entity_type: 'file' }),
      finding({ id: 8, finding_type: 'corrupt_audio', entity_id: '42', title: 'Ptolemy' }),
    ]);

    const buttons = await screen.findAllByRole('button', { name: /re-download/i });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onInspectRedownload).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }));
  });

  it('resolves only the findings that have a fix, through a plan', async () => {
    vi.mocked(previewBulkFix).mockResolvedValue(albumPlan(0, { total: 1 }) as never);
    window.showToast = vi.fn();
    renderTray([
      finding({ id: 7, finding_type: 'fake_lossless', entity_type: 'file' }),
      finding({ id: 9, finding_type: 'missing_lyrics', entity_id: '43' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: /resolve album/i }));

    await waitFor(() => expect(bulkFixWithPlan).toHaveBeenCalledWith('album-plan'));
    expect(previewBulkFix).toHaveBeenCalledWith({ ids: [9] });
    // nothing touches a file, so no confirm stands in the way
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(startBulkFix).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(window.showToast).toHaveBeenCalledWith('Resolved all issues on "SAW"', 'success'),
    );
  });

  it('previews an album whose fixes move files, and runs only the confirmed plan', async () => {
    vi.mocked(previewBulkFix).mockResolvedValue(albumPlan(1) as never);
    renderTray([
      finding({ id: 8, finding_type: 'duplicate_tracks', entity_id: '42', title: 'Tha' }),
      finding({ id: 9, finding_type: 'missing_lyrics', entity_id: '43' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: /resolve album/i }));

    const dialog = await screen.findByRole('dialog');
    expect(previewBulkFix).toHaveBeenCalledWith({ ids: [8, 9] });
    expect(bulkFixWithPlan).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Fix 2 selected findings?')).toBeTruthy();
    expect(
      within(dialog).getByText('Keeps the best copy and moves the others to the recycle bin'),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Fix 2 findings' });
    expect(confirm.getAttribute('data-tone')).toBe('danger');

    fireEvent.click(confirm);
    await waitFor(() => expect(bulkFixWithPlan).toHaveBeenCalledWith('album-plan'));
  });

  it('shows the refusal and Preview again when the plan is gone', async () => {
    vi.mocked(previewBulkFix).mockResolvedValue(albumPlan(1) as never);
    vi.mocked(bulkFixWithPlan).mockResolvedValueOnce({
      success: false,
      code: 'plan_expired',
      error: 'That preview is out of date. Preview again so you confirm what is on disk now.',
    });
    renderTray([finding({ id: 8, finding_type: 'duplicate_tracks', entity_id: '42' })]);

    fireEvent.click(await screen.findByRole('button', { name: /resolve album/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fix 2 findings' }));

    expect(
      await within(dialog).findByText(
        'That preview is out of date. Preview again so you confirm what is on disk now.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(previewBulkFix).toHaveBeenCalledTimes(2));
  });
});
