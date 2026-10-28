/**
 * A pair's plan as the chips and the controller read it (auto-mix stage A's
 * `GET /api/library/dj/plan`, CONTRACTS "Auto-mix stage A"), with Auto's
 * lean (26h) applied, and the words a chip says in every state (26g).
 */
import type { Plan } from '@/features/engine/loader';

import { fetchPlan } from '@/features/engine/loader';
import { fallbackOf, fallbackSentence } from '@/features/engine/plan-words';

import type { Lean } from './prefs';

/** 26a's styles (Sets' names) and what a pair's chip can ask for. */
export type ChipStyle =
  | 'auto'
  | 'long_blend'
  | 'short_blend'
  | 'bass_swap'
  | 'cut'
  | 'echo_out'
  | 'filter_sweep'
  | 'drop_swap';

export interface Choice {
  style: ChipStyle;
  bars: number | null;
}

export const AUTO_CHOICE: Choice = { style: 'auto', bars: null };

export interface PairPlan extends Plan {
  /** null where a tempo isn't known (the planner's own null) */
  tempo?:
    | (NonNullable<Plan['tempo']> & { from_bpm?: number; to_bpm?: number; gap_pct?: number })
    | null;
  key?: { from: string | null; to: string | null; relation: string };
  /** Auto's lean (26h) moved Auto's own pick */
  leaned?: boolean;
}

/** The planner's style words (core/dj/planner.py STYLE_WORDS). */
export const STYLE_LABELS: Record<ChipStyle, string> = {
  auto: 'Auto',
  long_blend: 'Long blend',
  short_blend: 'Short blend',
  bass_swap: 'Bass swap',
  cut: 'Cut',
  echo_out: 'Echo out',
  filter_sweep: 'Filter sweep',
  drop_swap: 'Drop swap',
};

/** 26a's one line a style. */
export const STYLE_LINES: Record<Exclude<ChipStyle, 'auto'>, string> = {
  long_blend: '32 bars, the EQ handed over slowly',
  short_blend: '8 bars',
  bass_swap: 'The low end changes over on the one',
  cut: 'Straight in on the downbeat',
  echo_out: 'The outgoing track echoes away; safe for clashes',
  filter_sweep: 'Out through a closing filter',
  drop_swap: 'Its drop lands as this one breaks down',
};

export const PICKER_STYLES: Exclude<ChipStyle, 'auto'>[] = [
  'long_blend',
  'short_blend',
  'bass_swap',
  'cut',
  'echo_out',
  'filter_sweep',
  'drop_swap',
];

/** 26a's lengths (32 too, for a long blend). */
export const PICKER_BARS = [2, 4, 8, 16, 32] as const;

/**
 * The plan for a pair and a chip's choice. With Auto, the lean (26h) moves
 * a short blend to a long one ("Long blends") or back ("Short blends"),
 * when the pair can do it; the chip still says "auto".
 */
export async function planFor(
  from: string,
  to: string,
  choice: Choice,
  lean: Lean,
  fetcher: typeof fetchPlan = fetchPlan,
): Promise<PairPlan> {
  // Auto takes its pick's own length
  const bars = choice.style === 'auto' ? undefined : (choice.bars ?? undefined);
  const plan = (await fetcher(from, to, choice.style, bars)) as PairPlan;
  if (choice.style !== 'auto' || lean === 'auto' || plan.status !== 'ok') return plan;
  const want =
    lean === 'long' && plan.style === 'short_blend'
      ? 'long_blend'
      : lean === 'short' && plan.style === 'long_blend'
        ? 'short_blend'
        : null;
  if (!want || !plan.styles?.some((s) => s.style === want && s.available)) return plan;
  const leaned = (await fetcher(from, to, want)) as PairPlan;
  if (leaned.status !== 'ok' || leaned.style !== want) return plan;
  return { ...leaned, requested: 'auto', chosen_by: 'auto', leaned: true };
}

export function planKey(from: string, to: string, choice: Choice, lean: Lean) {
  return ['automix', 'plan', from, to, choice.style, choice.bars ?? 0, lean] as const;
}

/**
 * A pair that plays straight on (no grid going out, an album in its order,
 * or a page that can't run the decks): no transition.
 */
export function playsOn(plan: PairPlan | null | undefined): boolean {
  return plan?.status === 'play_on';
}

// Design's 302 words (shared with the lab): MOVE_WORDS, fallbackOf, fallbackSentence
export { MOVE_WORDS, fallbackOf, fallbackSentence } from '@/features/engine/plan-words';

/** "Long blend · 32 bars", "Cut", "Echo out · 4 bars", "Straight on", "Waiting"; never a crossfade. */
export function planWords(plan: PairPlan | null | undefined, choice: Choice): string {
  if (!plan) return choiceWords(choice);
  if (plan.status === 'waiting') return 'Waiting';
  if (plan.status === 'cut') return STYLE_LABELS.cut;
  if (plan.status === 'play_on') return 'Straight on';
  const style = (plan.style ?? 'auto') as ChipStyle;
  const label = STYLE_LABELS[style] ?? plan.label ?? 'Auto';
  return style === 'cut' || !plan.bars ? label : `${label} · ${plan.bars} bars`;
}

