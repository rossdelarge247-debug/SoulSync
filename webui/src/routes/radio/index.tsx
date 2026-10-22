import { createFileRoute } from '@tanstack/react-router';

import { RadioHome } from './-ui/radio-home';

export interface RadioHomeSearch {
  tab?: 'heard';
  show?: 'missing';
  /** Settings → Radio's "Add a stream link" opens the dialog here. */
  add?: 'link';
}

export const Route = createFileRoute('/radio/')({
  validateSearch: (search: Record<string, unknown>): RadioHomeSearch => ({
    ...(search.tab === 'heard' ? { tab: 'heard' as const } : {}),
    ...(search.show === 'missing' ? { show: 'missing' as const } : {}),
    ...(search.add === 'link' ? { add: 'link' as const } : {}),
  }),
  component: RadioHome,
});
