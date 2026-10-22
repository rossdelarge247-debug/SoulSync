import { Outlet, createFileRoute } from '@tanstack/react-router';

import { ModuleGate } from '@/features/modules/module-gate';
import { guardPageAccess } from '@/platform/shell/route-guard';

/**
 * Internet radio (build e; boards 4a–4k): the stations (`/radio`), Heard on
 * radio (`/radio?tab=heard`), a station (`/radio/station/<id>`), a show's
 * tracklist (`/radio/tracklist?show=<id>`) and the directory search
 * (`/radio/search`). Behind the "Internet radio" module: while it's off the
 * pages say so instead of calling routes that answer 409.
 */
export const Route = createFileRoute('/radio')({
  beforeLoad: ({ context }) => {
    guardPageAccess(context.shell.bridge, 'radio');
  },
  component: RadioLayout,
});

function RadioLayout() {
  return (
    <ModuleGate module="radio" pageId="radio">
      <Outlet />
    </ModuleGate>
  );
}
