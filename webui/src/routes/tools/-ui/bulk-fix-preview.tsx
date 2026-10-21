/**
 * Preview, then confirm, for a bulk fix that moves or deletes files.
 *
 * The backend refuses such a run without a plan id (409 `plan_required`) and
 * a confirmed plan fixes exactly the previewed findings with the previewed
 * action (RepairWorker.preview_bulk_fix / consume_bulk_fix_plan). So a group
 * fix of a destructive type previews first, shows the findings and files it
 * would touch with the reason for each, and only starts when the dialog's own
 * button, named for the action, sends the plan id back.
 */

import { useCallback, useRef, useState } from 'react';

import type { SafeActionPhase, SafeActionRow } from '@/features/safe-action/safe-action-dialog';

import { countLabel, isPlanRefusalCode, pathTail } from '@/features/safe-action/plan';
import { SafeActionDialog } from '@/features/safe-action/safe-action-dialog';
import styles from '@/features/safe-action/safe-action.module.css';

import type { FindingTypeInfo } from '../-tools.groups';

import {
  type BulkFixOptions,
  type BulkFixPreview,
  type BulkFixStartResult,
  previewBulkFix,
  startBulkFix,
} from '../-tools.api';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

/** What the run is, for the copy: its type, the chosen action, the label. */
export interface BulkFixContext {
  findingType: string;
  fixAction: string | null;
  label: string;
  info?: FindingTypeInfo;
}

const REMOVE_ACTIONS = new Set(['delete', 'remove']);

/** The confirm screen's title, button and explanation for one run. */
export function bulkFixCopy(ctx: BulkFixContext, n: number) {
  const { findingType, fixAction, label, info } = ctx;
  const verb = info?.verb || 'Fix';
  if (findingType === 'orphan_file' && fixAction === 'staging') {
    return {
      title: `Move ${countLabel(n, 'orphan file')} to Staging?`,
      confirm: `Move ${countLabel(n, 'file')}`,
      lead: 'These files move from your library folder to Staging, where you can review and import them. Nothing is deleted.',
    };
  }
  if (fixAction && REMOVE_ACTIONS.has(fixAction)) {
    const files = /file/i.test(label)
      ? countLabel(n, label.toLowerCase().replace(/s$/, ''), label.toLowerCase())
      : countLabel(n, 'file');
    return {
      title: `Remove ${files}?`,
      confirm: `Remove ${countLabel(n, 'file')}`,
      lead:
        info?.confirm ||
        'These files are removed from disk. Removed files go to the recycle bin by default, so you can put them back until it is emptied.',
    };
  }
  return {
    title: `${verb}: ${countLabel(n, label.toLowerCase().replace(/s$/, ''), label.toLowerCase())}?`,
    confirm: `${verb}: ${countLabel(n, 'finding')}`,
    lead:
      info?.confirm ||
      'Some of these fixes move or delete files on disk. Check the list before you confirm.',
  };
}

function rows(preview: BulkFixPreview): SafeActionRow[] {
  return preview.sample.map((item, index) => ({
    key: `${item.finding_id}-${index}`,
    cells: [
      <div key="finding" className={styles.primaryCell}>
        {item.reason}
      </div>,
      <span key="file" className={styles.secondary} title={item.path}>
        {item.path ? pathTail(item.path, 3) : 'No file'}
      </span>,
    ],
  }));
}

export interface BulkFixPreviewFlow {
  /** Preview the run and open the confirm. */
  begin: (options: BulkFixOptions, ctx: BulkFixContext) => Promise<void>;
  /** Open the confirm on a preview the backend already attached (a 409
   *  `plan_required` answer to a run the client thought harmless). */
  show: (preview: BulkFixPreview, options: BulkFixOptions, ctx: BulkFixContext) => void;
  dialog: React.ReactNode;
}

export function useBulkFixPreview(
  onStarted: (result: BulkFixStartResult, ctx: BulkFixContext) => void,
): BulkFixPreviewFlow {
  const [current, setCurrent] = useState<{
    preview: BulkFixPreview;
    options: BulkFixOptions;
    ctx: BulkFixContext;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<SafeActionPhase>({ kind: 'review' });
  const [busy, setBusy] = useState(false);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  const show = useCallback(
    (preview: BulkFixPreview, options: BulkFixOptions, ctx: BulkFixContext) => {
      setCurrent({ preview, options, ctx });
      setPhase({ kind: 'review' });
      setOpen(true);
    },
    [],
  );

  const begin = useCallback(
    async (options: BulkFixOptions, ctx: BulkFixContext) => {
      let preview: BulkFixPreview;
      try {
        preview = await previewBulkFix(options);
      } catch {
        toast('Could not preview the fix.', 'error');
        return;
      }
      if (preview.success === false || preview.invalid) {
        toast(preview.error || 'Could not preview the fix.', 'error');
        return;
      }
      if (!preview.plan_id || !preview.total) {
        toast('Nothing left to fix here.', 'info');
        return;
      }
      show(preview, options, ctx);
    },
    [show],
  );

  const confirm = useCallback(async () => {
    const planId = current?.preview.plan_id;
    if (!current || !planId) return;
    setBusy(true);
    try {
      const result = await startBulkFix({ planId });
      if (result.started || result.already_running) {
        setOpen(false);
        onStartedRef.current(result, current.ctx);
        return;
      }
      setPhase({
        kind: 'refused',
        message: result.error || 'Bulk fix failed to start',
        previewAgain: isPlanRefusalCode(result.code),
      });
    } catch {
      setPhase({ kind: 'refused', message: 'Error starting bulk fix', previewAgain: false });
    } finally {
      setBusy(false);
    }
  }, [current]);

  const preview = current?.preview;
  const n = preview?.total ?? 0;
  const copy = current ? bulkFixCopy(current.ctx, n) : null;
  const touching = preview?.destructive ?? 0;
  const shown = preview?.sample.length ?? 0;

  const dialog = (
    <SafeActionDialog
      open={open}
      onClose={() => setOpen(false)}
      phase={phase}
      onPreviewAgain={() => {
        if (current) void begin(current.options, current.ctx);
      }}
      title={copy?.title ?? 'Bulk fix'}
      stats={
        preview
          ? [
              { label: 'Findings', value: n.toLocaleString() },
              { label: 'Move or delete a file', value: touching.toLocaleString() },
            ]
          : undefined
      }
      lead={copy?.lead}
      columns={['Finding', 'File']}
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
      confirmBusy={busy}
      onConfirm={() => void confirm()}
    />
  );

  return { begin, show, dialog };
}
