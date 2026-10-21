/**
 * Deep Scan's preview-then-confirm endpoints.
 *
 * In SoulSync standalone mode a deep scan can move files the database does not
 * know about from the music folder into Staging. That move now needs a
 * confirmed preview (api/database_admin.py):
 *
 *   POST /api/database/deep-scan/preview   → what would move, recorded as a plan
 *   POST /api/database/update {deep_scan, plan_id[, confirm_large_move]}
 *   GET  /api/database/deep-scan/plan      → the preview's full list, paged
 *
 * A deep scan WITHOUT a plan id still runs (it re-checks every track and drops
 * records whose file is gone) but moves nothing. On a media server a deep scan
 * never moves files, and the preview says so (`moves_files: false`).
 */

import type { PlanItem, PlanRefusal } from './plan';

import { fetchAllPlanItems, readRefusal } from './plan';

/** One file the move would relocate (standalone_scan.build_move_items). */
export interface DeepScanItem extends PlanItem {
  path: string;
  dest?: string;
  action?: string;
  reason?: string;
  size?: number;
}

/** Why the move is held back (standalone_scan BLOCK_*). */
export type DeepScanBlockReason =
  | ''
  | 'transfer_permanent'
  | 'desync'
  | 'empty_database'
  | 'large_move'
  | (string & Record<never, never>);

/**
 * The preview payload: `_deep_scan_move_summary` + `summarize_items`, plus
 * the route's own fields. Every count is optional because the media-server
 * answer carries none of them.
 */
export interface DeepScanPreview {
  success?: boolean;
  moves_files?: boolean;
  server?: string;
  message?: string;
  error?: string;
  /** preview | blocked | clean (| moved, in a finished run's report). */
  mode?: string;
  plan_id?: string | null;
  moved?: number;
  would_move?: number;
  library_files?: number;
  database_tracks?: number;
  untracked?: number;
  untracked_percent?: number;
  move_blocked?: boolean;
  block_reason?: DeepScanBlockReason;
  needs_confirmation?: boolean;
  total?: number;
  total_bytes?: number;
  sample?: DeepScanItem[];
  truncated?: boolean;
  staging_path?: string;
  max_move_percent?: number;
  created_at?: number | null;
  expires_at?: number | null;
}

export type DeepScanPreviewResult =
  | { kind: 'no-moves'; message: string }
  | { kind: 'preview'; preview: DeepScanPreview }
  | { kind: 'error'; message: string };

export async function fetchDeepScanPreview(): Promise<DeepScanPreviewResult> {
  try {
    const response = await fetch('/api/database/deep-scan/preview', { method: 'POST' });
    const body = (await response.json().catch(() => ({}))) as DeepScanPreview;
    if (!response.ok || body.success === false) {
      return { kind: 'error', message: body.error || 'Could not preview the deep scan.' };
    }
    // Only an explicit "this scan moves files" opens the move confirm; a media
    // server (moves_files: false) keeps the ordinary scan confirm.
    if (body.moves_files !== true) {
      return { kind: 'no-moves', message: body.message || '' };
    }
    return { kind: 'preview', preview: body };
  } catch {
    return { kind: 'error', message: 'Could not preview the deep scan.' };
  }
}

export type StartDeepScanResult = { ok: true } | { ok: false; refusal: PlanRefusal };

/**
 * Start a deep scan. With `planId` it moves exactly that preview's files (and
 * `confirmLargeMove` is the ticked large-move box); without one it scans and
 * moves nothing.
 */
export async function startDeepScan(
  options: { planId?: string | null; confirmLargeMove?: boolean } = {},
): Promise<StartDeepScanResult> {
  const body: Record<string, unknown> = { deep_scan: true };
  if (options.planId) body.plan_id = options.planId;
  if (options.planId && options.confirmLargeMove) body.confirm_large_move = true;
  try {
    const response = await fetch('/api/database/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      code?: string;
      error?: string;
    };
    const refusal = readRefusal(response.status, data, 'Failed to start the deep scan.');
    return refusal ? { ok: false, refusal } : { ok: true };
  } catch {
    return {
      ok: false,
      refusal: { code: '', message: 'Failed to start the deep scan.', previewAgain: false },
    };
  }
}

export function fetchDeepScanPlanItems(planId: string): Promise<DeepScanItem[]> {
  return fetchAllPlanItems<DeepScanItem>('/api/database/deep-scan/plan', planId);
}

/** How many files the confirm would move. */
export function deepScanMoveCount(preview: DeepScanPreview): number {
  return preview.would_move ?? preview.total ?? 0;
}

/** True when the preview can be confirmed into a move at all. */
export function deepScanCanMove(preview: DeepScanPreview): boolean {
  return Boolean(preview.plan_id) && deepScanMoveCount(preview) > 0;
}

/** True when that move also needs the large-move box ticked. */
export function deepScanNeedsCheck(preview: DeepScanPreview): boolean {
  return deepScanCanMove(preview) && Boolean(preview.needs_confirmation);
}

/** A Staging destination shown relative to Staging when it can be. */
export function stagingRelative(dest: string | undefined, stagingPath: string | undefined): string {
  if (!dest) return '';
  if (stagingPath && dest.startsWith(stagingPath)) {
    return `Staging/${dest.slice(stagingPath.length).replace(/^[\\/]+/, '')}`;
  }
  return dest;
}
