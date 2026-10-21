import { useRouteContext, useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useLayoutEffect } from 'react';

import { appURL } from '@/platform/url-base';

import { getProfileHomePath, type ShellContext, type ShellPageId } from './bridge';

export const ROUTER_ROOT_ID = 'webui-react-root';

export function useShellContext(): ShellContext {
  const context = useRouteContext({
    from: '__root__',
    select: (routeContext) => routeContext.shell,
  });
  return context;
}

export function useShellBridge() {
  return useShellContext().bridge;
}

export function useProfile() {
  return useShellContext().profile;
}

export function useShellStatus() {
  return useShellContext().status ?? null;
}

export function LegacyRouteController({ pathname }: { pathname: string }) {
  const bridge = useShellBridge();

  useEffect(() => {
    if (!bridge) return;
    bridge.activateLegacyPath(pathname);
  }, [bridge, pathname]);

  return null;
}

export function useReactPageShell(pageId: ShellPageId) {
  const bridge = useShellBridge();
  const router = useRouter();

  useLayoutEffect(() => {
    if (!bridge) return;
    if (!bridge.isPageAllowed(pageId)) return;

    bridge.setActivePageChrome(pageId);
    bridge.showReactHost(pageId);
  }, [bridge, pageId]);

  useEffect(() => {
    if (!bridge) return;

    if (!bridge.isPageAllowed(pageId)) {
      void router.navigate({ href: appURL(getProfileHomePath(bridge)), replace: true });
      return;
    }
  }, [bridge, pageId, router]);

  return bridge;
}

/** Announced on window after every router location change (src/shell/nav-shell.ts). */
export const SHELL_LOCATION_EVENT = 'ss:shell-location';

/**
 * Tells the navigation shell the URL changed. Most changes also go through
 * setActivePageChrome, but a change inside one page doesn't (the library's
 * Artists / Albums views are /library and /library?view=albums), and the
 * shell's current row and back / forward buttons follow the full URL.
 */
export function ShellLocationReporter() {
  const href = useRouterState({ select: (state) => state.location.href });
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(SHELL_LOCATION_EVENT, { detail: { href } }));
  }, [href]);
  return null;
}
