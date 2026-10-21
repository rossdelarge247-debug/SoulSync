/**
 * What a Latest row says: its status word and, for something that needs you,
 * the one link that deals with it. Pure; the rows themselves are in
 * -ui/home/latest-section.tsx.
 */

import type { LatestItem } from './-home.api';
import type { TagView } from './-home.targets';

export function latestTag(item: LatestItem): TagView {
  if (item.needsYou) return { word: 'Needs you', tone: 'warning' };
  switch (item.status) {
    case 'running':
      return { word: 'Running', tone: 'info', live: true };
    case 'ok':
      return { word: 'Done', tone: 'success' };
    case 'warning':
      return { word: 'Partly done', tone: 'warning' };
    case 'error':
      return { word: 'Failed', tone: 'danger' };
    default:
      return { word: 'Info', tone: 'neutral' };
  }
}

/** The action a "needs you" item offers, by kind (the Activity board's words). */
const NEEDS_YOU_ACTIONS: Record<string, string> = {
  safety: 'Preview again',
  import: 'Choose',
  automation: 'Open Automations',
  sync: 'Open Mirrored playlists',
  download: 'Open Downloads',
};

export interface LatestAction {
  label: string;
  href: string;
}

export function latestAction(item: LatestItem): LatestAction | null {
  if (!item.needsYou || !item.link) return null;
  return { label: NEEDS_YOU_ACTIONS[item.kind] ?? 'Open', href: item.link };
}

/**
 * The detail with the action's words linked where the sentence already says
 * them ("Nothing was changed. Preview again to recycle 214 files."), so the
 * link doesn't repeat them; otherwise the link follows the sentence.
 */
export function splitDetail(
  detail: string,
  label: string,
): { before: string; after: string; inline: boolean } {
  const at = detail.indexOf(label);
  if (at === -1) return { before: detail, after: '', inline: false };
  return { before: detail.slice(0, at), after: detail.slice(at + label.length), inline: true };
}
