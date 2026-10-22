import { createFileRoute } from '@tanstack/react-router';

import { StationPage } from './-ui/station-page';

export interface StationSearch {
  confirm?: 'auto-add';
}

export const Route = createFileRoute('/radio/station/$stationId')({
  validateSearch: (search: Record<string, unknown>): StationSearch =>
    search.confirm === 'auto-add' ? { confirm: 'auto-add' } : {},
  component: StationRoute,
});

function StationRoute() {
  const { stationId } = Route.useParams();
  const { confirm } = Route.useSearch();
  return <StationPage stationId={stationId} confirmAutoAdd={confirm === 'auto-add'} />;
}
