/**
 * The lab's mix report (Ross, 27 October): grids, the plan, the last run's
 * measurements and the browser's details, and never audio, file paths or
 * names other than the tracks' titles and artists.
 */
import { describe, expect, it } from 'vitest';

import type { ApiGrid } from '../grid';

import { BeatGrid } from '../grid';
import { LabSession, type LabDeps } from './lab-session';
import {
  REPORT_KIND,
  buildMixReport,
  environment,
  gridSummary,
  reportFileName,
  scrub,
  type RunRecord,
} from './mix-report';

const grid = (id: string, bpm: number): ApiGrid & Record<string, unknown> => ({
  track_id: id,
  analyzed: true,
  version: 2,
  bpm,
  grid: { kind: 'constant', first_beat: 0.5, period: 60 / bpm, beats: null, confidence: 0.86 },
  downbeats: { first: 0.5, beat_index: 0, meter: '4/4', confidence: 0.9 },
  bars: 112,
  phrases: [{ bar: 0, time: 0.5, level: 16, section: true }],
  sections: [{ kind: 'intro', start_bar: 0, end_bar: 16, start: 0.5, end: 31.5, confidence: 0.9 }],
  mix_in: { start_bar: 0, end_bar: 16, start: 0.5, end: 31.5, how: 'intro' },
  mix_out: { start: 185.9, end: 216.9, start_bar: 96, end_bar: 112 },
  loudness: { replaygain_db: -7.2, level_db: -8.9, source: 'replaygain' },
  analysed_s: 217.4,
  truncated: false,
  // what must never reach a report, if a server ever sent it
  file_path: '/music/Ross/Saltmarsh/Lantern/01 Static Bloom.flac',
});

const run: RunRecord = {
  started_at: 10,
  t0: 26,
  sample_rate: 48000,
  windows: { a: { start: 140, dur: 90 }, b: { start: 0, dur: 90 }, aFrom: 150, outStart: 166 },
  key_lock: false,
  correction: [{ beat: 0, ms: 1.25 }],
  samples: [
    {
      t: 27,
      phase: 'mixing',
      bar: 1,
      rates: { out: 1, in: 0.984 },
      modes: { out: 'resample', in: 'resample' },
      pos: { a: 167, b: 0.7 },
      reported: { a: 167.001, b: 0.7 },
      reportDriftMs: { a: 1, b: 0 },
      beatDriftMs: 0.4,
    },
  ],
  end: { phase: 'done', at: 90 },
};

