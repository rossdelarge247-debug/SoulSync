import { createFileRoute } from '@tanstack/react-router';

import { ModuleGate } from '@/features/modules/module-gate';
import { guardPageAccess } from '@/platform/shell/route-guard';

import { PodcastProvider } from './-ui/podcast-context';
import { PodcastsLayout } from './-ui/podcasts-layout';

export const Route = createFileRoute('/podcasts')({
  beforeLoad: ({ context }) => {
    guardPageAccess(context.shell.bridge, 'podcasts');
  },
  component: PodcastsRouteComponent,
});

function PodcastsRouteComponent() {
  return (
    <ModuleGate module="podcasts" pageId="podcasts">
      <PodcastProvider>
        <PodcastsLayout />
      </PodcastProvider>
    </ModuleGate>
  );
}
