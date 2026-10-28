import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { analysisStore, resetAnalysisRequests } from '@/features/dj/analysis.api';
import { HttpResponse, http, server } from '@/test/msw';

import { CUE_WHY_NOT } from '../outputs';

const downloads = vi.hoisted(() => ({ files: [] as { name: string; data: unknown }[] }));
vi.mock('./mix-report', async (original) => ({
  ...(await original<typeof import('./mix-report')>()),
  downloadJson: (name: string, data: unknown) => downloads.files.push({ name, data }),
}));
import AutomixLab, { PlanSummary } from './automix-lab';
import { LabSession, waitingWords } from './lab-session';

const track = (id: string, title: string, bpm: number, key: string) => ({
  id,
  title,
  artist_name: 'Saltmarsh',
  album_title: 'Lantern',
  artist_id: '1',
  album_id: '10',
  duration_ms: 240000,
  file_path: `/m/${id}.flac`,
  bitrate: 1000,
  image_url: null,
  dj: { bpm, key, analyzed: true },
});

/** A deck's picker: Search, its fallback source. */
function searchIn(deck: 'outgoing' | 'incoming') {
  const group = screen.getByRole('radiogroup', { name: `Pick the ${deck} track from` });
  fireEvent.click(within(group).getByRole('radio', { name: 'Search' }));
}

describe('the auto-mix lab page', () => {
  it('finds two tracks, shows their plan, and says why a second output is impossible here', async () => {
    server.use(
      http.get('*/api/library/dj/browse', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q');
        const tracks =
          q === 'night'
            ? [track('1', 'Night Ferry', 124, '8A')]
            : [track('2', 'Static Bloom', 126, '9A')];
        return HttpResponse.json({
          tracks,
          total: 1,
          page: 1,
          limit: 8,
          has_more: false,
          sort: 'title',
        });
      }),
      http.get('*/api/library/dj/plan', ({ request }) => {
        const u = new URL(request.url);
        expect(u.searchParams.get('from')).toBe('1');
        expect(u.searchParams.get('to')).toBe('2');
        return HttpResponse.json({
          success: true,
          plan: {
            status: 'ok',
            style: 'long_blend',
            label: 'Long blend',
            bars: 32,
            chosen_by: 'auto',
            why: '8A → 9A, +2 BPM: the keys mix and the tempo is close',
            beatmatch: true,
            tempo: { relation: 'same', rate: 0.98413, speed_change_ok: true },
            out: { start: 154.951, bar: 80 },
            in: { start: 0.2, bar: 0 },
          },
        });
      }),
    );
    render(<AutomixLab />);
    expect(screen.getByRole('heading', { name: 'Auto-mix lab' })).toBeInTheDocument();
    expect(screen.getByText(CUE_WHY_NOT)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /On another output/ })).toBeDisabled();
    const play = screen.getByRole('button', { name: 'Play the mix' });
    expect(play).toBeDisabled();
    searchIn('outgoing');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the outgoing track' }), {
      target: { value: 'night' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Night Ferry' }));
    searchIn('incoming');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the incoming track' }), {
      target: { value: 'static' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Static Bloom' }));
    expect(play).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Show the plan' }));
    await waitFor(() =>
      expect(screen.getByText(/the keys mix and the tempo is close/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/154.95 s \(bar 80\)/)).toBeInTheDocument();
  });
});

describe('the lab without storage', () => {
  it('still opens where reading localStorage throws', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      render(<AutomixLab />);
      expect(screen.getByRole('heading', { name: 'Auto-mix lab' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /Split one output/ })).toBeChecked();
    } finally {
      if (real) Object.defineProperty(window, 'localStorage', real);
    }
  });
});

// ── every planner status (core/dj/planner.py): waiting has no places, a
// crossfade may have no outgoing start ──

const WAITING = {
  status: 'waiting',
  style: null,
  bars: null,
  waiting_for: 'from',
  reason: 'analyzing',
  why: 'Waiting for the analysis',
  styles: [],
  pair: '8A → 9A, +2 BPM',
  key: { from: '8A', to: '9A', relation: 'up' },
  tempo: null,
};
const CROSSFADE = {
  status: 'crossfade',
  style: 'crossfade',
  bars: null,
  beatmatch: false,
  why: "Couldn't beat-match: no steady beat",
  fallback: { kind: 'crossfade', code: 'no_beat', reason: 'no steady beat' },
  out: { start: null, bar: null, end: null },
  in: { start: 0, bar: null },
  length_s: 6,
};
const OK = {
  status: 'ok',
  style: 'long_blend',
  label: 'Long blend',
  bars: 32,
  chosen_by: 'auto',
  why: '8A → 9A, +2 BPM: the keys mix',
  beatmatch: true,
  tempo: { relation: 'same', rate: 0.98413, speed_change_ok: true },
  out: { start: 154.951, bar: 80 },
  in: { start: 0.2, bar: 0 },
};
const titles = { from: 'Night Ferry', to: 'Static Bloom' };