/** A choice's words before its plan is known: "Auto", "Bass swap · 16 bars". */
export function choiceWords(choice: Choice): string {
  const label = STYLE_LABELS[choice.style];
  return choice.bars && choice.style !== 'cut' && choice.style !== 'auto'
    ? `${label} · ${choice.bars} bars`
    : label;
}

export type StepTone = 'smooth' | 'jump' | 'unknown';

/**
 * The step's tone for a pair (Sets' rule, 22c): a key clash, or more than
 * 3 BPM apart (half and double time count), is a jump; a key not known yet
 * is not known.
 */
export function stepOf(plan: PairPlan | null | undefined): StepTone {
  if (!plan?.key) return 'unknown';
  const rel = plan.key.relation;
  if (rel === 'unknown') return 'unknown';
  if (rel === 'clash') return 'jump';
  const t = plan.tempo;
  if (t?.from_bpm && t?.to_bpm) {
    const per = { same: 1, half: 2, double: 0.5 }[t.relation ?? 'same'] ?? 1;
    if (Math.abs(t.to_bpm * per - t.from_bpm) > 3) return 'jump';
  }
  return 'smooth';
}

/** "auto · 8A → 9A, +2 BPM" or "yours · 9A → 4B, +1 BPM, keys clash" (26g). */
export function chipWhy(
  plan: PairPlan | null | undefined,
  choice: Choice,
  toTitle: string,
  fromTitle = '',
): string {
  const who = choice.style === 'auto' ? 'auto' : 'yours';
  if (!plan) return who;
  if (plan.status === 'waiting') {
    // the track it's waiting for (the planner's waiting_for), and why
    const title = (plan.waiting_for === 'from' ? fromTitle : toTitle) || 'It';
    return plan.reason === 'not_analyzed'
      ? `${title} isn't analysed yet`
      : `${title} is being analysed`;
  }
  // 302: what stood in the way (the chip names the move)
  // (26g's fallback line: no "auto" before it, so the reason fits)
  const f = fallbackOf(plan);
  if (f) return `couldn't beat-match: ${f.reason}`;
  if (plan.status === 'play_on')
    return plan.fallback?.code === 'unsupported'
      ? 'Needs https or localhost'
      : `plays straight on${plan.fallback?.reason ? ` · ${plan.fallback.reason}` : ''}`;
  // 303 and 304 say why in place, not in silence
  if (plan.shortened) return `${who} · ${plan.shortened}`;
  if (plan.unsure_bars) return `${who} · Not sure where the bars start`;
  const pair = plan.pair ?? '';
  const clash = plan.key?.relation === 'clash' ? ', keys clash' : '';
  return [who, `${pair}${clash}`].filter(Boolean).join(' · ');
}

/** The short reason on a phone (26b): "auto · keys clash", "live drums: can't match". */
export function chipWhyShort(plan: PairPlan | null | undefined, choice: Choice): string {
  const who = choice.style === 'auto' ? 'auto' : 'yours';
  if (!plan) return who;
  if (plan.status === 'waiting') return 'being analysed';
  if (fallbackOf(plan)) return `${who} · can't beat-match`;
  if (plan.status === 'play_on')
    return plan.fallback?.code === 'unsupported' ? 'Needs https' : 'plays straight on';
  if (plan.shortened) return `${who} · ${plan.shortened}`;
  if (plan.unsure_bars) return `${who} · bars unsure`;
  if (plan.key?.relation === 'clash') return `${who} · keys clash`;
  const pair = plan.pair?.split(',')[0] ?? '';
  return [who, pair].filter(Boolean).join(' · ');
}

/** Auto's pick in the picker (26a): "Auto: Echo out" and why it chose it. */
export function autoLine(plan: PairPlan | null | undefined): { name: string; why: string } {
  if (!plan) return { name: 'Auto', why: 'Picks a style from the keys and tempos' };
  if (plan.status === 'waiting')
    return { name: 'Auto', why: 'Picks once both tracks are ready to mix' };
  const sentence = fallbackSentence(plan);
  if (plan.status === 'play_on')
    return {
      name: 'Auto: Straight on',
      why: sentence ?? plan.fallback?.reason ?? 'Nothing to mix on',
    };
  const label = STYLE_LABELS[(plan.style ?? 'auto') as ChipStyle] ?? plan.label ?? 'Auto';
  const reason = (plan.why ?? '').split(': ').slice(1).join(': ');
  // 302's move, taken because the pair can't be beat-matched: its sentence
  // is the picker's detail (never a "crossfade" warning)
  const why = sentence
    ? sentence
    : plan.shortened
      ? `Short blend: ${plan.shortened}`
      : plan.leaned
        ? `Leaning to ${label.toLowerCase()}s (Settings → Library → DJ)`
        : reason
          ? `Chosen because ${reason}`
          : 'Chosen for this pair';
  return { name: `Auto: ${label}`, why };
}

/** "in 2:58" (Design's 249): out.start less where the track is. */
export function inWords(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  return `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
