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

import { countLabel, formatBytes, isPlanRefusalCode, pathTail } from '@/features/safe-action/plan';
import { SafeActionDialog } from '@/features/safe-action/safe-action-dialog';
import styles from '@/features/safe-action/safe-action.module.css';

import type { FindingTypeInfo } from '../-tools.groups';

import {
  type BulkFixInlineResult,
  type BulkFixLossy,
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

/** The Lossy Converter's finding type. */
export const TYPE_LOSSY = 'missing_lossy_copy';

/** How many fixes remove something, by kind, from the preview. The Lossy
 *  Converter's deleted originals are counted on their own (lossySentences). */
function removals(preview: BulkFixPreview | undefined) {
  const byEffect = preview?.by_effect ?? {};
  const lossy = preview?.lossy;
  const lossyDeletes = lossy?.delete_originals ?? 0;
  return {
    permanent: (byEffect.delete ?? 0) - (lossy && !lossy.recycle ? lossyDeletes : 0),
    recycled: (byEffect.recycle ?? 0) - (lossy?.recycle ? lossyDeletes : 0),
    moved: byEffect.move ?? 0,
    folders: byEffect.folder ?? 0,
    known: Boolean(preview?.by_effect),
  };
}

function lossyTarget(lossy: BulkFixLossy): string {
  return lossy.labels.length ? lossy.labels.join(' or ') : 'a lossy copy';
}

/** "About 4.1 GB", or "Up to 6.3 GB" when the copies' size can't be estimated. */
export function lossySpaceFreed(lossy: BulkFixLossy): string {
  return lossy.estimated_freed_bytes == null
    ? `Up to ${formatBytes(lossy.originals_bytes)}`
    : `About ${formatBytes(lossy.estimated_freed_bytes)}`;
}

/** Whether every finding in the run is the Lossy Converter's: its group's
 *  Convert, or a selection (an album's Resolve all) of nothing else. */
export function lossyOnly(
  ctx: Pick<BulkFixContext, 'findingType' | 'selection'>,
  preview?: BulkFixPreview,
): boolean {
  if (!preview?.lossy) return false;
  if (!ctx.selection && ctx.findingType === TYPE_LOSSY) return true;
  const types = Object.keys(preview.per_type ?? {});
  return types.length === 1 && types[0] === TYPE_LOSSY;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** What a run does to lossless files, in plain sentences: converted, then
 *  the originals kept, recycled or deleted for good. */
export function lossySentences(lossy: BulkFixLossy | undefined): string[] {
  if (!lossy || !lossy.convert) return [];
  const target = lossyTarget(lossy);
  const gone = lossy.delete_originals;
  const kept = lossy.convert - gone;
  const out: string[] = [];
  if (gone) {
    const one = gone === 1;
    const where = lossy.recycle
      ? `${one ? 'goes' : 'go'} to the recycle bin, where you can restore ${one ? 'it' : 'them'} until it is emptied.`
      : `${one ? 'is' : 'are'} deleted permanently. Recycling is turned off in Settings, so ${one ? 'it' : 'they'} can't be put back.`;
    out.push(
      `${countLabel(gone, 'lossless file')} ${one ? 'is' : 'are'} converted to ${target}, then ${one ? 'its original' : 'their originals'} ${where}`,
    );
  }
  if (kept) {
    out.push(
      `${countLabel(kept, 'lossless file')} ${kept === 1 ? 'is' : 'are'} converted to ${target} and kept.`,
    );
  }
  if (gone) {
    out.push(
      `That frees ${lowerFirst(lossySpaceFreed(lossy))}. A file whose copy fails or can't be checked keeps its original.`,
    );
  }
  return out;
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
  const out: string[] = [...lossySentences(preview?.lossy)];
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
  const lossyItems = preview?.lossy?.convert ?? 0;
  const others = (preview?.total ?? 0) - permanent - recycled - moved - folders - lossyItems;
  if (out.length && others > 0) {
    out.push(
      `The other ${others.toLocaleString()} only ${others === 1 ? 'changes' : 'change'} tags, library entries or the wishlist.`,
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
  const lossy = preview?.lossy;
  if (lossy && lossyOnly(ctx, preview)) {
    const files = countLabel(lossy.convert || n, 'lossless file');
    const gone = lossy.delete_originals;
    const forGood = gone > 0 && !lossy.recycle;
    return {
      title: gone
        ? `Convert ${files} and ${forGood ? 'permanently delete' : 'delete'} the originals?`
        : `Convert ${files}?`,
      confirm: `Convert ${countLabel(lossy.convert || n, 'file')}`,
      lead: `${forGood ? "This can't be undone. " : ''}${sentences.join(' ')}`,
    };
  }
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
        if (result.started) {
          onStartedRef.current(result, ctx);
          await ctx.afterStart?.();
          return null;
        }
        if (result.already_running) {
          // the backend keeps the plan when another run is going, but this
          // run has not started: say so rather than close as if it had
          return {
            message:
              'Another bulk fix is still running, so this one has not started. Wait for it to finish, then confirm again.',
            previewAgain: true,
          };
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
  const lossy = preview?.lossy;
  const lossyStats =
    lossy && current && lossyOnly(current.ctx, preview)
      ? [
          { label: 'Files to convert', value: lossy.convert.toLocaleString() },
          {
            label: 'Originals deleted',
            value: lossy.delete_originals.toLocaleString(),
          },
          ...(lossy.delete_originals
            ? [{ label: 'Space freed', value: lossySpaceFreed(lossy) }]
            : []),
        ]
      : null;

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
        lossyStats ??
        (preview
          ? [
              { label: 'Findings', value: n.toLocaleString() },
              { label: 'Move or delete a file', value: touching.toLocaleString() },
              ...(permanent
                ? [{ label: 'Deleted for good', value: permanent.toLocaleString() }]
                : []),
              ...(lossy?.delete_originals
                ? [{ label: 'Space freed', value: lossySpaceFreed(lossy) }]
                : []),
            ]
          : undefined)
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
