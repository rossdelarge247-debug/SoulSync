/**
 * Every page Home links to, in one place, so a page that moves is a one-line
 * change here.
 *
 * `path` is where the link should go; `fallback` is where it goes when that
 * page isn't in the shell's route manifest.
 */

import { getShellRouteByPath, type ShellPageId } from '@/platform/shell/route-manifest';

export interface HomeRoute {
  path: `/${string}`;
  fallback?: `/${string}`;
}

export const HOME_ROUTES = {
  /** The Wanted page (Wanted + Followed artists). */
  wanted: { path: '/wanted', fallback: '/wishlist' },
  /** The Wanted page's Followed artists tab. */
  followed: { path: '/wanted?tab=followed', fallback: '/watchlist' },
  /** The Activity timeline. */
  activity: { path: '/activity', fallback: '/active-downloads' },
  /** Mirrored playlists: Sync opens on its Mirrored tab, where "Add playlist" starts a mirror. */
  mirrored: { path: '/sync' },
  /** Follow an artist: Followed artists, whose header action is "Follow an artist". */
  followArtist: { path: '/wanted?tab=followed', fallback: '/watchlist' },
  search: { path: '/search' },
  /** The quality target is the default quality profile, on Settings → Quality. */
  quality: { path: '/settings?tab=quality' },
  setupCheck: { path: '/setup-check' },
  automations: { path: '/automations' },
} as const satisfies Record<string, HomeRoute>;

export type HomeRouteKey = keyof typeof HOME_ROUTES;

export interface ResolvedLink {
  /** path + query, without the URL base */
  href: string;
  /** the shell page it opens, for window.navigateToPage */
  pageId: ShellPageId | null;
  /** a ?tab= for Settings, handed to requestSettingsTab before navigating */
  settingsTab: string | null;
}

function pathOnly(href: string): string {
  return href.split(/[?#]/)[0] || '/';
}

/** A path the app can open: in the shell's route manifest. */
export function routeExists(href: string): boolean {
  return Boolean(getShellRouteByPath(pathOnly(href)));
}

export function resolveHref(href: string): ResolvedLink {
  const route = getShellRouteByPath(pathOnly(href));
  const query = href.includes('?') ? new URLSearchParams(href.split('?')[1]) : null;
  return {
    href,
    pageId: route?.pageId ?? null,
    settingsTab: route?.pageId === 'settings' ? (query?.get('tab') ?? null) : null,
  };
}

export function resolveHomeRoute(key: HomeRouteKey): ResolvedLink {
  const route: HomeRoute = HOME_ROUTES[key];
  const href = route.fallback && !routeExists(route.path) ? route.fallback : route.path;
  return resolveHref(href);
}
