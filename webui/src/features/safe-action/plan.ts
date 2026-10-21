/**
 * Preview-then-confirm plans, as the backend serves them.
 *
 * Every tool that moves or deletes files (the duplicate cleaner, Deep Scan's
 * move to Staging, repair bulk fixes) first records a PLAN: an id, the items it
 * would act on with a reason for each, and a 15-minute expiry. The action only
 * runs when that id comes back while it is still fresh, and a plan is spent by
 * the run it authorised (core/library/action_plans.py).
 *
 * These are the shared shapes and the pure helpers the confirm screens use.
 * Nothing here invents a field: each one is read from ActionPlan.summary() /
 * summarize_items() or the route that wraps them.
 */

/** One planned item. Each tool adds its own fields on top of these. */
export interface PlanItem {
  path?: string;
  action?: string;
  reason?: string;
  size?: number;
}

/** `ActionPlan.summary()` — what a preview screen needs. */
export interface PlanSummary<Item extends PlanItem = PlanItem> {
  plan_id: string | null;
  tool?: string;
  total: number;
  counts?: Record<string, number>;
  by_reason?: Record<string, number>;
  total_bytes?: number;
  sample: Item[];
  truncated?: boolean;
  /** Epoch seconds. */
  created_at?: number | null;
  /** Epoch seconds. */
  expires_at?: number | null;
  expires_in_seconds?: number;
  meta?: Record<string, unknown>;
}

/** The 409 refusal codes (PLAN_MISSING / UNKNOWN / EXPIRED / WRONG_TOOL). */
export const PLAN_REFUSAL_CODES = [
  'plan_required',
  'plan_unknown',
  'plan_expired',
  'plan_wrong_tool',
] as const;

export type PlanRefusalCode = (typeof PLAN_REFUSAL_CODES)[number];

export function isPlanRefusalCode(code: unknown): code is PlanRefusalCode {
  return typeof code === 'string' && (PLAN_REFUSAL_CODES as readonly string[]).includes(code);
}

/** A refused confirm: the backend's own user copy, and whether previewing
 *  again is the way out (it is for every plan code). */
export interface PlanRefusal {
  code: string;
  message: string;
  previewAgain: boolean;
}

/** Turns a confirm response into a refusal, or null when it was accepted. */
export function readRefusal(
  status: number,
  body: { success?: boolean; code?: string; error?: string } | null | undefined,
  fallback = 'That did not go through.',
): PlanRefusal | null {
  if (status >= 200 && status < 300 && body?.success !== false) return null;
  const code = String(body?.code || '');
  return {
    code,
    message: body?.error || fallback,
    previewAgain: isPlanRefusalCode(code),
  };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** "3.2 GB". Zero or unknown sizes read "0 B". */
export function formatBytes(bytes: number | null | undefined): string {
  let value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** "10:44" in the viewer's own clock. */
export function formatClock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Whether the plan's window has closed. Unknown expiry is never "expired":
 *  the backend is the judge, and it says so on confirm. */
export function planExpired(
  plan: { expires_at?: number | null } | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const expires = plan?.expires_at;
  return typeof expires === 'number' && expires * 1000 <= nowMs;
}

/** The "made at … works until …" line, or '' when the times are unknown. */
export function previewWindowText(
  createdAt: number | null | undefined,
  expiresAt: number | null | undefined,
): string {
  if (typeof createdAt !== 'number' || typeof expiresAt !== 'number') return '';
  return (
    `This preview was made at ${formatClock(createdAt)} and works until ` +
    `${formatClock(expiresAt)}. After that, preview again so you confirm what's on disk then.`
  );
}

/** The last `parts` segments of a path: "Artist/Album/01 Track.flac". */
export function pathTail(path: string | null | undefined, parts = 3): string {
  const segments = String(path || '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments.slice(-parts).join('/');
}

/** The file name alone. */
export function baseName(path: string | null | undefined): string {
  return pathTail(path, 1);
}

/** The folder a file sits in, as its last two segments. */
export function folderTail(path: string | null | undefined): string {
  const segments = String(path || '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return segments.slice(-3, -1).join('/');
}

/** "214 files" / "1 file". */
export function countLabel(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** RFC 4180 CSV: every cell quoted, quotes doubled. */
export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  return rows
    .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

/** Hands the viewer a text file to save. False when the browser can't. */
export function saveTextFile(filename: string, text: string, type = 'text/csv'): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

/** One page of a plan's full item list (`GET …/plan?plan_id&offset&limit`). */
export interface PlanPage<Item extends PlanItem = PlanItem> {
  success?: boolean;
  total?: number;
  items?: Item[];
  error?: string;
  code?: string;
}

/**
 * Every item of a plan, page by page. Throws with the backend's message when
 * the plan is gone, so the caller can say so instead of saving half a list.
 */
export async function fetchAllPlanItems<Item extends PlanItem>(
  url: string,
  planId: string,
  pageSize = 1000,
): Promise<Item[]> {
  const items: Item[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const query = new URLSearchParams({
      plan_id: planId,
      offset: String(offset),
      limit: String(pageSize),
    });
    const response = await fetch(`${url}?${query.toString()}`);
    const page = (await response.json().catch(() => ({}))) as PlanPage<Item>;
    if (!response.ok || page.success === false) {
      throw new Error(page.error || 'That preview is no longer available. Preview again.');
    }
    const batch = page.items ?? [];
    items.push(...batch);
    if (batch.length < pageSize || items.length >= (page.total ?? 0)) return items;
  }
}
