/**
 * Coerce a raw search value to a string.
 *
 * TanStack JSON-parses search values, so an all-digits value arrives as a
 * NUMBER and a bare `z.string()` would throw and take the route down. Only
 * primitives are stringified: a hand-edited `?q[]=x` reads as absent.
 */
function searchString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** The list's filter buttons, as the URL spells them (`?show=`). */
export const LIST_SHOWS = ['all', 'attention', 'mine', 'builtin', 'paused'] as const;
export type ListShow = (typeof LIST_SHOWS)[number];

/**
 * Old `?nav=` collections (and the older `?health=` lenses) and the filter
 * that took their place, so bookmarks keep their meaning.
 */
const LEGACY_NAV_TO_SHOW: Record<string, ListShow> = {
  attention: 'attention',
  off: 'paused',
  system: 'builtin',
  operations: 'builtin',
  maintenance: 'builtin',
  ungrouped: 'mine',
};
const LEGACY_HEALTH_TO_SHOW: Record<string, ListShow> = {
  failing: 'attention',
  never: 'attention',
  off: 'paused',
};

/** `group=` value for "automations in no group". */
export const NO_GROUP = '__none__';

export interface AutomationsListSearch {
  /** The selected automation's id. */
  automation?: number;
  show?: ListShow;
  /** A group name, or NO_GROUP. */
  group?: string;
  q?: string;
  /** Exact trigger / action type (links from the old filter dropdowns). */
  trigger?: string;
  action?: string;
  /** `guides`: the recipes and guides instead of the list. */
  view?: 'guides';
}

/**
 * Search for /automations. Old links keep working: `?view=library&nav=…`,
 * `?nav=group:Name`, `?health=failing`, and the trigger/action filters.
 */
export function parseListSearch(raw: Record<string, unknown>): AutomationsListSearch {
  const out: AutomationsListSearch = {};
  const id = Number.parseInt(searchString(raw.automation) ?? '', 10);
  if (Number.isFinite(id) && id > 0) out.automation = id;

  const show = searchString(raw.show);
  if (show && (LIST_SHOWS as readonly string[]).includes(show) && show !== 'all') {
    out.show = show as ListShow;
  }
  const nav = searchString(raw.nav) ?? '';
  const health = searchString(raw.health) ?? '';
  if (!out.show) {
    const legacy =
      LEGACY_NAV_TO_SHOW[nav] ??
      (nav.startsWith('group:') ? undefined : LEGACY_HEALTH_TO_SHOW[health]);
    if (legacy) out.show = legacy;
  }

  const group = searchString(raw.group);
  if (group) out.group = group;
  else if (nav.startsWith('group:') && nav.length > 'group:'.length) out.group = nav.slice(6);
  else if (nav === 'ungrouped') out.group = NO_GROUP;

  for (const key of ['q', 'trigger', 'action'] as const) {
    const value = (searchString(raw[key]) ?? '').trim();
    if (value) out[key] = value;
  }
  if (searchString(raw.view) === 'guides' || nav === 'guides') out.view = 'guides';
  return out;
}

/**
 * One row from GET /api/automations.
 *
 * `automations` table rows passed through _hydrate_automation, which
 * JSON-parses the config columns and backfills `then_actions` from the legacy
 * notify_* pair. Fields are optional because the table grew by migration.
 */
export interface Automation {
  id: number;
  name: string;
  enabled?: boolean | number;
  trigger_type?: string;
  trigger_config?: Record<string, unknown> | null;
  action_type?: string;
  action_config?: Record<string, unknown> | null;
  then_actions?: ThenAction[];
  last_run?: string | null;
  next_run?: string | null;
  run_count?: number;
  last_error?: string | null;
  /** JSON-parsed run facts; null when malformed. */
  last_result?: unknown;
  /** Seeded, undeletable automations. */
  is_system?: boolean | number;
  group_name?: string | null;
  /** 'video' rows belong to the video page. */
  owned_by?: string | null;
  profile_id?: number;
  created_at?: string | null;
  updated_at?: string | null;
}

/** One follow-up step (a THEN block). */
export interface ThenAction {
  type?: string;
  config?: Record<string, unknown>;
  conditions?: StepCondition[] | null;
  match?: string;
}

export interface StepCondition {
  field?: string;
  operator?: string;
  value?: string;
}

/** GET /api/automations returns the bare array, or {error} on failure. */
export type AutomationsListResponse = Automation[] | { error?: string };

/** GET /api/automations/master — the per-side global pause. */
export interface AutomationsMasterState {
  music?: boolean;
  video?: boolean;
  error?: string;
}

/** GET /api/automations/progress — in-flight runs, keyed by automation id. */
export interface AutomationsProgressResponse {
  [key: string]: unknown;
  error?: string;
}

export interface BlockConfigField {
  key: string;
  type: string;
  label?: string;
  default?: unknown;
  min?: number;
  max?: number;
  placeholder?: string;
  description?: string;
  options?: { value: string; label: string }[];
}

/** One entry in the block catalogue (core/automation/blocks.py). */
export interface AutomationBlockDef {
  type: string;
  label?: string;
  description?: string;
  category?: string;
  module?: string | null;
  available?: boolean;
  has_conditions?: boolean;
  condition_fields?: string[];
  variables?: string[];
  config_fields?: BlockConfigField[];
}

/** GET /api/automations/blocks (music scope). */
export interface AutomationBlocks {
  triggers?: AutomationBlockDef[];
  actions?: AutomationBlockDef[];
  notifications?: AutomationBlockDef[];
  category_order?: string[];
  known_signals?: string[];
}

export const BLOCK_CATEGORIES = ['triggers', 'actions', 'notifications'] as const;

/** One recorded run, from GET /api/automations/<id>/history. */
export interface RunEntry {
  id: number;
  automation_id?: number;
  started_at?: string | null;
  finished_at?: string | null;
  duration_seconds?: number | null;
  /** completed | error | timeout | skipped | preview */
  status?: string;
  summary?: string | null;
  result_json?: Record<string, unknown> | string | null;
  log_lines?: { type?: string; text?: string }[];
}

export interface RunHistoryResponse {
  history?: RunEntry[];
  total?: number;
  automation_id?: number;
  error?: string;
}

export interface PreviewCount {
  key: string;
  label: string;
  value: number;
  /** `bytes` for a size. */
  unit?: string;
}

export interface PreviewStep {
  position: number;
  kind: 'action' | 'then';
  type: string;
  previewed: boolean;
  note: string | null;
}

/** POST /api/automations/<id>/preview (CONTRACTS.md, "Preview a run"). */
export interface PreviewResult {
  success: boolean;
  error?: string;
  automation_id: number | null;
  action_type: string;
  available: boolean;
  /** Why there's no preview, when `available` is false. */
  reason?: string;
  /** The step moves or deletes files (it runs through preview-then-confirm). */
  files: boolean;
  summary?: string;
  counts?: PreviewCount[];
  sample?: { title: string; detail: string }[];
  sample_total?: number;
  sample_noun?: string;
  steps: PreviewStep[];
  previewed_at: number;
  duration_ms: number;
  recorded: boolean;
  run_id: number | null;
}

/** What POST/PUT /api/automations take. */
export interface AutomationPayload {
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
  then_actions: ThenAction[];
  group_name?: string | null;
}

/** GET /api/mirrored-playlists/list. */
export interface MirroredPlaylistOption {
  id: number;
  name: string;
  source?: string;
}
