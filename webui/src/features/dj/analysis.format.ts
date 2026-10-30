/**
 * The analysis indicator's words (Brief A, 31a–31g; CONTRACTS.md "Analyse
 * on demand"): what one track's line says ("Analysing Canopy · beat grid
 * (5 of 6)", "In line · 3rd", "BPM and key · no beat grid yet"), its row
 * marker ("Ready", "In line · 2nd"), the topbar's count ("Analysing · 14 in
 * line"), the popover's checklist and line, and what "Analyse these" did.
 *
 * The dot says the kind, the words say the state: green is ready to mix,
 * neutral (white at 40%) has some data or is in line, the accent is being
 * analysed now, amber waits, is stopped or can't be beat-matched, red
 * failed. "Ready to mix" means a beat grid at this version, never less.
 */
import { mixTabShown } from '@/features/mix/mix-visibility';

import type {
  AnalyseAnswer,
  AnalysisBeat,
  AnalysisEntry,
  AnalysisLineEntry,
  AnalysisStep,
  AnalysisSweep,
  AnalysisWait,
} from './analysis.api';

/** The dot's kind (31a's note). */
export type AnalysisTone = 'ready' | 'neutral' | 'running' | 'warning' | 'failed';

/** What an action link on the line does; who gets which is in `lineView`. */
export type AnalysisAction =
  | 'analyse'
  | 'analyse_now'
  | 'analyse_mine'
  | 'move_up'
  | 'resume'
  | 'try_again'
  | 'analyse_again'
  | 'drives'
  | 'open_move'
  | 'start_now';

export const ACTION_WORDS: Record<AnalysisAction, string> = {
  analyse: 'Analyse',
  analyse_now: 'Analyse now',
  analyse_mine: 'Analyse mine',
  move_up: 'Move up',
  resume: 'Resume',
  try_again: 'Try again',
  analyse_again: 'Analyse again',
  drives: 'Drives',
  open_move: 'Open the move',
  start_now: 'Start now',
};

/** Who is looking: admins get Analyse now, Analyse all, Resume; members Analyse mine. */
export interface AnalysisViewer {
  admin: boolean;
}

/** The six steps a person sees (31a); the tag write is part of energy's. */
export const SHOWN_STEPS = ['read', 'tempo', 'key', 'energy', 'grid', 'phrases'] as const;
export type ShownStep = (typeof SHOWN_STEPS)[number];

/** The checklist's names (31b). */
export const STEP_NAMES: Record<ShownStep, string> = {
  read: 'Reading audio',
  tempo: 'Tempo',
  key: 'Key',
  energy: 'Energy',
  grid: 'Beat grid',
  phrases: 'Phrases and sections',
};

/** The step as the line says it: "beat grid". */
const STEP_PHRASES: Record<ShownStep, string> = {
  read: 'reading audio',
  tempo: 'tempo',
  key: 'key',
  energy: 'energy',
  grid: 'beat grid',
  phrases: 'phrases and sections',
};

/** The step a code step belongs to (the tag write is energy's; none yet is reading). */
export function shownStep(step: AnalysisStep | null | undefined): ShownStep {
  if (step === 'tags') return 'energy';
  return step && (SHOWN_STEPS as readonly string[]).includes(step) ? (step as ShownStep) : 'read';
}

/** 1–6: the bar fills by step, not by time (1 of 6 is a sixth). */
export function stepNumber(step: AnalysisStep | null | undefined): number {
  return SHOWN_STEPS.indexOf(shownStep(step)) + 1;
}

/** "beat grid (5 of 6)" */
export function stepPhrase(step: AnalysisStep | null | undefined): string {
  return `${STEP_PHRASES[shownStep(step)]} (${stepNumber(step)} of 6)`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, with thousands separators. */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
  return `${n.toLocaleString('en-GB')}${suffix}`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? word : `${word}s`}`;
}

function count(n: number): string {
  return n.toLocaleString('en-GB');
}

/** "next sweep in about 25 min", or null when none is coming. */
export function nextSweepWords(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return 'next sweep in under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `next sweep in about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `next sweep in about ${h} h${m ? ` ${m} min` : ''}`;
}

