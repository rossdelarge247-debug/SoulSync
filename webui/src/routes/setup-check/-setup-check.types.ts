// GET /api/setup/check (api/setup_check.py, core/setup_check.py).

export type CheckStatus = 'ok' | 'warning' | 'error' | 'skipped';

export type CheckScope = 'all' | 'local';

/** One result. `fix` is empty when there is nothing to do. */
export interface SetupCheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix: string;
  category: string;
  /** machine-readable extras (paths, free space); not every check has them */
  data?: Record<string, unknown>;
}

export interface SetupCheckSummary {
  ok: number;
  warning: number;
  error: number;
  skipped: number;
}

export interface SetupCheckReport {
  status: CheckStatus;
  summary: SetupCheckSummary;
  checks: SetupCheckResult[];
  scope: CheckScope;
  /** unix seconds */
  ranAt: number;
  durationMs: number;
}

export interface SetupCheckResponse {
  success: boolean;
  error?: string;
  status?: string;
  summary?: Partial<SetupCheckSummary>;
  checks?: Array<Partial<SetupCheckResult>>;
  scope?: string;
  ran_at?: number;
  duration_ms?: number;
}

export interface CheckGroup {
  category: string;
  label: string;
  checks: SetupCheckResult[];
  /** no warnings or problems: the group renders one line per check */
  allClear: boolean;
  problems: number;
  warnings: number;
}

export type FixSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; code: string }
  /** a line to paste (a compose volume line, a command): its own block with a Copy button */
  | { kind: 'line'; code: string };

export type StepState = 'done' | 'not-needed' | 'todo' | 'attention' | 'checking';

export interface FirstRunStep {
  id: 'slskd' | 'folders' | 'media-server' | 'verify';
  title: string;
  state: StepState;
}
