import { createFileRoute } from '@tanstack/react-router';

import { LegacyRouteController } from '@/platform/shell/route-controllers';
import { guardPageAccess } from '@/platform/shell/route-guard';
import { getShellRouteByPageId } from '@/platform/shell/route-manifest';

import { artistIndexInfiniteQueryOptions, releasesInfiniteQueryOptions } from './-library.api';
import {
  ALBUM_SHOWS,
  ALBUM_SORTS,
  ARTIST_SHOWS,
  ARTIST_SORTS,
  librarySearchSchema,
  pick,
  resolveLibrarySearch,
} from './-library.types';
import { LibraryPage } from './-ui/library-page';

/**
 * Whether the shell has handed /library over to React yet.
 *
 * Without this check TanStack would match /library regardless of the manifest
 * and the vanilla page and the React host would both activate. Delete this
 * indirection once the vanilla library page is gone.
 */
function isReactOwned(): boolean {
  return getShellRouteByPageId('library')?.kind === 'react';
}

export const Route = createFileRoute('/library')({
  validateSearch: librarySearchSchema,
  beforeLoad: ({ context }) => {
    guardPageAccess(context.shell.bridge, 'library');
  },
  loaderDeps: ({ search }) => resolveLibrarySearch(search),
  loader: async ({ context, deps }) => {
    if (!isReactOwned()) return;
    const { profile } = context.shell;
    // Warming the cache for the first paint, NOT a gate: a failure is the
    // page's own error state (the danger Notice over faded squares), never
    // the router's "Something went wrong".
    // Listening history reads its own routes on mount (its range is the
    // browser's remembered one, which the loader can't see)
    if (deps.view === 'history') return;
    if (deps.view === 'albums') {
      if (deps.tab === 'genres') return;
      await context.queryClient
        .prefetchInfiniteQuery(
          releasesInfiniteQueryOptions(profile.profileId, {
            show: pick(deps.show, ALBUM_SHOWS),
            genre: deps.genre,
            q: deps.q,
            sort: pick(deps.sort, ALBUM_SORTS),
          }),
        )
        .catch(() => undefined);
      return;
    }
    await context.queryClient
      .prefetchInfiniteQuery(
        artistIndexInfiniteQueryOptions(profile.profileId, {
          show: pick(deps.show, ARTIST_SHOWS),
          genre: deps.genre,
          q: deps.q,
          sort: pick(deps.sort, ARTIST_SORTS),
        }),
      )
      .catch(() => undefined);
  },
  component: LibraryRouteComponent,
});

function LibraryRouteComponent() {
  if (!isReactOwned()) {
    return <LegacyRouteController pathname="/library" />;
  }
  return <LibraryPage />;
}
