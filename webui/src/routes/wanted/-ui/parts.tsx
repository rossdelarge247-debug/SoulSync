import { useNavigate } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';

import { Button, OptionButton, Select } from '@/components/form';
import { Notice, Skeleton, SkeletonList } from '@/components/primitives';

import { whyItFailed } from '../-wanted.helpers';
import { PAGE_SIZE } from '../-wanted.types';
import styles from './wanted-page.module.css';

/** The 13px count on a tab or filter; shimmers while it isn't known yet. */
export function CountBadge({ count, loading = false }: { count?: number; loading?: boolean }) {
  if (loading) return <Skeleton className={styles.badgeLoading} />;
  if (count === undefined) return null;
  return <span className={styles.badge}>{count}</span>;
}

export interface FilterOption<T extends string> {
  key: T;
  label: string;
  count?: number;
}

/** OptionButtons, pressed for the one in use (the boards' "Show" group). */
export function FilterButtons<T extends string>({
  options,
  value,
  onChange,
  label = 'Show',
}: {
  options: FilterOption<T>[];
  value: T;
  onChange: (next: T) => void;
  label?: string;
}) {
  return (
    <div className={styles.filters} role="group" aria-label={label}>
      {options.map((option) => (
        <OptionButton
          key={option.key}
          data-slot="filter"
          selected={option.key === value}
          onClick={() => onChange(option.key)}
        >
          {option.label}
          {option.count !== undefined ? <CountBadge count={option.count} /> : null}
        </OptionButton>
      ))}
    </div>
  );
}

export function SortSelect<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  const id = useId();
  return (
    <span className={styles.sort}>
      <label className={styles.sortLabel} htmlFor={id}>
        Sort
      </label>
      <Select
        id={id}
        size="lg"
        aria-label="Sort"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </Select>
    </span>
  );
}

/** "6 of 312" and "Show 50 more" (or "Show all" when the rest fits in a page). */
export function ListFooter({
  shown,
  total,
  onMore,
}: {
  shown: number;
  total: number;
  onMore: () => void;
}) {
  if (total === 0) return null;
  const remaining = total - shown;
  return (
    <div className={styles.footer}>
      <p className={styles.footerCount}>
        {shown} of {total}
      </p>
      {remaining > 0 ? (
        <Button size="lg" onClick={onMore}>
          {remaining <= PAGE_SIZE ? 'Show all' : `Show ${PAGE_SIZE} more`}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A list that couldn't load (the 2s/2t failure pattern): a danger Notice that
 * says what didn't happen, why, and that nothing is at risk, with Try again
 * and Run Setup check; faded placeholder rows behind it.
 */
export function ListFailure({
  title,
  safeLine,
  error,
  onRetry,
  roundArt = false,
}: {
  title: string;
  /** "Your list is safe." */
  safeLine: string;
  error: unknown;
  onRetry: () => void;
  roundArt?: boolean;
}) {
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);
  return (
    <>
      <Notice
        tone="danger"
        role="alert"
        title={title}
        actions={
          <>
            <Button
              size="lg"
              disabled={retrying}
              focusableWhenDisabled
              onClick={() => {
                setRetrying(true);
                void Promise.resolve(onRetry()).finally(() => setRetrying(false));
              }}
            >
              Try again
            </Button>
            <Button size="lg" onClick={() => void navigate({ to: '/setup-check' })}>
              Run Setup check
            </Button>
          </>
        }
      >
        {whyItFailed(error)} {safeLine}
        <span className={styles.subtitleMore}>
          {' '}
          This is a display problem. If it keeps happening, the Setup check can tell you why.
        </span>
      </Notice>
      <SkeletonList rows={2} faded roundArt={roundArt} />
    </>
  );
}

/** Album art or an avatar, with the 8% placeholder when there's none (or it
 *  fails); a label's placeholder carries its initials. */
export function RowArt({
  src,
  round = false,
  initials = '',
  icon,
}: {
  src: string;
  round?: boolean;
  initials?: string;
  /** Drawn in the placeholder: a podcast's microphone. */
  icon?: 'microphone';
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className={styles.art} data-round={round ? 'true' : undefined} aria-hidden="true">
        {icon === 'microphone' ? (
          <svg
            className={styles.artIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
          </svg>
        ) : initials ? (
          <span className={styles.artInitials}>{initials}</span>
        ) : null}
      </span>
    );
  }
  return (
    <img
      className={styles.art}
      data-round={round ? 'true' : undefined}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** A back link to the main list of a tab, above a secondary view. */
export function SubHead({
  backLabel,
  onBack,
  title,
  note,
}: {
  backLabel: string;
  onBack: () => void;
  title: string;
  note?: ReactNode;
}) {
  return (
    <div className={styles.subHead}>
      <Button size="lg" variant="ghost" onClick={onBack}>
        ← {backLabel}
      </Button>
      <h2 className={styles.subTitle}>{title}</h2>
      {note ? <p className={styles.subNote}>{note}</p> : null}
    </div>
  );
}
