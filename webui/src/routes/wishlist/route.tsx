import { createFileRoute, redirect } from '@tanstack/react-router';

import { ModuleGate } from '@/features/modules/module-gate';
import { guardPageAccess } from '@/platform/shell/route-guard';

import { wantedSearchFromWishlist } from '../wanted/-wanted.redirects';
import { VideoWishlistPage } from './-ui/video-wishlist-page';
import { isVideoMedia } from './-video.types';
import { wishlistSearchSchema } from './-wishlist.types';

/**
 * The music Wishlist is the Wanted tab of /wanted now; old links keep what
 * they meant. The video side's wishlist is still this page, on its Movies /
 * TV / YouTube tabs (`?media=movies|tv|youtube`): the video sidebar hands
 * /video-wishlist off to it (gotoUnifiedWishlist in video-side.js).
 */
export const Route = createFileRoute('/wishlist')({
  validateSearch: wishlistSearchSchema,
  beforeLoad: ({ context, search }) => {
    if (!isVideoMedia(search.media)) {
      throw redirect({ to: '/wanted', search: wantedSearchFromWishlist(search), replace: true });
    }
    // the video tabs are the video side's wishlist: the shell asks for the
    // video-wishlist permission (and the video side) instead of the music one.
    guardPageAccess(context.shell.bridge, 'wishlist', `?media=${search.media}`);
  },
  component: VideoWishlistRouteComponent,
});

/** The Video module turned off: its wishlist says so instead of calling an API that answers 409. */
function VideoWishlistRouteComponent() {
  return (
    <ModuleGate module="video">
      <VideoWishlistPage />
    </ModuleGate>
  );
}
