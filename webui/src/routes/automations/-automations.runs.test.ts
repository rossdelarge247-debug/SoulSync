import { describe, expect, it } from 'vitest';

import type { RunEntry } from './-automations.types';

import { durationWords, runNumbers, runRow, runsLine, runsWindow } from './-automations.runs';

const NOW = Date.UTC(2026, 9, 21, 12, 0);
const DAY = 86_400_000;

function run(id: number, daysAgo: number, over: Partial<RunEntry> = {}): RunEntry {
  const finished = new Date(NOW - daysAgo * DAY).toISOString();
  return {
    id,
    status: 'completed',
    finished_at: finished,
    started_at: finished,
    duration_seconds: 240,
    summary: 'Done',
    ...over,
  };
}

describe('the 30-day window', () => {
  it('counts the runs of the last 30 days when every run is kept', () => {
    const history = [run(5, 1), run(4, 2), run(3, 29), run(2, 40), run(1, 50)];
    const w = runsWindow(history, 5, NOW);
    expect(w.complete).toBe(true);
    expect(w.label).toBe('3 in 30 days');
    expect(w.runs.map((r) => r.id)).toEqual([5, 4, 3]);
  });

  it('says which runs it covers when the history cap cut the 30 days short', () => {
    const history = Array.from({ length: 100 }, (_, i) => run(100 - i, i * 0.02));
    const w = runsWindow(history, 100, NOW);
    expect(w.complete).toBe(false);
    expect(w.label).toMatch(/^Last 100, since (\d+ Oct|Oct \d+)$/);
    expect(w.runs).toHaveLength(100);
  });

  it('is complete at the cap when the kept runs reach back past 30 days', () => {
    const history = Array.from({ length: 100 }, (_, i) => run(100 - i, i * 0.5));
    expect(runsWindow(history, 100, NOW).label).toBe('61 in 30 days');
  });
});

describe('the three numbers', () => {
  it('counts what the runs produced, when the action records it', () => {
    const runs = [
      run(4, 1, { result_json: { tracks_added_to_wishlist: 3 } }),
      run(3, 2, {
        result_json: JSON.stringify({ tracks_added_to_wishlist: '2' }),
        duration_seconds: 50,
      }),
      run(2, 3, { status: 'error', summary: 'Spotify said no' }),
      run(1, 4, { status: 'preview', result_json: { tracks_added_to_wishlist: 99 } }),
    ];
    expect(runNumbers(runs, 'scan_watchlist')).toEqual([
      { label: 'Added to Wanted', value: '5' },
      { label: 'Failed runs', value: '1' },
      { label: 'Typical', value: '2\u00a0min' },
    ]);
  });

  it('falls back to how many finished, and leaves out preview-only runs from outcomes', () => {
    const runs = [
      run(3, 1),
      run(2, 1, { status: 'timeout' }),
      run(1, 2, { duration_seconds: null }),
    ];
    expect(runNumbers(runs, 'process_wishlist')).toEqual([
      { label: 'Done', value: '2' },
      { label: 'Failed runs', value: '1' },
      { label: 'Typical', value: '4\u00a0min' },
    ]);
    expect(
      runNumbers(
        [run(1, 1, { result_json: { mode: 'plan', files_deleted: 0, would_remove: 9 } })],
        'run_duplicate_cleaner',
      )[0],
    ).toEqual({ label: 'Moved to the bin', value: '0' });
    expect(runNumbers([], 'scan_library')[2]).toEqual({ label: 'Typical', value: '—' });
  });
});

describe('rows', () => {
  it('tags each run with a word', () => {
    expect(runRow(run(1, 0, { summary: '12 found.' }), NOW)).toMatchObject({
      tag: 'Done',
      tone: 'success',
      summary: '12 found · 4\u00a0min',
    });
    expect(
      runRow(run(2, 0, { status: 'error', summary: "Soulseek wasn't reachable" }), NOW),
    ).toMatchObject({
      tag: 'Failed',
      tone: 'danger',
      summary: "Soulseek wasn't reachable",
    });
    expect(
      runRow(run(3, 0, { status: 'preview', summary: 'Would search 44 · nothing changed' }), NOW),
    ).toMatchObject({
      tag: 'Preview',
      tone: 'neutral',
      preview: true,
      summary: 'Preview · Would search 44 · nothing changed',
    });
    expect(
      runRow(run(4, 0, { status: 'skipped', summary: 'music automations are paused' }), NOW),
    ).toMatchObject({
      tag: 'Skipped',
      summary: 'Skipped · music automations are paused',
    });
  });

  it('words what a Wanted search records', () => {
    expect(
      runRow(
        run(1, 0, {
          summary: 'Started: 2 album batch(es), 1 per-track for cycle albums',
          duration_seconds: 3,
        }),
        NOW,
      ).summary,
    ).toBe('Started 2 album and 1 track searches · albums turn · 3\u00a0s');
    expect(
      runRow(run(2, 0, { summary: 'Started: no batches for cycle singles' }), NOW).summary,
    ).toBe('Nothing was due · singles turn · 4\u00a0min');
    expect(
      runRow(run(6, 0, { summary: 'Started: 7 per-track for cycle singles' }), NOW).summary,
    ).toBe('Started 7 track searches · singles turn · 4\u00a0min');
    expect(
      runRow(run(3, 0, { status: 'error', summary: 'Error: Soulseek is not connected' }), NOW)
        .summary,
    ).toBe('Soulseek is not connected');
    expect(
      runRow(run(4, 0, { summary: 'Queued 8 quality upgrades on the wishlist' }), NOW).summary,
    ).toBe('Queued 8 quality upgrades on Wanted · 4\u00a0min');
    expect(
      runRow(run(5, 0, { summary: 'Scanned 18 artists — 2 new tracks, 1 added to wishlist' }), NOW)
        .summary,
    ).toBe('Scanned 18 artists — 2 new tracks, 1 added to Wanted · 4\u00a0min');
  });

  it('writes the phone line', () => {
    expect(
      runsLine([run(3, 0), run(2, 1, { status: 'error' }), run(1, 2, { status: 'preview' })], NOW),
    ).toMatch(/^3 runs in 30 days · last failed /);
    expect(runsLine([], NOW)).toBe('No runs yet');
  });

  it('words durations', () => {
    expect(durationWords(0.4)).toBe('under a second');
    expect(durationWords(38)).toBe('38\u00a0s');
    expect(durationWords(3900)).toBe('1\u00a0h\u00a05\u00a0min');
    expect(durationWords(null)).toBe('');
  });

  it('counts what Wanted searches found, once their runs carry it', () => {
    const runs = [
      run(1, 0, {
        summary: 'Started: 2 album batch(es), 1 per-track for cycle albums',
        result_json: { found: { tracks: 7, albums: 1 }, searched: { tracks: 9, albums: 2 } },
      }),
      run(2, 1, { result_json: JSON.stringify({ found: { tracks: 3, albums: 0 } }) }),
      run(3, 2, { summary: 'Started: no batches for cycle singles' }),
    ];
    expect(runNumbers(runs, 'process_wishlist')[0]).toEqual({ label: 'Found', value: '10' });
    expect(runRow(runs[0], NOW).summary).toBe(
      'Started 2 album and 1 track searches · albums turn · 7 found · 4\u00a0min',
    );
    // older runs say nothing about what they found
    expect(runRow(runs[2], NOW).summary).not.toMatch(/found/);
    expect(runNumbers([runs[2]], 'process_wishlist')[0].label).toBe('Done');
  });
});
