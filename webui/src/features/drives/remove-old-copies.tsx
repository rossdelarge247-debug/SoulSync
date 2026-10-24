/**
 * "Remove the old copies…" (14i) through the Safe action: the preview lists
 * exactly the files this move copied and checked; tiles Files / Frees /
 * Deleted for good; the list; "I checked the list"; then the danger button
 * "Delete N files". The recycle bin would keep the space on the same disk,
 * so this one says plainly that it can't be undone.
 */

import { useEffect, useState } from 'react';

import type { SafeActionPhase } from '@/features/safe-action/safe-action-dialog';

import { SafeActionDialog } from '@/features/safe-action/safe-action-dialog';

import type { Move, MovePayload, RemovePreview } from './drives.api';

import { drivesApi, DrivesError, planListURL } from './drives.api';
import { count, sizeWords } from './drives.format';

export function RemoveOldCopies({
  move,
  onClose,
  onDone,
}: {
  move: Move;
  onClose: () => void;
  onDone: (payload: MovePayload) => void;
}) {
  const [preview, setPreview] = useState<RemovePreview | null>(null);
  const [phase, setPhase] = useState<SafeActionPhase>({
    kind: 'working',
    message: 'Listing the old copies…',
  });
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const source = move.plan?.source_label ?? 'the old drive';
  const target = move.plan?.target_label ?? 'the new drive';

  const load = async () => {
    setPhase({ kind: 'working', message: 'Listing the old copies…' });
    setTicked(false);
    try {
      setPreview(await drivesApi.removePreview(move.id));
      setPhase({ kind: 'review' });
    } catch (e) {
      setPhase({
        kind: 'refused',
        message: e instanceof Error ? e.message : 'That didn’t go through.',
        previewAgain: false,
      });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const out = await drivesApi.remove(move.id, preview.plan_id);
      onDone(out);
    } catch (e) {
      const code = e instanceof DrivesError ? e.code : undefined;
      setPhase({
        kind: 'refused',
        message: e instanceof Error ? e.message : 'That didn’t go through.',
        previewAgain: Boolean(code),
        code,
      });
    } finally {
      setBusy(false);
    }
  };

  const total = preview?.total ?? 0;
  return (
    <SafeActionDialog
      open
      onClose={onClose}
      phase={phase}
      title="Permanently delete the old copies?"
      stats={
        preview
          ? [
              { label: 'Files', value: total.toLocaleString('en-GB') },
              { label: 'Frees', value: sizeWords(preview.total_bytes) },
              { label: 'Deleted', value: 'For good' },
            ]
          : undefined
      }
      lead={
        <p>
          Only the files SYNCHRO.S copied to {target} and checked are deleted, and each one only
          while its copy is still there. This can’t be undone: the recycle bin would keep the space
          on {source}.
        </p>
      }
      guard={{
        message: `${count(total, 'file')} on ${source} will be deleted for good.`,
        checked: ticked,
        onChange: setTicked,
        label: 'I checked the list',
      }}
      columns={['File on ' + source, 'Size']}
      rows={(preview?.sample ?? []).map((item) => ({
        key: item.path,
        cells: [<code key="p">{item.path}</code>, sizeWords(item.size)],
      }))}
      shownLabel={
        preview
          ? `${Math.min(preview.sample.length, total).toLocaleString('en-GB')} of ${count(total, 'file')} shown`
          : undefined
      }
      fullList={
        preview
          ? {
              label: 'Download the full list',
              onClick: () => window.open(planListURL(preview.plan_id), '_blank'),
            }
          : undefined
      }
      createdAt={preview?.created_at}
      expiresAt={preview?.expires_at}
      confirmLabel={`Delete ${count(total, 'file')}`}
      confirmTone="danger"
      confirmDisabled={!ticked}
      confirmDisabledReason="Tick “I checked the list” to delete the files."
      confirmBusy={busy}
      onConfirm={() => void confirm()}
      onPreviewAgain={() => void load()}
    />
  );
}
