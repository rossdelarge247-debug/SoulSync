/**
 * The unified Downloads page: music + video in ONE place.
 *
 * A Music | Video switcher above the page, deep-linkable via ?media= — the
 * old /video-downloads route redirects here with media=video. Each view is
 * the full page it always was: the music view is the untouched
 * ActiveDownloadsPage, the video view is the React rewrite of the old
 * vanilla video downloads page. No visual redesign — both keep their
 * existing look.
 */

import { useNavigate } from '@tanstack/react-router';

import { ModuleOffNotice, useModuleOff } from '@/features/modules/module-gate';
import { useProfile } from '@/platform/shell/route-controllers';

import { Route } from '../route';
import { ActiveDownloadsPage } from './active-downloads-page';
import { VideoDownloadsView } from './video-downloads-view';

export type DownloadsMedia = 'music' | 'video';

export function UnifiedDownloadsPage() {
  const { media } = Route.useSearch();
  const navigate = useNavigate();
  const profile = useProfile();
  // the Video module turned off: no Video tab, and an old ?media=video link
  // says so rather than loading a view whose API answers 409
  const videoOff = useModuleOff('video');

  const setMedia = (next: DownloadsMedia) => {
    if (next === media) return;
    void navigate({
      to: '/active-downloads',
      search: { media: next },
    });
  };

  return (
    <div className="adl-unified">
      <div className="adl-nav adl-media-switch" role="tablist" aria-label="Downloads media">
        <div className="adl-view-tabs">
          <button
            type="button"
            role="tab"
            aria-selected={media === 'music'}
            className={`adl-view-tab${media === 'music' ? ' active' : ''}`}
            onClick={() => setMedia('music')}
          >
            🎵 Music
          </button>
          {videoOff ? null : (
            <button
              type="button"
              role="tab"
              aria-selected={media === 'video'}
              className={`adl-view-tab${media === 'video' ? ' active' : ''}`}
              onClick={() => setMedia('video')}
            >
              🎬 Video
            </button>
          )}
        </div>
      </div>

      {media !== 'video' ? (
        <ActiveDownloadsPage />
      ) : videoOff ? (
        <ModuleOffNotice module={videoOff} isAdmin={profile.isAdmin} />
      ) : videoOff === null ? (
        <VideoDownloadsView />
      ) : null}
    </div>
  );
}
