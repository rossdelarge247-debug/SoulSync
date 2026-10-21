import { createFileRoute, redirect } from '@tanstack/react-router';

import { guardPageAccess } from '@/platform/shell/route-guard';

import type { ActivitySearch } from './-activity.types';

import { parseRange, parseShow, readRememberedRange } from './-activity.helpers';
import { ActivityPage } from './-ui/activity-page';

/**
 * Activity: one timeline of downloads, imports, automation runs, playlist
 * mirrors and expired previews, with "Needs you" pinned on top.
 *
 * Filter and range live in the URL (?show=downloads&range=30d) so back,
 * forward and links work. Arriving without a range uses the one this browser
 * picked last (7 days by default) and writes it into the URL, replacing the
 * entry, so every history entry says which range it showed.
 *
 * No loader: the page renders its header and controls at once and shows the
 * loading state in place of the timeline.
 */
export const Route = createFileRoute('/activity')({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => {
    const show = parseShow(search.show);
    const range = parseRange(search.range);
    return {
      ...(show && show !== 'all' ? { show } : {}),
      ...(range ? { range } : {}),
    };
  },
  beforeLoad: ({ context, search }) => {
    guardPageAccess(context.shell.bridge, 'activity');
    if (!search.range) {
      throw redirect({
        to: '/activity',
        search: { ...search, range: readRememberedRange() },
        replace: true,
      });
    }
  },
  component: ActivityPage,
});
