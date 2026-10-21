import clsx from 'clsx';
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from 'react';

import styles from './primitives.module.css';

type ShowChildren<T> = ReactNode | ((value: NonNullable<T>) => ReactNode);

export interface ShowProps<T> {
  children: ShowChildren<T>;
  fallback?: ReactNode;
  when: T;
}

export function Show<T>({ fallback = null, children, when }: ShowProps<T>) {
  if (!when) {
    return <>{fallback}</>;
  }

  if (typeof children === 'function') {
    return <>{(children as (value: NonNullable<T>) => ReactNode)(when as NonNullable<T>)}</>;
  }

  return <>{children}</>;
}

type BaseBadgeProps = ComponentPropsWithoutRef<'span'>;

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type BadgeProps = Omit<BaseBadgeProps, 'className'> & {
  className?: string;
  tone?: BadgeTone;
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone = 'neutral', ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={clsx(styles.badge, className)}
      data-slot="badge"
      data-tone={tone}
      {...props}
    />
  );
});

export type NoticeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type NoticeProps = Omit<ComponentPropsWithoutRef<'div'>, 'className' | 'title'> & {
  className?: string;
  tone?: NoticeTone;
  /**
   * With a title the Notice is the design system's attention box (14px
   * radius, the tone at 35% border and 7% fill, an 8px dot): the title says
   * what didn't happen, the children say why and whether anything is at
   * risk, and `actions` hold the one or two buttons that help. Without one
   * it is the compact one-line note.
   */
  title?: ReactNode;
  /** Buttons beside (desktop) or under (phone) the text. Titled Notices only. */
  actions?: ReactNode;
};

export const Notice = forwardRef<HTMLDivElement, NoticeProps>(function Notice(
  { actions, children, className, title, tone = 'info', role = 'note', ...props },
  ref,
) {
  if (title == null || title === false) {
    return (
      <div
        ref={ref}
        className={clsx(styles.notice, className)}
        data-tone={tone}
        role={role}
        {...props}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={clsx(styles.noticeTitled, className)}
      data-tone={tone}
      data-slot="notice"
      role={role}
      {...props}
    >
      <div className={styles.noticeMain}>
        <span className={styles.noticeDot} aria-hidden="true" />
        <div className={styles.noticeText}>
          <p className={styles.noticeTitle} data-slot="notice-title">
            {title}
          </p>
          {children ? (
            <div className={styles.noticeBody} data-slot="notice-body">
              {children}
            </div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className={styles.noticeActions} data-slot="notice-actions">
          {actions}
        </div>
      ) : null}
    </div>
  );
});

export type StatusTagTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type StatusTagProps = Omit<ComponentPropsWithoutRef<'span'>, 'className'> & {
  className?: string;
  tone?: StatusTagTone;
  /** Something is happening now ("Running", "Searching"): the dot pulses
   *  slowly (1.6s), and stops under prefers-reduced-motion. */
  live?: boolean;
};

/**
 * A status: an 8px dot AND a word, never colour alone. The colour at 12%
 * behind the colour as text; neutral is 86% white on 6%. Not interactive, so
 * it never changes on hover, even inside a hovered row.
 */
export const StatusTag = forwardRef<HTMLSpanElement, StatusTagProps>(function StatusTag(
  { children, className, live = false, tone = 'neutral', ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={clsx(styles.statusTag, className)}
      data-tone={tone}
      data-live={live ? 'true' : undefined}
      data-slot="status-tag"
      {...props}
    >
      <span className={styles.statusTagDot} aria-hidden="true" />
      {children}
    </span>
  );
});

export type SpinnerTone = 'accent' | 'soft' | 'tinted' | 'light';

export type SpinnerProps = Omit<ComponentPropsWithoutRef<'span'>, 'children' | 'className'> & {
  className?: string;
  /** Accessible name. Without one the spinner is decorative (aria-hidden). */
  label?: string;
  /** Diameter in px. The ring is 3px from 28px up, 2px below. */
  size?: number;
  tone?: SpinnerTone;
};

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { className, label, size = 16, style, tone = 'accent', ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={clsx(styles.spinner, className)}
      data-slot="spinner"
      data-tone={tone}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
      style={
        {
          '--spinner-size': `${size}px`,
          '--spinner-ring': `${size >= 28 ? 3 : 2}px`,
          ...style,
        } as CSSProperties
      }
      {...props}
    />
  );
});

export type SkeletonProps = Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'className'> & {
  className?: string;
};

/** A shimmering placeholder. Size and shape come from `className`. */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(styles.skeleton, className)}
      data-slot="skeleton"
      aria-hidden="true"
      {...props}
    />
  );
});

export interface SkeletonListProps {
  className?: string;
  /** How many placeholder rows. The boards use 5 while loading, 2 behind an error. */
  rows?: number;
  /** Art (album cover / avatar) size in px; 0 for rows without art. */
  art?: number;
  /** Round art, for artists. */
  roundArt?: boolean;
  /** Show the status-tag placeholder at the right of each row. */
  tag?: boolean;
  /**
   * Behind a "couldn't load" Notice: still rows at 60% opacity, no shimmer,
   * on the quiet 2% wash.
   */
  faded?: boolean;
}

