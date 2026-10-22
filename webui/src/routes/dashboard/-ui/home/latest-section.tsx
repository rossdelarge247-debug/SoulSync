/**
 * Latest: the three newest things SoulSync did (GET /api/activity), each with
 * its time, a status word and one sentence, then "See all activity".
 */

import type { UseQueryResult } from '@tanstack/react-query';

import { Button } from '@/components/form';
import { Notice, Skeleton, StatusTag } from '@/components/primitives';

import type { LatestItem } from '../../-home.api';

import { latestAction, latestTag, splitDetail } from '../../-home.latest';
import { resolveHref } from '../../-home.routes';
import { fullDateTime, latestTimeLabel } from '../../-home.time';
import { HomeLink, HrefLink, useLinkAllowed } from './home-nav';
import styles from './home.module.css';

const HEADING_ID = 'home-latest-title';

function Detail({ item }: { item: LatestItem }) {
  const action = latestAction(item);
  const allowed = useLinkAllowed(resolveHref(action?.href ?? '/'));
  if (!item.detail && !action) return null;
  if (!action || !allowed) return <span className={styles.latestDetail}>{item.detail}</span>;
  const { before, after, inline } = splitDetail(item.detail, action.label);
  const link = (
    <HrefLink href={action.href} className={styles.link}>
      {action.label}
    </HrefLink>
  );
  return (
    <span className={styles.latestDetail}>
      {inline ? (
        <>
          {before}
          {link}
          {after}
        </>
      ) : (
        <>
          {item.detail ? `${item.detail} ` : null}
          {link}
        </>
      )}
    </span>
  );
}

function Row({ item, nowMs }: { item: LatestItem; nowMs: number }) {
  const tag = latestTag(item);
  const at = item.time * 1000;
  return (
    <li className={styles.latestRow} data-testid="home-latest-row">
      <time
        className={styles.latestTime}
        dateTime={at ? new Date(at).toISOString() : undefined}
        title={at ? fullDateTime(at) : undefined}
      >
        {at ? latestTimeLabel(item.time, nowMs) : ''}
      </time>
      <StatusTag className={styles.latestTag} tone={tag.tone} live={tag.live}>
        {tag.word}
      </StatusTag>
      <div className={styles.latestText}>
        <span className={styles.latestTitle}>{item.title}</span>
        <Detail item={item} />
      </div>
    </li>
  );
}

function RowSkeletons() {
  return (
    <div className={styles.listCard} aria-hidden="true" data-testid="home-latest-loading">
      {[220, 280, 180].map((width) => (
        <div className={styles.latestRow} key={width}>
          <Skeleton className={styles.skeletonTime} />
          <Skeleton className={styles.skeletonTag} />
          <span className={styles.latestText}>
            <Skeleton className={styles.skeletonLine} style={{ width }} />
            <Skeleton className={styles.skeletonLineShort} style={{ width: width - 60 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function LatestSection({
  query,
  nowMs,
}: {
  query: UseQueryResult<LatestItem[]>;
  nowMs: number;
}) {
  let body;
  if (query.isPending) {
    body = <RowSkeletons />;
  } else if (query.isError && !query.data) {
    body = (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn’t load the latest activity"
        actions={
          <Button
            size="lg"
            onClick={() => {
              void query.refetch();
            }}
          >
            {query.isFetching ? 'Trying…' : 'Try again'}
          </Button>
        }
      >
        SoulSync didn’t answer. Nothing is lost; this is a display problem.
      </Notice>
    );
  } else if (query.data.length === 0) {
    body = (
      <div className={styles.emptyCard} data-testid="home-latest-empty">
        <h3 className={styles.cardTitle}>Nothing yet</h3>
        <p className={styles.cardText}>
          Downloads, imports and automation runs show here as they happen.
        </p>
      </div>
    );
  } else {
    body = (
      <ol className={styles.listCard}>
        {query.data.map((item) => (
          <Row key={item.id} item={item} nowMs={nowMs} />
        ))}
      </ol>
    );
  }

  return (
    <section className={styles.section} aria-labelledby={HEADING_ID} data-tour="home-latest">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id={HEADING_ID}>
          Latest
        </h2>
        <HomeLink route="activity" className={styles.sectionLink}>
          <span className={styles.wideOnly}>See all activity</span>
          <span className={styles.phoneOnly}>See all</span>
        </HomeLink>
      </div>
      {body}
    </section>
  );
}
