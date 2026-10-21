/**
 * Preview, then confirm, for a bulk fix that moves or deletes files.
 *
 * The backend refuses such a run without a plan id (409 `plan_required`) and
 * a confirmed plan fixes exactly the previewed findings with the previewed
 * action (RepairWorker.preview_bulk_fix / consume_bulk_fix_plan). So a group
 * fix of a destructive type, a "Fix selected" over ticked rows and an album's
 * "Resolve all" preview first, show the findings and what happens to each,
 * and only run when the dialog's own button, named for the action, sends the
 * plan id back.
 *
 * What the copy says about removed files comes from the preview, never from
 * a default: each item carries its effect, and `recycle_deletes` says whether
 * removed files go to the recycle bin or are deleted for good.
 */

import { useCallback, useRef, useState } from 'react';

import type { SafeActionPhase, SafeActionRow } from '@/features/safe-action/safe-action-dialog';

import { countLabel, isPlanRefusalCode, pathTail } from '@/features/safe-action/plan';
import { SafeActionDialog } from '@/features/safe-action/safe-action-dialog';
import styles from '@/features/safe-action/safe-action.module.css';

import type { FindingTypeInfo } from '../-tools.groups';

import {
  type BulkFixInlineResult,
  type BulkFixOptions,
  type BulkFixPreview,
  type BulkFixStartResult,
  bulkFixWithPlan,
  previewBulkFix,
  startBulkFix,
} from '../-tools.api';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

/** What the run is, for the copy: its type, the chosen action, the label. */
export interface BulkFixContext {
  /** '' for a selection that spans several kinds. */
  findingType: string;
  fixAction: string | null;
  label: string;
  info?: FindingTypeInfo;
  /** Ticked rows or one album's findings, rather than a whole group. */
  selection?: boolean;
  /** Run straight away, with no dialog, when the preview finds nothing that
   *  moves or deletes a file. */
  confirmOnlyWhenDestructive?: boolean;
  /** After the confirmed run started (background) or finished (inline). */
  afterStart?: () => void | Promise<void>;
}

const REMOVE_ACTIONS = new Set(['delete', 'remove']);
const REMOVING_EFFECTS = ['delete', 'recycle', 'folder'] as const;

/** How many fixes remove something, by kind, from the preview. */
function removals(preview: BulkFixPreview | undefined) {
  const byEffect = preview?.by_effect ?? {};
  return {
    permanent: byEffect.delete ?? 0,
    recycled: byEffect.recycle ?? 0,
    moved: byEffect.move ?? 0,
    folders: byEffect.folder ?? 0,
    known: Boolean(preview?.by_effect),
  };
}

/** The lead for removed files, from the recycle-bin setting the preview
 *  reports. Off means gone for good, and the copy says so. */
export function removalLead(recycle: boolean | undefined): string {
  return recycle === false
    ? "These files are deleted permanently. Recycling is turned off in Settings, so they can't be put back."
    : 'These files go to the recycle bin, so you can put them back until it is emptied.';
}

/** One plain sentence per kind of change, with its count. */
export function effectSentences(preview: BulkFixPreview | undefined): string[] {
  const { permanent, recycled, moved, folders } = removals(preview);
  const out: string[] = [];
  if (permanent) {
    out.push(
      `${countLabel(permanent, 'fix', 'fixes')} ${permanent === 1 ? 'deletes' : 'delete'} files permanently. They can't be put back.`,
    );
  }
  if (recycled) {
    out.push(
      `${countLabel(recycled, 'fix', 'fixes')} ${recycled === 1 ? 'moves' : 'move'} files to the recycle bin, where you can restore them until it is emptied.`,
    );
  }
  if (moved) {
    out.push(
      `${countLabel(moved, 'fix', 'fixes')} ${moved === 1 ? 'moves' : 'move'} files without deleting them.`,
    );
  }
  if (folders) {
    out.push(
      `${countLabel(folders, 'fix', 'fixes')} ${folders === 1 ? 'deletes' : 'delete'} empty folders.`,
    );
  }
  return out;
}

/** Whether the confirm deletes anything (bin or permanent), so its button
 *  is the danger one. */
export function bulkFixDeletes(ctx: BulkFixContext, preview: BulkFixPreview | undefined): boolean {
  const { known } = removals(preview);
  if (known) return REMOVING_EFFECTS.some((kind) => (preview?.by_effect?.[kind] ?? 0) > 0);
  return Boolean(ctx.fixAction && REMOVE_ACTIONS.has(ctx.fixAction));
}

