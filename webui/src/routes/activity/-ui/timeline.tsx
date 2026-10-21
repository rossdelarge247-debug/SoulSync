import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { Spinner, StatusTag } from '@/components/primitives';
import { copyText } from '@/routes/setup-check/-setup-check.clipboard';

import type { DayGroup } from '../-activity.helpers';
import type { ActivityItem } from '../-activity.types';

import { activityLogQueryOptions, invalidateActivity, postRetry } from '../-activity.api';
import {
  detailWithRetry,
  formatDateTime,
  formatTime,
  isoTime,
  logOpenLabel,
  logText,
  rowAction,
  statusTag,
  type RetryAction,
} from '../-activity.helpers';
import styles from './activity-page.module.css';
import { AppLink } from './app-link';

function errorText(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : '';
  return message.replace(/[.\s]+$/, '') || 'That didn’t go through';
}

/** The day groups. Expanded logs survive a refresh because they're keyed by id. */
export function Timeline({
  groups,
  expanded,
  onToggleLog,
}: {
  groups: DayGroup[];
  expanded: ReadonlySet<string>;
  onToggleLog: (id: string) => void;
}) {
  return (
    <>
      {groups.map((group) => (
        <DayGroupSection
          key={group.key}
          group={group}
          expanded={expanded}
          onToggleLog={onToggleLog}
        />
      ))}
    </>
  );
}

function DayGroupSection({
  group,
  expanded,
  onToggleLog,
}: {
  group: DayGroup;
  expanded: ReadonlySet<string>;
  onToggleLog: (id: string) => void;
}) {
  const headingId = useId();
  const { lead, date } = group.label;
  return (
    <>
      <h2 className={styles.dayLabel} id={headingId}>
        {lead ? (
          <>
            {lead}
            <span className={styles.dayDate}> · {date}</span>
          </>
        ) : (
          date
        )}
      </h2>
      <ul className={styles.list} aria-labelledby={headingId} data-testid="activity-day">
        {group.items.map((item) => (
          <TimelineRow
            key={item.id}
            item={item}
            logOpen={expanded.has(item.id)}
            onToggleLog={() => onToggleLog(item.id)}
          />
        ))}
      </ul>
    </>
  );
}

function TimelineRow({
  item,
  logOpen,
  onToggleLog,
}: {
  item: ActivityItem;
  logOpen: boolean;
  onToggleLog: () => void;
}) {
  const tag = statusTag(item);
  const action = rowAction(item);
  const logId = useId();
  return (
    <li className={styles.item} data-testid="activity-row" data-id={item.id}>
      <div className={styles.row}>
        <time
          className={styles.time}
          dateTime={isoTime(item.time)}
          title={formatDateTime(item.time)}
        >
          {formatTime(item.time)}
        </time>
        <StatusTag className={styles.tag} tone={tag.tone} live={tag.live}>
          {tag.label}
        </StatusTag>
        <div className={styles.text}>
          <span className={styles.itemTitle}>{item.title}</span>
          {item.detail || item.retry_at ? (
            <span className={styles.detail}>{detailWithRetry(item)}</span>
          ) : null}
        </div>
        <div className={styles.action}>
          {action?.type === 'log' ? (
            <button
              type="button"
              className={styles.actionLink}
              aria-expanded={logOpen}
              aria-controls={logOpen ? logId : undefined}
              onClick={onToggleLog}
            >
              {logOpen ? 'Hide log' : 'Show log'}
            </button>
          ) : action?.type === 'retry' ? (
            <RetryButton retry={action.retry} title={item.title} />
          ) : action?.type === 'open' ? (
            <AppLink to={action.href} className={styles.actionLink}>
              Open
            </AppLink>
          ) : null}
        </div>
      </div>
      {logOpen ? <LogPanel id={logId} item={item} /> : null}
    </li>
  );
}

function RetryButton({ retry, title }: { retry: RetryAction; title: string }) {
  const queryClient = useQueryClient();
  const [done, setDone] = useState(false);
  const mutation = useMutation({
    mutationFn: () => postRetry(retry.path),
    onSuccess: () => {
      setDone(true);
      void invalidateActivity(queryClient);
    },
    onError: (error) => {
      window.showToast?.(`Couldn’t retry: ${errorText(error)}.`, 'error');
    },
  });
  if (done) {
    return (
      <span className={styles.actionNote} role="status">
        Retry started
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.actionLink}
      aria-disabled={mutation.isPending || undefined}
      aria-label={mutation.isPending ? undefined : `${retry.label}: ${title}`}
      onClick={() => {
        if (!mutation.isPending) mutation.mutate();
      }}
    >
      {mutation.isPending ? 'Retrying…' : retry.label}
    </button>
  );
}

function LogPanel({ id, item }: { id: string; item: ActivityItem }) {
  const query = useQuery(activityLogQueryOptions(item.id, true));
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const lines = query.data ?? [];
  const text = logText(lines);

  const copy = async () => {
    const ok = await copyText(text);
    setCopied(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied('idle'), 2000);
  };

  return (
    <div className={styles.log} id={id} data-testid="activity-log">
      {query.isPending ? (
        <p className={styles.logStatus} role="status">
          <Spinner size={16} />
          Loading the log…
        </p>
      ) : query.isError ? (
        <p className={styles.logStatus} data-tone="danger" role="alert">
          Couldn’t load the log: {errorText(query.error)}.{' '}
          <button type="button" className={styles.actionLink} onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : lines.length === 0 ? (
        <p className={styles.logStatus}>This run didn’t write a log.</p>
      ) : (
        <pre className={styles.pre}>{text}</pre>
      )}
      <p className={styles.logLinks}>
        {item.link ? (
          <AppLink to={item.link} className={styles.actionLink}>
            {logOpenLabel(item)}
          </AppLink>
        ) : null}
        {item.link && lines.length > 0 ? <span aria-hidden="true">·</span> : null}
        {lines.length > 0 ? (
          <button type="button" className={styles.actionLink} onClick={() => void copy()}>
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : 'Copy log'}
          </button>
        ) : null}
      </p>
    </div>
  );
}
