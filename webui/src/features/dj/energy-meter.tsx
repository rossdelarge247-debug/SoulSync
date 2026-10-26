import styles from './dj.module.css';

/** How many of the ten steps light for an energy of 1–10 (clamped; 0 for none). */
export function energySteps(energy: number | null | undefined): number {
  if (!energy || !Number.isFinite(energy)) return 0;
  return Math.max(0, Math.min(10, Math.round(energy)));
}

/**
 * Energy as a number with a ten-step bar (HANDOFF 151; Tracks only): the
 * number in 15px tabular figures, then ten 4 × 12px steps 2px apart, the lit
 * ones at 86% white and the rest at 14%. You read the number; you compare
 * the bars down a column. The bar is decoration: the number is what's read.
 *
 * `variant="steps"` is the Mix tab's meter (29a, 29c): ten 8px steps across
 * the width, 3px apart, the lit ones in accent-light and the rest at 12%,
 * as a `meter`; with `label` the words "Energy 6 of 10" sit above it. "—"
 * while it isn't known.
 */
export function EnergyMeter({
  energy,
  variant = 'number',
  label = false,
}: {
  energy: number | null | undefined;
  variant?: 'number' | 'steps';
  label?: boolean;
}) {
  const lit = energySteps(energy);
  if (variant === 'steps') {
    const words = lit ? `Energy ${lit} of 10` : 'Energy —';
    const meter = (
      <span
        className={styles.energySteps}
        role="meter"
        aria-valuemin={1}
        aria-valuemax={10}
        aria-valuenow={lit || undefined}
        aria-label={lit ? 'Energy' : 'Energy, not known yet'}
        aria-valuetext={lit ? words : 'not known yet'}
        data-energy-steps=""
      >
        {Array.from({ length: 10 }, (_v, i) => (
          <span key={i} data-lit={i < lit ? 'true' : undefined} />
        ))}
      </span>
    );
    if (!label) return meter;
    return (
      <span className={styles.energyLabelled}>
        <span className={styles.energyWords}>{words}</span>
        {meter}
      </span>
    );
  }
  if (!lit) return <span className={styles.energyNone}>–</span>;
  return (
    <span className={styles.energy} title={`Energy ${lit} of 10`}>
      <span className={styles.energyNumber}>{lit}</span>
      <span className={styles.energyBar} aria-hidden="true">
        {Array.from({ length: 10 }, (_v, i) => (
          <span key={i} data-lit={i < lit ? 'true' : undefined} />
        ))}
      </span>
    </span>
  );
}
