/**
 * What the "Set a quality target" dialog says (board 2q, 2r), worked out from
 * GET /api/quality/presets and the automations list. Pure, so every sentence
 * is pinned by unit tests.
 */

import type { AutomationRow, CurrentTarget, PresetCount, QualityPresets } from './quality.api';
import type { PresetKey } from './quality.model';

import { PRESET_COPY } from './quality.model';
import { nextRunText, scheduleText } from './schedule';

const number = new Intl.NumberFormat('en-GB');

export function formatCount(value: number): string {
  return number.format(value);
}

/** "4,512 of 4,980 tracks already meet it"; estimated counts say "About". */
export function meetsLine(preset: PresetCount): string {
  const line = `${formatCount(preset.meeting)} of ${formatCount(preset.total)} tracks already meet it`;
  return preset.estimated ? `About ${line.charAt(0).toLowerCase()}${line.slice(1)}` : line;
}

/** The phone's shorter "Hi-res only. About 612 of 4,980 meet it." */
export function shortLine(preset: PresetCount): string {
  const meets = `${formatCount(preset.meeting)} of ${formatCount(preset.total)} meet it.`;
  return `${PRESET_COPY[preset.key].short} ${preset.estimated ? `About ${meets}` : meets}`;
}

/** What upgrades the tracks you already have, if anything does. */
export type UpgradeHelper =
  | { kind: 'ready'; name: string; schedule: string; next: string }
  | { kind: 'off'; name: string }
  | { kind: 'paused'; name: string }
  | { kind: 'none' };

/**
 * The "Apply Quality Upgrades" automation is what queues better copies of
 * tracks below the target on Wanted, and only for a profile that keeps
 * upgrading (core/automation/blocks.py). Several: the soonest enabled one.
 */
export function findUpgradeHelper(
  rows: readonly AutomationRow[] | undefined,
  paused: boolean,
  nowMs: number,
): UpgradeHelper {
  const all = (rows ?? []).filter(
    (row) => row.action_type === 'apply_quality_upgrades' && row.owned_by !== 'video',
  );
  if (!all.length) return { kind: 'none' };
  const enabled = all.filter((row) => Boolean(row.enabled));
  if (!enabled.length) return { kind: 'off', name: all[0].name };
  const soonest = [...enabled].sort((a, b) =>
    String(a.next_run ?? '9999').localeCompare(String(b.next_run ?? '9999')),
  )[0];
  if (paused) return { kind: 'paused', name: soonest.name };
  return {
    kind: 'ready',
    name: soonest.name,
    schedule: scheduleText(soonest.trigger_type, soonest.trigger_config),
    next: nextRunText(soonest.next_run, nowMs),
  };
}

export interface Consequence {
  /** "With FLAC:" */
  lead: string;
  /** What new searches do. */
  searches: string;
  /** Tracks you have below the selected preset. */
  below: number;
  /** The rest of the paragraph: how many are below, and what upgrades them. */
  belowText: string;
  /** The phone's one paragraph (board 2r). */
  short: string;
  /** Show "Upgrade what I already have": something can honour it. */
  canUpgrade: boolean;
}

export function consequence(
  data: QualityPresets,
  selected: PresetKey,
  helper: UpgradeHelper,
): Consequence {
  const preset = data.presets.find((p) => p.key === selected);
  const name = PRESET_COPY[selected].title;
  const fallback = data.current.fallback_enabled !== false;
  const searches = fallback
    ? `new searches look for ${name} or better, and take the best copy they find when there's none at ${name}.`
    : `new searches accept ${name} or better, and nothing below it.`;
  const below = preset ? Math.max(0, preset.total - preset.meeting) : 0;
  const tracks = `${formatCount(below)} ${below === 1 ? 'track' : 'tracks'}`;
  let belowText: string;
  let short: string;
  let canUpgrade = false;
  if (below === 0) {
    belowText = 'Everything you already have meets it.';
    short = `Everything you have meets ${name}.`;
  } else if (helper.kind === 'ready') {
    canUpgrade = true;
    const when = [helper.schedule, helper.next ? `next ${helper.next}` : '']
      .filter(Boolean)
      .join(', ');
    belowText = `${tracks} you already have ${below === 1 ? 'is' : 'are'} below it; ${helper.name} adds better copies of them to Wanted${when ? ` (${when})` : ''}.`;
    short = `${tracks} you have ${below === 1 ? 'is' : 'are'} below ${name}. ${helper.name} adds better copies to Wanted as they turn up.`;
  } else if (helper.kind === 'off' || helper.kind === 'paused') {
    const why = helper.kind === 'off' ? 'is switched off' : 'is paused with the other automations';
    belowText = `${tracks} you already have ${below === 1 ? 'is' : 'are'} below it. ${helper.name} would look for better copies, but it ${why}.`;
    short = `${tracks} you have ${below === 1 ? 'is' : 'are'} below ${name}. ${helper.name} ${why}.`;
  } else {
    belowText = `${tracks} you already have ${below === 1 ? 'is' : 'are'} below it. Nothing replaces them on its own yet: an "Apply Quality Upgrades" automation would.`;
    short = `${tracks} you have ${below === 1 ? 'is' : 'are'} below ${name}. Nothing upgrades them on its own yet.`;
  }
  return { lead: `With ${name}:`, searches, below, belowText, short, canUpgrade };
}

/** The header's sentence (board 2q). */
export function subtitle(helper: UpgradeHelper): string {
  return helper.kind === 'ready'
    ? `The least you'll accept. Searches look for this or better, and ${helper.name} looks for better copies of anything below it.`
    : "The least you'll accept. Searches look for this or better.";
}

/** "Current target: FLAC or better, saved 14 March 2026". */
export function footerText(current: CurrentTarget): string {
  if (!current.updated_at) return `Current target: ${current.name}`;
  const date = new Date(current.updated_at * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return `Current target: ${current.name}, saved ${date}`;
}

/** The preset the dialog opens on: the current one, else FLAC. */
export function initialPreset(current: CurrentTarget | undefined): PresetKey {
  return current?.preset ?? 'flac';
}

/** Nothing to save: the selection is the target you already have. */
export function isUnchanged(
  current: CurrentTarget | undefined,
  selected: PresetKey,
  upgrade: boolean,
  canUpgrade: boolean,
): boolean {
  if (!current || current.preset !== selected) return false;
  if (!canUpgrade) return true;
  return Boolean(current.upgrade_existing) === upgrade;
}
