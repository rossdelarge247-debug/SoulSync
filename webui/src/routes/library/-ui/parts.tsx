import { Menu } from '@base-ui/react/menu';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Select } from '@/components/form';

import type { GenreCount } from '../-library.types';

import styles from './library.module.css';

/** The 13/600 count on a tab, a Show button or a chip. */
export function CountBadge({ count }: { count: number | undefined }) {
  if (count === undefined) return null;
  return <span className={styles.badge}>{count.toLocaleString()}</span>;
}

export function ChevronDown({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function MoreIcon({ vertical = false }: { vertical?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {vertical ? (
        <>
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </>
      ) : (
        <>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </>
      )}
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5v14l12-7z" />
    </svg>
  );
}

export function CheckMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export interface ShowOption<T extends string> {
  key: T;
  label: string;
  count?: number;
}

/** The Show OptionButtons: one pressed. */
export function ShowButtons<T extends string>({
  options,
  value,
  onChange,
  label = 'Show',
  id,
}: {
  options: ShowOption<T>[];
  value: T;
  onChange: (next: T) => void;
  label?: string;
  /** An anchor for the guided tour (helper.js), when the page has one. */
  id?: string;
}) {
  return (
    <div className={styles.group} id={id} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={styles.chip}
          aria-pressed={option.key === value}
          onClick={() => onChange(option.key)}
        >
          {option.label}
          <CountBadge count={option.count} />
        </button>
      ))}
    </div>
  );
}

export function SortSelect<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <span className={[styles.sort, className].filter(Boolean).join(' ')}>
      <label htmlFor={id}>Sort</label>
      <Select
        id={id}
        size="lg"
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

function FunnelIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 3H2l8 9.5V19l4 2v-8.5z" />
    </svg>
  );
}

/**
 * The 320px filter field. Typing a genre's name offers "Genre: Ambient" first
 * (Enter or a click picks the genre and clears the text); otherwise the text
 * filters titles, artists and genres after a short pause.
 */