describe('[gauntlet lab] the plan summary reads every status', () => {
  it('waiting: which track and why, no places', () => {
    render(<PlanSummary plan={WAITING as never} titles={titles} />);
    expect(
      screen.getByText("Waiting for Night Ferry's beat grid · being analysed"),
    ).toBeInTheDocument();
    expect(screen.getByText('waiting')).toBeInTheDocument();
  });

  it('crossfade with no outgoing start: "?" for it, the incoming start', () => {
    render(<PlanSummary plan={CROSSFADE as never} titles={titles} />);
    expect(screen.getByText('? s (bar —) → 0.00 s (bar —)')).toBeInTheDocument();
    expect(screen.getByText("Couldn't beat-match: no steady beat")).toBeInTheDocument();
  });

  it('ok: both places', () => {
    render(<PlanSummary plan={OK as never} titles={titles} />);
    expect(screen.getByText('154.95 s (bar 80) → 0.20 s (bar 0)')).toBeInTheDocument();
  });

  it('the words for each track and reason', () => {
    expect(waitingWords({ waiting_for: 'to', reason: 'not_analyzed' }, titles)).toBe(
      "Waiting for Static Bloom's beat grid · not analysed yet",
    );
    expect(waitingWords({ waiting_for: 'from' })).toBe(
      "Waiting for the outgoing track's beat grid · not analysed yet",
    );
  });
});

describe('[gauntlet lab] a waiting pair on the page', () => {
  function serve(plan: object) {
    server.use(
      http.get('*/api/library/dj/browse', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q');
        const tracks =
          q === 'night'
            ? [track('1', 'Night Ferry', 124, '8A')]
            : [track('2', 'Static Bloom', 126, '9A')];
        return HttpResponse.json({
          tracks,
          total: 1,
          page: 1,
          limit: 8,
          has_more: false,
          sort: 'title',
        });
      }),
      http.get('*/api/library/dj/plan', () => HttpResponse.json({ success: true, plan })),
    );
  }
  async function pick() {
    render(<AutomixLab />);
    searchIn('outgoing');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the outgoing track' }), {
      target: { value: 'night' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Night Ferry' }));
    searchIn('incoming');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the incoming track' }), {
      target: { value: 'static' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Static Bloom' }));
  }

  it('shows the plan without breaking, and Play the mix waits, saying why', async () => {
    serve(WAITING);
    await pick();
    const play = screen.getByRole('button', { name: 'Play the mix' });
    expect(play).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Show the plan' }));
    await waitFor(() => expect(play).toBeDisabled());
    expect(play).toHaveAccessibleDescription(
      "Waiting for Night Ferry's beat grid · being analysed: Play the mix waits for it.",
    );
  });

  it('a crossfade plan shows and can play', async () => {
    serve(CROSSFADE);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Show the plan' }));
    await screen.findByText('? s (bar —) → 0.00 s (bar —)');
    expect(screen.getByRole('button', { name: 'Play the mix' })).toBeEnabled();
  });

  it('the session itself stops at a waiting plan with the words, before any grid or window', async () => {
    const fetchGrids = vi.fn();
    const fetchWindow = vi.fn();
    const s = new LabSession(
      { from: '1', to: '2', style: 'auto', prerollBars: 8, keyLock: false, correct: true, titles },
      {
        fetchPlan: async () => WAITING as never,
        fetchGrids,
        fetchWindow,
      } as never,
    );
    await s.start();
    expect(s.status.stage).toBe('error');
    expect(s.status.words).toBe("Waiting for Night Ferry's beat grid · being analysed");
    expect(fetchGrids).not.toHaveBeenCalled();
    expect(fetchWindow).not.toHaveBeenCalled();
  });
});

describe('analyse on demand in the lab', () => {
  it('a picked track jumps the analysis queue, and shows its step', async () => {
    resetAnalysisRequests();
    analysisStore.reset();
    const asked: unknown[] = [];
    server.use(
      http.get('*/api/library/dj/browse', () =>
        HttpResponse.json({
          tracks: [{ ...track('5', 'Sand Script', 0, ''), dj: null }],
          total: 1,
          page: 1,
          limit: 8,
          has_more: false,
          sort: 'title',
        }),
      ),
      http.post('*/api/library/dj/analyse', async ({ request }) => {
        asked.push(await request.json());
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
            started: true,
          },
          { status: 202 },
        );
      }),
      http.post('*/api/library/dj/progress', () =>
        HttpResponse.json({
          success: true,
          tracks: { '5': { state: 'working', step: 'tempo', percent: 20 } },
          sweep: { running: true },
        }),
      ),
    );
    render(<AutomixLab />);
    searchIn('outgoing');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the outgoing track' }), {
      target: { value: 'sand' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Sand Script' }));
    // a lab pick: a person's ask, from the lab (the popover's "the lab")
    await waitFor(() =>
      expect(asked).toEqual([{ track_ids: ['5'], reason: 'asked', source: 'lab' }]),
    );
    // the chosen track's line names it with its step (31c)
    expect(
      (await screen.findAllByText('Analysing Sand Script · tempo (2 of 6)')).length,
    ).toBeGreaterThan(0);
    analysisStore.reset();
  });
});

