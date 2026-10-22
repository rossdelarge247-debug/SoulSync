/**
 * Targets: the four cards in their fixed order (Wanted, Mirrored playlists,
 * Followed artists, Quality), or, with none of the first three set up, the one
 * "Tell SoulSync what you want" panel (board 1b). Loading and a failed load
 * follow the design system: words beside a spinner then card-shaped
 * placeholders; a danger Notice in front of faded placeholders.
 */

import type { UseQueryResult } from '@tanstack/react-query';

import { Button } from '@/components/form';
import { LoadingState, Notice, Skeleton } from '@/components/primitives';

import type { TargetsSummary } from '../../-home.api';

import { SETUP_PANEL_ITEMS, soonestSearchShort, targetCardView } from '../../-home.targets';
import { HomeAction } from './home-dialogs';
import { HomeLink, useHomeNav } from './home-nav';
import styles from './home.module.css';
import { TargetCard } from './target-card';

const HEADING_ID = 'home-targets-title';

function SectionHead({ phoneNote }: { phoneNote?: string | null }) {
  return (
    <div className={styles.sectionHead}>
      <h2 className={styles.sectionTitle} id={HEADING_ID}>
        Targets
      </h2>
      <p className={styles.sectionNote}>
        <span className={styles.wideOnly}>Searches run on the Automations schedule.</span>
        {phoneNote ? <span className={styles.phoneOnly}>{phoneNote}</span> : null}
      </p>
    </div>
  );
}

function CardSkeletons({ faded = false }: { faded?: boolean }) {
  return (
    <div className={styles.grid} data-faded={faded ? 'true' : undefined} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div className={styles.skeletonCard} key={i}>
          <Skeleton className={styles.skeletonLabel} />
          <Skeleton className={styles.skeletonTitle} />
          <Skeleton className={styles.skeletonBar} />
          <div className={styles.skeletonStats}>
            <Skeleton className={styles.skeletonStat} />
            <Skeleton className={styles.skeletonStat} />
            <Skeleton className={styles.skeletonStat} />
          </div>
          <Skeleton className={styles.skeletonMeta} />
        </div>
      ))}
    </div>
  );
}

function SetupPanel() {
  return (
    <section
      className={styles.setupPanel}
      aria-labelledby="home-setup-title"
      data-testid="home-setup-panel"
    >
      <div className={styles.setupPanelText}>
        <p className={styles.cardLabel}>Targets</p>
        <h2 className={styles.sectionTitle} id="home-setup-title">
          Tell SoulSync what you want
        </h2>
        <p className={styles.cardText}>
          Home fills in once you set a target. SoulSync then searches for what’s missing on a
          schedule and shows you how far along it is.
        </p>
      </div>
      <ul className={styles.grid}>
        {SETUP_PANEL_ITEMS.map((item) => (
          <li className={styles.setupItem} key={item.key}>
            <h3 className={styles.cardTitle}>{item.title}</h3>
            <p className={styles.cardText}>{item.sentence}</p>
            <div className={styles.cardAction}>
              <HomeAction
                action={item.action}
                className={styles.buttonLink}
                buttonClassName={`${styles.buttonLink} ${styles.asButton}`}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TargetsSection({
  query,
  nowMs,
}: {
  query: UseQueryResult<TargetsSummary>;
  nowMs: number;
}) {
  const { isAdmin } = useHomeNav();

  if (query.isPending) {
    return (
      <section className={styles.section} aria-labelledby={HEADING_ID}>
        <SectionHead />
        <LoadingState label="Loading your targets…">
          <CardSkeletons />
        </LoadingState>
      </section>
    );
  }

  if (query.isError && !query.data) {
    return (
      <section className={styles.section} aria-labelledby={HEADING_ID}>
        <SectionHead />
        <Notice
          tone="danger"
          role="alert"
          title="Couldn’t load your targets"
          actions={
            <>
              <Button
                size="lg"
                onClick={() => {
                  void query.refetch();
                }}
              >
                {query.isFetching ? 'Trying…' : 'Try again'}
              </Button>
              {isAdmin ? (
                <HomeLink route="setupCheck" className={styles.ghostButtonLink}>
                  Run Setup check
                </HomeLink>
              ) : null}
            </>
          }
        >
          SoulSync didn’t answer, so Home can’t show how your targets are doing. Nothing is lost;
          this is a display problem.
          {isAdmin ? ' If it keeps happening, the Setup check can tell you why.' : null}
        </Notice>
        <CardSkeletons faded />
      </section>
    );
  }

  const summary = query.data;
  if (!summary.anySetUp) return <SetupPanel />;

  return (
    <section className={styles.section} aria-labelledby={HEADING_ID}>
      <SectionHead phoneNote={soonestSearchShort(summary.targets, nowMs)} />
      <div className={styles.grid} data-testid="home-targets">
        {summary.targets.map((target) => (
          <TargetCard key={target.key} view={targetCardView(target, nowMs)} />
        ))}
      </div>
    </section>
  );
}
