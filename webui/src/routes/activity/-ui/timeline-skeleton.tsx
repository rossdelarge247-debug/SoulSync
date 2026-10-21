import { Skeleton } from '@/components/primitives';

import styles from './activity-page.module.css';

// [tag width, title width, meta width] per placeholder row, as on board 1i
const DAYS: Array<{ label: number; rows: Array<[number, number, number]> }> = [
  {
    label: 64,
    rows: [
      [96, 340, 220],
      [80, 280, 180],
      [110, 380, 160],
    ],
  },
  {
    label: 90,
    rows: [
      [96, 300, 200],
      [80, 260, 150],
    ],
  },
];

/**
 * Placeholders in the timeline's shape: a day label, then rows of time,
 * status tag and two lines of text; two days. Decorative (aria-hidden).
 * `faded` is the still, 60% version that sits behind a "couldn't load" Notice.
 */
export function TimelineSkeleton({ faded = false, days = 2 }: { faded?: boolean; days?: number }) {
  return (
    <div
      className={styles.skeleton}
      data-faded={faded ? 'true' : undefined}
      data-testid={faded ? 'activity-skeleton-faded' : 'activity-skeleton'}
      aria-hidden="true"
    >
      {DAYS.slice(0, days).map((day, dayIndex) => (
        <div key={dayIndex} className={styles.skeletonGroup}>
          <Skeleton className={styles.skeletonDay} style={{ width: day.label }} />
          <div className={styles.list}>
            {day.rows.map(([tag, title, meta], index) => (
              <div key={index} className={styles.skeletonRow}>
                <Skeleton className={styles.skeletonTime} />
                <Skeleton className={styles.skeletonTag} style={{ width: tag }} />
                <span className={styles.skeletonLines}>
                  <Skeleton className={styles.skeletonTitle} style={{ width: title }} />
                  <Skeleton className={styles.skeletonMeta} style={{ width: meta }} />
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
