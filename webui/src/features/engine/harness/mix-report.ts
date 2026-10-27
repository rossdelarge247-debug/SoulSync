/**
 * "Download a mix report" (the lab; Ross, 27 October): one JSON file for a
 * pair, to look at a mix that sounded wrong. Made in the browser from what
 * the lab already has: no new route.
 *
 * It holds both tracks' grid summaries (BPM, confidence, kind, the first
 * downbeat, phrases, sections, mix-in and mix-out), the plan, what the
 * engine measured during the last run (each deck's rate, the beat
 * correction from the audio, start times, where each deck was against the
 * beat clock and against the worklet's own report: the drift), and the
 * browser's and the audio context's details.
 *
 * Never in it: audio, file paths, user or profile names. Tracks are named
 * by their id, title and artist only; `scrub` drops any key that could
 * carry a path, and any string that looks like one, from whatever the
 * server sent.
 */
import type { ApiGrid } from '../grid';
import type { Plan } from '../loader';

export const REPORT_KIND = 'soulsync-mix-report';
export const REPORT_VERSION = 1;
/** at most this many samples of a run are kept (about eight minutes at 4 a second) */
export const MAX_SAMPLES = 2000;

export interface ReportTrack {
  id: string;
  title: string;
  artist: string;
}

/** One look at the decks while the lab's mix plays. */
export interface RunSample {
  /** the context's time (s) */
  t: number;
  phase: string | null;
  bar: number | null;
  rates: { out: number; in: number } | null;
  modes: { out: string; in: string } | null;
  /** each deck's place by its map (track seconds) */
  pos: { a: number | null; b: number | null };
  /** each deck's place as the worklet last reported it (track seconds) */
  reported: { a: number | null; b: number | null };
  /** the worklet's report less the map's, in ms (how far the audio is from the plan) */
  reportDriftMs: { a: number | null; b: number | null };
  /** beat-matched mixes: the incoming deck's beat less the outgoing one's, in ms */
  beatDriftMs: number | null;
}

export interface RunRecord {
  started_at: number;
  /** the context time the outgoing deck reaches the plan's out.start */
  t0: number;
  sample_rate: number;
  windows: {
    a: { start: number; dur: number };
    b: { start: number; dur: number };
    aFrom: number;
    outStart: number;
  };
  key_lock: boolean;
  /** refine.ts's correction for the incoming deck, every 4 beats of the window (ms) */
  correction: { beat: number; ms: number }[] | null;
  samples: RunSample[];
  end: { phase: string; at: number } | null;
}

export interface Environment {
  user_agent: string | null;
  platform: string | null;
  language: string | null;
  hardware_concurrency: number | null;
  device_memory_gb: number | null;
  secure_context: boolean | null;
  audio_worklet: boolean;
  audio_context: {
    sample_rate: number;
    base_latency: number | null;
    output_latency: number | null;
    state: string;
  } | null;
}

const PATH_KEYS = new Set(['file_path', 'path', 'src', 'url', 'image_url', 'folder', 'stored']);
// A path anywhere in a string. Once an anchor is found (a drive, C:\ or
// C:/; a share, \\nas; file:; ~/; or a / that starts a path of two parts or
// a file), everything to the next double quote or the line's end goes: a
// path's names can hold spaces, commas, brackets, & and '. Without an anchor
// only a relative path to a file (Music/Ross/01 Static Bloom.flac) is one,
// from its first name without a space, so dates (27/10/2026) and words with
// slashes (AC/DC, 1/2) stay.
// Percent-encoded text (%2Fm%2Fx.flac) is decoded before it's looked at.
const EXT = String.raw`\.[a-z][a-z0-9]{0,4}\b`;
const ANCHORED = new RegExp(
  String.raw`(?:file:|\\\\(?=[^\s\\])|\b[a-z]:[\\/]|~[\\/]|(?<![\w.~/\\)\]])\/(?=[^\s/\\"][^/\\"\n]*?(?:[\\/]|${EXT})))[^"\x60<>\n]*`,
  'gi',
);
const RELATIVE = new RegExp(
  String.raw`(?<![\w.~/\\%])[^\s/\\"<>|:*?]+(?:[\\/][^/\\"<>|:*?\n]+?)+${EXT}`,
  'gi',
);
const LEFT_OUT = '[path left out]';

function leaveOutPaths(text: string): string {
  return text.replace(ANCHORED, LEFT_OUT).replace(RELATIVE, LEFT_OUT);
}

