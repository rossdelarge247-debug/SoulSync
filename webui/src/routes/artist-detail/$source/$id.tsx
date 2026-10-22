import { createFileRoute, redirect } from '@tanstack/react-router';
import { useLayoutEffect } from 'react';

import { useShellBridge } from '@/platform/shell/route-controllers';
import { getShellRouteByPageId } from '@/platform/shell/route-manifest';

import { artistDetailSearchSchema } from '../-artist-detail.types';
import { ArtistPage } from '../-ui/artist-page';

/**
 * Whether the shell has handed artist detail over to React yet.
 *
 * TanStack matches from the generated route tree, not the manifest, so this
 * route matches the moment the file exists. Without this guard the React page
 * and the vanilla page would both activate on the same URL. Delete the
 * indirection once the vanilla artist-detail page is gone.
 *
 * The search schema moved to -artist-detail.types.ts, where its preprocess is
 * unit-tested: TanStack JSON-parses search values, so an all-digits artist
 * name ("311", "702") arrives as a NUMBER and a bare z.string() throws
 * SearchParamError, killing the route. That has regressed once already.
 */
function isReactOwned(): boolean {
  return getShellRouteByPageId('artist-detail')?.kind === 'react';
}

/**
 * The one Artist page: /artist-detail/<source>/<id>, where <source> is
 * "library" for a library artist and a metadata source for anyone else.
 * `?tab=tracks|similar` and `?show=library|missing|albums` keep the tab and filter in
 * the URL, so Back steps between them.
 *
 * Old links keep their meaning: `?album=<id>` (the library's album grid, an
 * issue's "edit details") used to open that album in the "Your library" view,
 * which is the Tracks tab now (with its tag and file tools for an admin).
 */
export const Route = createFileRoute('/artist-detail/$source/$id')({
  validateSearch: artistDetailSearchSchema,
  beforeLoad: ({ params, search, context }) => {
    if (search.album && !search.tab) {
      const admin = Boolean(context.shell?.profile?.isAdmin);
      throw redirect({
        to: '/artist-detail/$source/$id',
        params,
        search: { ...search, tab: 'tracks', ...(admin ? { manage: true } : {}) },
        replace: true,
      });
    }
  },
  component: ArtistDetailRouteComponent,
});

function ArtistDetailRouteComponent() {
  if (!isReactOwned()) {
    return <LegacyArtistDetailHandoff />;
  }
  return <ArtistPage />;
}

/**
 * Thin legacy handoff: TanStack owns the URL shape, but the vanilla JS page
 * still renders the experience. The route owns cancellation so similar-artist
 * loading stops when this page changes.
 */
function LegacyArtistDetailHandoff() {
  const bridge = useShellBridge();
  const { source, id } = Route.useParams();
  const { name } = Route.useSearch();

  useLayoutEffect(() => {
    if (!bridge) return;

    const normalizedSource = source.toLowerCase() === 'library' ? null : source.toLowerCase();
    bridge.navigateToArtistDetail(id, name, normalizedSource, {
      skipRouteChange: true,
    });

    return () => {
      bridge.cancelSimilarArtistsLoad();
    };
  }, [bridge, id, source, name]);

  return null;
}
