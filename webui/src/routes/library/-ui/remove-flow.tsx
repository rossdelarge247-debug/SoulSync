import { useCallback, useEffect, useState } from 'react';

import type { PlanSummary } from '@/features/safe-action/plan';

import { apiClient } from '@/app/api-client';
import { formatBytes, pathTail, readRefusal } from '@/features/safe-action/plan';
import { SafeActionDialog, type SafeActionPhase } from '@/features/safe-action/safe-action-dialog';

import type { SelectionBody } from '../-library.types';

import { previewRemoval } from '../-library.api';
import { plural } from './parts';

interface RemoveItem {
  path?: string;
  reason?: string;
  size?: number;
  action?: string;
}

/**
 * Remove from library (the bar's "…", admins), through the Safe action: a
 * preview of every file, "I checked the list", then the files go to the
 * recycle bin and the albums leave the library. The Artist page's Remove
 * from library (HANDOFF 74) is the same flow for every album of one artist
 * (`body.artist_id` and `artistName`); the artist goes once nothing is left.
 */
export function RemoveFromLibrary({
  body,
  artistName,
  onClose,
  onDone,
}: {
  body: SelectionBody & { artist_id?: string | number };
  artistName?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState<PlanSummary<RemoveItem> | null>(null);
  const [phase, setPhase] = useState<SafeActionPhase>({
    kind: 'working',
    message: 'Listing their files…',
  });
  const [checked, setChecked] = useState(false);

  const preview = useCallback(() => {
    setChecked(false);
    setPhase({ kind: 'working', message: 'Listing their files…' });
    previewRemoval(body)
      .then((summary) => {
        setPlan(summary as PlanSummary<RemoveItem>);
        setPhase({ kind: 'review' });
      })
      .catch((error: Error) =>
        setPhase({ kind: 'refused', message: error.message, previewAgain: false }),
      );
  }, [body]);

  useEffect(() => {
    preview();
  }, [preview]);

  const confirm = async () => {
    if (!plan?.plan_id) return;
    setPhase({ kind: 'working', message: 'Moving the files to the recycle bin…' });
    const response = await apiClient.post('library/albums/remove', {
      json: { plan_id: plan.plan_id },
      throwHttpErrors: false,
    });
    const result = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      code?: string;
      error?: string;
      albums_removed?: number;
      artist_removed?: boolean;
      files_moved?: number;
      skipped?: number;
      errors?: unknown[];
    };
    const refusal = readRefusal(response.status, result, "The albums weren't removed.");
    if (refusal) {
      setPhase({
        kind: 'refused',
        message: refusal.message,
        previewAgain: refusal.previewAgain,
        code: refusal.code,
      });
      return;
    }
    const failed = result.errors?.length ?? 0;
    setPhase({
      kind: 'done',
      tone: failed ? 'warning' : 'success',
      title:
        artistName && result.artist_removed
          ? `Removed ${artistName} from your library`
          : `Removed ${plural(result.albums_removed ?? 0, 'album')} from your library`,
      body: [
        `${plural(result.files_moved ?? 0, 'file')} went to the recycle bin (Maintenance → Recycle bin restores them).`,
        result.skipped ? `${plural(result.skipped, 'file')} had already gone.` : '',
        failed
          ? `${plural(failed, 'file')} couldn't be moved, so ${failed === 1 ? 'its album stays' : 'their albums stay'}.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    });
    onDone();
  };

  const albums = Number(plan?.meta?.albums ?? 0);
  return (
    <SafeActionDialog
      open
      onClose={onClose}
      phase={phase}
      title={
        artistName
          ? `Remove ${artistName} from your library?`
          : `Remove ${plural(albums, 'album')} from your library?`
      }
      stats={
        plan
          ? [
              { label: 'Albums', value: albums.toLocaleString() },
              { label: 'Files', value: plan.total.toLocaleString() },
              { label: 'Size', value: formatBytes(plan.total_bytes) },
            ]
          : []
      }
      lead={
        artistName
          ? `Their ${plural(albums, 'album')} go${albums === 1 ? 'es' : ''} to the recycle bin and leave your library, and so does ${artistName} once nothing of theirs is left. Nothing is deleted for good until the recycle bin is emptied.`
          : 'Their files go to the recycle bin and the albums leave your library. Nothing is deleted for good until the recycle bin is emptied.'
      }
      columns={['Album', 'File', 'Size']}
      rows={(plan?.sample ?? []).map((item, index) => ({
        key: `${item.path}-${index}`,
        cells: [item.reason ?? '', pathTail(item.path), formatBytes(item.size)],
      }))}
      shownLabel={plan ? `${plan.sample.length} of ${plural(plan.total, 'file')} shown` : undefined}
      createdAt={plan?.created_at}
      expiresAt={plan?.expires_at}
      guard={{
        message: 'Check the list: these are the files that will move.',
        checked,
        onChange: setChecked,
        label: 'I checked the list',
      }}
      confirmLabel={`Remove ${plural(albums, 'album')}`}
      confirmDisabled={!checked}
      confirmDisabledReason={'Tick "I checked the list" to remove them.'}
      onConfirm={() => void confirm()}
      onPreviewAgain={preview}
    />
  );
}
