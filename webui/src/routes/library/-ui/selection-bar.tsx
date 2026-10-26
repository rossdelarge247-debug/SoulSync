import { Button } from '@/components/form';

import styles from './library.module.css';
import { MoreMenu, type MenuEntry } from './parts';

/**
 * The selection bar (7c): at the foot of the content column, above the
 * player (above the tab bar on a phone). The count and track total, "Select
 * all N missing" for the current Show filter, the primary named with the
 * number (disabled-neutral at zero, with its reason), "…" and Done.
 */
export function SelectionBar({
  label,
  shortLabel,
  selectAll,
  primaryLabel,
  idleLabel = 'Add to Wanted',
  emptyReason,
  count,
  onPrimary,
  menu,
  onDone,
  barLabel,
  primaryVariant = 'primary',
  secondary = null,
}: {
  /** "6 albums selected · 49 tracks" */
  label: string;
  /** The phone's "2 albums · 19 tracks". */
  shortLabel: string;
  selectAll?: { label: string; onClick: () => void } | null;
  /** "Add 6 to Wanted" */
  primaryLabel: string;
  idleLabel?: string;
  emptyReason: string;
  count: number;
  /** the primary's own button, for a picker that pops from it (28b) */
  onPrimary: (anchor: HTMLElement | null) => void;
  menu: MenuEntry[];
  onDone: () => void;
  barLabel: string;
  /** 21a draws Tracks' "Export to Traktor…" as a secondary */
  primaryVariant?: 'primary' | 'secondary';
  /** 28b: Tracks' "Export to Traktor…" beside the primary */
  secondary?: { label: string; onClick: () => void } | null;
}) {
  return (
    <div className={styles.barDock} data-selection-bar="">
      <div className={styles.bar} role="toolbar" aria-label={barLabel}>
        <span className={styles.barCount} aria-live="polite">
          <span className={styles.barCountLong}>{label}</span>
          <span className={styles.barCountShort}>{shortLabel}</span>
        </span>
        {selectAll ? (
          <button
            type="button"
            className={`${styles.linkButton} ${styles.barSelectAll}`}
            onClick={selectAll.onClick}
          >
            {selectAll.label}
          </button>
        ) : null}
        <span className={styles.barSpacer} />
        <span className={styles.barActions}>
          <Button
            size="lg"
            variant={primaryVariant}
            disabled={count === 0}
            disabledReason={count === 0 ? emptyReason : undefined}
            onClick={(event) => onPrimary(event.currentTarget)}
          >
            {count === 0 ? (
              idleLabel
            ) : (
              <>
                <span className={styles.primaryLong}>{primaryLabel}</span>
                <span className={styles.primaryShort}>{idleLabel}</span>
              </>
            )}
          </Button>
          {secondary ? (
            <Button
              size="lg"
              variant="secondary"
              className={styles.barSecondary}
              disabled={count === 0}
              disabledReason={count === 0 ? emptyReason : undefined}
              onClick={secondary.onClick}
            >
              {secondary.label}
            </Button>
          ) : null}
          <MoreMenu label="More actions for the selection" entries={menu} vertical={false} />
          <Button size="lg" variant="ghost" className={styles.barDone} onClick={onDone}>
            Done
          </Button>
        </span>
      </div>
    </div>
  );
}
