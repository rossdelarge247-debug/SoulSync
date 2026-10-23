/**
 * GET /api/activity and friends (api/activity.py, core/activity/feed.py).
 * The contract is docs/design/CONTRACTS.md, "Activity feed".
 */

export type ActivityKind = 'download' | 'import' | 'automation' | 'sync' | 'safety' | 'radio';
export type ActivityStatus = 'running' | 'ok' | 'warning' | 'error' | 'info';

export interface ActivityRef {
  automation_id?: number;
  run_id?: number;
  auto_import_id?: number;
  /** The import folder's auto-import status (pending_review, failed, …). */
  import_status?: string;
  tool?: string;
  plan_id?: string;
  batch_id?: string;
  mirror_run_id?: number;
  /** A library job's id, and while it runs the route that stops it (under /api/). */
  job_id?: number;
  stop_path?: string;
  [key: string]: unknown;
}

export interface ActivityItem {
  id: string;
  /** Unix seconds. */
  time: number;
  kind: ActivityKind;
  status: ActivityStatus;
  title: string;
  /** One line; on a failure it says why and, when it retries, when. */
  detail: string;
  link: string;
  needs_you: boolean;
  has_log?: boolean;
  /** Unix seconds of the next try, when something will retry it. */
  retry_at?: number;
  ref?: ActivityRef;
}

export type ActivityCounts = Record<ActivityKind | 'needs_you', number>;

export interface ActivityResponse {
  success: boolean;
  error?: string;
  items: ActivityItem[];
  next_before: string | null;
  range: string;
  since: number;
  kind: string;
  counts: ActivityCounts;
  running_count: number;
  needs_you: ActivityItem[];
  generated_at: number;
}

export interface ActivityLogLine {
  type?: string;
  text?: string;
}

export interface ActivityLogResponse {
  success: boolean;
  error?: string;
  id: string;
  log_lines: ActivityLogLine[];
}

/** The filter buttons, as the URL spells them (`?show=`). */
export type ActivityShow =
  | 'all'
  | 'downloads'
  | 'imports'
  | 'automations'
  | 'playlists'
  | 'radio'
  | 'needs-you';

/** The range buttons, as the URL and the API spell them (`?range=`). */
export type ActivityRange = 'today' | '7d' | '30d';

export interface ActivitySearch {
  show?: ActivityShow;
  range?: ActivityRange;
}
