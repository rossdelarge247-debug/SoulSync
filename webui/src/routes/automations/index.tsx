import { createFileRoute } from '@tanstack/react-router';

import { parseListSearch } from './-automations.types';
import { AutomationsListPage } from './-ui/list-page';

/**
 * The list. Selection, filters and search live in the URL
 * (`/automations?automation=12&show=attention&group=Nightly&q=wanted`), so
 * back, forward, reload and links keep them; old `?view=&nav=&health=` links
 * land on the matching filter.
 */
export const Route = createFileRoute('/automations/')({
  validateSearch: (search: Record<string, unknown>) => parseListSearch(search),
  component: AutomationsListPage,
});
