import { Menu } from '@base-ui/react/menu';

import styles from './artist-page.module.css';

/** One line of a "…" menu: an action, an on/off option, a separator, a group label. */
export type MenuEntry =
  | {
      key: string;
      label: string;
      onSelect: () => void;
      tone?: 'danger';
      disabled?: boolean;
      /** a quiet second line (Send to…'s "adds as #9") */
      reason?: string;
      /** a submenu (Brief B's Send to…, 32d) */
      submenu?: {
        key: string;
        label: string;
        onSelect: () => void;
        disabled?: boolean;
        reason?: string;
      }[];
    }
  | {
      key: string;
      label: string;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
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

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** Drop separators that would sit first, last or twice in a row. */
function tidyEntries(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if ('separator' in entry && (out.length === 0 || 'separator' in out[out.length - 1])) continue;
    out.push(entry);
  }
  while (out.length && 'separator' in out[out.length - 1]) out.pop();
  return out;
}

/**
 * The 44px "…" button and its menu (Base UI: arrow keys, Escape, focus goes
 * back to the button). `bare` is the quiet "⋮" on a release card.
 */
export function ArtistMenu({
  label,
  entries,
  variant = 'default',
  className,
}: {
  /** The button's accessible name: "More for Pale Harbour". */
  label: string;
  entries: MenuEntry[];
  variant?: 'default' | 'bare';
  className?: string;
}) {
  const shown = tidyEntries(entries);
  if (shown.length === 0) return null;
  return (
    // not modal: a modal menu locks scrolling, and the app's scroll lock
    // jumps the page back to the top every time a menu opens
    <Menu.Root modal={false}>
      <Menu.Trigger
        className={[styles.iconButton, className].filter(Boolean).join(' ')}
        data-variant={variant === 'bare' ? 'bare' : undefined}
        aria-label={label}
      >
        <MoreIcon vertical={variant === 'bare'} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className={styles.menuPositioner}
          align="end"
          sideOffset={6}
          collisionPadding={12}
        >
          <Menu.Popup className={styles.menu}>
            {shown.map((entry) => {
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
              if ('checked' in entry) {
                return (
                  <Menu.CheckboxItem
                    key={entry.key}
                    className={styles.menuItem}
                    checked={entry.checked}
                    disabled={entry.disabled}
                    onCheckedChange={(next) => entry.onCheckedChange(next)}
                  >
                    <span className={styles.menuCheck} aria-hidden="true">
                      <Menu.CheckboxItemIndicator>
                        <CheckIcon />
                      </Menu.CheckboxItemIndicator>
                    </span>
                    {entry.label}
                  </Menu.CheckboxItem>
                );
              }
              if (entry.submenu) {
                return (
                  <Menu.SubmenuRoot key={entry.key}>
                    <Menu.SubmenuTrigger className={styles.menuItem} data-submenu="">
                      {entry.label}
                    </Menu.SubmenuTrigger>
                    <Menu.Portal>
                      <Menu.Positioner
                        className={styles.menuPositioner}
                        align="start"
                        sideOffset={4}
                        collisionPadding={12}
                      >
                        <Menu.Popup className={styles.menu}>
                          {entry.submenu.map((sub) => (
                            <Menu.Item
                              key={sub.key}
                              className={styles.menuItem}
                              disabled={sub.disabled}
                              onClick={sub.onSelect}
                              title={sub.reason}
                            >
                              {sub.label}
                              {sub.reason ? (
                                <span className={styles.menuMeta}> · {sub.reason}</span>
                              ) : null}
                            </Menu.Item>
                          ))}
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.SubmenuRoot>
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
