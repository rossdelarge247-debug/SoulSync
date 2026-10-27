/**
 * The words of analyse on demand (CONTRACTS.md "Analyse on demand"): a
 * track's step ("Finding the beat grid · 60%"), its place in line ("2nd in
 * line"), what it waits for ("Waiting for downloads"), why it failed, the
 * sweep's line for Activity, and what "Analyse these" did.
 */
import type {
  AnalyseAnswer,
  AnalysisEntry,
  AnalysisFail,
  AnalysisStep,
  AnalysisSweep,
  AnalysisWait,
} from './analysis.api';

export const STEP_WORDS: Record<AnalysisStep, string> = {
  read: 'Reading the audio',
  tempo: 'Finding the tempo',
  key: 'Working out the key',
  energy: 'Measuring the energy',
  tags: 'Writing tags',
  grid: 'Finding the beat grid',
  phrases: 'Finding phrases and sections',
};

export const WAIT_WORDS: Record<AnalysisWait, string> = {
  drive_away: 'Waiting for the library drive',
  download: 'Waiting for downloads',
  import: 'Waiting for an import',
  drive_move: 'Waiting for the drive move',
  tag_write: 'Waiting while tags are written',
  held: 'Analysis is stopped',
  off: 'Analysis is off in Settings',
  not_queued: 'Not analysed yet',
};

export const FAIL_WORDS: Record<AnalysisFail, string> = {
  too_long: 'Too long to analyse',
  unreachable: "Can't open its file",
  error: "Couldn't be analysed",
  no_grid: 'No beat grid found',
};

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, with thousands separators. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
  return `${n.toLocaleString('en-GB')}${suffix}`;
}

/** "Next in line" for the first, else "2nd in line". */
export function lineWords(position: number): string {
  return position <= 1 ? 'Next in line' : `${ordinal(position)} in line`;
}

export function stepWords(
  step: AnalysisStep | null | undefined,
  percent: number | null | undefined,
): string {
  const words = (step && STEP_WORDS[step]) || 'Starting';
  return percent === null || percent === undefined ? words : `${words} · ${Math.round(percent)}%`;
}

/** One track's status line. */
export function entryWords(entry: AnalysisEntry): string {
  switch (entry.state) {
    case 'done':
      return 'Analysed';
    case 'working':
      return stepWords(entry.step, entry.percent);
    case 'queued':
      return lineWords(entry.position);
    case 'waiting':
      return WAIT_WORDS[entry.reason] ?? 'Waiting';
    case 'failed':
      return FAIL_WORDS[entry.reason] ?? "Couldn't be analysed";
  }
}

/** The bar's fill, 0–100: the step's place while working, else empty. */
export function entryPercent(entry: AnalysisEntry): number {
  return entry.state === 'working' ? Math.max(0, Math.min(100, entry.percent)) : 0;
}

/** In line or being worked out, for Tracks' rows (asked-for tracks only). */
export function inLine(entry: AnalysisEntry | null | undefined): boolean {
  if (!entry) return false;
  if (entry.state === 'working') return true;
  if (entry.state === 'queued') return entry.asked_for;
  return entry.state === 'waiting' && entry.position !== null && entry.asked_for;
}

/** Still to come: not done and not failed. */
export function pending(entry: AnalysisEntry | null | undefined): boolean {
  return Boolean(entry && entry.state !== 'done' && entry.state !== 'failed');
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? word : `${word}s`}`;
}

/** Activity's DJ row: "1,240 of 4,980 · Static Bloom · Finding the beat grid · 60%". */
export function sweepWords(sweep: AnalysisSweep): string {
  const parts: string[] = [];
  if (sweep.total)
    parts.push(`${sweep.done.toLocaleString('en-GB')} of ${plural(sweep.total, 'track')}`);
  if (sweep.waiting) parts.push(WAIT_WORDS[sweep.waiting] ?? 'Waiting');
  else if (sweep.current) {
    if (sweep.current.title) parts.push(sweep.current.title);
    parts.push(stepWords(sweep.current.step, sweep.current.percent));
  }
  return parts.join(' · ');
}

/** "Analyse these"'s second line: "12 tracks · ones already done are skipped". */
export function analyseTheseHint(count: number): string {
  return `${plural(count, 'track')} · ones already done are skipped`;
}

/** What "Analyse these" did, for its toast. */
export function analyseTheseWords(a: AnalyseAnswer): { words: string; tone: 'success' | 'info' } {
  const coming = a.queued + a.already_queued;
  const skipped: string[] = [];
  if (a.already_done)
    skipped.push(
      `${plural(a.already_done, 'track')} already done ${a.already_done === 1 ? 'is' : 'are'} skipped`,
    );
  if (a.cant)
    skipped.push(
      `${a.cant.toLocaleString('en-GB')} that couldn't be analysed before ${a.cant === 1 ? 'is' : 'are'} skipped`,
    );
  const over = a.over_limit
    ? `${plural(a.over_limit, 'track')} more wait for the usual sweep: you can have ${a.limit.toLocaleString('en-GB')} in line at once.`
    : '';
  if (!a.asked) return { words: 'None of these are in your library with a file.', tone: 'info' };
  if (!coming) {
    if (a.over_limit)
      return { words: ['Nothing more could go in line.', over].join(' '), tone: 'info' };
    if (a.already_done === a.asked)
      return {
        words: `${a.asked === 1 ? 'It is' : `All ${a.asked.toLocaleString('en-GB')} are`} analysed already.`,
        tone: 'info',
      };
    return {
      words: [
        'Nothing here needs analysing.',
        skipped.length ? `${capital(skipped.join('; '))}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
      tone: 'info',
    };
  }
  const lead = `${plural(coming, 'track')} will be analysed next.`;
  return {
    words: [lead, skipped.length ? `${capital(skipped.join('; '))}.` : '', over]
      .filter(Boolean)
      .join(' '),
    tone: 'success',
  };
}

function capital(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
