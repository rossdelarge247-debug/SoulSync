/**
 * The list's filters and selection. Pure, so the URL is the only state.
 */

import { automationActMode, filterByHealth } from './-automations.helpers';
import { schedulePhrase, stepSentences, type SentenceContext } from './-automations.steps';
import {
  type Automation,
  type AutomationsListSearch,
  type ListShow,
  NO_GROUP,
} from './-automations.types';

function truthy(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

export function isSystem(a: Automation): boolean {
  return truthy(a.is_system);
}

export function isEnabled(a: Automation): boolean {
  return truthy(a.enabled);
}

/** Its last run failed (the engine clears last_error on the next good run). */
export function hasFailed(a: Automation): boolean {
  return Boolean(a.last_error);
}

/** Needs attention: failing, or switched on and never run. */
export function needsAttention(a: Automation): boolean {
  return hasFailed(a) || (isEnabled(a) && !a.last_run);
}

export const SHOW_OPTIONS: { value: ListShow; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'mine', label: 'Yours' },
  { value: 'builtin', label: 'Built-in' },
  { value: 'paused', label: 'Paused' },
];

export function matchesShow(a: Automation, show: ListShow): boolean {
  switch (show) {
    case 'attention':
      return needsAttention(a);
    case 'mine':
      return !isSystem(a);
    case 'builtin':
      return isSystem(a);
    case 'paused':
      return filterByHealth([a], 'off').length > 0;
    default:
      return true;
  }
}

export function groupNames(automations: Automation[]): string[] {
  return [
    ...new Set(
      automations.filter((a) => a.group_name && !isSystem(a)).map((a) => a.group_name as string),
    ),
  ].sort((x, y) => x.localeCompare(y));
}

/**
 * The cards to show, in order: failing first is the Activity page's job; here
 * the order is yours first (newest first, as the API sends them), then the
 * built-in ones, so what you made is at the top.
 */
export function visibleAutomations(
  automations: Automation[],
  search: AutomationsListSearch,
  ctx: SentenceContext = {},
): Automation[] {
  const show = search.show ?? 'all';
  const q = (search.q ?? '').toLowerCase().trim();
  return automations
    .filter((a) => matchesShow(a, show))
    .filter((a) => {
      if (!search.group) return true;
      if (search.group === NO_GROUP) return !isSystem(a) && !a.group_name;
      return !isSystem(a) && a.group_name === search.group;
    })
    .filter((a) => !search.trigger || (a.trigger_type ?? '') === search.trigger)
    .filter((a) => !search.action || (a.action_type ?? '') === search.action)
    .filter((a) => {
      if (!q) return true;
      const haystack = [a.name, schedulePhrase(a, ctx.blocks), ...stepSentences(a, ctx)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    })
    .sort((x, y) => Number(isSystem(x)) - Number(isSystem(y)));
}

export function countFor(automations: Automation[], show: ListShow): number {
  return automations.filter((a) => matchesShow(a, show)).length;
}

/** The selected automation: the URL's, when it's on screen, else the first. */
export function selectedAutomation(
  visible: Automation[],
  id: number | undefined,
): Automation | undefined {
  return (id != null ? visible.find((a) => a.id === id) : undefined) ?? visible[0];
}

/** Whether running it moves or deletes files, so Run now previews first. */
export function movesFiles(a: Pick<Automation, 'action_type' | 'action_config'>): boolean {
  return automationActMode(a as Automation) !== null;
}
