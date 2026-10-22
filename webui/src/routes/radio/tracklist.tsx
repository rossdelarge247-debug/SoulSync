import { createFileRoute } from '@tanstack/react-router';

import { TracklistPage } from './-ui/tracklist-page';

export const Route = createFileRoute('/radio/tracklist')({
  validateSearch: (search: Record<string, unknown>): { show?: string } =>
    typeof search.show === 'string' && search.show ? { show: search.show } : {},
  component: TracklistRoute,
});

function TracklistRoute() {
  const { show } = Route.useSearch();
  return <TracklistPage showId={show ?? ''} />;
}