/** "2 h 14 min" */
export function lengthWords(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A step's time in the checklist: "1.2 s", "< 0.1 s". */
export function stepTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 0.1) return '< 0.1 s';
  return `${seconds.toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** "Analysis stopped by Ross · 14 in line" (an admin) or "… by an admin" (a member). */
export function heldWords(sweep: AnalysisSweep | null | undefined, viewer: AnalysisViewer): string {
  const who = viewer.admin && sweep?.held_by ? sweep.held_by : 'an admin';
  const inLine = sweep?.in_line ?? 0;
  return `Analysis stopped by ${who}${inLine ? ` · ${count(inLine)} in line` : ''}`;
}

function notAnalysedWords(sweep: AnalysisSweep | null | undefined): string {
  const next = nextSweepWords(sweep?.next_in);
  return next ? `Not analysed · ${next}` : 'Not analysed yet';
}

/** What the sweep waits for (31a, state 6): "Waiting for 3 downloads to finish". */
export function waitWords(
  reason: AnalysisWait,
  sweep: AnalysisSweep | null | undefined,
  viewer: AnalysisViewer,
): string {
  const detail = sweep?.waiting === reason ? sweep.waiting_detail : null;
  const n = detail?.count ?? null;
  switch (reason) {
    case 'download':
      return n
        ? `Waiting for ${plural(n, 'download')} to finish`
        : 'Waiting for downloads to finish';
    case 'import':
      return n
        ? `Waiting for the import to finish · ${plural(n, 'file')}`
        : 'Waiting for the import to finish';
    case 'drive_away':
      return `Waiting for ${detail?.drive ?? "the library's drive"} · it's away`;
    case 'drive_move':
      return 'Waiting for the move to finish';
    case 'tag_write':
      return 'Waiting for tags to be written';
    case 'held':
      return heldWords(sweep, viewer);
    case 'off':
      return 'Analysis is off in Settings';
    case 'not_queued':
      return notAnalysedWords(sweep);
  }
}

/** What one track's line says and shows (31a). */
export interface LineView {
  tone: AnalysisTone;
  sentence: string;
  /** 1–6 while it's being analysed, else null (the bar rests) */
  step: number | null;
  /** the action link at the right, if this viewer gets one */
  action: AnalysisAction | null;
  /** shown, but not this viewer's to use (31d: a member's Resume) */
  actionDisabled?: boolean;
}

/** "Analysing Canopy · beat grid (5 of 6)" */
export function workingWords(title: string | null | undefined, step: AnalysisStep | null): string {
  return `Analysing${title ? ` ${title}` : ''} · ${stepPhrase(step)}`;
}

function beatWhy(beat: AnalysisBeat): string {
  if (beat === 'not_4_4') return 'not in 4/4';
  if (beat === 'too_short') return 'too short';
  // a grid found, just not sure enough: not "no steady beat" (Ross's report of 28 October)
  if (beat === 'unsure') return 'beat grid not sure enough';
  return 'no steady beat';
}

/** Can't be beat-matched (31a, state 9): what the pair does instead. */
export function beatWords(beat: AnalysisBeat): string {
  return `Can't be beat-matched · ${beatWhy(beat)} · echo out or cut`;
}

/**
 * One track's line. `title` names it while it's analysed; `sweep` says when
 * the next sweep comes and who stopped it; members get Analyse mine where
 * admins get Analyse now and Move up.
 */
export function lineView(
  entry: AnalysisEntry | null | undefined,
  {
    title,
    viewer,
    sweep,
  }: { title?: string | null; viewer: AnalysisViewer; sweep?: AnalysisSweep | null },
): LineView | null {
  if (!entry) return null;
  const ask: AnalysisAction = viewer.admin ? 'analyse_now' : 'analyse_mine';
  const bpmKey: LineView = {
    tone: 'neutral',
    sentence: 'BPM and key · no beat grid yet',
    step: null,
    action: viewer.admin ? 'analyse' : 'analyse_mine',
  };
  switch (entry.state) {
    case 'done':
      if (entry.beat)
        // an admin can have its beat grid found again (Ross's report of 28
        // October: a grid judged by an older rule could never be asked again)
        return {
          tone: 'warning',
          sentence: beatWords(entry.beat),
          step: null,
          action: viewer.admin && entry.beat !== 'too_short' ? 'analyse_again' : null,
        };
      if (entry.ready === false) return bpmKey;
      return {
        tone: 'ready',
        sentence: 'Ready to mix · beat grid and phrases',
        step: null,
        action: null,
      };
    case 'working':
      return {
        tone: 'running',
        sentence: workingWords(title, entry.step),
        step: stepNumber(entry.step),
        action: null,
      };
    case 'queued': {
      const first = !viewer.admin && entry.asked_for && sweep?.yours_first;
      return {
        tone: 'neutral',
        sentence: `In line · ${ordinal(entry.position)}${first ? ' · yours go first' : ''}`,
        step: null,
        action: viewer.admin && entry.position > 1 ? 'move_up' : null,
      };
    }
    case 'waiting': {
      if (entry.reason === 'not_queued')
        return entry.bpm_key
          ? bpmKey
          : { tone: 'neutral', sentence: notAnalysedWords(sweep), step: null, action: ask };
      if (entry.reason === 'held')
        return {
          tone: 'warning',
          sentence: heldWords(sweep, viewer),
          step: null,
          action: 'resume',
          actionDisabled: !viewer.admin,
        };
      const action: AnalysisAction | null = !viewer.admin
        ? null
        : entry.reason === 'drive_away'
          ? 'drives'
          : entry.reason === 'drive_move'
            ? 'open_move'
            : null;
      return {
        tone: 'warning',
        sentence: waitWords(entry.reason, sweep, viewer),
        step: null,
        action,
      };
    }
    case 'failed':
      if (entry.reason === 'too_long')
        return {
          tone: 'neutral',
          sentence: entry.duration
            ? `Skipped, ${lengthWords(entry.duration)} is too long to analyse · plays straight on`
            : 'Skipped, too long to analyse · plays straight on',
          step: null,
          action: null,
        };
      if (entry.reason === 'no_grid')
        return {
          tone: 'failed',
          sentence: "No beat grid found · won't auto-mix; plays straight on",
          step: null,
          action: viewer.admin ? 'try_again' : null,
        };
      return {
        tone: 'failed',
        sentence: "Couldn't be read · won't auto-mix; plays straight on",
        step: null,
        action: viewer.admin && entry.reason === 'error' ? 'try_again' : null,
      };
  }
}

