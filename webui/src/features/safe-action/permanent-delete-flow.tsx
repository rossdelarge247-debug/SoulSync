/**
 * Preview, then confirm, for emptying the recycle bin and clearing the
 * quarantine: the shared dialog with the count, size and dates, a sample of
 * the files, wording that says this is permanent, and a danger button named
 * for the delete. A refused plan shows the backend's message and Preview
 * again.
 *
 * The Downloads page uses the hook directly. The classic Settings page gets
 * the same dialog through `window.openPermanentDelete`, which the host below
 * registers once for the whole app.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { SafeActionPhase, SafeActionRow } from './safe-action-dialog';

import {
  confirmPermanentDelete,
  formatDay,
  permanentDeleteCopy,
  permanentDeleteOutcome,
  previewPermanentDelete,
  type PermanentDeletePreview,
  type PermanentDeleteTarget,
} from './permanent-delete';
import { countLabel, pathTail } from './plan';
import { SafeActionDialog } from './safe-action-dialog';
import styles from './safe-action.module.css';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

function emptyMessage(target: PermanentDeleteTarget): string {
  if (target.kind === 'quarantine') return 'The quarantine is already empty.';
  if (target.retention) return 'Nothing in the recycle bin is past its keep window.';
  return target.ids ? 'Those files are no longer in the recycle bin.' : 'The recycle bin is empty.';
}

function rows(preview: PermanentDeletePreview, target: PermanentDeleteTarget): SafeActionRow[] {
  return preview.sample.map((item, index) => {
    const when = formatDay(target.kind === 'quarantine' ? item.modified : item.deleted_at);
    return {
      key: `${item.id ?? item.name ?? item.path}-${index}`,
      cells: [
        <div key="file">
          <div className={`${styles.primaryCell} ${styles.pathCell}`}>
            {item.name || pathTail(item.path, 1)}
          </div>
          {target.kind === 'recycle-bin' && item.path ? (
            <div className={styles.secondary} title={item.path}>
              from {pathTail(item.path, 3)}
            </div>
          ) : null}
        </div>,
        <span key="when" className={styles.secondary}>
          {when || 'Unknown'}
        </span>,
      ],
    };
  });
}

/** What comes after this delete (an automation's next half): offered as a
 *  button on the done screen, and started at once when there was nothing to
 *  delete. */
export interface PermanentDeleteNext {
  label: string;
  run: () => void;
}

export interface PermanentDeleteFlow {
  /** Preview, then open the confirm. `onDone` runs once something was
   *  deleted, or when there was nothing to delete (so the list refreshes). */
  begin: (
    target: PermanentDeleteTarget,
    onDone?: () => void,
    next?: PermanentDeleteNext,
  ) => Promise<void>;
  dialog: React.ReactNode;
}

export function usePermanentDelete(): PermanentDeleteFlow {
  const [current, setCurrent] = useState<{
    target: PermanentDeleteTarget;
    preview: PermanentDeletePreview;
    onDone?: () => void;
    next?: PermanentDeleteNext;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<SafeActionPhase>({ kind: 'review' });
  const [busy, setBusy] = useState(false);
  const previewing = useRef(false);

  const begin = useCallback(
    async (target: PermanentDeleteTarget, onDone?: () => void, next?: PermanentDeleteNext) => {
      if (previewing.current) return;
      previewing.current = true;
      try {
        let preview: PermanentDeletePreview;
        try {
          preview = await previewPermanentDelete(target);
        } catch {
          toast('Could not preview the delete.', 'error');
          return;
        }
        if (preview.success === false) {
          toast(preview.error || 'Could not preview the delete.', 'error');
          return;
        }
        if (!preview.plan_id || !preview.files) {
          toast(emptyMessage(target), 'info');
          onDone?.();
          if (next) {
            previewing.current = false;
            next.run();
          }
          return;
        }
        setCurrent({ target, preview, onDone, next });
        setPhase({ kind: 'review' });
        setOpen(true);
      } finally {
        previewing.current = false;
      }
    },
    [],
  );

  const confirm = useCallback(async () => {
    const planId = current?.preview.plan_id;
    if (!current || !planId) return;
    setBusy(true);
    try {
      const { result, refusal } = await confirmPermanentDelete(current.target, planId);
      if (refusal) {
        setPhase({
          kind: 'refused',
          message: refusal.message,
          previewAgain: refusal.previewAgain,
          code: refusal.code,
        });
        return;
      }
      const outcome = permanentDeleteOutcome(current.target, result);
      const next = current.next;
      setPhase({
        kind: 'done',
        title: outcome.tone === 'success' ? 'Deleted for good' : 'Some files were not deleted',
        body: outcome.body,
        tone: outcome.tone,
        ...(next
          ? {
              extra: {
                label: next.label,
                onClick: () => {
                  setOpen(false);
                  next.run();
                },
              },
            }
          : {}),
      });
      current.onDone?.();
    } catch {
      setPhase({ kind: 'refused', message: 'The delete did not go through.', previewAgain: false });
    } finally {
      setBusy(false);
    }
  }, [current]);

  const preview = current?.preview;
  const copy = current && preview ? permanentDeleteCopy(current.target, preview) : null;
  const shown = preview?.sample.length ?? 0;
  const n = preview?.files ?? 0;

  const dialog = (
    <SafeActionDialog
      open={open}
      onClose={() => setOpen(false)}
      phase={phase}
      onPreviewAgain={() => {
        if (current) void begin(current.target, current.onDone, current.next);
      }}
      title={copy?.title ?? 'Permanently delete'}
      stats={
        preview
          ? [
              { label: 'Files', value: n.toLocaleString() },
              { label: 'Size', value: copy ? copy.size : '' },
              { label: 'Oldest', value: formatDay(preview.oldest) || 'Unknown' },
              { label: 'Newest', value: formatDay(preview.newest) || 'Unknown' },
            ]
          : undefined
      }
      lead={copy?.lead}
      columns={['File', copy?.dateLabel ?? 'Date']}
      rows={preview && current ? rows(preview, current.target) : undefined}
      shownLabel={
        preview
          ? shown < n
            ? `${shown.toLocaleString()} of ${countLabel(n, 'file')} shown`
            : `All ${countLabel(n, 'file')} shown`
          : undefined
      }
      createdAt={preview?.created_at}
      expiresAt={preview?.expires_at}
      confirmLabel={copy?.confirm}
      confirmTone="danger"
      confirmBusy={busy}
      onConfirm={() => void confirm()}
    />
  );

  return { begin, dialog };
}

/** One dialog for the classic pages, opened with `window.openPermanentDelete`. */
export function PermanentDeleteHost() {
  const flow = usePermanentDelete();
  const begin = flow.begin;
  useEffect(() => {
    const previous = window.openPermanentDelete;
    window.openPermanentDelete = (target, onDone) => begin(target, onDone);
    return () => {
      window.openPermanentDelete = previous;
    };
  }, [begin]);
  return <>{flow.dialog}</>;
}

const HOST_ID = 'permanent-delete-root';

/** Mount the host once, so Settings → Clear quarantine has the same dialog. */
export function mountPermanentDeleteHost(): void {
  if (typeof document === 'undefined' || document.getElementById(HOST_ID)) return;
  const el = document.createElement('div');
  el.id = HOST_ID;
  document.body.appendChild(el);
  createRoot(el).render(<PermanentDeleteHost />);
}
