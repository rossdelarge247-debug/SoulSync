/**
 * What each Home target card says, worked out from one target of the summary.
 * Pure, so every state (live, searching, not set up, can't search) is pinned
 * by unit tests without rendering.
 *
 * Copy follows the boards ("Main v2", "Main (390)", "Flows" 2s) with the real
 * data's limits from docs/design/HANDOFF.md: Wanted counts tracks, Following
 * counts what you follow (every kind the Wanted page's Following tab lists)
 * and the tracks from followed artists' new releases, Quality names its real
 * target.
 */

import type { StatusTagTone } from '@/components/primitives';

import type { FollowingCounts, HomeTarget, TargetKey } from './-home.api';
import type { HomeRouteKey } from './-home.routes';

import { formatCount, nextSearchPhrase, nextSearchShort, plural } from './-home.time';

export const TARGET_LABELS: Record<TargetKey, string> = {
  wanted: 'Wanted',
  mirrored: 'Mirrored playlists',
  followed: 'Following',
  quality: 'Quality',
};

export interface TagView {
  word: string;
  tone: StatusTagTone;
  live?: boolean;
}

export interface StatView {
  label: string;
  /** The phone's shorter label ("Not found"), when it differs. */
  shortLabel?: string;
  /** null: not known right now, shown as "—" */
  value: number | null;
}

/** The dialogs Home opens in place ("Mirror a playlist", "Set a quality target"). */
export type HomeDialog = 'mirror' | 'quality';

/** A link to another page, or a button that opens a dialog on Home. */
export type LinkView =
  | { route: HomeRouteKey; label: string }
  | { dialog: HomeDialog; label: string };

export function isDialogAction(view: LinkView): view is { dialog: HomeDialog; label: string } {
  return 'dialog' in view;
}

export interface LiveCardView {
  kind: 'live';
  key: TargetKey;
  label: string;
  title: string;
  tag: TagView;
  have: number;
  items: number;
  /** 0-100, for the bar */
  percent: number;
  stats: [StatView, StatView, StatView];
  /** The desktop footer's sentence parts, joined with " · " before the link. */
  meta: string[];
  link: LinkView;
  /** cant_search: the sentence saying why; replaces meta and link. */
  problem: string | null;
}

export interface NotSetUpCardView {
  kind: 'not-set-up';
  key: TargetKey;
  label: string;
  tag: TagView;
  title: string;
  sentence: string;
  action: LinkView;
}

export type TargetCardView = LiveCardView | NotSetUpCardView;

const LINKS: Record<TargetKey, LinkView> = {
  wanted: { route: 'wanted', label: 'Open Wanted' },
  mirrored: { route: 'mirrored', label: 'Open Mirrored playlists' },
  followed: { route: 'followed', label: 'Open Following' },
  quality: { dialog: 'quality', label: 'Change target' },
};

/** A card whose target isn't set up: one sentence, one button. */
const NOT_SET_UP: Record<TargetKey, Omit<NotSetUpCardView, 'kind' | 'key' | 'label' | 'tag'>> = {
  wanted: {
    title: 'Get the music you want',
    sentence:
      'Add tracks and albums you want. SYNCHRO.S searches for them on a schedule, at the quality you set.',
    action: { route: 'search', label: 'Add to Wanted' },
  },
  mirrored: {
    title: 'Keep a playlist complete in your library',
    sentence:
      "Pick a playlist from a connected service. SYNCHRO.S finds the tracks you don't have and keeps up as the list changes.",
    action: { dialog: 'mirror', label: 'Mirror a playlist' },
  },
  followed: {
    title: 'Get new releases as they come out',
    sentence:
      'Follow an artist and each new release is added to Wanted and searched for, at the quality you set.',
    action: { route: 'followArtist', label: 'Follow an artist' },
  },
  quality: {
    title: 'Choose the quality you want',
    sentence:
      'Pick a format or bitrate. SYNCHRO.S looks for that quality when it downloads, and can upgrade what you already have.',
    action: { dialog: 'quality', label: 'Set a quality target' },
  },
};

/** The folded panel's four ways in, when nothing is set up (board 1b). */
export const SETUP_PANEL_ITEMS: ReadonlyArray<{
  key: TargetKey;
  title: string;
  sentence: string;
  action: LinkView;
}> = [
  {
    key: 'wanted',
    title: 'Wanted',
    sentence: 'Tracks and albums you want, found as they turn up.',
    action: { route: 'search', label: 'Add to Wanted' },
  },
  {
    key: 'mirrored',
    title: 'Mirrored playlists',
    sentence: 'A playlist kept complete in your library as it changes.',
    action: { dialog: 'mirror', label: 'Mirror a playlist' },
  },
  {
    key: 'followed',
    title: 'Following',
    sentence: 'New releases added to Wanted as they come out.',
    action: { route: 'followArtist', label: 'Follow an artist' },
  },
  {
    key: 'quality',
    title: 'Quality',
    sentence: 'A format or bitrate to upgrade your library towards.',
    action: { dialog: 'quality', label: 'Set a quality target' },
  },
];