/** What a row's marker says the sweep waits for: "Waiting · downloads". */
const WAIT_SHORT: Record<
  'drive_away' | 'download' | 'import' | 'drive_move' | 'tag_write',
  string
> = {
  drive_away: "the drive's away",
  download: 'downloads',
  import: 'an import',
  drive_move: 'a drive move',
  tag_write: 'tag writing',
};

/** A row's marker (31b, 31c): a dot and two words. */
export interface MarkerView {
  tone: AnalysisTone;
  words: string;
  /** 1–6: only the row being analysed has a bar */
  step: number | null;
}

export function markerView(
  entry: AnalysisEntry | null | undefined,
  viewer: AnalysisViewer = { admin: false },
  /** names the track while it's analysed (Up next's chip: "Analysing Canopy · …") */
  title: string | null = null,
): MarkerView | null {
  if (!entry) return null;
  switch (entry.state) {
    case 'done':
      if (entry.beat)
        return {
          tone: 'warning',
          words: `Can't be beat-matched · ${beatWhy(entry.beat)}`,
          step: null,
        };
      if (entry.ready === false)
        return { tone: 'neutral', words: 'BPM and key · no grid yet', step: null };
      return { tone: 'ready', words: 'Ready', step: null };
    case 'working':
      return {
        tone: 'running',
        words: title ? workingWords(title, entry.step) : `Analysing · ${stepPhrase(entry.step)}`,
        step: stepNumber(entry.step),
      };
    case 'queued':
      // the sweep's own order says what the track has, not its place: a
      // library mid-sweep isn't rows of "1,240th" (HANDOFF 334)
      if (!entry.asked_for) return dataMarker(entry);
      return { tone: 'neutral', words: `In line · ${ordinal(entry.position)}`, step: null };
    case 'waiting':
      if (entry.reason !== 'held' && entry.reason !== 'off' && !entry.asked_for)
        return dataMarker(entry);
      if (entry.reason === 'not_queued')
        return entry.bpm_key
          ? { tone: 'neutral', words: 'BPM and key', step: null }
          : { tone: 'neutral', words: 'Not analysed', step: null };
      if (entry.reason === 'held')
        return {
          tone: 'warning',
          words: viewer.admin ? 'Stopped' : 'Analysis stopped',
          step: null,
        };
      if (entry.reason === 'off') return { tone: 'warning', words: 'Analysis off', step: null };
      return { tone: 'warning', words: `Waiting · ${WAIT_SHORT[entry.reason]}`, step: null };
    case 'failed':
      if (entry.reason === 'too_long')
        return { tone: 'neutral', words: 'Too long · plays straight on', step: null };
      if (entry.reason === 'no_grid')
        return { tone: 'failed', words: 'No beat grid · plays straight on', step: null };
      return { tone: 'failed', words: "Couldn't be read · plays straight on", step: null };
  }
}

/** What a track not yet analysed has: "BPM and key", or "Not analysed". */
function dataMarker(entry: AnalysisEntry): MarkerView {
  return entry.bpm_key
    ? { tone: 'neutral', words: 'BPM and key', step: null }
    : { tone: 'neutral', words: 'Not analysed', step: null };
}

