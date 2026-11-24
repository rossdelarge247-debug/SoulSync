import { createFileRoute } from '@tanstack/react-router';

import { guardPageAccess } from '@/platform/shell/route-guard';

import { UnifiedDownloadsPage } from './-ui/unified-downloads-page';

export interface DownloadsSearch {
  media: 'music' | 'video';
  /** Open on Review → Quarantine (Activity's "Needs you" and Wanted link here). */
  review?: 'quarantine';
  /** With review: just this entry and the other attempts at the same song. */
  entry?: string;
}

/**
 * The unified Downloads page — music + video behind a Music | Video
 * switcher (?media=music|video). The old /video-downloads route redirects
 * here with media=video. `?review=quarantine` opens Review on Quarantine,
 * and `&entry=<id>` narrows it to one song's attempts.
 *
 * No loader: everything here is live and polled, so anything fetched before
 * render would be stale by the time it painted. The controllers fetch on mount.
 */
export const Route = createFileRoute('/active-downloads')({
  validateSearch: (search: Record<string, unknown>): DownloadsSearch => {
    const media = search.media === 'video' ? 'video' : 'music';
    if (media !== 'music' || search.review !== 'quarantine') return { media };
    // TanStack JSON-parses search values, so an all-digit id arrives as a number
    const raw = typeof search.entry === 'number' ? String(search.entry) : search.entry;
    const entry = typeof raw === 'string' && raw ? raw : undefined;
    return { media, review: 'quarantine', ...(entry ? { entry } : {}) };
  },
  beforeLoad: ({ context }) => {
    guardPageAccess(context.shell.bridge, 'active-downloads');
  },
  component: UnifiedDownloadsPage,
});
