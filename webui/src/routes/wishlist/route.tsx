import { createFileRoute, redirect } from '@tanstack/react-router';

import { wantedSearchFromWishlist } from '../wanted/-wanted.redirects';
import { wishlistSearchSchema } from './-wishlist.types';

/** The Wishlist is the Wanted tab of /wanted now; old links keep what they meant. */
export const Route = createFileRoute('/wishlist')({
  validateSearch: wishlistSearchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/wanted', search: wantedSearchFromWishlist(search), replace: true });
  },
});