/** A string with any path in it left out (percent-encoded ones too). */
export function scrubText(text: string): string {
  const plain = leaveOutPaths(text);
  if (!/%[0-9a-f]{2}/i.test(text)) return plain;
  const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
  const scrubbed = leaveOutPaths(decoded);
  return scrubbed === decoded ? plain : scrubbed;
}

/** A deep copy without anything that could carry a file path. */
export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => scrub(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PATH_KEYS.has(k)) continue;
      out[k] = scrub(v);
    }
    return out as T;
  }
  if (typeof value === 'string') return scrubText(value) as unknown as T;
  return value;
}

/** A track's grid as the report keeps it: the summary, not every beat. */
export function gridSummary(g: (ApiGrid & Record<string, unknown>) | null | undefined) {
  if (!g) return null;
  if (!g.analyzed) return { analyzed: false, reason: g.reason ?? null };
  const grid = g.grid;
  return scrub({
    analyzed: true,
    version: (g as { version?: number }).version ?? null,
    bpm: g.bpm ?? null,
    kind: grid?.kind ?? null,
    confidence: grid?.confidence ?? null,
    first_beat: grid?.first_beat ?? null,
    period: grid?.period ?? null,
    beats_listed: grid?.beats ? grid.beats.length : null,
    downbeats: g.downbeats ?? null,
    bars: g.bars ?? null,
    phrases: g.phrases ?? [],
    sections: (g as { sections?: unknown }).sections ?? [],
    mix_in: (g as { mix_in?: unknown }).mix_in ?? null,
    mix_out: g.mix_out ?? null,
    loudness: g.loudness ?? null,
    analysed_s: g.analysed_s ?? null,
    truncated: g.truncated ?? null,
  });
}

export function environment(
  context: BaseAudioContext | null,
  nav: Partial<Navigator> | null = typeof navigator === 'object' ? navigator : null,
  win: { isSecureContext?: boolean; AudioWorkletNode?: unknown } | null = typeof window === 'object'
    ? (window as unknown as { isSecureContext?: boolean; AudioWorkletNode?: unknown })
    : null,
): Environment {
  const ctx = context as
    | (BaseAudioContext & { baseLatency?: number; outputLatency?: number })
    | null;
  return {
    user_agent: nav?.userAgent ?? null,
    platform: (nav as { platform?: string } | null)?.platform ?? null,
    language: nav?.language ?? null,
    hardware_concurrency: nav?.hardwareConcurrency ?? null,
    device_memory_gb: (nav as { deviceMemory?: number } | null)?.deviceMemory ?? null,
    secure_context: win?.isSecureContext ?? null,
    audio_worklet: typeof win?.AudioWorkletNode !== 'undefined',
    audio_context: ctx
      ? {
          sample_rate: ctx.sampleRate,
          base_latency: typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null,
          output_latency: typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
          state: ctx.state,
        }
      : null,
  };
}

export function buildMixReport(input: {
  from: ReportTrack;
  to: ReportTrack;
  request: {
    style: string;
    bars?: number;
    prerollBars: number;
    keyLock: boolean;
    correct: boolean;
  };
  plan: Plan | null;
  grids: Record<string, ApiGrid>;
  run: RunRecord | null;
  env: Environment;
  now?: Date;
}) {
  const track = (t: ReportTrack) => ({ id: String(t.id), title: t.title, artist: t.artist });
  return {
    kind: REPORT_KIND,
    version: REPORT_VERSION,
    created_at: (input.now ?? new Date()).toISOString(),
    pair: { from: track(input.from), to: track(input.to) },
    request: { ...input.request },
    plan: input.plan ? scrub(input.plan) : null,
    grids: {
      from: gridSummary(input.grids[input.from.id] as ApiGrid & Record<string, unknown>),
      to: gridSummary(input.grids[input.to.id] as ApiGrid & Record<string, unknown>),
    },
    run: input.run ? scrub(input.run) : null,
    environment: input.env,
  };
}

export type MixReport = ReturnType<typeof buildMixReport>;

/** "mix-report-night-ferry-to-static-bloom-2026-10-27.json" */
export function reportFileName(from: ReportTrack, to: ReportTrack, now = new Date()): string {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .slice(0, 40) || 'track';
  return `mix-report-${slug(from.title)}-to-${slug(to.title)}-${now.toISOString().slice(0, 10)}.json`;
}

/** Hand the browser a file to save. */
export function downloadJson(name: string, data: unknown, doc: Document = document): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
