/**
 * The two deletes nothing can undo: emptying the music recycle bin (all of
 * it, or chosen files) and clearing the download quarantine.
 *
 * Both routes only delete against a fresh preview plan
 * (api/deleted_files.py, api/quarantine.py): the preview records exactly
 * which files would go and answers with the count, the total size, the
 * oldest and newest date and a sample; the delete takes that plan id and
 * removes only those files. Without a plan the routes answer 409.
 *
 * These are the requests and the pure copy; permanent-delete-flow.tsx is
 * the dialog.
 */

import type { PlanItem, PlanSummary } from './plan';

import { countLabel, formatBytes, readRefusal, type PlanRefusal } from './plan';

/**
 * What to delete: the whole bin, chosen bin entries, what the bin's keep
 * window lets go now (`retention`, which the Weekly Cleanup automation
 * empties), or the quarantine.
 */
export type PermanentDeleteTarget =
  | { kind: 'recycle-bin'; ids?: string[]; retention?: boolean }
  | { kind: 'quarantine' };

/** One file the preview lists. */
export interface PermanentDeleteItem extends PlanItem {
  /** Recycle-bin entry id. */
  id?: string;
  name?: string;
  /** file (a download or a binned file), info (a quarantine sidecar), other. */
  kind?: string;
  /** Recycle bin: when the file was deleted (UTC ISO). */
  deleted_at?: string | null;
  /** Quarantine: when the file was quarantined (UTC ISO). */
  modified?: string | null;
  source?: string | null;
}

/** The preview: the plan summary plus the numbers the confirm shows. */
export interface PermanentDeletePreview extends PlanSummary<PermanentDeleteItem> {
  success?: boolean;
  error?: string;
  /** Files that go (quarantine sidecars counted apart, in `info_files`). */
  files: number;
  info_files?: number;
  total_bytes: number;
  oldest?: string | null;
  newest?: string | null;
}

/** What the delete answers once it ran. */
export interface PermanentDeleteResult {
  success?: boolean;
  error?: string;
  code?: string;
  message?: string;
  /** Recycle bin: the entry ids deleted, and those kept because they
   *  changed since the preview. */
  purged?: string[];
  skipped?: string[] | number;
  errors?: { id?: string; entry?: string; error: string }[];
  /** Quarantine: entries removed, of which downloads (not sidecars). */
  removed?: number;
  files_removed?: number;
  freed_bytes?: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function urls(target: PermanentDeleteTarget) {
  return target.kind === 'quarantine'
    ? { preview: '/api/quarantine/clear-preview', confirm: '/api/quarantine/clear' }
    : { preview: '/api/deleted-files/purge-preview', confirm: '/api/deleted-files/purge' };
}

/** Records the plan. Deletes nothing. */
export async function previewPermanentDelete(
  target: PermanentDeleteTarget,
): Promise<PermanentDeletePreview> {
  const body =
    target.kind === 'quarantine'
      ? {}
      : target.ids
        ? { ids: target.ids }
        : target.retention
          ? { retention: true }
          : { all: true };
  const response = await fetch(urls(target).preview, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as PermanentDeletePreview;
  if (!response.ok) {
    data.success = false;
    data.error = data.error || 'Could not preview the delete.';
  }
  return data;
}

/** Deletes exactly the plan's files. A refusal (expired, used, unknown plan)
 *  comes back as `refusal`, with the backend's own words. */
export async function confirmPermanentDelete(
  target: PermanentDeleteTarget,
  planId: string,
): Promise<{ result: PermanentDeleteResult; refusal: PlanRefusal | null }> {
  const response = await fetch(urls(target).confirm, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ plan_id: planId }),
  });
  const result = (await response.json().catch(() => ({}))) as PermanentDeleteResult;
  return {
    result,
    refusal: readRefusal(response.status, result, 'The delete did not go through.'),
  };
}

/** "2 Jan 2026" in the viewer's own format; '' when unknown. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The confirm's question, explanation and button, which all say plainly
 *  that this is permanent. */
export function permanentDeleteCopy(
  target: PermanentDeleteTarget,
  preview: Pick<PermanentDeletePreview, 'files' | 'total_bytes' | 'sample'>,
) {
  const n = preview.files;
  const size = formatBytes(preview.total_bytes);
  const single = target.kind === 'recycle-bin' && target.ids?.length === 1 && n === 1;
  const name = single ? preview.sample[0]?.name : undefined;
  const title = name
    ? `Permanently delete "${name}" (${size})?`
    : `Permanently delete ${countLabel(n, 'file')} (${size})?`;
  let lead: string;
  if (target.kind === 'quarantine') {
    lead =
      'Every file in the download quarantine is deleted for good, with its info file. ' +
      'None of them can be approved or recovered afterwards. Anything quarantined after this preview stays.';
  } else if (target.retention) {
    lead =
      'These are the files the recycle bin lets go now: everything past its keep window, or all of ' +
      'it when the bin keeps files forever. They are deleted for good and cannot be restored afterwards.';
  } else if (target.ids) {
    lead =
      n === 1
        ? 'The file is deleted for good. It leaves the recycle bin and cannot be restored afterwards.'
        : 'These files are deleted for good. They leave the recycle bin and cannot be restored afterwards.';
  } else {
    lead =
      'This empties the recycle bin. Every file in it is deleted for good and cannot be restored afterwards. ' +
      'Anything deleted after this preview stays in the bin.';
  }
  return {
    title,
    size,
    lead: `This can't be undone. ${lead}`,
    confirm: name ? 'Delete permanently' : `Delete ${countLabel(n, 'file')} permanently`,
    dateLabel: target.kind === 'quarantine' ? 'Quarantined' : 'Deleted',
  };
}

/** The result screen's words: what went, what stayed, what failed. */
export function permanentDeleteOutcome(
  target: PermanentDeleteTarget,
  result: PermanentDeleteResult,
): { body: string; tone: 'success' | 'warning' } {
  const errors = result.errors ?? [];
  const deleted =
    target.kind === 'quarantine' ? (result.files_removed ?? 0) : (result.purged ?? []).length;
  const kept = Array.isArray(result.skipped) ? result.skipped.length : 0;
  const parts = [
    `Deleted ${countLabel(deleted, 'file')} (${formatBytes(result.freed_bytes)}) for good.`,
  ];
  if (kept) {
    parts.push(
      `${countLabel(kept, 'file')} changed since the preview and ${kept === 1 ? 'was' : 'were'} kept.`,
    );
  }
  if (errors.length) {
    parts.push(`${countLabel(errors.length, 'file')} could not be deleted: ${errors[0].error}`);
  }
  return { body: parts.join(' '), tone: errors.length ? 'warning' : 'success' };
}
