/**
 * Home's data: the four targets (GET /api/targets/summary) and the newest
 * activity (GET /api/activity). Shapes are in docs/design/CONTRACTS.md.
 *
 * Both answers are normalised into small camelCase objects here, so the cards
 * never read a raw payload and a missing field is a 0 or a null, never an
 * undefined deep in the markup.
 */

import { queryOptions } from '@tanstack/react-query';

import { apiClient, readJson } from '@/app/api-client';

export type TargetKey = 'wanted' | 'mirrored' | 'followed' | 'quality';
export type TargetStatus = 'not_set_up' | 'cant_search' | 'searching' | 'ok';

/** The summary's fixed order, which Home keeps whatever the payload says. */
export const TARGET_ORDER: readonly TargetKey[] = ['wanted', 'mirrored', 'followed', 'quality'];

export interface HomeTarget {
  key: TargetKey;
  setUp: boolean;
  status: TargetStatus;
  /** items = have + inProgress + notFoundYet, in tracks */
  items: number;
  have: number;
  inProgress: number;
  notFoundYet: number;
  nextSearchAt: number | null;
  nextSearchAutomation: { id: number; name: string } | null;
  schedulePaused: boolean;
  /** cant_search only: the sentence saying why */
  reason: string | null;
  checkedAt: number | null;
  /** mirrored: how many playlists */
  playlists: number | null;
  /** followed: how many artists */
  artists: number | null;
  /**
   * followed: everything the Following tab lists, by kind. podcasts and
   * authors are null while their module is off (or the profile can't see
   * Audiobooks), and then left out of total.
   */
  following: FollowingCounts | null;
  /** quality: the target's name ("FLAC or better") */
  name: string | null;
  /** quality: library tracks checked against it */
  tracksChecked: number | null;
}

export interface FollowingCounts {
  total: number;
  artists: number;
  labels: number;
  podcasts: number | null;
  authors: number | null;
}

export interface TargetsSummary {
  targets: HomeTarget[];
  /** false: none of Wanted, Mirrored, Followed is set up (quality never counts) */
  anySetUp: boolean;
  generatedAt: number | null;
}

export type ActivityStatus = 'running' | 'ok' | 'warning' | 'error' | 'info';

export interface LatestItem {
  id: string;
  time: number;
  kind: string;
  status: ActivityStatus;
  title: string;
  detail: string;
  link: string | null;
  needsYou: boolean;
}

/** How many activity items Home shows. */
export const LATEST_LIMIT = 3;
/** Numbers refresh server-side at most every 30 s; poll no faster. */
export const HOME_REFRESH_MS = 30_000;

const STATUSES: readonly TargetStatus[] = ['not_set_up', 'cant_search', 'searching', 'ok'];
const ACTIVITY_STATUSES: readonly ActivityStatus[] = ['running', 'ok', 'warning', 'error', 'info'];

type Raw = Record<string, unknown>;

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function optionalCount(value: unknown): number | null {
  return value == null ? null : count(value);
}

function seconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : value == null ? NaN : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function notSetUp(key: TargetKey): HomeTarget {
  return {
    key,
    setUp: false,
    status: 'not_set_up',
    items: 0,
    have: 0,
    inProgress: 0,
    notFoundYet: 0,
    nextSearchAt: null,
    nextSearchAutomation: null,
    schedulePaused: false,
    reason: null,
    checkedAt: null,
    playlists: null,
    artists: null,
    following: null,
    name: null,
    tracksChecked: null,
  };
}

function normalizeFollowing(value: unknown): FollowingCounts | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Raw;
  const kinds = {
    artists: count(raw.artists),
    labels: count(raw.labels),
    podcasts: optionalCount(raw.podcasts),
    authors: optionalCount(raw.authors),
  };
  const sum = kinds.artists + kinds.labels + (kinds.podcasts ?? 0) + (kinds.authors ?? 0);
  return { total: raw.total == null ? sum : count(raw.total), ...kinds };
}

