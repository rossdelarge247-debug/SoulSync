/**
 * The set's energy graph (22c): time across, energy 1–10 up. The set is the
 * accent-light line with a 12% area; the shape asked for is a dashed line at
 * 40% white, drawn only when a shape was chosen; the track being swapped is
 * shaded. A picture, not a control: the list is where the order changes.
 * Also the 96×28 sparkline on a Your sets row.
 */
import { useId } from 'react';

import type { ViewRow } from './sets.api';

import { SHAPES, isShape } from './sets.format';
import styles from './sets.module.css';

const W = 680;
const H = 96;
const PAD_Y = 6;

function y(energy: number, height = H, pad = PAD_Y): number {
  const e = Math.max(1, Math.min(10, energy));
  return pad + (height - 2 * pad) * (1 - (e - 1) / 9);
}

export interface GraphPoint {
  start: number;
  length: number;
  energy: number | null;
}

/** Each playing row's start and length in seconds, and its energy. */
export function graphPoints(rows: ViewRow[]): GraphPoint[] {
  const out: GraphPoint[] = [];
  let at = 0;
  for (const row of rows) {
    if (!row.track) continue;
    const length = Math.max(60, Math.round((row.track.duration_ms ?? 300_000) / 1000));
    out.push({ start: at, length, energy: row.track.dj?.energy ?? null });
    at += length;
  }
  return out;
}

function ticks(totalMin: number): number[] {
  const step = totalMin > 150 ? 60 : 30;
  const out = [];
  for (let m = 0; m < totalMin - step / 3; m += step) out.push(m);
  return out;
}

export function EnergyGraph({
  rows,
  shape,
  shaded = null,
}: {
  rows: ViewRow[];
  shape?: string | null;
  /** the row index being swapped */
  shaded?: number | null;
}) {
  const fill = useId();
  const points = graphPoints(rows);
  const total = points.reduce((sum, p) => sum + p.length, 0) || 1;
  const x = (seconds: number) => (W * seconds) / total;
  const known = points.filter((p) => p.energy !== null);
  const line = known
    .map(
      (p, i) =>
        `${i ? 'L' : 'M'}${x(p.start + p.length / 2).toFixed(1)},${y(p.energy ?? 1).toFixed(1)}`,
    )
    .join(' ');
  const first = known[0];
  const last = known.at(-1);
  const area =
    first && last
      ? `M0,${y(first.energy ?? 1)} ${line.replace(/^M/, 'L')} L${W},${y(last.energy ?? 1)} L${W},${H} L0,${H} Z`
      : '';
  const asked = isShape(shape)
    ? Array.from({ length: 41 }, (_v, i) => {
        const t = i / 40;
        return `${i ? 'L' : 'M'}${(W * t).toFixed(1)},${y(SHAPES[shape].at(t)).toFixed(1)}`;
      }).join(' ')
    : '';
  // the shaded track: the playing row's place among the playing rows
  let shadedPoint: GraphPoint | null = null;
  if (shaded !== null && rows[shaded]?.track) {
    const index = rows.slice(0, shaded).filter((r) => r.track).length;
    shadedPoint = points[index] ?? null;
  }
  const totalMin = Math.round(total / 60);
  const unknown = points.length - known.length;
  return (
    <figure className={styles.graph} data-energy-graph="">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={styles.graphSvg}
        role="img"
        aria-label={`Energy across the set: ${known.map((p) => p.energy).join(', ') || 'not known yet'}${
          asked ? `, against the ${SHAPES[shape as keyof typeof SHAPES].name} shape asked for` : ''
        }`}
      >
        <defs>
          <linearGradient id={fill} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgb(var(--ss-accent-light-rgb))" stopOpacity="0.16" />
            <stop offset="1" stopColor="rgb(var(--ss-accent-light-rgb))" stopOpacity="0.08" />
          </linearGradient>
        </defs>
        {shadedPoint ? (
          <rect
            x={x(shadedPoint.start)}
            y={0}
            width={Math.max(4, x(shadedPoint.length))}
            height={H}
            className={styles.graphShade}
            data-graph-shade=""
          />
        ) : null}
        {area ? <path d={area} fill={`url(#${fill})`} /> : null}
        {asked ? <path d={asked} className={styles.graphAsked} data-graph-asked="" /> : null}
        {line ? <path d={line} className={styles.graphLine} data-graph-line="" /> : null}
      </svg>
      <figcaption className={styles.graphAxis}>
        <span className={styles.graphTicks} aria-hidden="true">
          {ticks(totalMin).map((m) => (
            <span key={m} style={{ left: `${(100 * m * 60) / total}%` }}>
              {m}
            </span>
          ))}
          <span className={styles.graphEnd}>{totalMin} min</span>
        </span>
        <span className={styles.graphLegend}>
          {asked ? (
            <span>
              <i className={styles.legendAsked} aria-hidden="true" /> asked for
            </span>
          ) : null}
          <span>
            <i className={styles.legendSet} aria-hidden="true" /> this set
          </span>
          {unknown ? <span>{unknown} not known yet</span> : null}
        </span>
      </figcaption>
    </figure>
  );
}

/** Your sets' 96×28 sparkline. */
export function Sparkline({ energy }: { energy: (number | null)[] }) {
  const known = energy.map((e, i) => [i, e] as const).filter(([, e]) => e !== null) as [
    number,
    number,
  ][];
  const w = 96;
  const h = 28;
  const n = Math.max(1, energy.length - 1);
  const d = known
    .map(([i, e], k) => `${k ? 'L' : 'M'}${((w * i) / n).toFixed(1)},${y(e, h, 3).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={styles.spark}
      aria-hidden="true"
      data-sparkline=""
    >
      {known.length > 1 ? <path d={d} className={styles.graphLine} /> : null}
      {known.length < 2 ? (
        <path d={`M0,${h - 3} L${w},${h - 3}`} className={styles.sparkFlat} />
      ) : null}
    </svg>
  );
}
