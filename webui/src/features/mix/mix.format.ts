/** The Mix tab's words (29a–29d). */
import type { Step, ViewRow } from '@/features/sets/sets.api';

import { chipWords } from '@/features/sets/sets.format';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A new working set's name (29d): "Set from Sunday 26 Oct". */
export function workingSetName(now = new Date()): string {
  return `Set from ${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
}

/** "2:14", "1:02:09". */
export function clockWords(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** The primary button: "Add Night Ferry to Sunday Set"; "✓ Added · #7" for 4 s after. */
export function addLabel(title: string, setName: string | null): string {
  const what = title || 'this track';
  return setName ? `Add ${what} to ${setName}` : `Start a mix set with ${what}`;
}

export function addedLabel(number: number): string {
  return `✓ Added · #${number}`;
}

/** The step's word, first in the join's sentence and the set list (22c). */
export function stepWord(step: Step | null | undefined): string {
  if (!step) return '';
  if (step.kind === 'smooth') return 'Smooth';
  if (step.kind === 'jump') return 'Jump';
  return 'Not known yet';
}

/** "Night Ferry would follow Copper Sky" (the reason follows: "Smooth · 8B → 8A, +4 BPM"). */
export function joinLead(playing: string, last: string): string {
  return `${playing || 'This track'} would follow ${last || 'the last track'}`;
}

/** "Track 4 of 12" while a set plays. */
export function trackOfWords(number: number, total: number): string {
  return `Track ${number} of ${total}`;
}

/** The set's next join, while it plays: "Long blend · 32 bars" (Auto until one is chosen). */
export function nextTransitionWords(row: ViewRow | null | undefined): string {
  return row ? chipWords(row.transition) : '';
}

/** "6 tracks · 38 min", the working-set picker's meta (and "6 · 38 min" on a phone). */
export function setMetaWords(tracks: number, seconds: number, short = false): string {
  const minutes = Math.round(seconds / 60);
  const count = short ? String(tracks) : `${tracks} ${tracks === 1 ? 'track' : 'tracks'}`;
  return seconds ? `${count} · ${minutes} min` : count;
}

/** The energy line's y for 1–10 in a box `height` tall (29a: 28px, 4px in from each edge). */
export function energyY(energy: number, height = 28, pad = 4): number {
  const e = Math.max(1, Math.min(10, energy));
  return pad + (height - 2 * pad) * (1 - (e - 1) / 9);
}

/**
 * The strip's energy line (29a): one point per cell (x at each cell's
 * middle, 0–100), the set's tracks solid, the step to the playing one
 * dashed. Cells without an energy leave a gap.
 */
export function stripLine(energies: (number | null | undefined)[]): {
  solid: string;
  dashed: string;
} {
  const n = energies.length;
  const points = energies.map((e, i) =>
    e ? `${(((i + 0.5) * 100) / n).toFixed(1)},${energyY(e).toFixed(1)}` : null,
  );
  const set = points.slice(0, -1);
  const solid = set.every(Boolean) ? set.join(' ') : set.filter(Boolean).join(' ');
  const last = points[n - 1];
  const before = points[n - 2];
  return {
    solid: set.filter(Boolean).length > 1 ? solid : '',
    dashed: last && before ? `${before} ${last}` : '',
  };
}

/** What Vibe can't do, from GET /api/ai/status's reason. */
export function vibeOffWords(reason: string | null | undefined): string {
  switch (reason) {
    case 'not_configured':
      return 'The AI is off: an admin adds a key in Settings → AI.';
    case 'members_not_allowed':
      return 'Only admins can use the AI on this server.';
    case 'key_refused':
      return "The AI's key was refused: an admin checks it in Settings → AI.";
    case 'cap_reached':
      return "This server's AI budget for the month is spent (one budget for every profile), so Vibe waits for the 1st.";
    default:
      return '';
  }
}

/** The foot under the matches (29a). */
export function matchesFoot(opts: { vibeLine?: string | null; leftOut?: number }): string {
  // the note is the AI's own words (a title can steer them), so it's quoted
  // and named as the AI's; the server has already cleaned it and dropped
  // any link or address (gauntlet L3)
  if (opts.vibeLine) return `Ordered for feel by the AI. The AI's note: “${opts.vibeLine}”`;
  const base = 'From your library, files present · starred first among equals';
  return opts.leftOut ? `${base} · the set's own tracks left out` : base;
}