export function targetTag(target: HomeTarget): TagView {
  if (!target.setUp) return { word: 'Not set up', tone: 'neutral' };
  if (target.status === 'cant_search') return { word: "Can't search", tone: 'danger' };
  if (target.status === 'searching') {
    // the master switch is off: nothing searches on its own
    if (target.schedulePaused) return { word: 'Paused', tone: 'neutral' };
    return {
      word: target.key === 'quality' ? 'Upgrading' : 'Searching',
      tone: 'info',
      live: true,
    };
  }
  if (target.items === 0) return { word: 'Up to date', tone: 'success' };
  if (target.notFoundYet === 0) {
    return { word: target.key === 'quality' ? 'At target' : 'Complete', tone: 'success' };
  }
  return { word: 'Not found yet', tone: 'neutral' };
}

function title(target: HomeTarget): string {
  switch (target.key) {
    case 'wanted':
      return plural(target.items, 'track');
    case 'mirrored':
      return `${plural(target.playlists ?? 0, 'playlist')} · ${plural(target.items, 'track')}`;
    case 'followed': {
      const kinds = followingKinds(target);
      // one kind: name it ("18 artists"); more: the total ("31 followed")
      const head =
        kinds.length === 1
          ? kinds[0]
          : `${formatCount(target.following?.total ?? target.artists ?? 0)} followed`;
      return `${head} · ${plural(target.items, 'new track')}`;
    }
    case 'quality':
      return target.name ?? 'Your quality target';
  }
}

const KIND_WORDS: ReadonlyArray<[Exclude<keyof FollowingCounts, 'total'>, string]> = [
  ['artists', 'artist'],
  ['labels', 'label'],
  ['podcasts', 'podcast'],
  ['authors', 'author'],
];

/**
 * What the Followed card counts, kind by kind, in the Following tab's order:
 * ["18 artists", "6 labels", "4 podcasts", "3 authors"]. Kinds with none (or
 * not counted, their module off) are left out; an older summary without
 * `following` counts artists only.
 */
export function followingKinds(target: HomeTarget): string[] {
  const f = target.following;
  if (!f) return [plural(target.artists ?? 0, 'artist')];
  const parts = KIND_WORDS.filter(([key]) => (f[key] ?? 0) > 0).map(([key, word]) =>
    plural(f[key] ?? 0, word),
  );
  return parts.length ? parts : [plural(0, 'artist')];
}

/** "Next search in about 2 hours", or why there isn't one. */
export function nextSearchSentence(target: HomeTarget, nowMs: number): string {
  if (target.schedulePaused) return 'Automations are paused';
  if (target.nextSearchAt == null) return 'No search scheduled';
  return `Next search ${nextSearchPhrase(target.nextSearchAt, nowMs)}`;
}

export function targetCardView(target: HomeTarget, nowMs: number): TargetCardView {
  const label = TARGET_LABELS[target.key];
  if (!target.setUp) {
    return {
      kind: 'not-set-up',
      key: target.key,
      label,
      tag: targetTag(target),
      ...NOT_SET_UP[target.key],
    };
  }

  const cantSearch = target.status === 'cant_search';
  const quality = target.key === 'quality';
  // Can't search: nothing is being searched for, so the middle number isn't
  // known ("—") and everything still missing counts as not found yet.
  const middle: StatView = {
    label: quality ? 'Upgrading' : 'Searching',
    value: cantSearch ? null : target.inProgress,
  };
  const missing: StatView = {
    label: 'Not found yet',
    shortLabel: 'Not found',
    value: cantSearch ? target.inProgress + target.notFoundYet : target.notFoundYet,
  };
  const first: StatView = { label: quality ? 'At target' : 'You have', value: target.have };

  const meta: string[] = [];
  if (quality) meta.push(`${formatCount(target.tracksChecked ?? target.items)} tracks checked`);
  if (target.key === 'followed') {
    // more than one kind: the title says the total, the meta says which
    const kinds = followingKinds(target);
    if (kinds.length > 1) meta.push(kinds.join(', '));
  }
  meta.push(nextSearchSentence(target, nowMs));

  const items = target.items;
  return {
    kind: 'live',
    key: target.key,
    label,
    title: title(target),
    tag: targetTag(target),
    have: target.have,
    items,
    percent: items > 0 ? Math.min(100, Math.round((target.have / items) * 100)) : 0,
    stats: [first, middle, missing],
    meta,
    link: LINKS[target.key],
    problem: cantSearch
      ? (target.reason ?? "SYNCHRO.S can't reach your download source, so searches can't run.")
      : null,
  };
}

/**
 * The phone says the next search once, beside the Targets heading: the
 * soonest among targets that can search. null when there's nothing to say.
 */
export function soonestSearchShort(targets: HomeTarget[], nowMs: number): string | null {
  const live = targets.filter((t) => t.setUp && t.status !== 'cant_search');
  if (live.length === 0) return null;
  if (live.every((t) => t.schedulePaused)) return 'Automations paused';
  const times = live
    .filter((t) => !t.schedulePaused && t.nextSearchAt != null)
    .map((t) => t.nextSearchAt as number);
  if (times.length === 0) return null;
  return `Next search ${nextSearchShort(Math.min(...times), nowMs)}`;
}
