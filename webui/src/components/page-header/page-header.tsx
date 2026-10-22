import type { ReactNode } from 'react';

import clsx from 'clsx';

import styles from './page-header.module.css';
import { TitleWithHelp } from './page-help';

/**
 * Shared page header for the React routes (Import / Issues / Stats).
 *
 * A compact accent bar — 48px icon + title (+ optional subtitle) on the left,
 * an optional actions slot on the right — matching the legacy pages' unified
 * compact header (post-X1) instead of the three hand-rolled headers each page
 * used to carry. Self-contained (rounded, own framing) so it renders
 * consistently regardless of the page container it sits in.
 */
export function PageHeader({
  actions,
  className,
  help,
  icon,
  id,
  subtitle,
  title,
}: {
  actions?: ReactNode;
  className?: string;
  /** The page id whose tour the phone's "?" opens (HANDOFF 25). */
  help?: string;
  icon?: ReactNode;
  id?: string;
  subtitle?: ReactNode;
  title: ReactNode;
}) {
  const heading = <h1 className={styles.title}>{title}</h1>;
  return (
    <header className={clsx(styles.pageHeader, className)} id={id}>
      <div className={styles.titleBlock}>
        {icon ? <span className={styles.icon}>{icon}</span> : null}
        <div className={styles.headingGroup}>
          {help ? <TitleWithHelp page={help}>{heading}</TitleWithHelp> : heading}
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
