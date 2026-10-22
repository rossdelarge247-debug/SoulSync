import { createFileRoute, redirect } from '@tanstack/react-router';

import { wantedSearchFromWatchlist } from '../wanted/-wanted.redirects';
import { watchlistSearchSchema } from './-watchlist.types';

/** The Watchlist is the Following tab of /wanted now; old links keep what they meant. */
export const Route = createFileRoute('/watchlist')({
  validateSearch: watchlistSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/wanted', search: wantedSearchFromWatchlist(search), replace: true });
  },
});