describe('Download a mix report', () => {
  it('saves the pair’s grids and plan as JSON, with no file paths', async () => {
    downloads.files.length = 0;
    resetAnalysisRequests();
    analysisStore.reset();
    server.use(
      http.get('*/api/library/dj/browse', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q');
        const tracks =
          q === 'night'
            ? [track('1', 'Night Ferry', 124, '8A')]
            : [track('2', 'Static Bloom', 126, '9A')];
        return HttpResponse.json({
          tracks,
          total: 1,
          page: 1,
          limit: 8,
          has_more: false,
          sort: 'title',
        });
      }),
      http.get('*/api/library/dj/plan', () =>
        HttpResponse.json({
          success: true,
          plan: {
            status: 'ok',
            style: 'long_blend',
            bars: 32,
            why: '8A → 9A: the keys mix',
            out: { start: 154.9, bar: 80 },
            in: { start: 0.2, bar: 0 },
          },
        }),
      ),
      http.post('*/api/library/dj/grids', () =>
        HttpResponse.json({
          grids: {
            '1': {
              track_id: '1',
              analyzed: true,
              bpm: 124,
              grid: {
                kind: 'constant',
                first_beat: 0.5,
                period: 0.4839,
                beats: null,
                confidence: 0.9,
              },
            },
            '2': { track_id: '2', analyzed: false, reason: 'no_beat' },
          },
        }),
      ),
      http.post('*/api/library/dj/analyse', () =>
        HttpResponse.json(
          {
            success: true,
            asked: 0,
            queued: 0,
            already_queued: 0,
            already_done: 2,
            cant: 0,
            over_limit: 0,
            limit: 200,
            yours: 0,
            started: false,
          },
          { status: 202 },
        ),
      ),
      http.post('*/api/library/dj/progress', () =>
        HttpResponse.json({ success: true, tracks: {}, sweep: { running: false } }),
      ),
    );
    render(<AutomixLab />);
    const report = screen.getByRole('button', { name: 'Download a mix report' });
    expect(report).toBeDisabled();
    searchIn('outgoing');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the outgoing track' }), {
      target: { value: 'night' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Night Ferry' }));
    searchIn('incoming');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find the incoming track' }), {
      target: { value: 'static' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Static Bloom' }));
    fireEvent.click(report);
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    const file = downloads.files[0]!;
    expect(file.name).toMatch(/^mix-report-night-ferry-to-static-bloom-\d{4}-\d{2}-\d{2}\.json$/);
    const data = file.data as {
      pair: { from: { title: string } };
      plan: { style: string };
      grids: { from: { bpm: number }; to: { analyzed: boolean } };
      run: unknown;
    };
    expect(data.pair.from.title).toBe('Night Ferry');
    expect(data.plan.style).toBe('long_blend');
    expect(data.grids.from.bpm).toBe(124);
    expect(data.grids.to.analyzed).toBe(false);
    expect(data.run).toBeNull();
    // the picked tracks came with their file paths: none reach the report
    expect(JSON.stringify(data)).not.toContain('/m/');
    analysisStore.reset();
  });
});
