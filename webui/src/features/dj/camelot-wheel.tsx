import type { KeyboardEvent } from 'react';

import styles from './dj.module.css';
import { keyColours, keyHue, mixKeys } from './key-colour';

/** Where a point sits: angle in radians from the top, clockwise. */
function point(centre: number, radius: number, angle: number): [number, number] {
  return [centre + radius * Math.sin(angle), centre - radius * Math.cos(angle)];
}

function fmt([x, y]: [number, number]): string {
  return `${x.toFixed(2)},${y.toFixed(2)}`;
}

/** One ring segment between two radii and two angles. */
function segment(centre: number, inner: number, outer: number, a0: number, a1: number): string {
  const p0 = point(centre, outer, a0);
  const p1 = point(centre, outer, a1);
  const p2 = point(centre, inner, a1);
  const p3 = point(centre, inner, a0);
  return (
    `M${fmt(p0)}A${outer},${outer} 0 0 1 ${fmt(p1)}` +
    `L${fmt(p2)}A${inner},${inner} 0 0 0 ${fmt(p3)}Z`
  );
}

export type WheelState = 'seed' | 'near' | 'off';

/**
 * How each of the 24 keys is drawn for a seed: the seed itself, its three
 * neighbours (−1, +1 and the relative major or minor), or off.
 */
export function wheelStates(seed: string | null | undefined): Record<string, WheelState> {
  const states: Record<string, WheelState> = {};
  for (let n = 1; n <= 12; n += 1) {
    states[`${n}A`] = 'off';
    states[`${n}B`] = 'off';
  }
  for (const { code, relation } of mixKeys(seed)) {
    states[code] = relation === 'same' ? 'seed' : 'near';
  }
  return states;
}

/**
 * The Camelot wheel (17a at 148px, 17b at 240px): outer ring B (major),
 * inner A (minor), 1 at the top's right and 12 at the top. The seed's
 * segment is lit in its hue at 90% with dark text, its three neighbours at
 * 40% with white text, the rest a 6% wash (their names only at 200px and
 * up). An uncertain seed is outlined in its hue, not filled. With `onPick`
 * the lit segments are buttons ("Show tracks in 7A"): they set Tracks' Key
 * filter.
 */
export function CamelotWheel({
  size,
  seed,
  uncertain = false,
  onPick,
}: {
  size: number;
  seed: string | null | undefined;
  uncertain?: boolean;
  onPick?: (code: string) => void;
}) {
  const states = wheelStates(seed);
  const centre = size / 2;
  const r0 = size * 0.2;
  const r1 = size * 0.34;
  const r2 = size * 0.5 - 1;
  const lit = mixKeys(seed).map((k) => k.code);
  const label = seed
    ? `Camelot wheel: ${seed}${uncertain ? ' (uncertain)' : ''}, with ${lit.slice(1, -1).join(', ')} and ${lit[lit.length - 1]} lit`
    : 'Camelot wheel';
  const parts = [];
  for (let n = 1; n <= 12; n += 1) {
    const a0 = ((n * 30 - 15) * Math.PI) / 180 + 0.01;
    const a1 = ((n * 30 + 15) * Math.PI) / 180 - 0.01;
    const hue = keyHue(`${n}A`) ?? 0;
    const colours = keyColours(hue);
    for (const [letter, inner, outer] of [
      ['A', r0, r1],
      ['B', r1 + 1, r2],
    ] as const) {
      const code = `${n}${letter}`;
      const state = states[code];
      const outlined = state === 'seed' && uncertain;
      const fill = outlined
        ? 'rgba(255,255,255,0.06)'
        : state === 'seed'
          ? colours.lit
          : state === 'near'
            ? colours.near
            : 'rgba(255,255,255,0.06)';
      const [tx, ty] = point(centre, (inner + outer) / 2, (n * 30 * Math.PI) / 180);
      const showName = size >= 200 || state !== 'off';
      const textFill =
        state === 'seed' && !outlined
          ? '#0b0b0f'
          : state !== 'off'
            ? '#fff'
            : 'rgba(255,255,255,0.62)';
      const shape = (
        <>
          <path
            d={segment(centre, inner, outer, a0, a1)}
            fill={fill}
            stroke={outlined ? colours.text : undefined}
            strokeWidth={outlined ? 2 : undefined}
          />
          {showName ? (
            <text
              x={tx.toFixed(2)}
              y={(ty + 4).toFixed(2)}
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              fill={textFill}
            >
              {code}
            </text>
          ) : null}
        </>
      );
      if (onPick && state !== 'off') {
        const pick = () => onPick(code);
        parts.push(
          <g
            key={code}
            role="button"
            tabIndex={0}
            className={styles.wheelPick}
            aria-label={`Show tracks in ${code}`}
            data-wheel-key={code}
            data-wheel-state={state}
            onClick={pick}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                pick();
              }
            }}
          >
            <title>{`Show tracks in ${code}`}</title>
            {shape}
          </g>,
        );
      } else {
        parts.push(
          <g key={code} data-wheel-key={code} data-wheel-state={state}>
            {shape}
          </g>,
        );
      }
    }
  }
  return (
    <svg
      className={styles.wheel}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="group"
      aria-label={label}
    >
      {parts}
    </svg>
  );
}