export function normalizeTarget(key: TargetKey, raw: Raw | undefined): HomeTarget {
  if (!raw) return notSetUp(key);
  const setUp = raw.set_up !== false;
  const status = STATUSES.includes(raw.status as TargetStatus)
    ? (raw.status as TargetStatus)
    : setUp
      ? 'ok'
      : 'not_set_up';
  const automation = raw.next_search_automation as Raw | null | undefined;
  return {
    key,
    setUp: setUp && status !== 'not_set_up',
    status,
    items: count(raw.items),
    have: count(raw.have),
    inProgress: count(raw.in_progress),
    notFoundYet: count(raw.not_found_yet),
    nextSearchAt: seconds(raw.next_search_at),
    nextSearchAutomation:
      automation && typeof automation === 'object'
        ? { id: count(automation.id), name: text(automation.name) ?? '' }
        : null,
    schedulePaused: raw.schedule_paused === true,
    reason: status === 'cant_search' ? text(raw.reason) : null,
    checkedAt: seconds(raw.checked_at),
    playlists: optionalCount(raw.playlists),
    artists: optionalCount(raw.artists),
    following: normalizeFollowing(raw.following),
    name: text(raw.name),
    tracksChecked: optionalCount(raw.tracks_checked),
  };
}

export function normalizeSummary(payload: unknown): TargetsSummary {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Raw;
  const list = Array.isArray(body.targets) ? (body.targets as Raw[]) : [];
  const byKey = new Map<string, Raw>();
  for (const raw of list) {
    if (raw && typeof raw === 'object' && typeof raw.key === 'string') byKey.set(raw.key, raw);
  }
  const targets = TARGET_ORDER.map((key) => normalizeTarget(key, byKey.get(key)));
  const anySetUp =
    typeof body.any_set_up === 'boolean'
      ? body.any_set_up
      : targets.some((t) => t.key !== 'quality' && t.setUp);
  return { targets, anySetUp, generatedAt: seconds(body.generated_at) };
}

export function normalizeLatest(payload: unknown): LatestItem[] {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Raw;
  const items = Array.isArray(body.items) ? (body.items as Raw[]) : [];
  return (
    items
      .filter((raw): raw is Raw => Boolean(raw) && typeof raw === 'object')
      // radio's auto-add roll-ups don't count towards Home (Ross, 22 October)
      .filter((raw) => raw.kind !== 'radio')
      .map((raw, index) => ({
        id: text(raw.id) ?? `item-${index}`,
        time: seconds(raw.time) ?? 0,
        kind: text(raw.kind) ?? 'other',
        status: ACTIVITY_STATUSES.includes(raw.status as ActivityStatus)
          ? (raw.status as ActivityStatus)
          : 'info',
        title: text(raw.title) ?? 'Something happened',
        detail: text(raw.detail) ?? '',
        link: text(raw.link),
        needsYou: raw.needs_you === true,
      }))
      .slice(0, LATEST_LIMIT)
  );
}

export async function fetchTargetsSummary(): Promise<TargetsSummary> {
  const payload = await readJson<Raw>(apiClient.get('targets/summary'));
  if (payload.success === false) {
    throw new Error(text(payload.error) ?? "Couldn't work out your targets");
  }
  return normalizeSummary(payload);
}

export async function fetchLatestActivity(): Promise<LatestItem[]> {
  // 30 days, the widest range: a quiet week shouldn't read as "nothing yet"
  const payload = await readJson<Raw>(
    apiClient.get('activity', { searchParams: { range: '30d', limit: LATEST_LIMIT } }),
  );
  if (payload.success === false) throw new Error(text(payload.error) ?? "Couldn't load activity");
  return normalizeLatest(payload);
}

export interface SourceCheckResult {
  ok: boolean;
  /** What the check said, to show when it still fails. */
  message: string | null;
}

/**
 * "Try now" on a card that can't search: the same download-source check the
 * Settings test button runs (POST /api/test-connection, service "soulseek"
 * tests whichever download source is configured). A check that passes updates
 * the server's cached status, so the next summary stops saying "Can't search".
 */
export async function checkDownloadSource(): Promise<SourceCheckResult> {
  const payload = await readJson<Raw>(
    apiClient.post('test-connection', { json: { service: 'soulseek' }, timeout: 30_000 }),
  );
  const ok = payload.success === true;
  return { ok, message: ok ? null : text(payload.error) };
}

export const HOME_QUERY_KEY = ['home'] as const;

export function targetsSummaryQueryOptions(profileId: number | null) {
  return queryOptions({
    queryKey: [...HOME_QUERY_KEY, 'targets', profileId],
    queryFn: fetchTargetsSummary,
    refetchInterval: HOME_REFRESH_MS,
    // catch up the moment the tab is looked at again (the interval pauses
    // while it's hidden)
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

export function latestActivityQueryOptions(profileId: number | null) {
  return queryOptions({
    queryKey: [...HOME_QUERY_KEY, 'latest', profileId],
    queryFn: fetchLatestActivity,
    refetchInterval: HOME_REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}
