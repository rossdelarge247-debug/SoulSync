/**
 * Home: downloads against targets ("Main v2" and "Main (390)" boards). What
 * you want (Wanted, mirrored playlists, followed artists, a quality target),
 * how much you have, and what SoulSync is doing about the gap, then the latest
 * activity. Below it, under "Library and system", everything else today's
 * dashboard had (home-more.tsx).
 *
 * The `#dashboard-page` id stays on the root: worker-orbs.js anchors
 * `#dashboard-page .orb-stage`, the dashboard stylesheet's rules are scoped
 * by it, and the tour targets live ids. The `page` class is NOT here (the
 * shell styles `.page { display:none }` and only vanilla pages get `.active`).
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { FinishSetupCard } from '@/features/onboarding/checklist-card';

import type { useDashboardHeader } from '../../-dash.header';

import { latestActivityQueryOptions, targetsSummaryQueryOptions } from '../../-home.api';
import { AlertsBand } from '../alerts-band';
import { HomeDialogsProvider } from './home-dialogs';
import { HomeMore } from './home-more';
import { HomeLink, HomeNavProvider, type HomeNav } from './home-nav';
import styles from './home.module.css';
import { LatestSection } from './latest-section';
import { TargetsSection } from './targets-section';

type DashboardHeaderState = ReturnType<typeof useDashboardHeader>;

/** The clock the relative times read; ticks every 30 s like the data. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function HomeHeader() {
  return (
    <header className={styles.header} data-tour="home-header">
      <div className={styles.headText}>
        <h1 className={styles.title}>Home</h1>
        <p className={styles.subtitle}>
          What you want, what you have, and what SoulSync is doing about the gap.
        </p>
      </div>
      <HomeLink route="search" className={styles.buttonLink}>
        Search for music
      </HomeLink>
    </header>
  );
}

export interface HomePageProps {
  header: DashboardHeaderState;
  profileId: number | null;
  nav: HomeNav;
}

export function HomePage({ header, profileId, nav }: HomePageProps) {
  const targets = useQuery(targetsSummaryQueryOptions(profileId));
  const latest = useQuery(latestActivityQueryOptions(profileId));
  const nowMs = useNow(30_000);

  return (
    <HomeNavProvider value={nav}>
      <HomeDialogsProvider>
        <div className={`${styles.page} home-page`} id="dashboard-page">
          <div className={styles.main}>
            <div className={styles.mainInner}>
              <HomeHeader />
              {/* Renders nothing while every core connection is healthy. */}
              <AlertsBand />
              <TargetsSection query={targets} nowMs={nowMs} />
              <LatestSection query={latest} nowMs={nowMs} />
              {/* What first-run setup left for later. Its API is admin only,
                  so members don't ask; it renders nothing once it's all done
                  or hidden. */}
              {nav.isAdmin ? <FinishSetupCard /> : null}
            </div>
          </div>
          <HomeMore header={header} />
        </div>
      </HomeDialogsProvider>
    </HomeNavProvider>
  );
}
