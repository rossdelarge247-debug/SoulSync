import { Outlet, createFileRoute } from '@tanstack/react-router';

import { LegacyRouteController } from '@/platform/shell/route-controllers';
import { guardPageAccess } from '@/platform/shell/route-guard';
import { getShellRouteByPageId } from '@/platform/shell/route-manifest';

import { automationsListQueryOptions, automationsMasterQueryOptions } from './-automations.api';

/**
 * Whether the shell has handed /automations over to React. Without this
 * check TanStack would match /automations regardless of the manifest and the
 * vanilla page and the React host would both activate.
 */
function isReactOwned(): boolean {
  return getShellRouteByPageId('automations')?.kind === 'react';
}

/**
 * Automations: the list (`/automations`), a new automation
 * (`/automations/new`) and the editor (`/automations/<id>/edit`). This layout
 * holds the page gate for all three.
 */
export const Route = createFileRoute('/automations')({
  beforeLoad: ({ context }) => {
    guardPageAccess(context.shell.bridge, 'automations');
  },
  loader: ({ context }) => {
    if (!isReactOwned()) return;
    const { profile } = context.shell;
    const { queryClient } = context;
    // Starts the two reads the first paint needs, without waiting for them:
    // the page draws its header and filters at once and says it's loading
    // (or that it couldn't load) in place of the cards.
    void queryClient.prefetchQuery(automationsListQueryOptions(profile.profileId));
    void queryClient.prefetchQuery(automationsMasterQueryOptions());
  },
  component: AutomationsLayout,
});

function AutomationsLayout() {
  if (!isReactOwned()) {
    return <LegacyRouteController pathname="/automations" />;
  }
  return <Outlet />;
}
