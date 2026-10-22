import { describe, expect, it } from 'vitest';

import type { SetupCheckResult } from './-setup-check.types';

import {
  firstRunSteps,
  fixBlocks,
  formatDuration,
  formatRelative,
  formatReportText,
  groupChecks,
  groupSuffix,
  isExpanded,
  normalizeReport,
  parseFixText,
} from './-setup-check.helpers';

function check(partial: Partial<SetupCheckResult> & { id: string }): SetupCheckResult {
  return {
    title: partial.id,
    status: 'ok',
    detail: '',
    fix: '',
    category: 'folders',
    ...partial,
  };
}

describe('normalizeReport', () => {
  it('recounts the summary from the checks and maps unknown statuses to skipped', () => {
    const report = normalizeReport({
      success: true,
      status: 'ok',
      summary: { ok: 9, warning: 0, error: 0, skipped: 0 },
      checks: [
        { id: 'a', title: 'A', status: 'ok', detail: 'fine', category: 'folders' },
        { id: 'b', title: 'B', status: 'error', detail: 'broken', fix: 'do x', category: 'system' },
        { id: 'c', title: 'C', status: 'weird' as never, category: 'system' },
      ],
      scope: 'local',
      ran_at: 1_700_000_000.5,
      duration_ms: 1234,
    });
    expect(report.summary).toEqual({ ok: 1, warning: 0, error: 1, skipped: 1 });
    expect(report.status).toBe('error');
    expect(report.scope).toBe('local');
    expect(report.checks[0].fix).toBe('');
    expect(report.checks[2].status).toBe('skipped');
    expect(report.durationMs).toBe(1234);
  });
});

describe('groupChecks', () => {
  it('puts groups with problems first, then warnings, and problems first inside a group', () => {
    const groups = groupChecks([
      check({ id: 'media_server.connection', category: 'media_server' }),
      check({ id: 'system.user', category: 'system', status: 'warning' }),
      check({ id: 'folder.downloads', category: 'folders' }),
      check({ id: 'folder.podcasts', category: 'folders', status: 'skipped' }),
      check({ id: 'folder.transfer', category: 'folders', status: 'error' }),
      check({ id: 'slskd.connection', category: 'downloads' }),
    ]);
    expect(groups.map((g) => g.category)).toEqual([
      'folders',
      'system',
      'downloads',
      'media_server',
    ]);
    expect(groups[0].checks.map((c) => c.id)).toEqual([
      'folder.transfer',
      'folder.downloads',
      'folder.podcasts',
    ]);
    expect(groups[0]).toMatchObject({ label: 'Folders', allClear: false, problems: 1 });
    expect(groups[2]).toMatchObject({ label: 'Downloads (slskd)', allClear: true });
  });

  it('sums a group up for its heading', () => {
    const [problems, clear, skipped] = [
      groupChecks([
        check({ id: 'a', status: 'error' }),
        check({ id: 'b', status: 'warning' }),
        check({ id: 'c', status: 'warning' }),
      ])[0],
      groupChecks([check({ id: 'a' }), check({ id: 'b', status: 'skipped' })])[0],
      groupChecks([check({ id: 'a', status: 'skipped' })])[0],
    ];
    expect(groupSuffix(problems)).toBe('1 problem, 2 warnings');
    expect(groupSuffix(clear)).toBe('all OK');
    expect(groupSuffix(skipped)).toBe('not checked');
  });

  it('labels an unknown category from its name', () => {
    expect(groupChecks([check({ id: 'x', category: 'new_thing' })])[0].label).toBe('New thing');
  });
});

describe('parseFixText', () => {
  it('breaks compose lines out as their own copyable line and keeps short code inline', () => {
    const segments = parseFixText(
      'Map a folder from your server to it: add a line like `- /path/on/your/server:/music` under ' +
        "SoulSync's volumes. Run `id` on the server.",
    );
    expect(segments).toEqual([
      { kind: 'text', text: 'Map a folder from your server to it: add a line like' },
      { kind: 'line', code: '- /path/on/your/server:/music' },
      { kind: 'text', text: "under SoulSync's volumes. Run " },
      { kind: 'code', code: 'id' },
      { kind: 'text', text: ' on the server.' },
    ]);
    expect(fixBlocks(segments)).toHaveLength(3);
  });

  it('treats a command with arguments as a line and drops the full stop after it', () => {
    const segments = parseFixText(
      'Give it access, e.g. `sudo chown -R 1000:1000 /path/on/your/server`. Or set PUID.',
    );
    expect(segments).toEqual([
      { kind: 'text', text: 'Give it access, e.g.' },
      { kind: 'line', code: 'sudo chown -R 1000:1000 /path/on/your/server' },
      { kind: 'text', text: 'Or set PUID.' },
    ]);
  });

  it('leaves plain text alone', () => {
    expect(parseFixText('Free up space.')).toEqual([{ kind: 'text', text: 'Free up space.' }]);
  });
});

