import type {
  CheckGroup,
  CheckStatus,
  FirstRunStep,
  FixSegment,
  SetupCheckReport,
  SetupCheckResponse,
  SetupCheckResult,
  SetupCheckSummary,
  StepState,
} from './-setup-check.types';

const STATUSES: readonly CheckStatus[] = ['ok', 'warning', 'error', 'skipped'];

export function toStatus(value: unknown): CheckStatus {
  return STATUSES.includes(value as CheckStatus) ? (value as CheckStatus) : 'skipped';
}

/** The word shown next to every status colour. */
export const STATUS_WORD: Record<CheckStatus, string> = {
  ok: 'OK',
  warning: 'Warning',
  error: 'Problem',
  skipped: 'Skipped',
};

// problems first, then warnings; a skipped check says the least
const STATUS_ORDER: Record<CheckStatus, number> = { error: 0, warning: 1, ok: 2, skipped: 3 };

const CATEGORY_LABELS: Record<string, string> = {
  folders: 'Folders',
  downloads: 'Downloads (slskd)',
  media_server: 'Media server',
  system: 'System',
  radio: 'Internet radio',
  privacy: 'Privacy (VPN)',
};

const CATEGORY_ORDER = ['folders', 'downloads', 'privacy', 'media_server', 'system', 'radio'];

/** The checks that only the full run (not `?scope=local`) includes. */
export const NETWORK_CATEGORIES = new Set(['downloads', 'media_server', 'privacy']);

