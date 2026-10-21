import type { WatchlistSearch } from '../watchlist/-watchlist.types';
import type { WishlistSearch } from '../wishlist/-wishlist.types';
import type { WantedSearch } from './-wanted.types';

/**
 * Where an old Wishlist link lands on /wanted: the Wanted tab, keeping the
 * filter text, the Failing chip (now "Not found yet") and the Audiobooks tab.
 */
export function wantedSearchFromWishlist(search: WishlistSearch): WantedSearch {
  return {
    tab: 'wanted',
    ...(search.q ? { q: search.q } : {}),
    ...(search.failing ? { filter: 'not-found' } : {}),
    ...(search.media === 'audiobooks' ? { media: 'audiobooks' as const } : {}),
  };
}

/**
 * Where an old Watchlist link lands on /wanted: the Followed artists tab,
 * keeping the Labels, Podcasts and Audiobooks tabs, the sort, the filter text,
 * and an open artist's settings or profile, or the global settings.
 */
export function wantedSearchFromWatchlist(search: WatchlistSearch): WantedSearch {
  return {
    tab: 'followed',
    ...(search.tab !== 'artists' ? { list: search.tab } : {}),
    ...(search.sort !== 'name-asc' ? { sort: search.sort } : {}),
    ...(search.q ? { q: search.q } : {}),
    ...(search.configId ? { configId: search.configId } : {}),
    ...(search.detailId ? { detailId: search.detailId } : {}),
    ...(search.settings ? { settings: true } : {}),
  };
}
