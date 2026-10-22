import { createFileRoute } from '@tanstack/react-router';

import { guardPageAccess } from '@/platform/shell/route-guard';

import { validateSearchUrl } from './-search.url';
import { SearchPage } from './-ui/search-page';

/**
 * Search: one query against your library, the download source (Soulseek,
 * streamed as it answers) and the connected metadata service, grouped by
 * source (boards 2m, 2n).
 *
 * The query and the type (Everything / Artists / Albums / Tracks) live in the
 * URL, `/search?q=pale+harbour&type=albums`, so back, forward and links work.
 * No loader: the header and field render at once and each section shows its
 * own loading state.
 */
export const Route = createFileRoute('/search')({
  validateSearch: validateSearchUrl,
  beforeLoad: ({ context }) => {
    guardPageAccess(context.shell.bridge, 'search');
  },
  component: SearchPage,
});
