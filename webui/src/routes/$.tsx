import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy, useEffect } from 'react';

import { openDriveMove } from '@/features/drives/move-flow';
import labStyles from '@/features/engine/harness/automix-lab.module.css';
import { labAllowed } from '@/features/engine/harness/lab-gate';
import { useMixTabShown } from '@/features/mix/mix-visibility';
import { ModuleOffPage, useModuleStates } from '@/features/modules/module-gate';
import { moduleForPath } from '@/features/modules/modules.helpers';
import { LegacyRouteController, useProfile } from '@/platform/shell/route-controllers';
import { resolveShellPageFromPath } from '@/platform/shell/route-manifest';

export const Route = createFileRoute('/$')({
  component: LegacyFallbackRouteComponent,
});

/**
 * /move opens Move your music to another drive over the page you came from
 * (the phone's Docker step hands this link to the computer; Activity's row
 * links here), then steps back so the page under it is a real one.
 */
function MoveLink() {
  useEffect(() => {
    openDriveMove();
    if (window.history.length > 1 && document.referrer.startsWith(window.location.origin)) {
      window.history.back();
    } else {
      void window.navigateToPage?.('dashboard');
    }
  }, []);
  return null;
}

// auto-mix stage B's bench, loaded only when it's opened
const AutomixLab = lazy(() => import('@/features/engine/harness/automix-lab'));

/**
 * /automix-lab: the two-deck engine's harness (HANDOFF "Dev, auto-mix stage
 * B"). Admins only, in a development build or with `?lab=1`; for anyone
 * else it's an unknown page, as before.
 */
function AutomixLabGate({ pathname }: { pathname: string }) {
  const profile = useProfile();
  // the Mix tab is named only while it shows (Settings → Library → DJ)
  const mixTab = useMixTabShown();
  // UX-31: anyone else opening the link is told so, not shown an empty page
  if (!profile?.isAdmin)
    return (
      <div className={labStyles.adminsOnly} data-lab-admins-only="">
        <h1>Auto-mix lab</h1>
        <p>
          {mixTab
            ? 'This page is for admins. Up next, a set’s page and the Mix tab do the mixing.'
            : 'This page is for admins. Up next and a set’s page do the mixing.'}
        </p>
      </div>
    );
  if (!labAllowed(Boolean(profile?.isAdmin), import.meta.env.DEV, window.location.search)) {
    return <LegacyRouteController pathname={pathname} />;
  }
  return (
    <Suspense fallback={null}>
      <AutomixLab />
    </Suspense>
  );
}

function LegacyFallbackRouteComponent() {
  const { _splat } = Route.useParams();
  const pathname = `/${_splat}`;
  const { data: modules } = useModuleStates();
  if (pathname === '/move') return <MoveLink />;
  if (pathname === '/automix-lab') return <AutomixLabGate pathname={pathname} />;
  // A video page bookmarked while the Video module is off: video-side.js
  // stays on the music side, so say why instead of showing nothing. Shell
  // pages (/chat) keep the legacy route, which shows its own notice.
  const owner =
    modules && !resolveShellPageFromPath(pathname) ? moduleForPath(modules, pathname) : undefined;
  if (owner && !owner.enabled) return <ModuleOffPage module={owner} />;
  return <LegacyRouteController pathname={pathname} />;
}
