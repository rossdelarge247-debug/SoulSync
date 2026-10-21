/**
 * The navigation shell's route map (docs/design/SCREENS.md, "Navigation").
 *
 * Pure data and functions: which sidebar row lights up for a page, where the
 * rows that are waiting on their own pages point today, the page name the top
 * bar shows, and how the badge endpoints' answers are read. The DOM half is
 * nav-shell.ts; the markup is the sidebar in webui/index.html, where every
 * row carries a `data-nav-row` key from NAV_ROWS.
 */

/**
 * Where Wanted and Activity point: their own pages. Changing a target is one
 * line here: nav-shell.ts writes these onto the rows, the top bar's running
 * link and the phone Activity button at boot. Pages that used to own the
 * row stay mapped to it in PAGE_ROWS below, so they keep it lit meanwhile.
 */
export const NAV_TARGETS = {
  wanted: { pageId: 'wanted', path: '/wanted' },
  activity: { pageId: 'activity', path: '/activity' },
} as const;

export type NavTargetKey = keyof typeof NAV_TARGETS;

/** Every row key in the music sidebar, in the order the rows appear. */
export const NAV_ROWS = [
  'home',
  // Get music
  'search',
  'discover',
  'wanted',
  'mirrored',
  'explorer',
  'chat',
  // Library
  'artists',
  'albums',
  'import',
  'stats',
  'podcasts',
  'audiobooks',
  'sample-studio',
  // Automate
  'automations',
  'activity',
  // Settings
  'settings',
  // Admin and help
  'setup-check',
  'hydrabase',
  'maintenance',
  'issues',
  'help',
] as const;

export type NavRowKey = (typeof NAV_ROWS)[number];

/** The phone tab bar's groups, which are also the sidebar's groups. */
export const NAV_GROUPS = ['get-music', 'library', 'automate', 'settings'] as const;
export type NavGroupKey = (typeof NAV_GROUPS)[number];

/** Which group a row sits in (Home and the admin rows sit in none). */
export const ROW_GROUP: Partial<Record<NavRowKey, NavGroupKey>> = {
  search: 'get-music',
  discover: 'get-music',
  wanted: 'get-music',
  mirrored: 'get-music',
  explorer: 'get-music',
  chat: 'get-music',
  artists: 'library',
  albums: 'library',
  import: 'library',
  stats: 'library',
  podcasts: 'library',
  audiobooks: 'library',
  'sample-studio': 'library',
  automations: 'automate',
  activity: 'automate',
  settings: 'settings',
  // the admin fold is the end of the Settings sheet on phones
  'setup-check': 'settings',
  hydrabase: 'settings',
  maintenance: 'settings',
  issues: 'settings',
  help: 'settings',
};

/**
 * Page id (the shell's, as in route-manifest.ts) -> the row it lights. Pages
 * the boards don't place keep the row they belong with: Watchlist and label
 * pages with Wanted, the artist page with Artists, Requests with "Requests
 * and issues".
 */
const LEGACY_PAGE_ROWS: Record<string, NavRowKey> = {
  dashboard: 'home',
  search: 'search',
  discover: 'discover',
  wishlist: 'wanted',
  watchlist: 'wanted',
  'label-detail': 'wanted',
  sync: 'mirrored',
  'playlist-explorer': 'explorer',
  chat: 'chat',
  'artist-detail': 'artists',
  import: 'import',
  stats: 'stats',
  podcasts: 'podcasts',
  audiobooks: 'audiobooks',
  'sample-studio': 'sample-studio',
  automations: 'automations',
  'active-downloads': 'activity',
  settings: 'settings',
  'setup-check': 'setup-check',
  hydrabase: 'hydrabase',
  tools: 'maintenance',
  issues: 'issues',
  requests: 'issues',
  help: 'help',
};

const PAGE_ROWS: Record<string, NavRowKey> = {
  ...LEGACY_PAGE_ROWS,
  // wherever the two rows point (NAV_TARGETS) lights them too
  [NAV_TARGETS.wanted.pageId]: 'wanted',
  [NAV_TARGETS.activity.pageId]: 'activity',
};

/** The library's album grid is the Albums row; everything else there is Artists. */
export function isAlbumView(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'albums';
}

