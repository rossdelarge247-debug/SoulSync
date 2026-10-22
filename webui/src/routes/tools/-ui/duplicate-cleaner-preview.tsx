/**
 * The duplicate cleaner's confirm screen, built from its preview plan.
 *
 * Every number and path here comes off the plan the backend recorded
 * (core/library/duplicate_cleaner.scan_duplicates + ActionPlan.summary):
 * each item is a file that would MOVE, with the copy that stays (`keep`),
 * both formats and sizes, and the reason.
 */

import type { PlanSummary } from '@/features/safe-action/plan';
import type {
  SafeActionDialogProps,
  SafeActionRow,
} from '@/features/safe-action/safe-action-dialog';

import { baseName, countLabel, folderTail, formatBytes } from '@/features/safe-action/plan';
import styles from '@/features/safe-action/safe-action.module.css';

import type { DuplicatePlanItem } from '../-tools.types';

function formatLabel(extension: string | undefined, size: number | undefined): string {
  const format = String(extension || '')
    .replace(/^\./, '')
    .toUpperCase();
  const parts = [format || 'File'];
  if (typeof size === 'number' && size > 0) parts.push(formatBytes(size));
  return parts.join(' · ');
}

function trackName(item: DuplicatePlanItem): string {
  return baseName(item.keep || item.path).replace(/\.[^.]+$/, '');
}

/** Where the moved copies land: the recycle bin under the output folder. */
export function recycleBinPath(plan: PlanSummary<DuplicatePlanItem>): string {
  const folder = plan.meta?.transfer_folder;
  if (typeof folder !== 'string' || !folder) return '';
  return `${folder.replace(/[\\/]+$/, '')}/.deleted`;
}

export function duplicateRows(plan: PlanSummary<DuplicatePlanItem>): SafeActionRow[] {
  return plan.sample.map((item, index) => ({
    key: `${item.path}-${index}`,
    cells: [
      <div key="track">
        <div className={styles.primaryCell}>{trackName(item)}</div>
        <div className={styles.secondary}>{folderTail(item.path)}</div>
      </div>,
      <span key="keep" className={styles.keep} title={item.keep}>
        {formatLabel(item.keep_extension, item.keep_size)}
      </span>,
      <span key="move" title={item.reason}>
        {formatLabel(item.extension, item.size)}
      </span>,
    ],
  }));
}

export interface DuplicateContentHandlers {
  busy: boolean;
  listBusy: boolean;
  onConfirm: () => void;
  onDownload: () => void;
}

/** The review half of the dialog for one preview. */
export function duplicateDialogContent(
  plan: PlanSummary<DuplicatePlanItem>,
  handlers: DuplicateContentHandlers,
): Omit<SafeActionDialogProps, 'open' | 'onClose' | 'phase'> {
  const n = plan.total;
  const checked = Number(plan.meta?.files_scanned) || 0;
  const bin = recycleBinPath(plan);
  const shown = plan.sample.length;
  return {
    title: `Move ${countLabel(n, 'duplicate file')} to the recycle bin?`,
    stats: [
      { label: 'Files', value: n.toLocaleString() },
      { label: 'Size', value: formatBytes(plan.total_bytes) },
      ...(checked ? [{ label: 'Files checked', value: checked.toLocaleString() }] : []),
    ],
    lead: (
      <>
        For each track SYNCHRO.S keeps the best copy and moves the others to the recycle bin
        {bin ? (
          <>
            {' '}
            in <code className={styles.code}>{bin}</code>
          </>
        ) : null}
        . Nothing is deleted, and you can put files back from the recycle bin.
      </>
    ),
    columns: ['Track', 'Keep', 'Move'],
    rows: duplicateRows(plan),
    shownLabel:
      shown < n
        ? `${shown.toLocaleString()} of ${countLabel(n, 'file')} shown`
        : `All ${countLabel(n, 'file')} shown`,
    fullList: plan.plan_id
      ? { label: 'Download the full list', onClick: handlers.onDownload, busy: handlers.listBusy }
      : undefined,
    createdAt: plan.created_at,
    expiresAt: plan.expires_at,
    confirmLabel: `Move ${countLabel(n, 'file')}`,
    confirmBusy: handlers.busy,
    onConfirm: handlers.onConfirm,
  };
}