/** The confirm screen's title, button and explanation for one run. */
export function bulkFixCopy(ctx: BulkFixContext, n: number, preview?: BulkFixPreview) {
  const { findingType, fixAction, label, info } = ctx;
  const verb = info?.verb || 'Fix';
  const sentences = effectSentences(preview);
  if (ctx.selection) {
    return {
      title: `Fix ${countLabel(n, 'selected finding')}?`,
      confirm: `Fix ${countLabel(n, 'finding')}`,
      lead: sentences.length
        ? sentences.join(' ')
        : 'Some of these fixes move or delete files on disk. Check the list before you confirm.',
    };
  }
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
    const { permanent, recycled, known } = removals(preview);
    // a type whose fixer always deletes for good, or always recycles, says
    // that whatever the setting is
    const recycle = known && (permanent || recycled) ? permanent === 0 : preview?.recycle_deletes;
    return {
      title: `Remove ${files}?`,
      confirm: `Remove ${countLabel(n, 'file')}`,
      lead: info?.confirm || removalLead(recycle),
    };
  }
  return {
    title: `${verb}: ${countLabel(n, label.toLowerCase().replace(/s$/, ''), label.toLowerCase())}?`,
    confirm: `${verb}: ${countLabel(n, 'finding')}`,
    lead:
      info?.confirm ||
      (sentences.length
        ? sentences.join(' ')
        : 'Some of these fixes move or delete files on disk. Check the list before you confirm.'),
  };
}

function rows(preview: BulkFixPreview): SafeActionRow[] {
  return preview.sample.map((item, index) => ({
    key: `${item.finding_id}-${index}`,
    cells: [
      <div key="finding">
        <div className={styles.primaryCell}>{item.reason}</div>
        <div className={styles.secondary} title={item.path}>
          {item.path ? pathTail(item.path, 3) : 'No file'}
        </div>
      </div>,
      <span key="effect">{item.effect || item.action}</span>,
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

export interface BulkFixPreviewOptions {
  /** `background` (default) starts the run and lets the page follow it;
   *  `inline` runs it inside the request, for small bounded selections. */
  runner?: 'background' | 'inline';
  /** Inline runs: the tally once the run is done. */
  onFinished?: (result: BulkFixInlineResult, ctx: BulkFixContext) => void;
}

type Refusal = { message: string; previewAgain: boolean };

export function useBulkFixPreview(
  onStarted: (result: BulkFixStartResult, ctx: BulkFixContext) => void,
  { runner = 'background', onFinished }: BulkFixPreviewOptions = {},
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
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const show = useCallback(
    (preview: BulkFixPreview, options: BulkFixOptions, ctx: BulkFixContext) => {
      setCurrent({ preview, options, ctx });
      setPhase({ kind: 'review' });
      setOpen(true);
    },
    [],
  );

  /** Runs exactly the plan. Null when it went through. */
  const run = useCallback(
    async (planId: string, ctx: BulkFixContext): Promise<Refusal | null> => {
      try {
        if (runner === 'inline') {
          const result = await bulkFixWithPlan(planId);
          if (result.success === false) {
            return {
              message: result.error || 'The fix did not run',
              previewAgain: isPlanRefusalCode(result.code),
            };
          }
          onFinishedRef.current?.(result, ctx);
          await ctx.afterStart?.();
          return null;
        }
        const result = await startBulkFix({ planId });
        if (result.started || result.already_running) {
          onStartedRef.current(result, ctx);
          await ctx.afterStart?.();
          return null;
        }
        return {
          message: result.error || 'Bulk fix failed to start',
          previewAgain: isPlanRefusalCode(result.code),
        };
      } catch {
        return { message: 'Error starting bulk fix', previewAgain: false };
      }
    },
    [runner],
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
      if (ctx.confirmOnlyWhenDestructive && !preview.destructive) {
        const refusal = await run(preview.plan_id, ctx);
        if (refusal) toast(refusal.message, 'error');
        return;
      }
      show(preview, options, ctx);
    },
    [run, show],
  );

  const confirm = useCallback(async () => {
    const planId = current?.preview.plan_id;
    if (!current || !planId) return;
    setBusy(true);
    if (runner === 'inline') {
      setPhase({
        kind: 'working',
        message: `Fixing ${countLabel(current.preview.total, 'finding')}…`,
      });
    }
    try {
      const refusal = await run(planId, current.ctx);
      if (!refusal) {
        setOpen(false);
        return;
      }
      setPhase({ kind: 'refused', ...refusal });
    } finally {
      setBusy(false);
    }
  }, [current, run, runner]);

  const preview = current?.preview;
  const n = preview?.total ?? 0;
  const copy = current ? bulkFixCopy(current.ctx, n, preview) : null;
  const touching = preview?.destructive ?? 0;
  const permanent = preview?.by_effect?.delete ?? 0;
  const shown = preview?.sample.length ?? 0;
  const danger = current ? bulkFixDeletes(current.ctx, preview) : false;

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
              ...(permanent
                ? [{ label: 'Deleted for good', value: permanent.toLocaleString() }]
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
      confirmTone={danger ? 'danger' : 'primary'}
      confirmBusy={busy}
      onConfirm={() => void confirm()}
    />
  );

  return { begin, show, dialog };
}
