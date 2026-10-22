import { describe, expect, it } from 'vitest';

import type { AutomationRow, QualityPresets } from './quality.api';

import {
  consequence,
  findUpgradeHelper,
  footerText,
  initialPreset,
  isUnchanged,
  meetsLine,
  shortLine,
  subtitle,
} from './quality.view';
import { nextRunText, scheduleText } from './schedule';

const DATA: QualityPresets = {
  total: 4980,
  unknown_format: 12,
  presets: [
    { key: 'mp3_320', name: 'MP3 320', meeting: 4931, total: 4980, estimated: false },
    { key: 'flac', name: 'FLAC', meeting: 4512, total: 4980, estimated: false },
    { key: 'flac_24', name: 'FLAC 24-bit', meeting: 612, total: 4980, estimated: true },
    { key: 'lossless', name: 'Any lossless', meeting: 4980, total: 4980, estimated: false },
  ],
  current: {
    preset: 'flac',
    name: 'FLAC or better',
    quality_profile_id: 1,
    quality_profile_name: 'Default',
    updated_at: 1773489600,
    upgrade_existing: true,
    fallback_enabled: true,
  },
};

const upgrades = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 3,
  name: 'Apply Quality Upgrades',
  enabled: true,
  trigger_type: 'daily_time',
  trigger_config: { time: '02:00' },
  action_type: 'apply_quality_upgrades',
  next_run: null,
  ...over,
});

describe('the preset cards', () => {
  it('say how much of the library meets each, and when that is an estimate', () => {
    expect(meetsLine(DATA.presets[1])).toBe('4,512 of 4,980 tracks already meet it');
    expect(meetsLine(DATA.presets[2])).toBe('About 612 of 4,980 tracks already meet it');
    expect(shortLine(DATA.presets[2])).toBe('Hi-res only. About 612 of 4,980 meet it.');
  });

  it('open on the current target, else FLAC', () => {
    expect(initialPreset(DATA.current)).toBe('flac');
    expect(initialPreset({ ...DATA.current, preset: null })).toBe('flac');
    expect(initialPreset({ ...DATA.current, preset: 'flac_24' })).toBe('flac_24');
    expect(initialPreset(undefined)).toBe('flac');
  });
});

describe('what upgrades what you have', () => {
  it('is the soonest enabled Apply Quality Upgrades automation', () => {
    const helper = findUpgradeHelper(
      [
        upgrades({ id: 1, name: 'Later', next_run: '2026-10-25T02:00:00' }),
        upgrades({ id: 2, name: 'Sooner', next_run: '2026-10-22T02:00:00' }),
        upgrades({ id: 4, name: 'Off', enabled: false }),
        { id: 5, name: 'Other', action_type: 'refresh_mirrored', enabled: true },
      ],
      false,
      Date.parse('2026-10-21T12:00:00Z'),
    );
    expect(helper).toMatchObject({ kind: 'ready', name: 'Sooner', schedule: 'every day at 02:00' });
  });

  it('is off, paused or missing', () => {
    expect(findUpgradeHelper([upgrades({ enabled: false })], false, 0)).toEqual({
      kind: 'off',
      name: 'Apply Quality Upgrades',
    });
    expect(findUpgradeHelper([upgrades()], true, 0)).toEqual({
      kind: 'paused',
      name: 'Apply Quality Upgrades',
    });
    expect(findUpgradeHelper([], false, 0)).toEqual({ kind: 'none' });
    expect(findUpgradeHelper([upgrades({ owned_by: 'video' })], false, 0)).toEqual({
      kind: 'none',
    });
  });

  it('reads schedules in words', () => {
    expect(scheduleText('schedule', { interval: 24, unit: 'hours' })).toBe('every 24 hours');
    expect(scheduleText('schedule', { interval: 1, unit: 'day' })).toBe('every day');
    expect(scheduleText('weekly_time', { days: ['mon', 'thu'], time: '6:00' })).toBe(
      'every Monday and Thursday at 06:00',
    );
    expect(scheduleText('monthly_time', { day_of_month: 3, time: '04:30' })).toBe(
      'on day 3 of each month at 04:30',
    );
    expect(scheduleText('playlist_changed', {})).toBe('');
    expect(nextRunText(null, 0)).toBe('');
    expect(nextRunText('2020-01-01T00:00:00', Date.now())).toBe('soon');
  });
});

describe('the consequence panel', () => {
  it('names what new searches do and what upgrades the rest', () => {
    const view = consequence(DATA, 'flac', {
      kind: 'ready',
      name: 'Apply Quality Upgrades',
      schedule: 'every day at 02:00',
      next: '',
    });
    expect(view.lead).toBe('With FLAC:');
    expect(view.searches).toBe(
      "new searches look for FLAC or better, and take the best copy they find when there's none at FLAC.",
    );
    expect(view.belowText).toBe(
      '468 tracks you already have are below it; Apply Quality Upgrades adds better copies of them to Wanted (every day at 02:00).',
    );
    expect(view.canUpgrade).toBe(true);
  });

  it('offers no upgrade when nothing can do it, and says why', () => {
    const none = consequence(DATA, 'flac_24', { kind: 'none' });
    expect(none.canUpgrade).toBe(false);
    expect(none.belowText).toBe(
      '4,368 tracks you already have are below it. Nothing replaces them on its own yet: an "Apply Quality Upgrades" automation would.',
    );
    const off = consequence(DATA, 'flac', { kind: 'off', name: 'Apply Quality Upgrades' });
    expect(off.canUpgrade).toBe(false);
    expect(off.belowText).toContain('but it is switched off');
  });

  it('says when everything already meets it, and when there is no fallback', () => {
    const view = consequence(
      { ...DATA, current: { ...DATA.current, fallback_enabled: false } },
      'lossless',
      { kind: 'none' },
    );
    expect(view.belowText).toBe('Everything you already have meets it.');
    expect(view.searches).toBe('new searches accept Any lossless or better, and nothing below it.');
  });

  it('has a header and a footer', () => {
    expect(subtitle({ kind: 'none' })).toBe(
      "The least you'll accept. Searches look for this or better.",
    );
    expect(footerText(DATA.current)).toBe('Current target: FLAC or better, saved 14 March 2026');
    expect(footerText({ ...DATA.current, updated_at: null })).toBe(
      'Current target: FLAC or better',
    );
  });

  it('knows when nothing would change', () => {
    expect(isUnchanged(DATA.current, 'flac', true, true)).toBe(true);
    expect(isUnchanged(DATA.current, 'flac', false, true)).toBe(false);
    expect(isUnchanged(DATA.current, 'flac', false, false)).toBe(true);
    expect(isUnchanged(DATA.current, 'mp3_320', true, true)).toBe(false);
  });
});