/** Ready to mix: a beat grid at this version (UX-5). */
export function isReady(entry: AnalysisEntry | null | undefined): boolean {
  return Boolean(entry && entry.state === 'done' && entry.ready !== false && !entry.beat);
}

/** In line or being worked out because someone asked for it. */
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

/** "Canopy is ready to mix" (31a, state 10): said once, held 4 s. */
export function readyWords(title: string | null | undefined): string {
  return title ? `${title} is ready to mix` : 'Ready to mix';
}

/* ── the topbar's count and its popover (31b, 31c, 31f) ─────────────── */

/** Everything still to do: the asked-for line and the sweep's own order. */
export function inLineCount(sweep: AnalysisSweep | null | undefined): number {
  if (!sweep) return 0;
  return (sweep.in_line ?? 0) + (sweep.left ?? 0);
}

export interface CountView {
  tone: AnalysisTone;
  /** the pill: "Analysing · 14 in line", "Analysis idle · next sweep in about 25 min" */
  words: string;
  running: boolean;
}

/** The topbar's pill; null while analysis is off (nothing to say there). */
export function countView(
  sweep: AnalysisSweep | null | undefined,
  viewer: AnalysisViewer,
): CountView | null {
  if (!sweep || !sweep.analyze) return null;
  if (sweep.running) {
    if (sweep.waiting && sweep.waiting !== 'held')
      return { tone: 'warning', words: waitWords(sweep.waiting, sweep, viewer), running: true };
    const n = inLineCount(sweep);
    const title = sweep.current?.title;
    return {
      tone: 'running',
      // the last one: "Analysing Canopy" rather than "0 in line"
      words: n ? `Analysing · ${count(n)} in line` : title ? `Analysing ${title}` : 'Analysing',
      running: true,
    };
  }
  if (sweep.held) return { tone: 'warning', words: heldWords(sweep, viewer), running: false };
  const next = nextSweepWords(sweep.next_in);
  return {
    tone: 'neutral',
    words: next ? `Analysis idle · ${next}` : 'Analysis idle',
    running: false,
  };
}

/** "yours: 2, both next" (a member's count, 31c). */
export function yoursWords(sweep: AnalysisSweep): string {
  const yours = sweep.yours ?? 0;
  if (!yours) return '';
  const next = sweep.yours_first
    ? yours === 1
      ? ', next'
      : yours === 2
        ? ', both next'
        : ', all next'
    : '';
  return `yours: ${count(yours)}${next}`;
}

/** Why a track is in line (31b): "you added it to Sunday Set", "Mira asked", "Up next". */
export function whyWords(e: AnalysisLineEntry): string {
  const you = e.by === 'you';
  const first = e.by && !you ? e.by.split(' ')[0] : null;
  switch (e.source) {
    case 'asked':
      return you ? 'you asked' : first ? `${first} asked` : 'asked for';
    case 'set':
      if (you) return e.set_name ? `you added it to ${e.set_name}` : 'you added it to a set';
      return first ? `${first}'s set` : 'a set';
    case 'up_next':
      return you || !first ? 'Up next' : `${first}'s Up next`;
    case 'mix':
      // asked from the Mix tab: named only while it shows (Settings → Library → DJ)
      if (!mixTabShown()) return you || !first ? 'the player' : `${first}'s player`;
      return you || !first ? 'the Mix tab' : `${first}'s Mix tab`;
    case 'lab':
      return you || !first ? 'the lab' : `${first}'s lab`;
    case 'dj_now':
      return you || !first ? 'DJ now' : `${first}'s DJ now`;
    case 'page':
      return you ? 'you opened it' : first ? `${first} opened it` : 'opened';
  }
}

/** The popover's header line: "Tidewater · 5 of 6 · 14 in line after it". */
export function currentSubline(sweep: AnalysisSweep): string {
  const parts: string[] = [];
  const c = sweep.current;
  if (c?.artist) parts.push(c.artist);
  if (c) parts.push(`${stepNumber(c.step)} of 6`);
  const n = inLineCount(sweep);
  if (n) parts.push(`${count(n)} in line after it`);
  return parts.join(' · ');
}

/** "Finding beats · 1,240 of 4,980" (301): the sweep's own progress. */
export function sweepProgressWords(sweep: AnalysisSweep): string {
  if (!sweep.total) return '';
  return `Finding beats · ${count(sweep.done)} of ${count(sweep.total)}`;
}