/** The row that lights up for a page, or null when no row owns it. */
export function navRowFor(pageId: string | null | undefined, search = ''): NavRowKey | null {
  if (!pageId) return null;
  if (pageId === 'library') return isAlbumView(search) ? 'albums' : 'artists';
  return PAGE_ROWS[pageId] ?? null;
}

/** The group a page belongs to, for the phone tab bar's current tab. */
export function navGroupFor(pageId: string | null | undefined, search = ''): NavGroupKey | null {
  const row = navRowFor(pageId, search);
  return row ? (ROW_GROUP[row] ?? null) : null;
}

/**
 * Pages whose name differs from the row that lights for them. Everything
 * else shows its row's label.
 */
const PAGE_TITLES: Record<string, string> = {
  dashboard: 'Home',
  watchlist: 'Watchlist',
  requests: 'Requests',
  'artist-detail': 'Artist',
  'label-detail': 'Label',
};

/** The video side's drill-in pages, which have no row. */
const VIDEO_DETAIL_TITLES: Record<string, string> = {
  'video-movie-detail': 'Movie',
  'video-show-detail': 'Show',
  'video-person-detail': 'Person',
  'video-studio-detail': 'Studio',
};

export function pageTitle(pageId: string | null | undefined, rowLabel: string | null): string {
  if (pageId && PAGE_TITLES[pageId]) return PAGE_TITLES[pageId];
  if (rowLabel) return rowLabel;
  return 'SoulSync';
}

export function videoPageTitle(videoPageId: string | null, rowLabel: string | null): string {
  if (videoPageId && VIDEO_DETAIL_TITLES[videoPageId]) return VIDEO_DETAIL_TITLES[videoPageId];
  return rowLabel || 'Video';
}

// ── badges ───────────────────────────────────────────────────────────────────

/** GET /api/activity/status, read. null means unknown (not "none"). */
export interface ActivityStatus {
  running: number | null;
  needsYou: number | null;
}

export const UNKNOWN_ACTIVITY: ActivityStatus = { running: null, needsYou: null };

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * `{"success", "running_count", "needs_you_count", "generated_at"}`. Anything
 * else, including `success: false`, is unknown: the shell hides the running
 * count and the needs-you badge rather than claim nothing is happening.
 */
export function parseActivityStatus(body: unknown): ActivityStatus {
  if (!body || typeof body !== 'object') return UNKNOWN_ACTIVITY;
  const value = body as Record<string, unknown>;
  if (value.success === false) return UNKNOWN_ACTIVITY;
  return { running: count(value.running_count), needsYou: count(value.needs_you_count) };
}

/** The top bar's running link: its words, and whether the live dot shows. */
export function runningCopy(running: number | null): { text: string; live: boolean } {
  if (running === null) return { text: 'Activity', live: false };
  if (running === 0) return { text: 'Nothing running', live: false };
  return { text: `${running} running`, live: true };
}

/** The phone Activity button's accessible name. */
export function activityLabel(status: ActivityStatus): string {
  const parts = ['Activity'];
  if (status.running) parts.push(`${status.running} running`);
  if (status.needsYou) parts.push(`${status.needsYou} need${status.needsYou === 1 ? 's' : ''} you`);
  return parts.join(', ');
}

/** A setup check report's summary -> how many checks need a look (warnings and problems). */
export function setupProblemCount(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const value = summary as Record<string, unknown>;
  const warning = count(value.warning);
  const error = count(value.error);
  if (warning === null && error === null) return null;
  return (warning ?? 0) + (error ?? 0);
}

export function setupProblemText(problems: number): string {
  return problems === 1 ? '1 problem' : `${problems} problems`;
}

/**
 * What a count means, for the compact rail's labels ("Activity, 2 need you").
 * An empty noun reads as the bare number, the way the board writes Wanted.
 */
export const COUNT_NOUNS: Record<string, string> = {
  wanted: '',
  discover: 'new',
  chat: 'unread',
  issues: 'open',
  activity: 'need you',
};

/** "Wanted, 312" / "Activity, 2 need you" (separator ", "), or "Wanted · 312" for a title. */
export function countedLabel(
  label: string,
  badge: string | null,
  noun: string,
  sep = ', ',
): string {
  if (!badge) return label;
  return `${label}${sep}${badge}${noun ? ` ${noun}` : ''}`;
}

/** The ⌘K hint: ⌘ on Apple keyboards, Ctrl elsewhere. */
export function shortcutHint(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K';
}
