/**
 * The grip (32b state 1): a reserved 24px column whose three 10×2 bars show
 * at 62% on the row's hover and focus; none on a row that can't lift (no
 * file, not in the library), dimmed on a locked one. A mouse drags from it;
 * on a phone the row's long-press lifts instead (32e), so it isn't drawn.
 */
import type { PointerEvent as ReactPointerEvent } from 'react';

import styles from './dnd.module.css';

export function GripGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="2" rx="1" />
      <rect x="7" y="11" width="10" height="2" rx="1" />
      <rect x="7" y="15" width="10" height="2" rx="1" />
    </svg>
  );
}

export function Grip({
  onPointerDown,
  none = false,
  locked = false,
  title = 'Drag to a set, Up next or another place',
  className,
}: {
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** nothing to lift: the column stays, the grip doesn't */
  none?: boolean;
  /** a locked row (275): its grip is dimmed and doesn't lift */
  locked?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={[styles.grip, className].filter(Boolean).join(' ')}
      aria-hidden="true"
      data-dnd-grip={none ? undefined : ''}
      data-none={none ? '' : undefined}
      data-locked={locked ? '' : undefined}
      title={none ? undefined : locked ? 'Locked in its place' : title}
      onPointerDown={none || locked ? undefined : onPointerDown}
    >
      {none ? null : <GripGlyph />}
    </span>
  );
}
