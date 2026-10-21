import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { Button } from '@/components/form';

import type { ActivityItem } from '../-activity.types';

import { dismissActivityItem, invalidateActivity, removeFromCache } from '../-activity.api';
import {
  detailWithRetry,
  formatDateTime,
  formatPinnedWhen,
  isoTime,
  pinnedActions,
} from '../-activity.helpers';
import styles from './activity-page.module.css';
import { toolNavigated } from './app-link';
import { LinkButton } from './link-button';

/**
 * Pinned above the timeline whatever the range, until it's dealt with: an
 * expired preview (Preview again, Dismiss), an import folder waiting on a
 * choice (Choose), and anything else that needs a step (Open).
 */
export function NeedsYou({ items, total }: { items: ActivityItem[]; total: number }) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId} data-testid="needs-you">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id={headingId}>
          Needs you
        </h2>
        <p className={styles.sectionNote}>
          {total > items.length
            ? `The newest ${items.length} of ${total}. They stay here until dealt with, whatever the range.`
            : 'Stays here until dealt with, whatever the range.'}
        </p>
      </div>
      <ul className={styles.needsCard}>
        {items.map((item) => (
          <NeedsYouRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function NeedsYouRow({ item }: { item: ActivityItem }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const dismiss = useMutation({
    mutationFn: () => dismissActivityItem(item.id),
    onMutate: () => setError(null),
    onSuccess: () => {
      removeFromCache(queryClient, item.id);
      void invalidateActivity(queryClient);
    },
    onError: (failure) => {
      const message = failure instanceof Error && failure.message ? failure.message : '';
      setError(
        `Couldn’t dismiss it${message ? `: ${message.replace(/[.\s]+$/, '')}` : ''}. Try again in a moment.`,
      );
    },
  });

  return (
    <li className={styles.needsRow} data-testid="needs-you-row" data-id={item.id}>
      <time className={styles.time} dateTime={isoTime(item.time)} title={formatDateTime(item.time)}>
        {formatPinnedWhen(item.time)}
      </time>
      <div className={styles.text}>
        <span className={styles.itemTitle}>{item.title}</span>
        {item.detail ? <span className={styles.detail}>{detailWithRetry(item)}</span> : null}
      </div>
      <div className={styles.needsActions}>
        {pinnedActions(item).map((action) => {
          if (action.type === 'dismiss') {
            return (
              <Button
                key="dismiss"
                size="lg"
                variant="ghost"
                aria-label={`Dismiss: ${item.title}`}
                disabled={dismiss.isPending}
                focusableWhenDisabled
                onClick={() => dismiss.mutate()}
              >
                {dismiss.isPending ? 'Dismissing…' : action.label}
              </Button>
            );
          }
          return (
            <LinkButton
              key={action.label}
              to={action.type === 'preview-again' ? action.destination.href : action.href}
              onNavigated={
                action.type === 'preview-again' ? toolNavigated(action.destination) : undefined
              }
            >
              {action.label}
            </LinkButton>
          );
        })}
      </div>
      {error ? (
        <p className={styles.needsError} role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
