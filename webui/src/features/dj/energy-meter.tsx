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
 */
export function EnergyMeter({ energy }: { energy: number | null | undefined }) {
  const lit = energySteps(energy);
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