describe('the mix report', () => {
  it('holds the pair, the grids’ summaries, the plan, the run and the browser', () => {
    const report = buildMixReport({
      from: { id: '1', title: 'Night Ferry', artist: 'Tidewater' },
      to: { id: '2', title: 'Static Bloom', artist: 'Saltmarsh' },
      request: { style: 'auto', prerollBars: 8, keyLock: false, correct: true },
      plan: {
        status: 'ok',
        style: 'long_blend',
        bars: 32,
        why: '8A → 9A, +2 BPM: the keys mix',
        out: { start: 166, bar: 80 },
        in: { start: 0.2, bar: 0 },
      },
      grids: { '1': grid('1', 124), '2': grid('2', 126) },
      run,
      env: environment(
        { sampleRate: 48000, state: 'running', baseLatency: 0.01 } as unknown as BaseAudioContext,
        { userAgent: 'TestBrowser/1', language: 'en-GB', hardwareConcurrency: 8 },
        { isSecureContext: true, AudioWorkletNode: class {} },
      ),
      now: new Date('2026-10-27T12:00:00Z'),
    });
    expect(report.kind).toBe(REPORT_KIND);
    expect(report.pair).toEqual({
      from: { id: '1', title: 'Night Ferry', artist: 'Tidewater' },
      to: { id: '2', title: 'Static Bloom', artist: 'Saltmarsh' },
    });
    expect(report.grids.from).toMatchObject({
      bpm: 124,
      kind: 'constant',
      confidence: 0.86,
      downbeats: { first: 0.5 },
      phrases: [{ bar: 0 }],
      sections: [{ kind: 'intro' }],
      mix_in: { how: 'intro' },
      mix_out: { start_bar: 96 },
    });
    expect(report.plan?.style).toBe('long_blend');
    expect(report.run?.samples[0]?.beatDriftMs).toBe(0.4);
    expect(report.run?.correction).toEqual([{ beat: 0, ms: 1.25 }]);
    expect(report.environment).toMatchObject({
      user_agent: 'TestBrowser/1',
      secure_context: true,
      audio_worklet: true,
      audio_context: { sample_rate: 48000, state: 'running', base_latency: 0.01 },
    });
    // no file paths, no audio, no names but the tracks'
    const text = JSON.stringify(report);
    expect(text).not.toContain('/music/');
    expect(text).not.toContain('file_path');
    expect(text).not.toMatch(/Ross/);
    expect(text.length).toBeLessThan(20_000);
  });

  it('scrubs path-like strings and keys from whatever the server sent', () => {
    expect(
      scrub({
        a: '/home/ross/x.flac',
        b: 'C:\\Music\\x.mp3',
        c: 'file:///x',
        d: '8A → 9A',
        src: 'x',
      }),
    ).toEqual({ a: '[path left out]', b: '[path left out]', c: '[path left out]', d: '8A → 9A' });
    expect(
      gridSummary({ track_id: '3', analyzed: false, reason: 'no_beat' } as ApiGrid &
        Record<string, unknown>),
    ).toEqual({
      analyzed: false,
      reason: 'no_beat',
    });
  });

  it('names its file by the pair and the day', () => {
    expect(
      reportFileName(
        { id: '1', title: 'Night Ferry', artist: '' },
        { id: '2', title: 'Static Bloom (Edit)', artist: '' },
        new Date('2026-10-27T12:00:00Z'),
      ),
    ).toBe('mix-report-night-ferry-to-static-bloom-edit-2026-10-27.json');
  });
});

describe('the lab session’s measurements', () => {
  it('samples rates, places, the worklet’s drift and the beats’ drift', () => {
    const s = new LabSession(
      { from: '1', to: '2', style: 'auto', prerollBars: 8, keyLock: false, correct: true },
      {} as LabDeps,
    );
    const gridA = new BeatGrid({ period: 60 / 124, firstBeat: 0.5 });
    const gridB = new BeatGrid({ period: 60 / 126, firstBeat: 0.2 });
    const t = 30;
    // deck B 2 ms behind where its beat should be
    const posA = gridA.timeAt(80 * 4 + 8);
    const posB = gridB.timeAt(0 + 8) - 0.002;
    s.engine = {
      context: { currentTime: t, sampleRate: 48000 },
      position: (d: 'A' | 'B') => (d === 'A' ? posA : posB),
      report: (d: 'A' | 'B') => ({
        frame: 0,
        report: { p: (d === 'A' ? posA : posB) + 0.001, playing: true, ended: false },
      }),
    } as unknown as LabSession['engine'];
    s.transition = {
      state: () => ({
        phase: 'mixing',
        bar: 3,
        beatmatch: true,
        rates: { out: 1, in: 0.984 },
        modes: { out: 'resample', in: 'resample' },
      }),
    } as unknown as LabSession['transition'];
    s.run = { ...run, t0: 20, samples: [], end: null };
    (s as unknown as { beatMap: unknown }).beatMap = { a0: 320, b0: 0, per: 1, gridA, gridB };
    const sample = s.sample()!;
    expect(sample.rates).toEqual({ out: 1, in: 0.984 });
    expect(sample.reportDriftMs.a).toBeCloseTo(1, 1);
    expect(sample.beatDriftMs).not.toBeNull();
    expect(Math.abs(sample.beatDriftMs! + (2 * (60 / 124)) / (60 / 126))).toBeLessThan(0.2);
    expect(s.run.samples).toHaveLength(1);
  });
});
