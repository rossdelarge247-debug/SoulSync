/**
 * One Home target card, in one of its states:
 *
 * - live: label, title, status tag (always a word), the have-of-items bar,
 *   three numbers, and a footer with the next search and one link;
 * - can't search (the failure variant, board 2s): the same card keeping its
 *   numbers, a danger "Can't search" tag, "—" for what isn't known, and a
 *   footer sentence saying why with "Run Setup check · Try now";
 * - not set up: a quieter card with one sentence and one button.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';

import { StatusTag } from '@/components/primitives';

import type { LiveCardView, NotSetUpCardView, StatView, TargetCardView } from '../../-home.targets';

import { checkDownloadSource, HOME_QUERY_KEY } from '../../-home.api';
import { formatCount } from '../../-home.time';
import { HomeLink, useHomeNav } from './home-nav';
import styles from './home.module.css';

function Stat({ stat }: { stat: StatView }) {
  return (
    <div className={styles.stat}>
      <dt className={styles.statLabel}>
        {stat.shortLabel ? (
          <>
            <span className={styles.wideOnly}>{stat.label}</span>
            <span className={styles.phoneOnly}>{stat.shortLabel}</span>
          </>
        ) : (
          stat.label
        )}
      </dt>
      {stat.value == null ? (
        <dd className={styles.statValue} data-unknown="true">
          <span aria-hidden="true">—</span>
          <span className={styles.srOnly}>Not known while searches can’t run</span>
        </dd>
      ) : (
        <dd className={styles.statValue}>{formatCount(stat.value)}</dd>
      )}
    </div>
  );
}

function TryNow() {
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: checkDownloadSource,
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...HOME_QUERY_KEY, 'targets'] }),
  });
  const failed = check.isError || (check.data && !check.data.ok);
  return (
    <>
      <button
        type="button"
        className={styles.linkButton}
        aria-busy={check.isPending || undefined}
        onClick={() => {
          if (!check.isPending) check.mutate();
        }}
      >
        {check.isPending ? 'Checking…' : 'Try now'}
      </button>
      {failed ? (
        <span className={styles.problemResult} role="status">
          Checked just now and it still didn’t answer
          {check.data?.message ? `: ${check.data.message.replace(/[.\s]+$/, '')}.` : '.'}
        </span>
      ) : null}
    </>
  );
}

function LiveCard({ view }: { view: LiveCardView }) {
  const titleId = useId();
  const labelId = useId();
  const { isAdmin } = useHomeNav();
  return (
    <article
      className={styles.card}
      data-testid="home-target"
      data-target={view.key}
      data-state={view.problem ? 'cant-search' : 'live'}
      aria-labelledby={`${labelId} ${titleId}`}
    >
      <div className={styles.cardHead}>
        <div className={styles.cardHeading}>
          <p className={styles.cardLabel} id={labelId}>
            {view.label}
          </p>
          <h3 className={styles.cardTitle} id={titleId}>
            {view.title}
          </h3>
        </div>
        <StatusTag className={styles.cardTag} tone={view.tag.tone} live={view.tag.live}>
          {view.tag.word}
        </StatusTag>
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label={`${view.label}: how much you have`}
        aria-valuemin={0}
        aria-valuemax={Math.max(view.items, 1)}
        aria-valuenow={view.have}
        aria-valuetext={`${formatCount(view.have)} of ${formatCount(view.items)} tracks`}
      >
        <span className={styles.barFill} style={{ width: `${view.percent}%` }} />
      </div>
      <dl className={styles.stats}>
        {view.stats.map((stat) => (
          <Stat key={stat.label} stat={stat} />
        ))}
      </dl>
      {view.problem ? (
        <p className={styles.problem}>
          <span className={styles.problemDot} aria-hidden="true" />
          <span>
            {view.problem}{' '}
            {isAdmin ? (
              <>
                <HomeLink route="setupCheck" className={styles.link}>
                  Run Setup check
                </HomeLink>
                {' · '}
              </>
            ) : null}
            <TryNow />
          </span>
        </p>
      ) : (
        <p className={styles.cardFooter}>
          <span className={styles.wideOnly}>{view.meta.join(' · ')} · </span>
          <HomeLink route={view.link.route} className={styles.footerLink}>
            {view.link.label}
          </HomeLink>
        </p>
      )}
    </article>
  );
}

function NotSetUpCard({ view }: { view: NotSetUpCardView }) {
  const titleId = useId();
  return (
    <article
      className={styles.card}
      data-quiet="true"
      data-testid="home-target"
      data-target={view.key}
      data-state="not-set-up"
      aria-labelledby={titleId}
    >
      <div className={styles.cardHead}>
        <p className={styles.cardLabel}>{view.label}</p>
        <StatusTag className={styles.cardTag} tone={view.tag.tone}>
          {view.tag.word}
        </StatusTag>
      </div>
      <h3 className={styles.cardTitle} id={titleId}>
        {view.title}
      </h3>
      <p className={styles.cardText}>{view.sentence}</p>
      <div className={styles.cardAction}>
        <HomeLink route={view.action.route} className={styles.buttonLink}>
          {view.action.label}
        </HomeLink>
      </div>
    </article>
  );
}

export function TargetCard({ view }: { view: TargetCardView }) {
  return view.kind === 'live' ? <LiveCard view={view} /> : <NotSetUpCard view={view} />;
}
