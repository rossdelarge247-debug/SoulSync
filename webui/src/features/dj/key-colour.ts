/**
 * The Camelot wheel's colours (hand-off "Added 2026-10-24", HANDOFF 151): a
 * key n takes the hue h = (n − 8) × 30°, so 8A and 8B sit at 0° and each
 * step round the wheel turns 30°. A and B share a hue. A chip fills with
 * `oklch(0.7 0.12 h / 0.16)` and writes in `oklch(0.86 0.1 h)`; key text in a
 * meta line takes the text colour alone. An uncertain key keeps no colour.
 *
 * The colours themselves live in `dj.module.css` (`.keyChip`, `.keyText`),
 * reading the hue from `--dj-key-h`; this file only works the hue out.
 */

export interface CamelotParts {
  /** 1–12 round the wheel */
  number: number;
  /** A minor, B major */
  letter: 'A' | 'B';
}

const CAMELOT = /^(1[0-2]|[1-9])([AB])$/;

/** "8A" -> {number: 8, letter: 'A'}; null for anything that isn't a Camelot code. */
export function camelotParts(code: string | null | undefined): CamelotParts | null {
  const match = CAMELOT.exec(
    String(code ?? '')
      .trim()
      .toUpperCase(),
  );
  return match ? { number: Number(match[1]), letter: match[2] as 'A' | 'B' } : null;
}

/** The wheel's hue for a key, 0–330 in 30° steps; null for no key. */
export function keyHue(code: string | null | undefined): number | null {
  const parts = camelotParts(code);
  if (!parts) return null;
  return ((((parts.number - 8) * 30) % 360) + 360) % 360;
}

/** The CSS colours for a key's hue (what `.keyChip` and `.keyText` draw). */
export function keyColours(hue: number): { fill: string; text: string; lit: string; near: string } {
  return {
    fill: `oklch(0.7 0.12 ${hue} / 0.16)`,
    text: `oklch(0.86 0.1 ${hue})`,
    // the wheel: the seed's segment, then its neighbours'
    lit: `oklch(0.7 0.12 ${hue} / 0.9)`,
    near: `oklch(0.7 0.12 ${hue} / 0.4)`,
  };
}

export type MixRelation = 'same' | 'down' | 'up' | 'relative';

/**
 * The keys that mix with one, in the order Tracks' count line names them:
 * the key, −1 and +1 on the wheel, then the relative major or minor
 * ("8A, 7A, 9A or 8B"). The server's rule (`core/dj/camelot.py`
 * `compatible_keys`); the wheel lights these.
 */
export function mixKeys(
  code: string | null | undefined,
): { code: string; relation: MixRelation }[] {
  const parts = camelotParts(code);
  if (!parts) return [];
  const { number, letter } = parts;
  const down = ((number + 10) % 12) + 1;
  const up = (number % 12) + 1;
  const other = letter === 'A' ? 'B' : 'A';
  return [
    { code: `${number}${letter}`, relation: 'same' },
    { code: `${down}${letter}`, relation: 'down' },
    { code: `${up}${letter}`, relation: 'up' },
    { code: `${number}${other}`, relation: 'relative' },
  ];
}

const NOTE_LONG: Record<string, string> = {
  'C#': 'C♯',
  Db: 'D♭',
  Eb: 'E♭',
  'F#': 'F♯',
  Ab: 'A♭',
  Bb: 'B♭',
};

/** The tag form to words: "Am" -> "A minor", "F#" -> "F♯ major", "Ebm" -> "E♭ minor". */
export function keyLongName(name: string): string {
  const match = /^([A-G])([#b]?)(m?)$/.exec(name);
  if (!match) return name;
  const note = `${match[1]}${match[2]}`;
  return `${NOTE_LONG[note] ?? note} ${match[3] ? 'minor' : 'major'}`;
}