describe('isExpanded', () => {
  it('expands problems, warnings and skipped checks that carry advice', () => {
    expect(isExpanded(check({ id: 'a', status: 'error', fix: 'x' }))).toBe(true);
    expect(isExpanded(check({ id: 'a', status: 'warning' }))).toBe(true);
    expect(isExpanded(check({ id: 'a', status: 'skipped', fix: 'Connect it' }))).toBe(true);
    expect(isExpanded(check({ id: 'a', status: 'skipped' }))).toBe(false);
    expect(isExpanded(check({ id: 'a', status: 'ok' }))).toBe(false);
  });
});

describe('formatting', () => {
  it('formats durations and relative times', () => {
    expect(formatDuration(420)).toBe('under a second');
    expect(formatDuration(4200)).toBe('4.2 s');
    expect(formatDuration(21_700)).toBe('22 s');
    expect(formatRelative(1000, 1000 * 1000 + 10_000)).toBe('Just now');
    expect(formatRelative(1000, 1000 * 1000 + 120_000)).toBe('2 min ago');
  });

  it('writes a plain-text report with every check, problems first', () => {
    const text = formatReportText(
      normalizeReport({
        success: true,
        checks: [
          { id: 'a', title: 'Download folder', status: 'ok', detail: 'Fine.', category: 'folders' },
          {
            id: 'b',
            title: 'Music library folder',
            status: 'error',
            detail: "/music doesn't exist.",
            fix: 'Map it: `- /path/on/your/server:/music`.',
            category: 'folders',
          },
        ],
        scope: 'all',
        ran_at: 1_700_000_000,
        duration_ms: 4200,
      }),
    );
    expect(text).toContain('SoulSync setup check');
    expect(text).toContain('took 4.2 s');
    expect(text).toContain('Result: 1 problem, 0 warnings, 1 OK, 0 skipped');
    expect(text.indexOf('[Problem] Music library folder')).toBeLessThan(
      text.indexOf('[OK] Download folder'),
    );
    expect(text).toContain('How to fix it: Map it: `- /path/on/your/server:/music`.');
  });
});

describe('firstRunSteps', () => {
  it('derives each step from the checks', () => {
    const steps = firstRunSteps(
      [
        check({ id: 'folder.downloads' }),
        check({ id: 'folder.transfer' }),
        check({ id: 'folders.layout' }),
        check({ id: 'slskd.connection', category: 'downloads', status: 'skipped' }),
        check({
          id: 'media_server.connection',
          category: 'media_server',
          status: 'skipped',
          fix: 'Connect it in Settings',
        }),
      ],
      false,
    );
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ['slskd', 'not-needed'],
      ['folders', 'done'],
      ['media-server', 'todo'],
      ['verify', 'todo'],
    ]);
  });

  it('asks for a fix when no library is chosen', () => {
    const steps = firstRunSteps(
      [
        check({ id: 'folder.transfer' }),
        check({
          id: 'media_server.connection',
          category: 'media_server',
          title: 'Where your library lives',
          status: 'warning',
          fix: 'Choose Standalone in Settings → Connections → Server Connections',
        }),
      ],
      true,
    );
    // settled from the local run alone, without waiting for the full one
    expect(steps.find((s) => s.id === 'media-server')!.state).toBe('attention');
  });

  it('marks the network steps as checking while the full run is going', () => {
    const steps = firstRunSteps([check({ id: 'folder.transfer', status: 'error' })], true);
    expect(steps.map((s) => s.state)).toEqual(['checking', 'attention', 'checking', 'checking']);
  });

  it('is all done when everything passed', () => {
    const steps = firstRunSteps(
      [
        check({ id: 'folder.transfer' }),
        check({ id: 'slskd.connection', category: 'downloads' }),
        check({ id: 'media_server.connection', category: 'media_server' }),
      ],
      false,
    );
    expect(steps.every((s) => s.state === 'done')).toBe(true);
  });
});
