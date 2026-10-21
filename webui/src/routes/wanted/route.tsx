import { createFileRoute, redirect } from '@tanstack/react-router';

import { getProfileHomePath } from '@/platform/shell/bridge';
import { appURL } from '@/platform/url-base';

import {
  automationsListQueryOptions,
  automationsMasterQueryOptions,
} from '../automations/-automations.api';
import {
  watchlistArtistsQueryOptions,
  watchlistCountQueryOptions,
  watchlistGlobalConfigQueryOptions,
  watchlistScanStatusQueryOptions,
} from '../watchlist/-watchlist.api';
import {
  wishlistCycleQueryOptions,
  wishlistStatsQueryOptions,
  wishlistTracksQueryOptions,
} from '../wishlist/-wishlist.api';
import { WantedPage } from './-ui/wanted-page';
import {
  followedSummaryQueryOptions,
  qualityProfilesQueryOptions,
  wantedFoundQueryOptions,
} from './-wanted.api';
import { resolveTab, wantedSearchSchema } from './-wanted.types';

/**
 * Wanted: what you want (the old Wishlist) and who you follow (the old
 * Watchlist), as two tabs. `?tab=wanted|followed` so each tab is a link and
 * Back steps between them.
 *
 * Permissions follow the two pages it replaces: a profile allowed either one
 * opens Wanted and sees that tab; asking for the other tab lands on the one
 * it has.
 */
export const Route = createFileRoute('/wanted')({
  validateSearch: wantedSearchSchema,
  beforeLoad: ({ context, search }) => {
    const { bridge } = context.shell;
    const canWanted = bridge.isPageAllowed('wishlist');
    const canFollowed = bridge.isPageAllowed('watchlist');
    if (!canWanted && !canFollowed) {
      const home = getProfileHomePath(bridge);
      // the same loop guard as guardPageAccess: never bounce to ourselves
      if (home !== '/wanted') throw redirect({ href: appURL(home), replace: true });
      return;
    }
    const tab = resolveTab(search);
    if (tab === 'wanted' && !canWanted) {
      throw redirect({ to: '/wanted', search: { tab: 'followed' }, replace: true });
    }
    if (tab === 'followed' && !canFollowed) {
      throw redirect({ to: '/wanted', search: { tab: 'wanted' }, replace: true });
    }
  },
  loaderDeps: ({ search }) => ({ tab: resolveTab(search) }),
  loader: ({ context, deps }) => {
    const { profile } = context.shell;
    const { queryClient } = context;
    const id = profile.profileId;

    // Started here, not awaited: the page draws its header and tabs at once
    // and says "Loading your list…" until these land (the Wanted v2 loading
    // board). Each part reads its own failure through useQuery.
    //
    // Both tabs show both counts, and Followed artists counts what each
    // artist has on Wanted, so the wishlist loads either way.
    // prefetchQuery never throws; a failure stays in the cache for useQuery
    void queryClient.prefetchQuery(wishlistTracksQueryOptions(id, 'albums'));
    void queryClient.prefetchQuery(wishlistTracksQueryOptions(id, 'singles'));
    void queryClient.prefetchQuery(watchlistCountQueryOptions(id));
    void queryClient.prefetchQuery(automationsListQueryOptions(id));
    void queryClient.prefetchQuery(automationsMasterQueryOptions());
    if (deps.tab === 'followed') {
      void queryClient.prefetchQuery(watchlistArtistsQueryOptions(id));
      void queryClient.prefetchQuery(followedSummaryQueryOptions(id));
      void queryClient.prefetchQuery(watchlistScanStatusQueryOptions(id));
      void queryClient.prefetchQuery(watchlistGlobalConfigQueryOptions(id));
    } else {
      void queryClient.prefetchQuery(wishlistStatsQueryOptions(id));
      void queryClient.prefetchQuery(wishlistCycleQueryOptions(id));
      void queryClient.prefetchQuery(wantedFoundQueryOptions(id));
      void queryClient.prefetchQuery(qualityProfilesQueryOptions());
    }
  },
  component: WantedPage,
});
