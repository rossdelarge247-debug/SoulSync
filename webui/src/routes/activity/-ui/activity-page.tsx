import { useInfiniteQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, OptionButton } from '@/components/form';
import { EmptyState, LoadingState, Notice, Skeleton } from '@/components/primitives';
import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import type { ActivityRange, ActivityResponse, ActivityShow } from '../-activity.types';

import { activityQueryOptions } from '../-activity.api';
import {
  RANGE_OPTIONS,
  SHOW_OPTIONS,
  emptyCopy,
  endNote,
  failureSentence,
  flattenPages,
  groupByDay,
  loadingLabel,
  pinnedFor,
  readRememberedRange,
  rememberRange,
  runningLabel,
  widerRange,
} from '../-activity.helpers';
import styles from './activity-page.module.css';
import { LinkButton } from './link-button';
import { NeedsYou } from './needs-you';
import { Timeline } from './timeline';
import { TimelineSkeleton } from './timeline-skeleton';

const routeApi = getRouteApi('/activity');

export function ActivityPage() {
  useReactPageShell('activity');
  const { isAdmin } = useProfile();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const show: ActivityShow = search.show ?? 'all';
  const range: ActivityRange = search.range ?? readRememberedRange();

  const query = useInfiniteQuery(activityQueryOptions(show, range));
  const pages = query.data?.pages;
  const first: ActivityResponse | undefined = pages?.[0];

  // The Needs you count stays put while another filter or range loads, so
  // the badge doesn't flicker back to a placeholder on every click.
  const [lastCount, setLastCount] = useState<number | null>(null);
  const firstCount = first?.counts.needs_you;
  useEffect(() => {
    if (firstCount != null) setLastCount(firstCount);
  }, [firstCount]);
  const needsCount = firstCount ?? lastCount;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleLog = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setShow = (value: ActivityShow) => {
    void navigate({ search: (prev) => ({ ...prev, show: value === 'all' ? undefined : value }) });
  };
  const setRange = (value: ActivityRange) => {
    rememberRange(value);
    void navigate({ search: (prev) => ({ ...prev, range: value }) });
  };

  const items = useMemo(() => (pages ? flattenPages(pages) : []), [pages]);
  const groups = useMemo(() => groupByDay(items), [items]);
  const pinned = first ? pinnedFor(first.needs_you, show) : [];
  const running = first?.running_count ?? 0;

  return (
    <div className={styles.page} data-testid="activity-page">
      <header className={styles.header}>
        <div className={styles.headText}>
          <h1 className={styles.title}>Activity</h1>
          <p className={styles.subtitle}>
            <span className={styles.subtitleLong}>
              Downloads, imports, playlist mirrors, automation runs, and anything that needs you.
              One timeline.
            </span>
            <span className={styles.subtitleShort}>
              Downloads, imports, mirrors, runs, and anything that needs you.
            </span>
          </p>
        </div>
        {running > 0 ? (
          <span className={styles.running} data-testid="activity-running">
            <span className={styles.runningDot} aria-hidden="true" />
            {runningLabel(running)}
          </span>
        ) : null}
      </header>

      <div className={styles.controls}>
        <div className={styles.filters} role="group" aria-label="Show">
          {SHOW_OPTIONS.map((option) => (
            <OptionButton
              key={option.value}
              selected={show === option.value}
              onClick={() => setShow(option.value)}
            >
              {option.label}
              {option.value === 'needs-you' && !(needsCount == null && query.isError) ? (
                <NeedsCount count={needsCount} />
              ) : null}
            </OptionButton>
          ))}
        </div>
        <div className={styles.ranges} role="group" aria-label="Range">
          {RANGE_OPTIONS.map((option) => (
            <OptionButton
              key={option.value}
              selected={range === option.value}
              onClick={() => setRange(option.value)}
            >
              {option.label}
            </OptionButton>
          ))}
        </div>
      </div>

      {query.isPending ? (
        <LoadingState label={loadingLabel(show, range)}>
          <TimelineSkeleton />
        </LoadingState>
      ) : query.isError && !first ? (
        <>
          <Notice
            tone="danger"
            role="alert"
            title="Couldn’t load activity"
            actions={
              <>
                <Button size="lg" onClick={() => void query.refetch()}>
                  Try again
                </Button>
                {isAdmin ? (
                  <LinkButton to="/setup-check" variant="ghost">
                    Run Setup check
                  </LinkButton>
                ) : null}
              </>
            }
          >
            {failureSentence(query.error)}
          </Notice>
          <TimelineSkeleton faded />
        </>
      ) : first ? (
        <>
          {pinned.length > 0 ? (
            <NeedsYou
              items={pinned}
              total={
                show === 'needs-you' || show === 'all' ? first.counts.needs_you : pinned.length
              }
            />
          ) : null}
          {show === 'needs-you' ? (
            pinned.length === 0 ? (
              <EmptyPanel show={show} range={range} onRange={setRange} onShow={setShow} />
            ) : null
          ) : items.length === 0 ? (
            <EmptyPanel show={show} range={range} onRange={setRange} onShow={setShow} />
          ) : (
            <section className={styles.section} aria-label="Timeline" data-testid="timeline">
              <Timeline groups={groups} expanded={expanded} onToggleLog={toggleLog} />
              <Paging
                hasMore={Boolean(query.hasNextPage)}
                loading={query.isFetchingNextPage}
                failed={query.isFetchNextPageError}
                range={range}
                onMore={() => void query.fetchNextPage()}
              />
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}

function NeedsCount({ count }: { count: number | null }) {
  if (count == null) {
    return <Skeleton className={styles.countLoading} />;
  }
  return (
    <span
      className={styles.count}
      data-tone={count > 0 ? 'warning' : undefined}
      aria-label={`${count} need${count === 1 ? 's' : ''} you`}
    >
      {count}
    </span>
  );
}

function EmptyPanel({
  show,
  range,
  onRange,
  onShow,
}: {
  show: ActivityShow;
  range: ActivityRange;
  onRange: (range: ActivityRange) => void;
  onShow: (show: ActivityShow) => void;
}) {
  const copy = emptyCopy(show, range);
  const wider = show === 'needs-you' ? null : widerRange(range);
  const widerLabel = RANGE_OPTIONS.find((option) => option.value === wider)?.label;
  return (
    <EmptyState
      variant="panel"
      title={copy.title}
      description={copy.description}
      hint={copy.hint}
      data-testid="activity-empty"
      actions={
        <>
          {wider && widerLabel ? (
            <Button size="lg" onClick={() => onRange(wider)}>
              Show {widerLabel}
            </Button>
          ) : null}
          {show === 'needs-you' ? (
            <Button size="lg" onClick={() => onShow('all')}>
              Show all activity
            </Button>
          ) : null}
          {copy.link ? <LinkButton to={copy.link.href}>{copy.link.label}</LinkButton> : null}
        </>
      }
    />
  );
}

function Paging({
  hasMore,
  loading,
  failed,
  range,
  onMore,
}: {
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  range: ActivityRange;
  onMore: () => void;
}) {
  if (failed) {
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn’t load earlier days"
        actions={
          <Button size="lg" onClick={onMore}>
            Try again
          </Button>
        }
      >
        SoulSync didn’t answer. What’s above is still current.
      </Notice>
    );
  }
  if (!hasMore) {
    return (
      <div className={styles.more}>
        <p className={styles.endNote}>{endNote(range)}</p>
      </div>
    );
  }
  return (
    <div className={styles.more}>
      <Button
        size="lg"
        disabled={loading}
        focusableWhenDisabled
        aria-busy={loading || undefined}
        onClick={onMore}
      >
        {loading ? 'Loading earlier days…' : 'Show earlier days'}
      </Button>
    </div>
  );
}
