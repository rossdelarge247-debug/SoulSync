import { useNavigate } from '@tanstack/react-router';

import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import { isVideoMedia } from '../-video.types';
import { Route } from '../route';
import { VideoWishlist } from './video-wishlist';

/**
 * The video side's wishlist on its Movies / TV / YouTube tabs. The music
 * wishlist is Wanted (/wanted), so the route only renders this for a video
 * `media`; it asks the video wishlist's permission, not the music one.
 */
export function VideoWishlistPage() {
  const search = Route.useSearch();
  const media = isVideoMedia(search.media) ? search.media : 'movies';
  useReactPageShell('wishlist', `?media=${media}`);
  const { profileId } = useProfile();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <div className="page-shell wlp wlp--video">
      <VideoWishlist
        profileId={profileId}
        media={media}
        query={search.q}
        failing={search.failing}
        onMedia={(next) =>
          void navigate({ search: (prev) => ({ ...prev, media: next, q: '', failing: false }) })
        }
        onQuery={(q) => void navigate({ search: (prev) => ({ ...prev, q }), replace: true })}
        onFailing={(failing) => void navigate({ search: (prev) => ({ ...prev, failing }) })}
      />
    </div>
  );
}
