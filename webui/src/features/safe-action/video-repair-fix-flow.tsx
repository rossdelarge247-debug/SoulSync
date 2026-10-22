/**
 * Preview, then confirm, for Video Library Maintenance's bulk fix ("Approve"
 * over the ticked findings on the video Tools page).
 *
 * The page is legacy markup (static/video/video-repair.js), so it opens this
 * dialog through `window.openVideoRepairBulkFix`, which the host below
 * registers once for the whole app. The dialog shows each finding with what
 * happens to it ("What happens"), the counts, and the danger button when the
 * fix removes files; "This can't be undone" leads when a delete is permanent.
 * A selection that only touches the wishlist or the library record runs
 * straight away, as the music side's Fix selected does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { SafeActionPhase, SafeActionRow } from './safe-action-dialog';

import { countLabel, pathTail } from './plan';
import { SafeActionDialog } from './safe-action-dialog';
import styles from './safe-action.module.css';
import {
  confirmVideoRepairFix,
  previewVideoRepairFix,
  videoRepairFixCopy,
  videoRepairFixDeletes,
  videoRepairFixOutcome,
  videoRepairEffects,
  type VideoRepairFixOptions,
  type VideoRepairFixPreview,
} from './video-repair-fix';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

function rows(preview: VideoRepairFixPreview): SafeActionRow[] {
  return preview.sample.map((item, index) => ({
    key: `${item.finding_id}-${index}`,
    cells: [
      <div key="finding">
        <div className={styles.primaryCell}>{item.reason}</div>
        {item.path ? (
          <div className={styles.secondary} title={item.path}>
            {pathTail(item.path, 3)}
          </div>
        ) : null}
      </div>,
      <span key="effect">{item.effect}</span>,
    ],
  }));
}

export interface VideoRepairFixFlow {
  /** Preview, then open the confirm (or run at once when nothing touches a
   *  file). `onDone` runs after a run, so the page reloads its findings. */
  begin: (options: VideoRepairFixOptions, onDone?: () => void) => Promise<void>;
  dialog: React.ReactNode;
}

export function useVideoRepairFix(): VideoRepairFixFlow {
  const [current, setCurrent] = useState<{
    options: VideoRepairFixOptions;
    preview: VideoRepairFixPreview;
    onDone?: () => void;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<SafeActionPhase>({ kind: 'review' });
  const [busy, setBusy] = useState(false);
  const previewing = useRef(false);

  const begin = useCallback(async (options: VideoRepairFixOptions, onDone?: () => void) => {
    if (previewing.current) return;
    previewing.current = true;
    try {
      let preview: VideoRepairFixPreview;
      try {
        preview = await previewVideoRepairFix(options);
      } catch {
        toast('Could not preview the fix.', 'error');
        return;
      }
      if (preview.success === false) {
        toast(preview.error || 'Could not preview the fix.', 'error');
        return;
      }
      if (!preview.plan_id || !preview.total) {
        toast('Nothing left to fix here.', 'info');
        onDone?.();
        return;
      }
      if (!preview.destructive) {
        // nothing moves or deletes a file: run the plan straight away
        try {
          const { result, refusal } = await confirmVideoRepairFix(preview.plan_id);
          if (refusal) {
            toast(refusal.message, 'error');
          } else {
            const outcome = videoRepairFixOutcome(result);
            toast(outcome.body, outcome.tone === 'success' ? 'success' : 'warning');
          }
        } catch {
          toast('The fix did not go through.', 'error');
        }
        onDone?.();
        return;
      }
      setCurrent({ options, preview, onDone });
      setPhase({ kind: 'review' });
      setOpen(true);
    } finally {
      previewing.current = false;
    }
  }, []);

  const confirm = useCallback(async () => {
    const planId = current?.preview.plan_id;
    if (!current || !planId) return;
    setBusy(true);
    setPhase({
      kind: 'working',
      message: `Fixing ${countLabel(current.preview.total, 'finding')}…`,
    });
    try {
      const { result, refusal } = await confirmVideoRepairFix(planId);
      if (refusal) {
        setPhase({
          kind: 'refused',
          message: refusal.message,
          previewAgain: refusal.previewAgain,
          code: refusal.code,
        });
        return;
      }
      const outcome = videoRepairFixOutcome(result);
      setPhase({
        kind: 'done',
        title: outcome.tone === 'success' ? 'Fixed' : 'Some findings were not fixed',
        body: outcome.body,
        tone: outcome.tone,
      });
      current.onDone?.();
    } catch {
      setPhase({
        kind: 'refused',
        message: 'The fix did not go through.',
        previewAgain: false,
      });
    } finally {
      setBusy(false);
    }
  }, [current]);

  const preview = current?.preview;
  const n = preview?.total ?? 0;
  const shown = preview?.sample.length ?? 0;
  const copy = preview ? videoRepairFixCopy(preview) : null;
  const permanent = preview ? videoRepairEffects(preview).permanent : 0;

  const dialog = (
    <SafeActionDialog
      open={open}
      onClose={() => setOpen(false)}
      phase={phase}
      onPreviewAgain={() => {
        if (current) void begin(current.options, current.onDone);
      }}
      title={copy?.title ?? 'Fix findings'}
      stats={
        preview
          ? [
              { label: 'Findings', value: n.toLocaleString() },
              {
                label: 'Move or delete a file',
                value: (preview.destructive ?? 0).toLocaleString(),
              },
              ...(permanent
                ? [
                    {
                      label: 'Deleted for good',
                      value: permanent.toLocaleString(),
                    },
                  ]
                : []),
            ]
          : undefined
      }
      lead={copy?.lead}
      columns={['Finding', 'What happens']}
      rows={preview ? rows(preview) : undefined}
      shownLabel={
        preview
          ? shown < n
            ? `${shown.toLocaleString()} of ${countLabel(n, 'finding')} shown`
            : `All ${countLabel(n, 'finding')} shown`
          : undefined
      }
      createdAt={preview?.created_at}
      expiresAt={preview?.expires_at}
      confirmLabel={copy?.confirm}
      confirmTone={preview && videoRepairFixDeletes(preview) ? 'danger' : 'primary'}
      confirmBusy={busy}
      onConfirm={() => void confirm()}
    />
  );

  return { begin, dialog };
}

/** One dialog for the legacy video Tools page, opened with
 *  `window.openVideoRepairBulkFix`. */
export function VideoRepairFixHost() {
  const flow = useVideoRepairFix();
  const begin = flow.begin;
  useEffect(() => {
    const previous = window.openVideoRepairBulkFix;
    window.openVideoRepairBulkFix = (options, onDone) => begin(options, onDone);
    return () => {
      window.openVideoRepairBulkFix = previous;
    };
  }, [begin]);
  return <>{flow.dialog}</>;
}

const HOST_ID = 'video-repair-fix-root';

/** Mount the host once, so the video Tools page has the dialog. */
export function mountVideoRepairFixHost(): void {
  if (typeof document === 'undefined' || document.getElementById(HOST_ID)) return;
  const el = document.createElement('div');
  el.id = HOST_ID;
  document.body.appendChild(el);
  createRoot(el).render(<VideoRepairFixHost />);
}
