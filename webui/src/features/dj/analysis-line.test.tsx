import type { ReactNode } from 'react';

/**
 * Brief A's AnalysisLine (31a–31g) in its three sizes: the line in every
 * state (its words, its dot, its bar by step), the actions each viewer gets,
 * "Canopy is ready to mix" said once and held 4 s, the six cells for reduced
 * motion, the row marker, the topbar's count with its popover, and the phone
 * Activity sheet.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import type { AnalysisEntry, AnalysisSweep } from './analysis.api';

import {
  AnalysisCountHost,
  AnalysisLine,
  AnalysisSheet,
  AnalysisViewerContext,
  SweepLine,
  resetAnalysisAnnouncements,
} from './analysis-line';
import { analysisStore, resetAnalysisRequests } from './analysis.api';

const SWEEP: AnalysisSweep = {
  running: true,
  held: false,
  analyze: true,
  id: 3,
  total: 4980,
  done: 1240,
  percent: 24,
  waiting: null,
  in_line: 4,
  yours: 0,
  left: 10,
  next_in: 1500,
  current: {
    step: 'grid',
    percent: 60,
    asked_for: true,
    track_id: '3',
    title: 'Canopy',
    artist: 'Tidewater',
    times: { read: 1.2, tempo: 0.8, key: 0.6, energy: 0.3 },
    now: 'grid',
    elapsed: 0.4,
  },
  line: [
    {
      track_id: '4',
      title: 'Static Bloom',
      artist: 'Saltmarsh',
      position: 1,
      source: 'set',
      by: 'you',
      set_name: 'Sunday Set',
      front: false,
    },
    {
      track_id: '9',
      title: 'Glass Harbour',
      artist: 'Mira K.',
      position: 3,
      source: 'asked',
      by: 'Mira K.',
      set_name: null,
      front: true,
    },
  ],
  line_more: 0,
};

let sweep: AnalysisSweep = SWEEP;
let tracks: Record<string, AnalysisEntry> = {};
let asked: Record<string, unknown>[] = [];
let started: unknown[] = [];
let stopped = 0;
let progressBodies: Record<string, unknown>[] = [];

beforeEach(() => {
  resetAnalysisRequests();
  analysisStore.reset();
  resetAnalysisAnnouncements();
  sweep = SWEEP;
  tracks = {};
  asked = [];
  started = [];
  stopped = 0;
  progressBodies = [];
  server.use(
    http.post('*/api/library/dj/progress', async ({ request }) => {
      progressBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ success: true, tracks, sweep });
    }),
    http.post('*/api/library/dj/analyse', async ({ request }) => {
      asked.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        {
          success: true,
          asked: 1,
          queued: 1,
          already_queued: 0,
          already_done: 0,
          cant: 0,
          over_limit: 0,
          limit: 200,
          yours: 1,
          started: false,
          moved: 2,
        },
        { status: 202 },
      );
    }),
    http.post('*/api/library/dj/start', async ({ request }) => {
      started.push(await request.json().catch(() => null));
      return HttpResponse.json({ success: true }, { status: 202 });
    }),
    http.post('*/api/library/dj/stop', () => {
      stopped += 1;
      return HttpResponse.json({ success: true });
    }),
    http.get('*/api/library/dj/status', () =>
      HttpResponse.json({
        success: true,
        settings: { analyze: true, write_tags: false, overwrite_tags: false },
        counts: { tracks: 4980, analyzed: 4000, failed: 0, unreachable: 0, pending: 980 },
        grids: { done: 2140, no_beat: 12, pending: 900 },
        job: null,
        held: false,
        can_start: true,
        can_stop: true,
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  analysisStore.reset();
  vi.useRealTimers();
});

function view(node: ReactNode, admin = true) {
  const qc = createTestQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AnalysisViewerContext.Provider value={{ admin }}>{node}</AnalysisViewerContext.Provider>
    </QueryClientProvider>,
  );
}

const lineOf = (text: string) =>
  screen
    .getAllByText(text)
    .map((el) => el.closest('[data-analysis-line]'))
    .find(Boolean)!;

