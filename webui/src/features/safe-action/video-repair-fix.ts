/**
 * Video Library Maintenance bulk fixes, preview then confirm.
 *
 * Watched Cleanup moves a movie's files to the recycle bin (or deletes them
 * for good when recycling is off) and Naming Conformance renames them, so a
 * bulk fix that includes either only runs against a fresh preview plan
 * (core/video/repair/worker.py, api/video/repair.py): the preview lists every
 * finding with what happens to it, and the fix takes that plan id and fixes
 * exactly those findings. Fixes that only touch the wishlist, the library
 * record or the download queue still run straight away.
 *
 * These are the requests and the pure copy; video-repair-fix-flow.tsx is the
 * dialog the legacy Tools page opens.
 */

import type { PlanItem, PlanSummary } from './plan';

import { countLabel, readRefusal, type PlanRefusal } from './plan';

/** One finding the preview would fix. */
export interface VideoRepairFixItem extends PlanItem {
  finding_id: number;
  finding_type: string;
  /** What happens, as a sentence ("Moves the movie's file to the recycle bin…"). */
  effect: string;
  /** move, recycle, delete, library, write or none. */
  effect_kind: string;
  destructive?: boolean;
}

/** `POST /api/video/repair/findings/bulk-fix-preview`. */
export interface VideoRepairFixPreview extends PlanSummary<VideoRepairFixItem> {
  success?: boolean;
  error?: string;
  /** How many fixes move or delete a file. */
  destructive?: number;
  by_effect?: Record<string, number>;
  per_type?: Record<string, number>;
  recycle_deletes?: boolean;
}

/** What the confirmed fix answers. */
export interface VideoRepairFixResult {
  success?: boolean;
  fixed?: number;
  failed?: number;
  total?: number;
  errors?: string[];
  code?: string;
  error?: string;
}

/** The findings to fix: chosen ids, or a job / severity scope. */
export interface VideoRepairFixOptions {
  ids?: number[];
  jobId?: string;
  severity?: string;
  fixAction?: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Records the plan. Changes nothing. */
export async function previewVideoRepairFix(
  options: VideoRepairFixOptions,
): Promise<VideoRepairFixPreview> {
  const body: Record<string, unknown> = {};
  if (options.ids) body.ids = options.ids;
  if (options.jobId) body.job_id = options.jobId;
  if (options.severity) body.severity = options.severity;
  if (options.fixAction) body.fix_action = options.fixAction;
  const response = await fetch('/api/video/repair/findings/bulk-fix-preview', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as VideoRepairFixPreview;
  if (!response.ok) {
    data.success = false;
    data.error = data.error || 'Could not preview the fix.';
  }
  return data;
}

/** Fixes exactly the plan's findings. A refusal comes back with the
 *  backend's own words. */
export async function confirmVideoRepairFix(
  planId: string,
): Promise<{ result: VideoRepairFixResult; refusal: PlanRefusal | null }> {
  const response = await fetch('/api/video/repair/findings/bulk-fix', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ plan_id: planId }),
  });
  const result = (await response.json().catch(() => ({}))) as VideoRepairFixResult;
  // a run where some fixes failed is still a run: success:false there is not a refusal
  const refused = response.status === 409 || !response.ok;
  return {
    result,
    refusal: refused ? readRefusal(response.status, result, 'The fix did not go through.') : null,
  };
}

/** How many fixes do what to files. */
export function videoRepairEffects(preview: Pick<VideoRepairFixPreview, 'by_effect'>) {
  const byEffect = preview.by_effect ?? {};
  return {
    permanent: byEffect.delete ?? 0,
    recycled: byEffect.recycle ?? 0,
    moved: byEffect.move ?? 0,
  };
}

/** Whether the confirm removes files (bin or for good), so its button is the danger one. */
export function videoRepairFixDeletes(preview: Pick<VideoRepairFixPreview, 'by_effect'>): boolean {
  const { permanent, recycled } = videoRepairEffects(preview);
  return permanent + recycled > 0;
}

/** The confirm's title, explanation and button. A permanent delete says so first. */
export function videoRepairFixCopy(preview: Pick<VideoRepairFixPreview, 'by_effect' | 'total'>) {
  const n = preview.total;
  const { permanent, recycled, moved } = videoRepairEffects(preview);
  const sentences: string[] = [];
  if (permanent) {
    sentences.push(
      `${countLabel(permanent, 'fix', 'fixes')} ${permanent === 1 ? 'deletes' : 'delete'} a movie's files permanently. They can't be put back.`,
    );
  }
  if (recycled) {
    sentences.push(
      `${countLabel(recycled, 'fix', 'fixes')} ${recycled === 1 ? 'moves' : 'move'} a movie's files to the recycle bin, where you can restore them until it is emptied.`,
    );
  }
  if (moved) {
    sentences.push(
      `${countLabel(moved, 'fix', 'fixes')} ${moved === 1 ? 'renames' : 'rename'} files. Nothing is deleted.`,
    );
  }
  const others = n - permanent - recycled - moved;
  if (others > 0) {
    sentences.push(
      sentences.length
        ? `The other ${others.toLocaleString()} only ${others === 1 ? 'changes' : 'change'} the wishlist, the library record or the download queue.`
        : 'These fixes only change the wishlist, the library record or the download queue.',
    );
  }
  return {
    title: `Fix ${countLabel(n, 'finding')}?`,
    lead: `${permanent ? "This can't be undone. " : ''}${sentences.join(' ')}`,
    confirm: `Fix ${countLabel(n, 'finding')}`,
  };
}

/** The done screen's words. */
export function videoRepairFixOutcome(result: VideoRepairFixResult): {
  body: string;
  tone: 'success' | 'warning';
} {
  const fixed = result.fixed ?? 0;
  const failed = result.failed ?? 0;
  const parts = [`Fixed ${countLabel(fixed, 'finding')}.`];
  if (failed) {
    const first = result.errors?.[0];
    parts.push(
      `${countLabel(failed, 'finding')} could not be fixed${first ? `: ${first.replace(/^#\d+:\s*/, '')}` : '.'}`,
    );
  }
  return { body: parts.join(' '), tone: failed ? 'warning' : 'success' };
}