/** "and 10 more from the sweep" under the line's tracks (a member's are counted, not named). */
export function moreWords(sweep: AnalysisSweep, viewer: AnalysisViewer): string {
  const others = sweep.line_more ?? 0;
  const left = sweep.left ?? 0;
  const more = others + left;
  if (!more) return '';
  if (!others) return `and ${count(more)} more from the sweep`;
  // a member's line names only its own tracks: the rest are counted
  return viewer.admin ? `and ${count(more)} more` : `and ${count(more)} more in line`;
}

/** The checklist (31b): each step done (with its time), now, or to come. */
export interface ChecklistRow {
  step: ShownStep;
  name: string;
  state: 'done' | 'now' | 'todo';
  time: string;
}

export function checklist(sweep: AnalysisSweep): ChecklistRow[] {
  const c = sweep.current;
  const at = stepNumber(c?.step ?? null);
  return SHOWN_STEPS.map((step, i) => {
    const n = i + 1;
    const state: ChecklistRow['state'] = n < at ? 'done' : n === at ? 'now' : 'todo';
    const time = state === 'now' ? 'now' : state === 'done' ? stepTime(c?.times?.[step]) : '';
    return { step, name: STEP_NAMES[step], state, time };
  });
}

/* ── Added toasts, a set's notice ──────────────────────────────────── */

/** "analysing, 2nd in line" for an Added toast (31b, 31d), once; '' when nothing waits. */
export function addedAnalysisWords(answer: AnalyseAnswer | null | undefined): string {
  if (!answer) return '';
  if (answer.working) return 'analysing now';
  if (answer.position) return `analysing, ${ordinal(answer.position)} in line`;
  return '';
}

/**
 * A set's warning Notice (31b): "12 tracks aren't ready to mix: 9 are in
 * line, 2 have BPM and key only, 1 couldn't be read. Play as a mix plays
 * them straight on until they are." Empty when every track is ready.
 */
export function notReadyNotice(entries: (AnalysisEntry | null | undefined)[]): string {
  let inLineN = 0;
  let bpmKey = 0;
  let unread = 0;
  let cant = 0;
  let notYet = 0;
  let tooLong = 0;
  for (const e of entries) {
    if (!e || isReady(e)) continue;
    if (
      e.state === 'working' ||
      e.state === 'queued' ||
      (e.state === 'waiting' && e.position !== null)
    )
      inLineN += 1;
    else if (e.state === 'done' && e.beat) cant += 1;
    else if (e.state === 'failed' && e.reason === 'too_long') tooLong += 1;
    else if (e.state === 'failed') unread += 1;
    else if (e.bpm_key) bpmKey += 1;
    else notYet += 1;
  }
  const total = inLineN + bpmKey + unread + cant + notYet + tooLong;
  if (!total) return '';
  const be = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (inLineN) parts.push(be(inLineN, 'is in line', 'are in line'));
  if (bpmKey) parts.push(be(bpmKey, 'has BPM and key only', 'have BPM and key only'));
  if (notYet) parts.push(be(notYet, "isn't analysed yet", "aren't analysed yet"));
  if (cant) parts.push(`${count(cant)} can't be beat-matched`);
  if (unread) parts.push(`${count(unread)} couldn't be read`);
  if (tooLong) parts.push(be(tooLong, 'is too long to analyse', 'are too long to analyse'));
  const list =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, ${parts[parts.length - 1]}` : parts[0];
  const one = total === 1;
  return `${plural(total, 'track')} ${one ? "isn't" : "aren't"} ready to mix: ${list}. Play as a mix plays ${one ? 'it' : 'them'} straight on until ${one ? 'it is' : 'they are'}.`;
}

/* ── Analyse these (as analyse on demand built it) ──────────────────── */

/** "Analyse these"'s second line: "12 tracks · ones already done are skipped". */
export function analyseTheseHint(n: number): string {
  return `${plural(n, 'track')} · ones already done are skipped`;
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
      `${count(a.cant)} that couldn't be analysed before ${a.cant === 1 ? 'is' : 'are'} skipped`,
    );
  const over = a.over_limit
    ? `${plural(a.over_limit, 'track')} more wait for the usual sweep: you can have ${count(a.limit)} in line at once.`
    : '';
  if (!a.asked) return { words: 'None of these are in your library with a file.', tone: 'info' };
  if (!coming) {
    if (a.over_limit)
      return { words: ['Nothing more could go in line.', over].join(' '), tone: 'info' };
    if (a.already_done === a.asked)
      return {
        words: `${a.asked === 1 ? 'It is' : `All ${count(a.asked)} are`} analysed already.`,
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
