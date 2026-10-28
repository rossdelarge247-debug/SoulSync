/**
 * Analyse on demand in the browser (analysis.api.ts, analysis.format.ts,
 * analysis-line.tsx): Brief A's words for every state, the batched asking
 * (one request at a time, a 429 waited out, a track not asked twice in a
 * while), and the one poll that refreshes a track's data once it's done.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import type { AnalyseAnswer, AnalysisEntry, AnalysisLineEntry, AnalysisWait } from './analysis.api';

import { AnalysisLine, useAnalysis, useAnalysisSweep } from './analysis-line';
import {
  DJ_ANALYSED_EVENT,
  analysisStore,
  postProgress,
  requestAnalysis,
  resetAnalysisRequests,
} from './analysis.api';
import {
  addedAnalysisWords,
  analyseTheseHint,
  analyseTheseWords,
  checklist,
  countView,
  currentSubline,
  inLine,
  isReady,
  lineView,
  markerView,
  moreWords,
  nextSweepWords,
  notReadyNotice,
  ordinal,
  readyWords,
  stepNumber,
  stepTime,
  sweepProgressWords,
  whyWords,
  yoursWords,
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

const admin = { admin: true };
const member = { admin: false };
const SWEEP = {
  running: true,
  held: false,
  analyze: true,
  id: 3,
  total: 4980,
  done: 1240,
  percent: 24,
  waiting: null,
  in_line: 4,
  yours: 2,
  left: 10,
  next_in: 1500,
  current: {
    step: 'grid' as const,
    percent: 60,
    asked_for: true,
    track_id: '7',
    title: 'Canopy',
    artist: 'Tidewater',
    times: { read: 1.2, tempo: 0.8, key: 0.6, energy: 0.3 },
  },
};

describe("the words (Brief A, 31a's states)", () => {
  const line = (e: AnalysisEntry, viewer = admin, sweep: typeof SWEEP | null = SWEEP) =>
    lineView(e, { title: 'Canopy', viewer, sweep: sweep as never })!;

  it('1 ready, 2 BPM and key only, 3 not analysed: their words, dots and actions', () => {
    expect(line({ state: 'done', ready: true, bpm_key: true })).toEqual({
      tone: 'ready',
      sentence: 'Ready to mix · beat grid and phrases',
      step: null,
      action: null,
    });
    expect(line({ state: 'done', ready: false, bpm_key: true })).toMatchObject({
      tone: 'neutral',
      sentence: 'BPM and key · no beat grid yet',
      action: 'analyse',
    });
    const notYet: AnalysisEntry = {
      state: 'waiting',
      reason: 'not_queued',
      position: null,
      asked_for: false,
      bpm_key: false,
    };
    expect(line(notYet)).toMatchObject({
      tone: 'neutral',
      sentence: 'Not analysed · next sweep in about 25 min',
      action: 'analyse_now',
    });
    // members get Analyse mine (31d)
    expect(line(notYet, member).action).toBe('analyse_mine');
    expect(line({ ...notYet, bpm_key: true }, member)).toMatchObject({
      sentence: 'BPM and key · no beat grid yet',
      action: 'analyse_mine',
    });
    expect(line(notYet, admin, { ...SWEEP, next_in: null } as never).sentence).toBe(
      'Not analysed yet',
    );
  });

  it('4 in line: an ordinal, Move up for admins, "yours go first" for a member', () => {
    expect(line({ state: 'queued', position: 3, asked_for: true })).toMatchObject({
      tone: 'neutral',
      sentence: 'In line · 3rd',
      action: 'move_up',
    });
    expect(line({ state: 'queued', position: 1, asked_for: true }).action).toBeNull();
    expect(
      line({ state: 'queued', position: 1, asked_for: true }, member, {
        ...SWEEP,
        yours_first: true,
      } as never),
    ).toMatchObject({ sentence: 'In line · 1st · yours go first', action: null });
  });

  it('5 analysing: each of the six steps, the bar by step', () => {
    const steps = ['read', 'tempo', 'key', 'energy', 'grid', 'phrases'] as const;
    expect(steps.map((step) => line({ state: 'working', step, percent: 0 }).sentence)).toEqual([
      'Analysing Canopy · reading audio (1 of 6)',
      'Analysing Canopy · tempo (2 of 6)',
      'Analysing Canopy · key (3 of 6)',
      'Analysing Canopy · energy (4 of 6)',
      'Analysing Canopy · beat grid (5 of 6)',
      'Analysing Canopy · phrases and sections (6 of 6)',
    ]);
    expect(steps.map((step) => line({ state: 'working', step, percent: 0 }).step)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    // the tag write is energy's step; none yet is the first
    expect(stepNumber('tags')).toBe(4);
    expect(stepNumber(null)).toBe(1);
    expect(line({ state: 'working', step: 'key', percent: 35 }).tone).toBe('running');
  });

  it('6 waiting, for each reason, amber; the drive named to admins', () => {
    const waiting = (reason: AnalysisWait, sweep = SWEEP as never, viewer = admin) =>
      lineView(
        { state: 'waiting', reason, position: 2, asked_for: true },
        { title: 'Canopy', viewer, sweep },
      )!;
    const counted = (reason: AnalysisWait, count: number | null, drive: string | null = null) =>
      ({ ...SWEEP, waiting: reason, waiting_detail: { count, drive } }) as never;
    expect(waiting('download', counted('download', 3)).sentence).toBe(
      'Waiting for 3 downloads to finish',
    );
    expect(waiting('download').sentence).toBe('Waiting for downloads to finish');
    expect(waiting('import', counted('import', 42)).sentence).toBe(
      'Waiting for the import to finish · 42 files',
    );
    expect(waiting('drive_away', counted('drive_away', null, 'Music HD'))).toMatchObject({
      tone: 'warning',
      sentence: "Waiting for Music HD · it's away",
      action: 'drives',
    });
    expect(waiting('drive_away', SWEEP as never, member)).toMatchObject({
      sentence: "Waiting for the library's drive · it's away",
      action: null,
    });
    expect(waiting('drive_move')).toMatchObject({
      sentence: 'Waiting for the move to finish',
      action: 'open_move',
    });
    expect(waiting('tag_write').sentence).toBe('Waiting for tags to be written');
  });

  it('7 stopped: by name for admins with Resume, "an admin" for members, Resume disabled', () => {
    const held: AnalysisEntry = {
      state: 'waiting',
      reason: 'held',
      position: null,
      asked_for: false,
    };
    const sweep = { ...SWEEP, running: false, held: true, held_by: 'Ross', in_line: 14 } as never;
    expect(lineView(held, { viewer: admin, sweep })).toMatchObject({
      tone: 'warning',
      sentence: 'Analysis stopped by Ross · 14 in line',
      action: 'resume',
      actionDisabled: false,
    });
    expect(
      lineView(held, { viewer: member, sweep: { ...(sweep as object), held_by: null } as never }),
    ).toMatchObject({
      sentence: 'Analysis stopped by an admin · 14 in line',
      action: 'resume',
      actionDisabled: true,
    });
  });

  it('8 failed and skipped say what still works; 9 no steady beat', () => {
    expect(line({ state: 'failed', reason: 'error' })).toMatchObject({
      tone: 'failed',
      sentence: "Couldn't be read · won't auto-mix; plays straight on",
      action: 'try_again',
    });
    expect(line({ state: 'failed', reason: 'error' }, member).action).toBeNull();
    expect(line({ state: 'failed', reason: 'unreachable' }).action).toBeNull();
    expect(line({ state: 'failed', reason: 'too_long', duration: 8040 })).toMatchObject({
      tone: 'neutral',
      sentence: 'Skipped, 2 h 14 min is too long to analyse · plays straight on',
    });
    expect(line({ state: 'failed', reason: 'no_grid' }).sentence).toBe(
      "No beat grid found · won't auto-mix; plays straight on",
    );
    // an admin can have its beat grid found again (Ross's report of 28 October)
    expect(line({ state: 'done', ready: false, bpm_key: true, beat: 'no_beat' })).toMatchObject({
      tone: 'warning',
      sentence: "Can't be beat-matched · no steady beat · echo out or cut",
      action: 'analyse_again',
    });
    expect(line({ state: 'done', ready: false, beat: 'no_beat' }, member).action).toBeNull();
    expect(line({ state: 'done', ready: false, beat: 'too_short' }).action).toBeNull();
    // a grid found but not sure enough isn't "no steady beat"
    expect(line({ state: 'done', ready: false, beat: 'unsure' }).sentence).toBe(
      "Can't be beat-matched · beat grid not sure enough · echo out or cut",
    );
    expect(line({ state: 'done', ready: false, beat: 'not_4_4' }).sentence).toBe(
      "Can't be beat-matched · not in 4/4 · echo out or cut",
    );
    expect(readyWords('Canopy')).toBe('Canopy is ready to mix');
  });

  it('the row marker: two words, the sweep’s own order says what it has (334)', () => {
    const mark = (e: AnalysisEntry) => markerView(e, admin)?.words;
    expect(mark({ state: 'done', ready: true, bpm_key: true })).toBe('Ready');
    expect(mark({ state: 'done', ready: false, bpm_key: true })).toBe('BPM and key · no grid yet');
    expect(mark({ state: 'queued', position: 1, asked_for: true })).toBe('In line · 1st');
    expect(mark({ state: 'queued', position: 1240, asked_for: false })).toBe('Not analysed');
    expect(mark({ state: 'queued', position: 1240, asked_for: false, bpm_key: true })).toBe(
      'BPM and key',
    );
    expect(mark({ state: 'working', step: 'grid', percent: 60 })).toBe(
      'Analysing · beat grid (5 of 6)',
    );
    expect(markerView({ state: 'working', step: 'key', percent: 35 }, admin, 'Canopy')?.words).toBe(
      'Analysing Canopy · key (3 of 6)',
    );
    expect(mark({ state: 'failed', reason: 'error' })).toBe("Couldn't be read · plays straight on");
    expect(mark({ state: 'done', beat: 'no_beat' })).toBe("Can't be beat-matched · no steady beat");
    expect(mark({ state: 'waiting', reason: 'download', position: 2, asked_for: true })).toBe(
      'Waiting · downloads',
    );
  });

  it('the topbar count: running in accent, idle with the next sweep, stopped amber', () => {
    expect(countView(SWEEP as never, admin)).toEqual({
      tone: 'running',
      words: 'Analysing · 14 in line',
      running: true,
    });
    expect(countView({ ...SWEEP, running: false, current: null } as never, admin)).toEqual({
      tone: 'neutral',
      words: 'Analysis idle · next sweep in about 25 min',
      running: false,
    });
    expect(
      countView(
        { ...SWEEP, running: false, held: true, held_by: 'Ross', in_line: 0 } as never,
        admin,
      )?.words,
    ).toBe('Analysis stopped by Ross');
    expect(countView({ ...SWEEP, analyze: false } as never, admin)).toBeNull();
    expect(yoursWords({ ...SWEEP, yours: 2, yours_first: true } as never)).toBe(
      'yours: 2, both next',
    );
  });

  it('the popover: the checklist with times, why each track is in line, the sweep', () => {
    expect(checklist(SWEEP as never).map((r) => [r.name, r.state, r.time])).toEqual([
      ['Reading audio', 'done', '1.2 s'],
      ['Tempo', 'done', '0.8 s'],
      ['Key', 'done', '0.6 s'],
      ['Energy', 'done', '0.3 s'],
      ['Beat grid', 'now', 'now'],
      ['Phrases and sections', 'todo', ''],
    ]);
    expect(stepTime(0.04)).toBe('< 0.1 s');
    expect(currentSubline(SWEEP as never)).toBe('Tidewater · 5 of 6 · 14 in line after it');
    expect(sweepProgressWords(SWEEP as never)).toBe('Finding beats · 1,240 of 4,980');
    const e = (over: Partial<AnalysisLineEntry>): AnalysisLineEntry => ({
      track_id: '1',
      title: 'Static Bloom',
      artist: 'Saltmarsh',
      position: 1,
      source: 'asked',
      by: 'you',
      set_name: null,
      front: true,
      ...over,
    });
    expect(whyWords(e({ source: 'set', set_name: 'Sunday Set' }))).toBe(
      'you added it to Sunday Set',
    );
    expect(whyWords(e({ by: 'Mira K.' }))).toBe('Mira asked');
    expect(whyWords(e({ source: 'up_next' }))).toBe('Up next');
    expect(whyWords(e({ source: 'set', by: 'Mira K.' }))).toBe("Mira's set");
    expect(moreWords({ ...SWEEP, line_more: 0 } as never, admin)).toBe(
      'and 10 more from the sweep',
    );
    expect(moreWords({ ...SWEEP, line_more: 3 } as never, member)).toBe('and 13 more in line');
    expect(nextSweepWords(30)).toBe('next sweep in under a minute');
    expect(nextSweepWords(5400)).toBe('next sweep in about 1 h 30 min');
  });

  it('the Added toast says once where it is; a set’s notice counts by kind', () => {
    expect(addedAnalysisWords(answer({ position: 2 }))).toBe('analysing, 2nd in line');
    expect(addedAnalysisWords(answer({ working: true }))).toBe('analysing now');
    expect(addedAnalysisWords(answer({}))).toBe('');
    expect(
      notReadyNotice([
        { state: 'done', ready: true },
        { state: 'queued', position: 1, asked_for: true },
        { state: 'working', step: 'grid', percent: 60 },
        { state: 'waiting', reason: 'not_queued', position: null, asked_for: false, bpm_key: true },
        { state: 'failed', reason: 'error' },
      ]),
    ).toBe(
      "4 tracks aren't ready to mix: 2 are in line, 1 has BPM and key only, 1 couldn't be read. Play as a mix plays them straight on until they are.",
    );
    expect(notReadyNotice([{ state: 'done', ready: true }])).toBe('');
    // a track too long to analyse isn't "couldn't be read"
    expect(
      notReadyNotice([
        { state: 'failed', reason: 'too_long' },
        { state: 'done', beat: 'no_beat' },
      ]),
    ).toBe(
      "2 tracks aren't ready to mix: 1 can't be beat-matched, 1 is too long to analyse. Play as a mix plays them straight on until they are.",
    );
    // the last one in line: named, not "0 in line"
    expect(countView({ ...SWEEP, in_line: 0, left: 0 } as never, admin)?.words).toBe(
      'Analysing Canopy',
    );
    expect(isReady({ state: 'done' })).toBe(true);
    expect(isReady({ state: 'done', ready: false })).toBe(false);
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

  it('asked-for tracks in line, and the one being worked out', () => {
    expect(inLine({ state: 'queued', position: 4, asked_for: true })).toBe(true);
    expect(inLine({ state: 'queued', position: 1240, asked_for: false })).toBe(false);
    expect(inLine({ state: 'working', step: 'key', percent: 35 })).toBe(true);
    expect(inLine({ state: 'done' })).toBe(false);
  });

  it('"Analyse these" says how many, and that ones already done are skipped', () => {
    expect(analyseTheseHint(12)).toBe('12 tracks · ones already done are skipped');
    expect(analyseTheseWords(answer({ asked: 12, queued: 9, already_done: 3 }))).toEqual({
      words: '9 tracks will be analysed next. 3 tracks already done are skipped.',
      tone: 'success',
    });
    expect(analyseTheseWords(answer({ asked: 4, already_done: 4 }))).toEqual({
      words: 'All 4 are analysed already.',
      tone: 'info',
    });
    expect(analyseTheseWords(answer({ asked: 0 })).words).toBe(
      'None of these are in your library with a file.',
    );
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
    expect(bodies).toEqual([{ track_ids: ['1', '2', '3'], reason: 'auto' }]);
    expect(a?.queued).toBe(2);
    expect(b).toEqual(a);
    expect(await requestAnalysis(['1', '3'])).toBeNull();
    expect(bodies).toHaveLength(1);
    // Analyse these asks again whatever was asked
    await requestAnalysis(['1'], { force: true });
    expect(bodies).toEqual([
      { track_ids: ['1', '2', '3'], reason: 'auto' },
      { track_ids: ['1'], reason: 'asked', source: 'asked' },
    ]);
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

  it('[review M1] while Stop holds the sweeps an automatic ask is turned away quietly; a person’s goes in', async () => {
    const bodies: { track_ids: string[]; reason: string }[] = [];
    server.use(
      http.post('/api/library/dj/analyse', async ({ request }) => {
        const body = (await request.json()) as { track_ids: string[]; reason: string };
        bodies.push(body);
        if (body.reason !== 'asked')
          return HttpResponse.json(
            { success: false, code: 'held', error: 'Stopped by an admin' },
            { status: 409 },
          );
        return HttpResponse.json(
          { success: true, ...answer({ asked: 1, queued: 1, started: true }) },
          { status: 202 },
        );
      }),
      http.post('/api/library/dj/progress', () =>
        HttpResponse.json({ success: true, tracks: {}, sweep: { running: false } }),
      ),
    );
    // automatic: no error, nothing said
    expect(await requestAnalysis(['4'])).toBeNull();
    expect(bodies).toEqual([{ track_ids: ['4'], reason: 'auto' }]);
    // [re-review 7] turned away, it's forgotten: a lab pick of it (asked,
    // not forced) goes in
    const lab = await requestAnalysis(['4'], { reason: 'asked' });
    expect(lab?.queued).toBe(1);
    expect(bodies[1]).toEqual({ track_ids: ['4'], reason: 'asked', source: 'asked' });
    // a person's ask (Analyse these, Analyse now) says so and goes in
    const got = await requestAnalysis(['5'], { force: true });
    expect(got?.queued).toBe(1);
    expect(bodies[2]).toEqual({ track_ids: ['5'], reason: 'asked', source: 'asked' });
  });

  it('a person’s ask and an automatic one gathered together go in separate requests', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/library/dj/analyse', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          { success: true, ...answer({ asked: 1, queued: 1 }) },
          { status: 202 },
        );
      }),
      http.post('/api/library/dj/progress', () =>
        HttpResponse.json({ success: true, tracks: {}, sweep: { running: false } }),
      ),
    );
    await Promise.all([requestAnalysis(['1']), requestAnalysis(['2'], { force: true })]);
    expect(bodies).toEqual([
      { track_ids: ['1'], reason: 'auto' },
      { track_ids: ['2'], reason: 'asked', source: 'asked' },
    ]);
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
          <AnalysisLine size="line" entry={progress[id]} title={`Track ${id}`} trackId={id} />
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
      expect(await screen.findByText('In line · 2nd')).toBeInTheDocument();
      expect(
        await screen.findByText(
          'Analysing Track 7 · reading audio (1 of 6)',
          {},
          { timeout: 4000 },
        ),
      ).toBeInTheDocument();
      expect(
        await screen.findByText('Analysing Track 7 · beat grid (5 of 6)', {}, { timeout: 4000 }),
      ).toBeInTheDocument();
      await waitFor(() => expect(finished).toEqual([['7']]), { timeout: 4000 });
      // done (31a, state 10): the line says it, and the polite live region says it once
      const said = await screen.findAllByText('Track 7 is ready to mix');
      expect(said.some((el) => el.closest('[data-analysis-line]'))).toBe(true);
      expect(document.querySelector('[data-analysis-live]')).toHaveTextContent(
        'Track 7 is ready to mix',
      );
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

  it('[review L4] more than 500 tracks: one request per 500, put back together', async () => {
    const sizes: number[] = [];
    server.use(
      http.post('/api/library/dj/progress', async ({ request }) => {
        const ids = ((await request.json()) as { track_ids: string[] }).track_ids;
        sizes.push(ids.length);
        return HttpResponse.json({
          success: true,
          tracks: Object.fromEntries(ids.map((id) => [id, { state: 'done' }])),
          sweep: { running: false },
        });
      }),
    );
    const ids = Array.from({ length: 1200 }, (_, i) => String(i + 1));
    const got = await postProgress(ids);
    expect(sizes).toEqual([500, 500, 200]);
    expect(Object.keys(got.tracks)).toHaveLength(1200);
    expect(got.tracks['1200']).toEqual({ state: 'done' });
  });

  it('[review cleanup] the poll’s timer is cleared when the last row goes', async () => {
    let polls = 0;
    server.use(
      http.post('/api/library/dj/progress', () => {
        polls += 1;
        return HttpResponse.json({
          success: true,
          tracks: { '1': { state: 'queued', position: 1, asked_for: true } },
          sweep: { running: true },
        });
      }),
    );
    const view = render(<Rows ids={['1']} />);
    await waitFor(() => expect(polls).toBe(1));
    await waitFor(() => expect(analysisStore.scheduled).toBe(true));
    view.unmount();
    expect(analysisStore.scheduled).toBe(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1700));
    });
    expect(polls).toBe(1);
  });

  it('[review M2] a sweep running elsewhere doesn’t speed up a page whose tracks are done', async () => {
    let polls = 0;
    server.use(
      http.post('/api/library/dj/progress', () => {
        polls += 1;
        return HttpResponse.json({
          success: true,
          tracks: { '1': { state: 'done' } },
          sweep: { running: true, total: 10, done: 2, current: null },
        });
      }),
    );
    const view = render(<Rows ids={['1']} />);
    await waitFor(() => expect(polls).toBe(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1800));
    });
    // the slow interval: no second poll within 1.5 s
    expect(polls).toBe(1);
    view.unmount();
    // Activity's sweep row open: the sweep's progress is polled fast
    function Sweep() {
      useAnalysisSweep();
      return null;
    }
    polls = 0;
    const sweep = render(<Sweep />);
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    sweep.unmount();
  }, 10_000);

  it('[re-review 1] the sweep’s own order far down the line polls slowly; asked-for, near or working fast', async () => {
    const answers: Record<string, unknown>[] = [
      // a library mid-sweep: rows deep in the sweep's own order, or waiting with a place
      {
        '1': { state: 'queued', position: 840, asked_for: false },
        '2': { state: 'waiting', reason: 'download', position: 1200, asked_for: false },
      },
      { '1': { state: 'queued', position: 3, asked_for: false } },
      { '1': { state: 'queued', position: 40, asked_for: true } },
      { '1': { state: 'working', step: 'read', percent: 5 } },
    ];
    let which = 0;
    let polls = 0;
    server.use(
      http.post('/api/library/dj/progress', () => {
        polls += 1;
        return HttpResponse.json({
          success: true,
          tracks: answers[which],
          sweep: { running: true, total: 2000, done: 10, current: null },
        });
      }),
    );
    const wait = (ms: number) =>
      act(async () => {
        await new Promise((r) => setTimeout(r, ms));
      });
    const view = render(<Rows ids={['1', '2']} />);
    await waitFor(() => expect(polls).toBe(1));
    await wait(1800);
    expect(polls).toBe(1);
    view.unmount();
    for (const i of [1, 2, 3]) {
      analysisStore.reset();
      which = i;
      polls = 0;
      const v = render(<Rows ids={['1']} />);
      await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2), { timeout: 4000 });
      v.unmount();
    }
  }, 20_000);

  it('[review M3] finishes are gathered, and only what shows those tracks is read again', async () => {
    let polls = 0;
    server.use(
      http.post('/api/library/dj/progress', () => {
        polls += 1;
        const seven =
          polls >= 2 ? { state: 'done' } : { state: 'working', step: 'grid', percent: 60 };
        const eight =
          polls >= 3 ? { state: 'done' } : { state: 'queued', position: 1, asked_for: true };
        return HttpResponse.json({
          success: true,
          tracks: { '7': seven, '8': eight },
          sweep: { running: true, total: 2, done: 0, current: null },
        });
      }),
    );
    const qc = createTestQueryClient();
    const keys: unknown[][] = [
      ['dj', 'tracks', '7,9'],
      ['dj', 'tracks', '9'],
      ['dj', 'mix', '7', null, false, null, null],
      ['dj', 'mix', '9', null, false, null, null],
      ['dj', 'mix-vibe', '7', null, false, null, null],
      ['dj', 'mixes', '7', 'library'],
      ['dj', 'status'],
      ['dj', 'browse', 1, {}],
      ['automix', 'plan', '7', '9', 'auto', 0, 'auto'],
      ['automix', 'plan', '1', '2', 'auto', 0, 'auto'],
      ['sets', 'set', 1, 3],
      ['sets', 'famous', 'x'],
      ['sets', 'join', '7', '1'],
      ['sets', 'join', '2', '1'],
    ];
    for (const k of keys) qc.setQueryData(k, { x: 1 });
    const finished: string[][] = [];
    const onDone = (e: Event) => finished.push((e as CustomEvent<{ ids: string[] }>).detail.ids);
    window.addEventListener(DJ_ANALYSED_EVENT, onDone);
    try {
      render(
        <QueryClientProvider client={qc}>
          <Rows ids={['7', '8']} />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(finished).toEqual([['7']]), { timeout: 4000 });
      const stale = (k: unknown[]) => qc.getQueryState(k)?.isInvalidated ?? false;
      expect(keys.filter(stale)).toEqual([
        ['dj', 'tracks', '7,9'],
        ['dj', 'mix', '7', null, false, null, null],
        ['dj', 'mixes', '7', 'library'],
        ['dj', 'status'],
        ['dj', 'browse', 1, {}],
        ['automix', 'plan', '7', '9', 'auto', 0, 'auto'],
        ['sets', 'set', 1, 3],
        ['sets', 'join', '7', '1'],
      ]);
      // 8 finishes on the next poll; its refresh waits out the few seconds
      await waitFor(() => expect(polls).toBeGreaterThanOrEqual(3), { timeout: 4000 });
      expect(finished).toEqual([['7']]);
      await waitFor(() => expect(finished).toEqual([['7'], ['8']]), { timeout: 4000 });
    } finally {
      window.removeEventListener(DJ_ANALYSED_EVENT, onDone);
    }
  }, 15_000);
});