// Title and meta widths per row, so the placeholders read as real rows.
const SKELETON_WIDTHS: Array<[number, number]> = [
  [260, 180],
  [320, 140],
  [220, 200],
  [290, 160],
  [240, 190],
];

/**
 * Placeholder rows in a list's real shape: art, a title line, a meta line,
 * and a status tag on the right, inside the list's card. Decorative
 * (aria-hidden): pair it with the words in LoadingState.
 */
export function SkeletonList({
  art = 48,
  className,
  faded = false,
  roundArt = false,
  rows = 5,
  tag = true,
}: SkeletonListProps) {
  return (
    <div
      className={clsx(styles.skeletonList, className)}
      data-slot="skeleton-list"
      data-faded={faded ? 'true' : undefined}
      aria-hidden="true"
      style={{ '--skeleton-art': `${art}px` } as CSSProperties}
    >
      {Array.from({ length: rows }, (_, index) => {
        const [title, meta] = SKELETON_WIDTHS[index % SKELETON_WIDTHS.length];
        return (
          <div
            className={styles.skeletonRow}
            data-art={art ? 'true' : undefined}
            data-tag={tag ? 'true' : undefined}
            key={index}
          >
            {art ? (
              <Skeleton className={styles.skeletonArt} data-round={roundArt ? 'true' : undefined} />
            ) : null}
            <span className={styles.skeletonLines}>
              <Skeleton className={styles.skeletonTitle} style={{ width: title }} />
              <Skeleton className={styles.skeletonMeta} style={{ width: meta }} />
            </span>
            {tag ? <Skeleton className={styles.skeletonTag} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export type LoadingStateProps = Omit<ComponentPropsWithoutRef<'div'>, 'className' | 'children'> & {
  className?: string;
  /**
   * What is loading, in words, shown beside the spinner and announced (a
   * live region): "Loading your list…", "Loading the last 7 days…".
   */
  label: ReactNode;
  /**
   * Placeholders in the content's real shape. Defaults to five SkeletonList
   * rows; pass your own for cards or a timeline.
   */
  children?: ReactNode;
};

/**
 * Loading, the design system's way: say so in words beside the spinner, then
 * placeholders in the content's real shape. The page's header and controls
 * stay in place above it (render this where the content goes, not instead of
 * the page).
 */
export const LoadingState = forwardRef<HTMLDivElement, LoadingStateProps>(function LoadingState(
  { children, className, label, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(styles.loadingState, className)}
      data-slot="loading-state"
      aria-busy="true"
      {...props}
    >
      <p className={styles.loadingStatus} role="status" data-slot="loading-status">
        <Spinner size={18} />
        <span>{label}</span>
      </p>
      {children === undefined ? <SkeletonList /> : children}
    </div>
  );
});

export type EmptyStateVariant = 'default' | 'panel';

export type EmptyStateProps = Omit<ComponentPropsWithoutRef<'div'>, 'className' | 'title'> & {
  className?: string;
  /** Decorative glyph above the title, e.g. an emoji. Not used by `panel`. */
  icon?: ReactNode;
  title?: ReactNode;
  /** One line (or paragraph) under the title. For `panel`: what the list is for. */
  description?: ReactNode;
  /** `panel` only: the second sentence, how things get onto the list. */
  hint?: ReactNode;
  /** `panel` only: one primary action (and at most one secondary). */
  actions?: ReactNode;
  /**
   * `default` is the centred "nothing here" line older pages use. `panel` is
   * the design system's empty state: a card with an 18px title, two short
   * paragraphs and one primary action, under the page header and controls,
   * which stay in place.
   */
  variant?: EmptyStateVariant;
};

/** The "nothing here" block: icon, title, description, then any children (actions). */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { actions, children, className, description, hint, icon, title, variant = 'default', ...props },
  ref,
) {
  if (variant === 'panel') {
    return (
      <section
        ref={ref}
        className={clsx(styles.emptyPanel, className)}
        data-slot="empty-state"
        data-variant="panel"
        {...props}
      >
        <div className={styles.emptyPanelText}>
          {title ? (
            <h2 className={styles.emptyPanelTitle} data-slot="empty-state-title">
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className={styles.emptyPanelBody} data-slot="empty-state-description">
              {description}
            </p>
          ) : null}
          {hint ? (
            <p className={styles.emptyPanelBody} data-slot="empty-state-hint">
              {hint}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className={styles.emptyPanelActions} data-slot="empty-state-actions">
            {actions}
          </div>
        ) : null}
        {children}
      </section>
    );
  }
  return (
    <div
      ref={ref}
      className={clsx(styles.emptyState, className)}
      data-slot="empty-state"
      {...props}
    >
      {icon ? (
        <div className={styles.emptyStateIcon} data-slot="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      {title ? (
        <h3 className={styles.emptyStateTitle} data-slot="empty-state-title">
          {title}
        </h3>
      ) : null}
      {description ? (
        <p className={styles.emptyStateDescription} data-slot="empty-state-description">
          {description}
        </p>
      ) : null}
      {actions}
      {children}
    </div>
  );
});
