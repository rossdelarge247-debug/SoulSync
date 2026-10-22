/**
 * What the library check says about the metadata results on screen: which
 * albums and tracks you own, which tracks are on Wanted, and the library row
 * for tracks with a file (for playing them).
 */

import type { LibraryCheckTrack } from './-search.types';

export interface OwnershipState {
  ownedAlbums: ReadonlySet<string>;
  ownedTracks: ReadonlySet<string>;
  wishlistTracks: ReadonlySet<string>;
  /**
   * Track identity → the library row, for tracks that have a local file.
   *
   * The whole row, not just the path: playLibraryTrack wants the library track
   * id, its title, the album thumb and the album/artist names, and those come
   * from the library check rather than from the search result.
   */
  libraryTracks: ReadonlyMap<string, LibraryCheckTrack>;
}

export const EMPTY_OWNERSHIP: OwnershipState = {
  ownedAlbums: new Set(),
  ownedTracks: new Set(),
  wishlistTracks: new Set(),
  libraryTracks: new Map(),
};
