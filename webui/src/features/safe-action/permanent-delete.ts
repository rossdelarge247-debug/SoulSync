/**
 * The deletes nothing can undo: emptying a recycle bin (the music one, the
 * video one or the audiobook one; all of it, or chosen entries) and clearing
 * the download quarantine.
 *
 * Every route only deletes against a fresh preview plan (api/deleted_files.py,
 * api/quarantine.py, api/video/downloads.py, api/audiobooks.py): the preview
 * records exactly which files would go and answers with the count, the total
 * size, the oldest and newest date and a sample; the delete takes that plan id
 * and removes only those files. Without a plan the routes answer 409.
 *
 * These are the requests and the pure copy; permanent-delete-flow.tsx is
 * the dialog.
 */

import type { PlanItem, PlanSummary } from './plan';

import { countLabel, formatBytes, readRefusal, type PlanRefusal } from './plan';

/** One video recycle-bin entry: the bin folder it is in and its name there. */
export interface VideoBinEntry {
  trash_dir?: string | null;
  name: string;
}

/**
 * What to delete: the whole music bin, chosen bin entries, what the bin's
 * keep window lets go now (`retention`, which the Weekly Cleanup automation
 * empties), or the quarantine; the video bin (all, or chosen entries); the
 * audiobook bin (all, or chosen books by their name in the bin).
 */
export type PermanentDeleteTarget =
  | { kind: 'recycle-bin'; ids?: string[]; retention?: boolean }
  | { kind: 'quarantine' }
  | { kind: 'video-recycle-bin'; entries?: VideoBinEntry[] }
  | { kind: 'audiobook-recycle-bin'; names?: string[] };

/** One file the preview lists. */
export interface PermanentDeleteItem extends PlanItem {
  /** Recycle-bin entry id. */
  id?: string;
  /** Video and audiobook bins: the entry's name in the bin (with its stamp). */
  entry?: string;
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
  /** Video and audiobook bins: whether deletes go to the bin at all now. */
  recycle_enabled?: boolean;
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
  switch (target.kind) {
    case 'quarantine':
      return { preview: '/api/quarantine/clear-preview', confirm: '/api/quarantine/clear' };
    case 'video-recycle-bin':
      return {
        preview: '/api/video/downloads/recycle/purge-preview',
        confirm: '/api/video/downloads/recycle/purge',
      };
    case 'audiobook-recycle-bin':
      return {
        preview: '/api/audiobooks/library/recycle/purge-preview',
        confirm: '/api/audiobooks/library/recycle/purge',
      };
    default:
      return { preview: '/api/deleted-files/purge-preview', confirm: '/api/deleted-files/purge' };
  }
}

function previewBody(target: PermanentDeleteTarget): Record<string, unknown> {
  switch (target.kind) {
    case 'quarantine':
      return {};
    case 'video-recycle-bin':
      return target.entries ? { entries: target.entries } : { all: true };
    case 'audiobook-recycle-bin':
      return target.names ? { names: target.names } : { all: true };
    default:
      return target.ids
        ? { ids: target.ids }
        : target.retention
          ? { retention: true }
          : { all: true };
  }
}

/** Whether the delete is of chosen entries rather than the whole bin. */
function chosen(target: PermanentDeleteTarget): number | null {
  if (target.kind === 'recycle-bin') return target.ids ? target.ids.length : null;
  if (target.kind === 'video-recycle-bin') return target.entries ? target.entries.length : null;
  if (target.kind === 'audiobook-recycle-bin') return target.names ? target.names.length : null;
  return null;
}

/** What one entry is called: a book in the audiobook bin, a file elsewhere. */
export function deleteNoun(target: PermanentDeleteTarget): {
  one: string;
  many: string;
} {
  return target.kind === 'audiobook-recycle-bin'
    ? { one: 'book', many: 'books' }
    : { one: 'file', many: 'files' };
}

/** Records the plan. Deletes nothing. */
export async function previewPermanentDelete(
  target: PermanentDeleteTarget,
): Promise<PermanentDeletePreview> {
  const body = previewBody(target);
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
  const noun = deleteNoun(target);
  const single = chosen(target) === 1 && n === 1;
  const name = single ? preview.sample[0]?.name : undefined;
  const title = name
    ? `Permanently delete "${name}" (${size})?`
    : `Permanently delete ${countLabel(n, noun.one, noun.many)} (${size})?`;
  let lead: string;
  if (target.kind === 'video-recycle-bin') {
    lead = target.entries
      ? n === 1
        ? 'The file is deleted for good. It leaves the video recycle bin and cannot be restored afterwards.'
        : 'These files are deleted for good. They leave the video recycle bin and cannot be restored afterwards.'
      : 'This empties the video recycle bin. Every file in it is deleted for good and cannot be restored ' +
        'afterwards. Anything deleted after this preview stays in the bin.';
  } else if (target.kind === 'audiobook-recycle-bin') {
    lead = target.names
      ? n === 1
        ? 'The book is deleted for good, with all its files. It leaves the audiobook recycle bin and cannot be restored afterwards.'
        : 'These books are deleted for good, with all their files. They leave the audiobook recycle bin and cannot be restored afterwards.'
      : 'This empties the audiobook recycle bin. Every book in it is deleted for good, with all its files, and ' +
        'cannot be restored afterwards. Anything deleted after this preview stays in the bin.';
  } else if (target.kind === 'quarantine') {
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
    confirm: name
      ? 'Delete permanently'
      : `Delete ${countLabel(n, noun.one, noun.many)} permanently`,
    dateLabel: target.kind === 'quarantine' ? 'Quarantined' : 'Deleted',
    countLabel: noun.many.charAt(0).toUpperCase() + noun.many.slice(1),
    itemLabel: noun.one.charAt(0).toUpperCase() + noun.one.slice(1),
  };
}

/** The result screen's words: what went, what stayed, what failed. */
export function permanentDeleteOutcome(
  target: PermanentDeleteTarget,
  result: PermanentDeleteResult,
): { body: string; tone: 'success' | 'warning' } {
  const errors = result.errors ?? [];
  const noun = deleteNoun(target);
  const deleted =
    target.kind === 'quarantine' ? (result.files_removed ?? 0) : (result.purged ?? []).length;
  const kept = Array.isArray(result.skipped) ? result.skipped.length : 0;
  const parts = [
    `Deleted ${countLabel(deleted, noun.one, noun.many)} (${formatBytes(result.freed_bytes)}) for good.`,
  ];
  if (kept) {
    parts.push(
      `${countLabel(kept, noun.one, noun.many)} changed since the preview and ${kept === 1 ? 'was' : 'were'} kept.`,
    );
  }
  if (errors.length) {
    parts.push(
      `${countLabel(errors.length, noun.one, noun.many)} could not be deleted: ${errors[0].error}`,
    );
  }
  return { body: parts.join(' '), tone: errors.length ? 'warning' : 'success' };
}
