import { createFileRoute } from '@tanstack/react-router';

import { ModuleOffPage, useModuleStates } from '@/features/modules/module-gate';
import { moduleForPath } from '@/features/modules/modules.helpers';
import { LegacyRouteController } from '@/platform/shell/route-controllers';
import { resolveShellPageFromPath } from '@/platform/shell/route-manifest';

export const Route = createFileRoute('/$')({
  component: LegacyFallbackRouteComponent,
});

function LegacyFallbackRouteComponent() {
  const { _splat } = Route.useParams();
  const pathname = `/${_splat}`;
  const { data: modules } = useModuleStates();
  // A video page bookmarked while the Video module is off: video-side.js
  // stays on the music side, so say why instead of showing nothing. Shell
  // pages (/chat) keep the legacy route, which shows its own notice.
  const owner =
    modules && !resolveShellPageFromPath(pathname) ? moduleForPath(modules, pathname) : undefined;
  if (owner && !owner.enabled) return <ModuleOffPage module={owner} />;
  return <LegacyRouteController pathname={pathname} />;
}
