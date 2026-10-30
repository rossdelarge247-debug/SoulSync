/**
 * Settings → Library → DJ's "Show the Mix tab" (`library.dj_show_mix_tab`,
 * off by default while Ross rethinks mixing; HANDOFF "Mix tab hidden").
 *
 * Off hides the tray's Mix mode (and the switch, which would hold Now
 * playing alone; DJ now isn't built), the phone sheet's Mix · Set, the
 * Visuals' Mix button and drawer, M / N / A as the Mix tab's keys (M and N
 * mute and skip again), "Mixes well with…" in every track's "…", and with
 * them the tab's rows as drag sources and its set card as a target. A tray
 * left in Mix, or a remembered Mix, falls back to Now playing. Sets, Up
 * next, Between tracks, Play as a mix and the analysis stay.
 *
 * Like the module switches (src/features/modules/), the state the page
 * shell rendered with comes first (`window.SOULSYNC_MIX_TAB`, api/dj.py),
 * so the tray never shows Mix before it knows; then `GET
 * /api/library/dj/status`'s `settings.show_mix_tab` (`noteMixTabSetting`),
 * and Settings' save (static/settings.js fires MIX_TAB_CHANGED_EVENT). Only
 * an explicit true shows it: unknown means hidden.
 */
import { useSyncExternalStore } from 'react';

/** window event: the setting changed. detail: { shown } */
export const MIX_TAB_CHANGED_EVENT = 'soulsync:mix-tab-changed';

function fromShell(): boolean {
  return typeof window !== 'undefined' && window.SOULSYNC_MIX_TAB === true;
}

/** `html[data-mix-tab]` while it shows: CSS hides the tab's own rows otherwise (the `?` list). */
export const MIX_TAB_ATTRIBUTE = 'data-mix-tab';

function mark(on: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.toggleAttribute(MIX_TAB_ATTRIBUTE, on);
}

let shown = fromShell();
mark(shown);
const listeners = new Set<() => void>();
/**
 * Bumped by every change that didn't come from a DJ status read (Settings'
 * save), so a status read that started before one can't undo it.
 */
let localChanges = 0;

/** Whether the Mix tab and its ways in show now. */
export function mixTabShown(): boolean {
  return shown;
}

/** Where a DJ status read starts: pass it to `noteMixTabSetting` with the answer. */
export function mixTabReadMark(): number {
  return localChanges;
}

/**
 * The server's answer. From a DJ status read, pass `startedAt`
 * (`mixTabReadMark()` before the request): an answer from before Settings'
 * latest save is ignored. Without it (Settings' save) it's a local change.
 */
export function noteMixTabSetting(next: unknown, startedAt?: number): void {
  if (typeof next !== 'boolean') return;
  if (startedAt === undefined) localChanges += 1;
  else if (startedAt !== localChanges) return;
  if (next === shown) return;
  shown = next;
  if (typeof window !== 'undefined') window.SOULSYNC_MIX_TAB = next;
  mark(next);
  for (const l of listeners) l();
}

export function subscribeMixTab(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMixTabShown(): boolean {
  return useSyncExternalStore(subscribeMixTab, mixTabShown, mixTabShown);
}

if (typeof window !== 'undefined') {
  window.addEventListener(MIX_TAB_CHANGED_EVENT, (event) => {
    noteMixTabSetting((event as CustomEvent<{ shown?: unknown }>).detail?.shown);
  });
}

/** Tests: as the page shell rendered it (or hidden), nothing remembered. */
export function resetMixTabForTests(next?: unknown): void {
  if (typeof window !== 'undefined') {
    if (next === undefined) delete window.SOULSYNC_MIX_TAB;
    else window.SOULSYNC_MIX_TAB = next;
  }
  shown = fromShell();
  localChanges = 0;
  mark(shown);
  for (const l of listeners) l();
}
