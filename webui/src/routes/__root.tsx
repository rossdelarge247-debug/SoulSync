import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';

import type { AppRouterContext } from '@/app/router';

import { AutomixHost } from '@/features/automix/automix-host';
import { AnalysisCountHost } from '@/features/dj/analysis-line';
import { DndHost } from '@/features/dnd/dnd-host';
import { MixTabHost } from '@/features/mix/mix-host';
import { WorkingSetNav } from '@/features/sets/set-actions';
import { waitForShellContext } from '@/platform/shell/bridge';
import { ShellLocationReporter } from '@/platform/shell/route-controllers';
import { shellStatusQueryOptions } from '@/platform/shell/status';

import { VideoDownloadsBadgePoller } from './active-downloads/-vdl.use-downloads';
import { IssueDomainHost } from './issues/-ui/issue-domain-host';
import { AutoSyncHost } from './sync/-ui/autosync-host';

export const Route = createRootRouteWithContext<AppRouterContext>()({
  beforeLoad: async ({ context }) => {
    const [shell, status] = await Promise.all([
      waitForShellContext(),
      context.queryClient.fetchQuery(shellStatusQueryOptions()).catch(() => undefined),
    ]);

    return { shell: { ...shell, status } };
  },
  component: () => (
    <>
      <Outlet />
      <IssueDomainHost />
      {/* the dashboard opens auto-sync through a window global, this makes
          it the same react manager the playlists page uses */}
      <AutoSyncHost />
      {/* keeps the video sidebar's downloads badge live while the unified
          page's video view isn't mounted (its own poll owns the badge then) */}
      <VideoDownloadsBadgePoller />
      {/* the navigation shell's current row follows the whole URL */}
      <ShellLocationReporter />
      {/* the player's Mix tab (29a–29c): the tray's second mode, the
          Visuals drawer and the phone's Mix · Set, placed into the shell */}
      <MixTabHost />
      {/* 33c: the sidebar's Sets row says the working set's name */}
      <WorkingSetNav />
      {/* auto-mix (26a–26h): Up next's chips, Mix now, the handover and
          Player settings → Between tracks, placed into the shell */}
      <AutomixHost />
      {/* Brief A (31b): the analysis count in the top bar, with its popover */}
      <AnalysisCountHost />
      {/* Brief B (32a–32g): drag and drop's ghost, line, trays and Up next's binding */}
      <DndHost />
    </>
  ),
});
