/**
 * The Home page on /dashboard (the profile's home route): downloads against
 * targets, the latest activity, then "Library and system" with everything
 * else the dashboard had (-ui/home/).
 *
 * The page owns the header hook once: its watchlist/wishlist counts feed the
 * rail tiles as well as the worker orbs, and a second hook would double every
 * fetch and socket subscription behind it.
 *
 * The mount effect re-pings worker-orbs: the shell bridge calls
 * setPage('dashboard') BEFORE React paints, so the orb layer's lazy re-anchor
 * needs one call at a moment the stage actually exists. (setPage is
 * idempotent — re-anchoring only runs when its anchor is missing or
 * unmounted.)
 */

import { useEffect, useMemo } from 'react';

import { useShellContext } from '@/platform/shell/route-controllers';

import type { HomeNav } from './home/home-nav';

import { useDashboardHeader } from '../-dash.header';
import { HomePage } from './home/home-page';

export function DashboardPage() {
  const header = useDashboardHeader();
  const { bridge, profile } = useShellContext();
  const nav = useMemo<HomeNav>(
    () => ({
      isAdmin: profile.isAdmin,
      isPageAllowed: (pageId) => bridge.isPageAllowed(pageId),
    }),
    [bridge, profile.isAdmin],
  );

  useEffect(() => {
    window.workerOrbs?.setPage('dashboard');
  }, []);

  return <HomePage header={header} profileId={profile.profileId} nav={nav} />;
}
