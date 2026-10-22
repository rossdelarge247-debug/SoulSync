/**
 * The unified Downloads page: music + video in ONE place.
 *
 * The Music | Video switch lives in the header now (dl-header.tsx). This page
 * owns its state: which side is showing (deep-linkable via ?media=, the old
 * /video-downloads route redirects here with media=video) and how many
 * downloads each side has moving, so the switch can show the other side's
 * count without you going over there.
 */

import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ModuleOffNotice, useModuleOff } from '@/features/modules/module-gate';
import { useProfile } from '@/platform/shell/route-controllers';

import type { DownloadsMedia, DownloadsMediaState } from './dl-header';

import { fetchVideoDownloads } from '../-vdl.api';
import { vdlIsActive } from '../-vdl.helpers';
import { Route } from '../route';
import { ActiveDownloadsPage } from './active-downloads-page';
import { DownloadsMediaContext } from './dl-header';
import { VideoDownloadsView } from './video-downloads-view';

export type { DownloadsMedia };

/** How often the hidden video side is counted while you're on music. */
export const OTHER_SIDE_POLL_MS = 10_000;

export function UnifiedDownloadsPage() {
  const { media } = Route.useSearch();
  const navigate = useNavigate();
  const profile = useProfile();
  // the Video module turned off: no Video side in the switch, no polling its
  // API, and an old ?media=video link says so rather than loading a view
  // whose API answers 409
  const videoOff = useModuleOff('video');
  const [active, setActive] = useState<Record<DownloadsMedia, number | null>>(() => ({
    music:
      typeof window.__soulsyncMusicActiveDownloads === 'number'
        ? window.__soulsyncMusicActiveDownloads
        : null,
    video: null,
  }));

  const reportActive = useCallback((side: DownloadsMedia, count: number) => {
    setActive((prev) => (prev[side] === count ? prev : { ...prev, [side]: count }));
  }, []);

  const setMedia = useCallback(
    (next: DownloadsMedia) => {
      if (next === media) return;
      void navigate({ to: '/active-downloads', search: { media: next } });
    },
    [media, navigate],
  );

  // music: the status push already carries the server-side total (core.js)
  useEffect(() => {
    const onPush = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n === 'number') reportActive('music', n);
    };
    document.addEventListener('soulsync:music-active-downloads', onPush);
    return () => document.removeEventListener('soulsync:music-active-downloads', onPush);
  }, [reportActive]);

  // video: nothing pushes it, so count it gently while it's the hidden side
  // (and only once the Video module is known to be on)
  useEffect(() => {
    if (media !== 'music' || videoOff !== null) return undefined;
    let alive = true;
    const count = async () => {
      if (document.hidden) return;
      const data = await fetchVideoDownloads();
      if (alive && data.downloads) {
        reportActive('video', data.downloads.filter((d) => vdlIsActive(d.status)).length);
      }
    };
    void count();
    const timer = setInterval(() => void count(), OTHER_SIDE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [media, reportActive, videoOff]);

  const value = useMemo<DownloadsMediaState>(
    () => ({ media, setMedia, active, reportActive, videoAvailable: !videoOff }),
    [media, setMedia, active, reportActive, videoOff],
  );

  return (
    <DownloadsMediaContext.Provider value={value}>
      <div className="adl-unified">
        {media !== 'video' ? (
          <ActiveDownloadsPage />
        ) : videoOff ? (
          <ModuleOffNotice module={videoOff} isAdmin={profile.isAdmin} />
        ) : videoOff === null ? (
          <VideoDownloadsView />
        ) : null}
      </div>
    </DownloadsMediaContext.Provider>
  );
}