export function categoryLabel(category: string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  if (!category) return 'Other';
  const words = category.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function summarize(checks: readonly SetupCheckResult[]): SetupCheckSummary {
  const summary: SetupCheckSummary = { ok: 0, warning: 0, error: 0, skipped: 0 };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

export function worstStatus(checks: readonly SetupCheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warning')) return 'warning';
  return 'ok';
}

export function normalizeReport(payload: SetupCheckResponse): SetupCheckReport {
  const checks: SetupCheckResult[] = (payload.checks ?? []).map((raw, index) => ({
    id: String(raw.id ?? `check-${index}`),
    title: String(raw.title ?? raw.id ?? 'Check'),
    status: toStatus(raw.status),
    detail: String(raw.detail ?? ''),
    fix: String(raw.fix ?? ''),
    category: String(raw.category ?? ''),
    ...(raw.data && typeof raw.data === 'object' ? { data: raw.data } : {}),
  }));
  return {
    // recounted rather than trusted: the tiles and the groups must agree
    status: worstStatus(checks),
    summary: summarize(checks),
    checks,
    scope: payload.scope === 'local' ? 'local' : 'all',
    ranAt: Number(payload.ran_at) || Date.now() / 1000,
    durationMs: Math.max(0, Number(payload.duration_ms) || 0),
  };
}

function sortChecks(checks: readonly SetupCheckResult[]): SetupCheckResult[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort(
      (a, b) => STATUS_ORDER[a.check.status] - STATUS_ORDER[b.check.status] || a.index - b.index,
    )
    .map(({ check }) => check);
}

/**
 * Checks grouped by category. Groups with problems come first, then groups
 * with warnings, then the rest in a fixed order; inside a group problems and
 * warnings lead.
 */
export function groupChecks(checks: readonly SetupCheckResult[]): CheckGroup[] {
  const byCategory = new Map<string, SetupCheckResult[]>();
  for (const check of checks) {
    const list = byCategory.get(check.category) ?? [];
    list.push(check);
    byCategory.set(check.category, list);
  }
  const rank = (category: string) => {
    const at = CATEGORY_ORDER.indexOf(category);
    return at === -1 ? CATEGORY_ORDER.length : at;
  };
  return [...byCategory.entries()]
    .map(([category, list]): CheckGroup => {
      const problems = list.filter((c) => c.status === 'error').length;
      const warnings = list.filter((c) => c.status === 'warning').length;
      return {
        category,
        label: categoryLabel(category),
        checks: sortChecks(list),
        allClear: problems === 0 && warnings === 0,
        problems,
        warnings,
      };
    })
    .sort((a, b) => {
      const severity = (g: CheckGroup) => (g.problems ? 0 : g.warnings ? 1 : 2);
      return severity(a) - severity(b) || rank(a.category) - rank(b.category);
    });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1 problem, 2 warnings" / "all OK" for a group heading. */
export function groupSuffix(group: CheckGroup): string {
  if (group.allClear) {
    // every check skipped (no media server, Soulseek not used) isn't "OK"
    return group.checks.some((c) => c.status === 'ok') ? 'all OK' : 'not checked';
  }
  const parts: string[] = [];
  if (group.problems) parts.push(plural(group.problems, 'problem'));
  if (group.warnings) parts.push(plural(group.warnings, 'warning'));
  return parts.join(', ');
}

/**
 * A backtick-quoted bit that's meant to be pasted somewhere: a compose volume
 * line (`- /path/on/your/server:/music`) or a command with arguments. Short
 * words like `id` or `user:` stay inline.
 */
export function isPasteLine(code: string): boolean {
  const trimmed = code.trim();
  return trimmed.startsWith('- ') || /\s/.test(trimmed);
}

/**
 * The backend's fix text, split so backtick-quoted bits render as code. Lines
 * to paste break out into their own block; the text around them is trimmed so
 * a sentence doesn't start with a stray full stop.
 */
export function parseFixText(fix: string): FixSegment[] {
  const parts = fix.split(/`([^`\n]+)`/);
  const segments: FixSegment[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      segments.push(
        isPasteLine(part) ? { kind: 'line', code: part.trim() } : { kind: 'code', code: part },
      );
      return;
    }
    if (part) segments.push({ kind: 'text', text: part });
  });

  // tidy the text either side of a block line
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.kind !== 'text') continue;
    const prev = segments[i - 1];
    const next = segments[i + 1];
    let text = segment.text;
    if (prev?.kind === 'line') text = text.replace(/^[\s.,;:]+/, '');
    if (next?.kind === 'line') text = text.replace(/\s+$/, '');
    segment.text = text;
  }
  return segments.filter((s) => s.kind !== 'text' || s.text.trim() !== '');
}

/** Group text and inline code into paragraphs; each block line stands alone. */
export function fixBlocks(segments: readonly FixSegment[]): Array<FixSegment[]> {
  const blocks: Array<FixSegment[]> = [];
  let current: FixSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === 'line') {
      if (current.length) blocks.push(current);
      blocks.push([segment]);
      current = [];
    } else {
      current.push(segment);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

/** A row expands (detail + fix box) when it needs attention or has advice. */
export function isExpanded(check: SetupCheckResult): boolean {
  if (check.status === 'error' || check.status === 'warning') return true;
  return check.status === 'skipped' && check.fix.trim() !== '';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return 'under a second';
  const seconds = ms / 1000;
  if (seconds < 10) return `${Number(seconds.toFixed(1))} s`;
  return `${Math.round(seconds)} s`;
}

export function formatRelative(ranAtSeconds: number, nowMs: number): string {
  const diff = Math.max(0, Math.round(nowMs / 1000 - ranAtSeconds));
  if (diff < 45) return 'Just now';
  const minutes = Math.round(diff / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ranAtSeconds * 1000).toLocaleDateString();
}

export function formatTimestamp(ranAtSeconds: number): string {
  return new Date(ranAtSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

export function summaryLine(summary: SetupCheckSummary): string {
  return [
    plural(summary.error, 'problem'),
    plural(summary.warning, 'warning'),
    `${summary.ok} OK`,
    `${summary.skipped} skipped`,
  ].join(', ');
}

/** Plain text for a bug report or a support thread. */
export function formatReportText(report: SetupCheckReport): string {
  const lines = [
    'SYNCHRO.S setup check',
    `Checked: ${formatTimestamp(report.ranAt)} (took ${formatDuration(report.durationMs)})`,
  ];
  if (report.scope === 'local') {
    lines.push('Scope: folders only (slskd and the media server were not checked)');
  }
  lines.push(`Result: ${summaryLine(report.summary)}`);
  for (const group of groupChecks(report.checks)) {
    lines.push('', `== ${group.label} ==`);
    for (const check of group.checks) {
      lines.push(`[${STATUS_WORD[check.status]}] ${check.title}`);
      if (check.detail) lines.push(`  ${check.detail}`);
      if (check.fix && check.status !== 'ok') lines.push(`  How to fix it: ${check.fix}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// First-run steps, derived from the report (the setup wizard's own state is
// only "finished or not", from GET /api/setup/status)
// ---------------------------------------------------------------------------

function stateOf(check: SetupCheckResult | undefined, pending: boolean): StepState {
  if (!check) return pending ? 'checking' : 'todo';
  if (check.status === 'ok') return 'done';
  if (check.status === 'error' || check.status === 'warning') return 'attention';
  // skipped: advice attached means "you haven't set this up"; none means it
  // doesn't apply (Soulseek isn't a source, SoulSync's own library)
  return check.fix.trim() ? 'todo' : 'not-needed';
}

export function firstRunSteps(
  checks: readonly SetupCheckResult[],
  networkPending: boolean,
): FirstRunStep[] {
  const byId = new Map(checks.map((c) => [c.id, c]));
  const folderChecks = checks.filter(
    (c) => c.id === 'folder.downloads' || c.id === 'folder.transfer' || c.id === 'folders.layout',
  );
  const folders: StepState = !folderChecks.length
    ? 'checking'
    : folderChecks.some((c) => c.status === 'error')
      ? 'attention'
      : 'done';
  const slskd = stateOf(byId.get('slskd.connection'), networkPending);
  const media = stateOf(byId.get('media_server.connection'), networkPending);
  const earlier = [slskd, folders, media];
  const verify: StepState = earlier.includes('checking')
    ? 'checking'
    : earlier.every((s) => s === 'done' || s === 'not-needed') && worstStatus(checks) === 'ok'
      ? 'done'
      : 'todo';
  return [
    { id: 'slskd', title: 'Connect slskd', state: slskd },
    { id: 'folders', title: 'Choose your folders', state: folders },
    { id: 'media-server', title: 'Connect a media server', state: media },
    { id: 'verify', title: 'Check it all works', state: verify },
  ];
}

export const STEP_WORD: Record<StepState, string> = {
  done: 'Done',
  'not-needed': 'Not needed',
  todo: 'To do',
  attention: 'Needs fixing',
  checking: 'Checking',
};
