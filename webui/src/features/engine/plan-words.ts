/**
 * Design's 302 in its words, for every place a plan is shown (Up next's
 * chips, the picker, a set's chips, the bar's countdown, the lab):
 * "Couldn't beat-match: cutting on the phrase · the tempos are 9.7% apart",
 * "…: echo out · Sand Script has no steady beat", "…: plays straight on ·
 * Sweet Waltz isn't in 4/4". The planner (core/dj/planner.py) decides the
 * move and the reason; this only says them. Nothing says "crossfade".
 */
import type { PlanLike } from './executor';

/** 302's moves, the sentence's middle. */
export const MOVE_WORDS: Record<string, string> = {
  cut: 'cutting on the phrase',
  echo_out: 'echo out',
  play_on: 'plays straight on',
};

/**
 * A pair that couldn't be beat-matched and took 302's move: its fallback.
 * Not an album played in its order (gapless, not a failure), nor a page
 * that can't run the decks.
 */
export function fallbackOf(
  plan: Pick<PlanLike, 'fallback'> | null | undefined,
): { kind: string; code: string; reason: string } | null {
  const f = plan?.fallback;
  if (!f || !MOVE_WORDS[f.kind]) return null;
  if (f.code === 'album_in_order' || f.code === 'unsupported') return null;
  return f;
}

/** The sentence, or null when the pair is beat-matched (or plays on for another reason). */
export function fallbackSentence(
  plan: Pick<PlanLike, 'fallback'> | null | undefined,
): string | null {
  const f = fallbackOf(plan);
  return f ? `Couldn't beat-match: ${MOVE_WORDS[f.kind]} · ${f.reason}` : null;
}