export function FilterField({
  value,
  onChange,
  placeholder,
  phonePlaceholder,
  label,
  genres,
  onPickGenre,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  /** The guided tour anchors to the library's field (helper.js). */
  id?: string;
  placeholder: string;
  phonePlaceholder?: string;
  label: string;
  genres?: GenreCount[];
  onPickGenre?: (genre: GenreCount) => void;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const [open, setOpen] = useState(false);
  const listId = useId();
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = draft;
      onChange(draft);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, onChange]);

  const needle = draft.trim().toLowerCase();
  const matches =
    needle && genres && onPickGenre
      ? genres.filter((g) => g.name.toLowerCase().includes(needle)).slice(0, 3)
      : [];
  const showSuggest = open && matches.length > 0;

  const pickGenre = (genre: GenreCount) => {
    committed.current = '';
    setDraft('');
    setOpen(false);
    onPickGenre?.(genre);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && showSuggest) {
      event.preventDefault();
      pickGenre(matches[0]);
    } else if (event.key === 'Escape' && draft) {
      // Escape clears the field first; a second Escape reaches the page
      event.stopPropagation();
      committed.current = '';
      setDraft('');
      onChange('');
    }
  };

  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches;
  return (
    <div className={styles.filterWrap}>
      <label className={styles.filter}>
        <FunnelIcon />
        <input
          id={id}
          type="text"
          value={draft}
          placeholder={narrow && phonePlaceholder ? phonePlaceholder : placeholder}
          aria-label={label}
          aria-controls={showSuggest ? listId : undefined}
          aria-expanded={matches.length > 0 ? showSuggest : undefined}
          aria-autocomplete={genres ? 'list' : undefined}
          role={genres ? 'combobox' : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        {draft ? (
          <button
            type="button"
            className={styles.clearFilter}
            aria-label="Clear the filter"
            onClick={() => {
              committed.current = '';
              setDraft('');
              onChange('');
            }}
          >
            ×
          </button>
        ) : null}
      </label>
      {showSuggest ? (
        <div className={styles.suggest} id={listId} role="listbox" aria-label="Genres">
          {matches.map((genre, index) => (
            <button
              key={genre.key}
              type="button"
              role="option"
              aria-selected={index === 0}
              data-active={index === 0 ? 'true' : undefined}
              className={styles.suggestItem}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickGenre(genre)}
            >
              Genre: {genre.name}
              <span>{genre.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The genre row: "All" with the grid's total, the top six genres by count
 * (as 7a draws it, one row at 1440), then "N more ▾" holding the rest. A
 * picked genre that isn't in the top six takes the last place, so the pressed
 * chip is always on show.
 */
export function GenreChips({
  genres,
  value,
  total,
  onChange,
  top = 6,
}: {
  genres: GenreCount[];
  value: string;
  total: number;
  onChange: (key: string) => void;
  top?: number;
}) {
  let shown = genres.slice(0, top);
  const picked = value ? genres.find((g) => g.key === value) : undefined;
  if (value && !shown.some((g) => g.key === value)) {
    shown = [...shown.slice(0, top - 1), picked ?? { key: value, name: value, count: 0 }];
  }
  const rest = genres.filter((g) => !shown.some((s) => s.key === g.key));
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // on a phone the row scrolls sideways: bring the pressed chip into view
    const el = row.current;
    const chip = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !chip || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, chip.offsetLeft - el.offsetLeft - 12);
  }, [value]);
  return (
    <div className={styles.genreRow} role="group" aria-label="Genre" ref={row}>
      <span className={styles.rowLabel}>Genre</span>
      <button
        type="button"
        className={styles.chip}
        aria-pressed={!value}
        onClick={() => onChange('')}
      >
        All
        <CountBadge count={total} />
      </button>
      {shown.map((genre) => (
        <button
          key={genre.key}
          type="button"
          className={styles.chip}
          aria-pressed={genre.key === value}
          onClick={() => onChange(genre.key === value ? '' : genre.key)}
        >
          {genre.name}
          <CountBadge count={genre.count} />
        </button>
      ))}
      {rest.length ? (
        <Menu.Root modal={false}>
          <Menu.Trigger className={`${styles.chip} ${styles.more}`}>
            {rest.length} more
            <ChevronDown />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className={styles.menuPositioner} align="end" sideOffset={6}>
              <Menu.Popup className={styles.menu}>
                {rest.map((genre) => (
                  <Menu.Item
                    key={genre.key}
                    className={styles.menuItem}
                    onClick={() => onChange(genre.key)}
                  >
                    {genre.name}
                    <span className={styles.menuMeta}>{genre.count.toLocaleString()}</span>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : null}
    </div>
  );
}

export type MenuEntry =
  | {
      key: string;
      label: string;
      onSelect: () => void;
      tone?: 'danger';
      disabled?: boolean;
      /** Why it's disabled (172, 23a): a 13px second line under the label,
       *  and the item's description for a screen reader. */
      reason?: string;
    }
  | { key: string; separator: true };

/** A 44px "…" and its menu (Base UI: arrows, Escape, focus back to the button). */
export function MoreMenu({
  label,
  entries,
  className,
  vertical = false,
}: {
  label: string;
  entries: MenuEntry[];
  className?: string;
  vertical?: boolean;
}) {
  const reasonId = useId();
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        className={[styles.iconButton, className].filter(Boolean).join(' ')}
        aria-label={label}
      >
        <MoreIcon vertical={vertical} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={styles.menuPositioner} align="end" sideOffset={6}>
          <Menu.Popup className={styles.menu}>
            {entries.map((entry) =>
              'separator' in entry ? (
                <Menu.Separator key={entry.key} className={styles.menuSeparator} />
              ) : (
                <Menu.Item
                  key={entry.key}
                  className={styles.menuItem}
                  data-tone={entry.tone}
                  data-two-line={entry.reason ? '' : undefined}
                  // Base UI keeps a disabled item focusable, with aria-disabled
                  disabled={entry.disabled}
                  aria-label={entry.reason ? entry.label : undefined}
                  aria-describedby={entry.reason ? `${reasonId}-${entry.key}` : undefined}
                  onClick={entry.onSelect}
                >
                  {entry.reason ? (
                    <>
                      <span>{entry.label}</span>
                      <span id={`${reasonId}-${entry.key}`} className={styles.menuReason}>
                        {entry.reason}
                      </span>
                    </>
                  ) : (
                    entry.label
                  )}
                </Menu.Item>
              ),
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The tabs of the Albums page (7a, 7e): links in the URL, arrow keys move. */
export function PageTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  const ids = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = tabs.findIndex((t) => t.key === value);
    const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault();
    onChange(next.key);
    requestAnimationFrame(() => ids.current[next.key]?.focus());
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          ref={(el) => {
            ids.current[tab.key] = el;
          }}
          type="button"
          role="tab"
          className={styles.chip}
          aria-selected={tab.key === value}
          tabIndex={tab.key === value ? 0 : -1}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          <CountBadge count={tab.count} />
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.stat}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
