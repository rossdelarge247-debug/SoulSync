/**
 * Home's links. Each is a real <a> (open in a new tab, copy the address) that
 * moves within the app through window.navigateToPage, the shell's one
 * cross-page entry, so the sidebar follows. A link to a page this profile
 * can't open isn't drawn at all (links are never disabled; the action hides).
 */

import { createContext, useContext, type MouseEvent, type ReactNode } from 'react';

import type { ShellPageId } from '@/platform/shell/route-manifest';

import { appURL } from '@/platform/url-base';

import {
  resolveHomeRoute,
  resolveHref,
  type HomeRouteKey,
  type ResolvedLink,
} from '../../-home.routes';

export interface HomeNav {
  isAdmin: boolean;
  isPageAllowed: (pageId: ShellPageId) => boolean;
}

const fallbackNav: HomeNav = {
  isAdmin: false,
  isPageAllowed: (pageId) => window.SoulSyncWebShellBridge?.isPageAllowed(pageId) ?? true,
};

const HomeNavContext = createContext<HomeNav>(fallbackNav);

export function HomeNavProvider({ value, children }: { value: HomeNav; children: ReactNode }) {
  return <HomeNavContext.Provider value={value}>{children}</HomeNavContext.Provider>;
}

export function useHomeNav(): HomeNav {
  return useContext(HomeNavContext);
}

/** Open a link inside the app; false when it has to be a normal page load. */
export function openInApp(link: ResolvedLink): boolean {
  const go = window.navigateToPage;
  if (!go || !link.pageId) return false;
  if (link.settingsTab) window.requestSettingsTab?.(link.settingsTab);
  void go(link.pageId);
  return true;
}

function onLinkClick(link: ResolvedLink) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (openInApp(link)) event.preventDefault();
  };
}

export function useLinkAllowed(link: ResolvedLink): boolean {
  const nav = useHomeNav();
  return !link.pageId || nav.isPageAllowed(link.pageId);
}

interface LinkProps {
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
}

/** A link to one of Home's routes (-home.routes.ts). */
export function HomeLink({ route, ...props }: LinkProps & { route: HomeRouteKey }) {
  return <PathLink link={resolveHomeRoute(route)} {...props} />;
}

/** A link to a path the server gave us (an activity item's `link`). */
export function HrefLink({ href, ...props }: LinkProps & { href: string }) {
  return <PathLink link={resolveHref(href)} {...props} />;
}

function PathLink({ link, className, children, ...rest }: LinkProps & { link: ResolvedLink }) {
  const allowed = useLinkAllowed(link);
  if (!allowed) return null;
  return (
    <a className={className} href={appURL(link.href)} onClick={onLinkClick(link)} {...rest}>
      {children}
    </a>
  );
}