describe('the line (31a), in every state', () => {
  const states: [string, AnalysisEntry, string, string, string | null][] = [
    [
      '1 ready',
      { state: 'done', ready: true, bpm_key: true },
      'Ready to mix · beat grid and phrases',
      'ready',
      null,
    ],
    [
      '2 BPM and key',
      { state: 'done', ready: false, bpm_key: true },
      'BPM and key · no beat grid yet',
      'neutral',
      null,
    ],
    [
      '4 queued',
      { state: 'queued', position: 3, asked_for: true },
      'In line · 3rd',
      'neutral',
      null,
    ],
    [
      '5 reading audio',
      { state: 'working', step: 'read', percent: 5 },
      'Analysing Canopy · reading audio (1 of 6)',
      'running',
      '1',
    ],
    [
      '5 tempo',
      { state: 'working', step: 'tempo', percent: 20 },
      'Analysing Canopy · tempo (2 of 6)',
      'running',
      '2',
    ],
    [
      '5 key',
      { state: 'working', step: 'key', percent: 35 },
      'Analysing Canopy · key (3 of 6)',
      'running',
      '3',
    ],
    [
      '5 energy',
      { state: 'working', step: 'energy', percent: 45 },
      'Analysing Canopy · energy (4 of 6)',
      'running',
      '4',
    ],
    [
      '5 beat grid',
      { state: 'working', step: 'grid', percent: 60 },
      'Analysing Canopy · beat grid (5 of 6)',
      'running',
      '5',
    ],
    [
      '5 phrases',
      { state: 'working', step: 'phrases', percent: 85 },
      'Analysing Canopy · phrases and sections (6 of 6)',
      'running',
      '6',
    ],
    [
      '6 downloads',
      { state: 'waiting', reason: 'download', position: 2, asked_for: true },
      'Waiting for downloads to finish',
      'warning',
      null,
    ],
    [
      '6 tag writing',
      { state: 'waiting', reason: 'tag_write', position: 2, asked_for: true },
      'Waiting for tags to be written',
      'warning',
      null,
    ],
    [
      '8 unreadable',
      { state: 'failed', reason: 'error' },
      "Couldn't be read · won't auto-mix; plays straight on",
      'failed',
      null,
    ],
    [
      '8 too long',
      { state: 'failed', reason: 'too_long', duration: 8040 },
      'Skipped, 2 h 14 min is too long to analyse · plays straight on',
      'neutral',
      null,
    ],
    [
      '9 no steady beat',
      { state: 'done', ready: false, bpm_key: true, beat: 'no_beat' },
      "Can't be beat-matched · no steady beat · echo out or cut",
      'warning',
      null,
    ],
  ];
  for (const [name, entry, words, tone, step] of states) {
    it(`${name}: "${words}", a ${tone} dot`, () => {
      view(<AnalysisLine size="line" entry={entry} title="Canopy" trackId="3" />);
      const line = lineOf(words);
      expect(line).toHaveAttribute('data-tone', tone);
      expect(line.querySelector('[class*="dot"]')).toHaveAttribute('data-tone', tone);
      const bar = line.querySelector('[class*="bar"]')!;
      // the bar is hidden from screen readers; the sentence carries "(5 of 6)"
      expect(bar).toHaveAttribute('aria-hidden', 'true');
      if (step) expect(bar).toHaveAttribute('data-step', step);
      else expect(bar).not.toHaveAttribute('data-step');
    });
  }

  it('3 not analysed: the next sweep, and Analyse now for an admin, Analyse mine for a member', async () => {
    sweep = { ...SWEEP, running: false, current: null };
    const entry: AnalysisEntry = {
      state: 'waiting',
      reason: 'not_queued',
      position: null,
      asked_for: false,
    };
    analysisStore.watch([], { summary: true });
    await waitFor(() => expect(analysisStore.sweep()).not.toBeNull());
    view(<AnalysisLine size="line" entry={entry} title="Canopy" trackId="3" />);
    fireEvent.click(
      within(lineOf('Not analysed · next sweep in about 25 min') as HTMLElement).getByRole(
        'button',
        { name: 'Analyse now' },
      ),
    );
    await waitFor(() =>
      expect(asked).toEqual([{ track_ids: ['3'], reason: 'asked', source: 'asked' }]),
    );
    cleanup();
    view(<AnalysisLine size="line" entry={entry} title="Canopy" trackId="3" />, false);
    expect(screen.getByRole('button', { name: 'Analyse mine' })).toBeInTheDocument();
  });

  it('7 stopped: Resume for an admin; a member sees it disabled (31d)', async () => {
    sweep = { ...SWEEP, running: false, held: true, held_by: 'Ross', in_line: 14, current: null };
    analysisStore.watch([], { summary: true });
    await waitFor(() => expect(analysisStore.sweep()?.held).toBe(true));
    const entry: AnalysisEntry = {
      state: 'waiting',
      reason: 'held',
      position: null,
      asked_for: false,
    };
    view(<AnalysisLine size="line" entry={entry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(started).toHaveLength(1));
    cleanup();
    view(<AnalysisLine size="line" entry={entry} />, false);
    expect(screen.getByText('Analysis stopped by an admin · 14 in line')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toHaveAttribute('aria-disabled', 'true');
  });

  it("Move up and Try again are an admin's", async () => {
    view(
      <AnalysisLine
        size="line"
        entry={{ state: 'queued', position: 3, asked_for: true }}
        trackId="7"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    await waitFor(() => expect(started).toEqual([{ track_id: '7' }]));
    cleanup();
    view(<AnalysisLine size="line" entry={{ state: 'failed', reason: 'error' }} trackId="7" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(asked).toEqual([{ track_ids: ['7'], reason: 'asked', source: 'asked', retry: true }]),
    );
    cleanup();
    view(
      <AnalysisLine size="line" entry={{ state: 'failed', reason: 'error' }} trackId="7" />,
      false,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it("a page's own words and action: a set's line (31a state 11)", () => {
    const onClick = vi.fn();
    view(
      <AnalysisLine
        size="line"
        entry={{ state: 'working', step: 'grid', percent: 60 }}
        title="Canopy"
        extra="11 more in this set"
        action={{ label: 'Analyse all 12', onClick }}
      />,
    );
    fireEvent.click(
      within(
        lineOf('Analysing Canopy · beat grid (5 of 6) · 11 more in this set') as HTMLElement,
      ).getByRole('button', {
        name: 'Analyse all 12',
      }),
    );
    expect(onClick).toHaveBeenCalled();
  });

  it('10 done: "Canopy is ready to mix" once, green and full, for 4 s, then at rest', () => {
    vi.useFakeTimers();
    const { rerender } = view(
      <AnalysisLine
        size="line"
        entry={{ state: 'working', step: 'phrases', percent: 85 }}
        title="Canopy"
        trackId="3"
      />,
    );
    const done = (
      <QueryClientProvider client={createTestQueryClient()}>
        <AnalysisViewerContext.Provider value={{ admin: true }}>
          <AnalysisLine
            size="line"
            entry={{ state: 'done', ready: true, bpm_key: true }}
            title="Canopy"
            trackId="3"
          />
        </AnalysisViewerContext.Provider>
      </QueryClientProvider>
    );
    rerender(done);
    const line = lineOf('Canopy is ready to mix');
    expect(line).toHaveAttribute('data-tone', 'ready');
    expect(line.querySelector('[class*="bar"]')).toHaveAttribute('data-step', '6');
    // said once by the polite live region
    expect(document.querySelector('[data-analysis-live]')).toHaveTextContent(
      'Canopy is ready to mix',
    );
    expect(document.querySelector('[data-analysis-live]')).toHaveAttribute('aria-live', 'polite');
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.getByText('Ready to mix · beat grid and phrases')).toBeInTheDocument();
  });

  it("switching to a track that's ready already says nothing (review L1)", () => {
    const line = (entry: AnalysisEntry, title: string, id: string) => (
      <QueryClientProvider client={createTestQueryClient()}>
        <AnalysisViewerContext.Provider value={{ admin: false }}>
          <AnalysisLine size="line" entry={entry} title={title} trackId={id} hideWhenReady />
        </AnalysisViewerContext.Provider>
      </QueryClientProvider>
    );
    const { rerender, container } = render(
      line({ state: 'queued', position: 2, asked_for: true, ready: false }, 'Night Ferry', 'A'),
    );
    rerender(line({ state: 'done', ready: true, bpm_key: true }, 'Canopy', 'B'));
    expect(document.querySelector('[data-analysis-live]')?.textContent ?? '').not.toContain(
      'ready to mix',
    );
    expect(container.querySelector('[data-analysis-line]')).toBeNull();
  });

  it('14 reduced motion: the bar is also six cells, lit to the step (no fill animation)', () => {
    view(
      <AnalysisLine
        size="line"
        entry={{ state: 'working', step: 'grid', percent: 60 }}
        title="Canopy"
      />,
    );
    const cells = lineOf('Analysing Canopy · beat grid (5 of 6)').querySelectorAll(
      '[class*="cells"] > span',
    );
    expect(cells).toHaveLength(6);
    expect([...cells].map((c) => c.hasAttribute('data-on'))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("the sweep's line (Tracks' head, Activity's row): its track, its step and the page's words", () => {
    view(<SweepLine sweep={SWEEP} extra="2,140 of 4,980 ready to mix" />);
    expect(
      lineOf('Analysing Canopy · beat grid (5 of 6) · 2,140 of 4,980 ready to mix'),
    ).toHaveAttribute('data-tone', 'running');
  });
});

describe('the row marker (31b, 31c)', () => {
  it('a dot and two words; Ready only where readiness is asked for; a bar only while analysed', () => {
    const { rerender } = view(
      <AnalysisLine size="marker" entry={{ state: 'done', ready: true }} />,
    );
    expect(document.querySelector('[data-analysis-marker]')).toBeNull();
    const wrap = (node: ReactNode) => (
      <QueryClientProvider client={createTestQueryClient()}>
        <AnalysisViewerContext.Provider value={{ admin: true }}>
          {node}
        </AnalysisViewerContext.Provider>
      </QueryClientProvider>
    );
    rerender(wrap(<AnalysisLine size="marker" entry={{ state: 'done', ready: true }} showReady />));
    expect(screen.getByText('Ready').closest('[data-analysis-marker]')).toHaveAttribute(
      'data-tone',
      'ready',
    );
    rerender(
      wrap(<AnalysisLine size="marker" entry={{ state: 'working', step: 'grid', percent: 60 }} />),
    );
    const marker = screen
      .getByText('Analysing · beat grid (5 of 6)')
      .closest('[data-analysis-marker]')!;
    expect(marker.querySelector('[data-step="5"]')).not.toBeNull();
    rerender(wrap(<AnalysisLine size="marker" entry={{ state: 'failed', reason: 'error' }} />));
    expect(
      screen.getByText("Couldn't be read · plays straight on").closest('[data-analysis-marker]'),
    ).toHaveAttribute('data-tone', 'failed');
  });
});

describe('the topbar count and its popover (31b, 31c)', () => {
  function topbar() {
    document.body.innerHTML =
      '<header id="ss-topbar"><div class="ss-topbar-end"><a id="ss-running">Activity</a></div></header>';
  }

  it('"Analysing · 14 in line" in the top bar; the popover holds the checklist, the line and Stop', async () => {
    topbar();
    view(<AnalysisCountHost />);
    const pill = await screen.findByRole('button', { name: 'Analysing · 14 in line' });
    expect(pill).toHaveAttribute('data-tone', 'running');
    expect(pill.closest('.ss-topbar-end')).not.toBeNull();
    // the count alone polls at the slow pace (20 s while the sweep runs), and
    // never asks for the line
    expect(progressBodies.every((b) => !b.line)).toBe(true);
    await waitFor(() => expect(analysisStore.delay).toBe(20_000));
    expect(progressBodies).toHaveLength(1);
    fireEvent.click(pill);
    const dialog = screen.getByRole('dialog', { name: 'Analysis' });
    expect(within(dialog).getByText('Analysing Canopy')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Tidewater · 5 of 6 · 14 in line after it'),
    ).toBeInTheDocument();
    const steps = within(within(dialog).getByRole('list', { name: 'Steps' })).getAllByRole(
      'listitem',
    );
    expect(steps.map((li) => li.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'now',
      'todo',
    ]);
    expect(steps[0]).toHaveTextContent('Reading audio, done1.2 s');
    expect(steps[4]).toHaveTextContent('Beat grid, nownow');
    await waitFor(() => expect(progressBodies.some((b) => b.line === true)).toBe(true));
    expect(within(dialog).getByText('you added it to Sunday Set')).toBeInTheDocument();
    expect(within(dialog).getByText('Mira asked')).toBeInTheDocument();
    expect(within(dialog).getByText(/^and 10 more from the sweep ·/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole('link', { name: 'Finding beats · 1,240 of 4,980' }),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop the sweep' }));
    await waitFor(() => expect(stopped).toBe(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pill).toHaveFocus();
  });

  it('idle: "Analysis idle · next sweep in about 25 min", Start now for an admin', async () => {
    sweep = { ...SWEEP, running: false, current: null, in_line: 0, left: 0, line: [] };
    topbar();
    view(<AnalysisCountHost />);
    const pill = await screen.findByRole('button', {
      name: 'Analysis idle · next sweep in about 25 min',
    });
    expect(pill).not.toHaveAttribute('data-running');
    fireEvent.click(pill);
    const dialog = screen.getByRole('dialog', { name: 'Analysis' });
    expect(
      await within(dialog).findByText('next sweep in about 25 min · 2,140 of 4,980 ready to mix'),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start now' }));
    await waitFor(() => expect(started).toHaveLength(1));
  });

  it("a member sees its own count and Analyse mine first, never another profile's tracks", async () => {
    sweep = { ...SWEEP, yours: 2, yours_first: false, line: [SWEEP.line![0]!], line_more: 1 };
    topbar();
    view(<AnalysisCountHost />, false);
    fireEvent.click(await screen.findByRole('button', { name: 'Analysing · 14 in line' }));
    const dialog = screen.getByRole('dialog', { name: 'Analysis' });
    expect(
      within(dialog).getByText('Tidewater · 5 of 6 · 14 in line after it · yours: 2'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Mira asked')).toBeNull();
    expect(within(dialog).getByText(/^and 11 more in line ·/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Stop the sweep' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Analyse mine first' }));
    await waitFor(() => expect(asked).toEqual([{ mine: true, reason: 'asked' }]));
  });

  it('says nothing while analysis is off', async () => {
    sweep = { ...SWEEP, analyze: false };
    topbar();
    view(<AnalysisCountHost />);
    await waitFor(() => expect(analysisStore.sweep()?.analyze).toBe(false));
    expect(document.querySelector('[data-analysis-count]')).toBeNull();
  });
});

describe("the phone's Activity sheet (31f)", () => {
  it('the card with its bar, the checklist, the line; nothing when all is quiet', async () => {
    sweep = { ...SWEEP, yours: 2, yours_first: false };
    view(<AnalysisSheet />, false);
    const sheet = (await screen.findByText('Analysing Canopy')).closest('[data-analysis-panel]')!;
    expect(sheet).toHaveAttribute('data-variant', 'sheet');
    expect(sheet).toHaveTextContent('beat grid (5 of 6) · 14 in line');
    expect(sheet.querySelector('[data-step="5"]')).not.toBeNull();
    expect(
      within(sheet as HTMLElement).getByRole('button', { name: 'Analyse mine first' }),
    ).toBeInTheDocument();
    cleanup();
    analysisStore.reset();
    sweep = { ...SWEEP, running: false, current: null, in_line: 0, left: 0 };
    view(<AnalysisSheet />, false);
    await waitFor(() => expect(analysisStore.sweep()?.running).toBe(false));
    expect(document.querySelector('[data-analysis-panel]')).toBeNull();
  });
});
