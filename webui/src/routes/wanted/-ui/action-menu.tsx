import { Menu } from '@base-ui/react/menu';

import styles from './wanted-page.module.css';

/** One line of a "…" menu: an action, a separator, or a small group label. */
export type MenuEntry =
  | {
      key: string;
      label: string;
      onSelect: () => void;
      tone?: 'danger';
      disabled?: boolean;
    }
  | { key: string; separator: true }
  | { key: string; group: string };

function MoreIcon({ vertical }: { vertical: boolean }) {
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

/**
 * The 44px "…" button and its menu (Base UI: arrow keys, Escape, focus goes
 * back to the button). `bare` is the phone row's borderless "⋮".
 */
export function ActionMenu({
  label,
  entries,
  variant = 'default',
  className,
}: {
  /** The button's accessible name: "More actions for Lantern". */
  label: string;
  entries: MenuEntry[];
  variant?: 'default' | 'bare';
  className?: string;
}) {
  return (
    // not modal: a modal menu locks scrolling, and the app's scroll lock
    // jumped the page back to the top every time a row's menu opened
    <Menu.Root modal={false}>
      <Menu.Trigger
        className={[styles.iconButton, className].filter(Boolean).join(' ')}
        data-variant={variant === 'bare' ? 'bare' : undefined}
        aria-label={label}
      >
        <MoreIcon vertical={variant === 'bare'} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={styles.menuPositioner} align="end" sideOffset={6}>
          <Menu.Popup className={styles.menu}>
            {entries.map((entry) => {
              if ('separator' in entry) {
                return <Menu.Separator key={entry.key} className={styles.menuSeparator} />;
              }
              if ('group' in entry) {
                return (
                  <div key={entry.key} className={styles.menuGroupLabel} aria-hidden="true">
                    {entry.group}
                  </div>
                );
              }
              return (
                <Menu.Item
                  key={entry.key}
                  className={styles.menuItem}
                  data-tone={entry.tone}
                  disabled={entry.disabled}
                  onClick={entry.onSelect}
                >
                  {entry.label}
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
