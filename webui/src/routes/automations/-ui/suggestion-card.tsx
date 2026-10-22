/**
 * The suggestion card at the top of the Automations list (3a): one at a
 * time, a quiet card with a dashed border, "Suggested by the Assistant", its
 * reason (always with a number), Use this and Not now. Worked out on the
 * server from the library's facts; nothing reaches the model until Use this.
 */

import { Button } from '@/components/form';

import type { ListSuggestion } from '../-automations.assistant';

import styles from './automations.module.css';

export function SuggestionCard({
  suggestion,
  onUse,
  onDismiss,
  busy,
}: {
  suggestion: ListSuggestion;
  onUse: () => void;
  onDismiss: () => void;
  busy?: boolean;
}) {
  return (
    <section
      className={styles.suggestionCard}
      aria-label="Suggested by the Assistant"
      data-testid="suggestion-card"
    >
      <div className={styles.suggestionText}>
        <p className={styles.panelLabel}>Suggested by the Assistant</p>
        <h2 className={styles.suggestionCardTitle}>{suggestion.title}</h2>
        <p className={styles.suggestionReason}>{suggestion.reason}</p>
      </div>
      <div className={styles.suggestionActions}>
        <Button size="lg" onClick={onUse}>
          Use this
        </Button>
        <Button size="lg" variant="ghost" onClick={onDismiss} disabled={busy} focusableWhenDisabled>
          Not now
        </Button>
      </div>
    </section>
  );
}
