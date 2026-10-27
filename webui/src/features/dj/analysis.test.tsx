/**
 * Analyse on demand in the browser (analysis.api.ts, analysis.format.ts,
 * analysis-progress.tsx): the indicator's words and bar, the batched asking
 * (one request at a time, a 429 waited out, a track not asked twice in a
 * while), and the one poll that refreshes a track's data once it's done.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import type { AnalyseAnswer, AnalysisEntry } from './analysis.api';

import { AnalysisProgress, SweepProgress, useAnalysis } from './analysis-progress';
import {
  DJ_ANALYSED_EVENT,
  analysisStore,
  requestAnalysis,
  resetAnalysisRequests,
} from './analysis.api';
import {
  analyseTheseHint,
  analyseTheseWords,
  entryWords,
  inLine,
  ordinal,
  sweepWords,
} from './analysis.format';

const answer = (over: Partial<AnalyseAnswer> = {}): AnalyseAnswer => ({
  asked: 0,
  queued: 0,
  already_queued: 0,
  already_done: 0,
  cant: 0,
  over_limit: 0,
  limit: 200,
  yours: 0,
  started: false,
  ...over,
});

beforeEach(() => {
  resetAnalysisRequests();
  analysisStore.reset();
});

afterEach(() => {
  cleanup();
  analysisStore.reset();
});

describe('the words', () => {
  it('says each state as the indicator shows it', () => {
    const say = (e: AnalysisEntry) => entryWords(e);
    expect(say({ state: 'working', step: 'grid', percent: 60 })).toBe(
      'Finding the beat grid · 60%',
    );
    expect(say({ state: 'working', step: 'read', percent: 5 })).toBe('Reading the audio · 5%');
    expect(say({ state: 'working', step: 'phrases', percent: 85 })).toBe(
      'Finding phrases and sections · 85%',
    );
    expect(say({ state: 'working', step: 'tags', percent: 50 })).toBe('Writing tags · 50%');
    expect(say({ state: 'queued', position: 1, asked_for: true })).toBe('Next in line');
    expect(say({ state: 'queued', position: 2, asked_for: true })).toBe('2nd in line');
    expect(say({ state: 'waiting', reason: 'download', position: 3, asked_for: false })).toBe(
      'Waiting for downloads',
    );
    expect(say({ state: 'waiting', reason: 'drive_away', position: 1, asked_for: true })).toBe(
      'Waiting for the library drive',
    );
    expect(say({ state: 'waiting', reason: 'not_queued', position: null, asked_for: false })).toBe(
      'Not analysed yet',
    );
    expect(say({ state: 'failed', reason: 'too_long' })).toBe('Too long to analyse');
    expect(say({ state: 'failed', reason: 'no_grid' })).toBe('No beat grid found');
  });

  it('counts in English', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 1240].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th',
      '1,240th',
    ]);
  });

  it('Tracks shows only asked-for tracks in line, and the one being worked out', () => {
    expect(inLine({ state: 'queued', position: 4, asked_for: true })).toBe(true);
    expect(inLine({ state: 'queued', position: 1240, asked_for: false })).toBe(false);
    expect(inLine({ state: 'working', step: 'key', percent: 35 })).toBe(true);
    expect(inLine({ state: 'waiting', reason: 'drive_away', position: 1, asked_for: true })).toBe(
      true,
    );
    expect(inLine({ state: 'waiting', reason: 'held', position: null, asked_for: false })).toBe(
      false,
    );
    expect(inLine({ state: 'done' })).toBe(false);
  });

  it('"Analyse these" says how many, and that ones already done are skipped', () => {
    expect(analyseTheseHint(12)).toBe('12 tracks · ones already done are skipped');
    expect(analyseTheseWords(answer({ asked: 12, queued: 9, already_done: 3 }))).toEqual({
      words: '9 tracks will be analysed next. 3 tracks already done are skipped.',
      tone: 'success',
    });
    expect(analyseTheseWords(answer({ asked: 1, queued: 1 })).words).toBe(
      '1 track will be analysed next.',
    );
    expect(analyseTheseWords(answer({ asked: 4, already_done: 4 }))).toEqual({
      words: 'All 4 are analysed already.',
      tone: 'info',
    });
    expect(
      analyseTheseWords(answer({ asked: 250, queued: 200, over_limit: 50, limit: 200 })).words,
    ).toBe(
      '200 tracks will be analysed next. 50 tracks more wait for the usual sweep: you can have 200 in line at once.',
    );
    expect(analyseTheseWords(answer({ asked: 0 })).words).toBe(
      'None of these are in your library with a file.',
    );
  });

  it("the sweep's line names the track and its step", () => {
    expect(
      sweepWords({
        running: true,
        held: false,
        analyze: true,
        id: 3,
        total: 4980,
        done: 1240,
        percent: 24,
        waiting: null,
        in_line: 2,
        yours: 2,
        current: {
          step: 'grid',
          percent: 60,
          asked_for: true,
          track_id: '7',
          title: 'Static Bloom',
        },
      }),
    ).toBe('1,240 of 4,980 tracks · Static Bloom · Finding the beat grid · 60%');
  });
});

describe('the indicator', () => {
  it('a bar with its step while working, the place in line while queued, nothing once done', () => {
    const { rerender } = render(
      <AnalysisProgress
        entry={{ state: 'working', step: 'grid', percent: 60 }}
        label="Analysis of Static Bloom"
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Analysis of Static Bloom' });
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar).toHaveAttribute('aria-valuetext', 'Finding the beat grid · 60%');
    expect(screen.getByText('Finding the beat grid · 60%')).toBeInTheDocument();
    rerender(<AnalysisProgress entry={{ state: 'queued', position: 2, asked_for: true }} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('2nd in line')).toBeInTheDocument();
    rerender(<AnalysisProgress entry={{ state: 'done' }} />);
    expect(document.querySelector('[data-analysis-progress]')).toBeNull();
  });

  it("the sweep's bar for Activity", () => {
    render(
      <SweepProgress
        sweep={{
          running: true,
          held: false,
          analyze: true,
          id: 1,
          total: 10,
          done: 4,
          percent: 40,
          waiting: 'download',
          in_line: 0,
          yours: 0,
          current: null,
        }}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Working out BPM, key and energy' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('4 of 10 tracks · Waiting for downloads')).toBeInTheDocument();
  });
});

describe('asking', () => {
  it('gathers ids into one request, and a track asked for a moment ago is not asked again', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/library/dj/analyse', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          { success: true, ...answer({ asked: 2, queued: 2 }) },
          { status: 202 },
        );
      }),
      http.post('/api/library/dj/progress', () =>
        HttpResponse.json({ success: true, tracks: {}, sweep: { running: false } }),
      ),
    );
    const [a, b] = await Promise.all([requestAnalysis(['1', '2']), requestAnalysis(['2', '3'])]);
    expect(bodies).toEqual([{ track_ids: ['1', '2', '3'] }]);
    expect(a?.queued).toBe(2);
    expect(b).toEqual(a);
    expect(await requestAnalysis(['1', '3'])).toBeNull();
    expect(bodies).toHaveLength(1);
    // Analyse these asks again whatever was asked
    await requestAnalysis(['1'], { force: true });
    expect(bodies).toEqual([{ track_ids: ['1', '2', '3'] }, { track_ids: ['1'] }]);
  });

  it("waits out the server's one request a second", async () => {
    let calls = 0;
    server.use(
      http.post('/api/library/dj/analyse', () => {
        calls += 1;
        if (calls === 1)
          return HttpResponse.json(
            { success: false, code: 'rate_limited', error: 'One request a second' },
            { status: 429, headers: { 'Retry-After': '1' } },
          );
        return HttpResponse.json(
          { success: true, ...answer({ asked: 1, queued: 1 }) },
          { status: 202 },
        );
      }),
      http.post('/api/library/dj/progress', () =>
        HttpResponse.json({ success: true, tracks: {}, sweep: { running: false } }),
      ),
    );
    const got = await requestAnalysis(['9']);
    expect(calls).toBe(2);
    expect(got?.queued).toBe(1);
  });

  it('says why when analysis is off', async () => {
    server.use(
      http.post('/api/library/dj/analyse', () =>
        HttpResponse.json(
          { success: false, code: 'off', error: 'Working out BPM, key and energy is off' },
          { status: 409 },
        ),
      ),
    );
    await expect(requestAnalysis(['4'], { force: true })).rejects.toThrow(/is off/);
  });
});

function Rows({ ids }: { ids: string[] }) {
  const progress = useAnalysis(ids);
  return (
    <ul>
      {ids.map((id) => (
        <li key={id} data-row={id}>
          <AnalysisProgress entry={progress[id]} />
        </li>
      ))}
    </ul>
  );
}

describe('the poll', () => {
  it('steps through and refreshes a track once it is done', async () => {
    const steps: unknown[] = [
      { state: 'queued', position: 2, asked_for: true },
      { state: 'working', step: 'read', percent: 5 },
      { state: 'working', step: 'grid', percent: 60 },
      { state: 'done' },
    ];
    let polls = 0;
    const asked: string[][] = [];
    server.use(
      http.post('/api/library/dj/progress', async ({ request }) => {
        asked.push(((await request.json()) as { track_ids: string[] }).track_ids);
        const entry = steps[Math.min(polls, steps.length - 1)];
        polls += 1;
        return HttpResponse.json({
          success: true,
          tracks: { '7': entry },
          sweep: { running: true, total: 1, done: 0, current: null },
        });
      }),
    );
    const qc = createTestQueryClient();
    const invalidated: unknown[] = [];
    const real = qc.invalidateQueries.bind(qc);
    qc.invalidateQueries = ((filters?: Parameters<typeof qc.invalidateQueries>[0]) => {
      invalidated.push(filters);
      return real(filters);
    }) as typeof qc.invalidateQueries;
    const finished: string[][] = [];
    const onDone = (e: Event) => finished.push((e as CustomEvent<{ ids: string[] }>).detail.ids);
    window.addEventListener(DJ_ANALYSED_EVENT, onDone);
    try {
      render(
        <QueryClientProvider client={qc}>
          <Rows ids={['7']} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText('2nd in line')).toBeInTheDocument();
      expect(
        await screen.findByText('Reading the audio · 5%', {}, { timeout: 4000 }),
      ).toBeInTheDocument();
      expect(
        await screen.findByText('Finding the beat grid · 60%', {}, { timeout: 4000 }),
      ).toBeInTheDocument();
      await waitFor(() => expect(finished).toEqual([['7']]), { timeout: 4000 });
      expect(document.querySelector('[data-analysis-progress]')).toBeNull();
      expect(invalidated.length).toBeGreaterThan(0);
      expect(asked[0]).toEqual(['7']);
    } finally {
      window.removeEventListener(DJ_ANALYSED_EVENT, onDone);
    }
  }, 15_000);

  it('one poll for every row on the page', async () => {
    const asked: string[][] = [];
    server.use(
      http.post('/api/library/dj/progress', async ({ request }) => {
        asked.push(((await request.json()) as { track_ids: string[] }).track_ids);
        return HttpResponse.json({
          success: true,
          tracks: { '1': { state: 'done' }, '2': { state: 'done' } },
          sweep: { running: false },
        });
      }),
    );
    render(
      <>
        <Rows ids={['1']} />
        <Rows ids={['2']} />
      </>,
    );
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(asked[0]?.slice().sort()).toEqual(['1', '2']);
    expect(asked).toHaveLength(1);
  });
});
