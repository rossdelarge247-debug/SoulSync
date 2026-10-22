import { describe, expect, it } from 'vitest';

import { countFor, groupNames, selectedAutomation, visibleAutomations } from './-automations.list';
import { NO_GROUP, parseListSearch, type Automation } from './-automations.types';

const A = (over: Partial<Automation>): Automation => ({
  id: 1,
  name: 'Fill Wanted',
  enabled: 1,
  trigger_type: 'schedule',
  trigger_config: { interval: 6, unit: 'hours' },
  action_type: 'process_wishlist',
  last_run: '2026-10-21 09:15:00',
  ...over,
});

const LIST = [
  A({ id: 9, name: 'Auto-Backup Database', is_system: 1, action_type: 'backup_database' }),
  A({ id: 1 }),
  A({
    id: 2,
    name: 'Check followed artists',
    action_type: 'scan_watchlist',
    group_name: 'Nightly',
  }),
  A({
    id: 3,
    name: 'Upgrade to FLAC',
    enabled: 0,
    action_type: 'apply_quality_upgrades',
    group_name: 'Nightly',
  }),
  A({ id: 4, name: 'Broken', last_error: 'boom' }),
];

describe('the list search', () => {
  it('reads the selection, filters and search', () => {
    expect(
      parseListSearch({ automation: '12', show: 'paused', group: 'Nightly', q: ' wanted ' }),
    ).toEqual({
      automation: 12,
      show: 'paused',
      group: 'Nightly',
      q: 'wanted',
    });
    expect(parseListSearch({ automation: 'x', show: 'all', q: [] })).toEqual({});
  });

  it('keeps old links working', () => {
    expect(parseListSearch({ view: 'library', nav: 'attention' })).toEqual({ show: 'attention' });
    expect(parseListSearch({ nav: 'off' })).toEqual({ show: 'paused' });
    expect(parseListSearch({ nav: 'maintenance' })).toEqual({ show: 'builtin' });
    expect(parseListSearch({ nav: 'group:Nightly' })).toEqual({ group: 'Nightly' });
    expect(parseListSearch({ nav: 'ungrouped' })).toEqual({ show: 'mine', group: NO_GROUP });
    expect(parseListSearch({ health: 'failing' })).toEqual({ show: 'attention' });
    expect(parseListSearch({ nav: 'guides' })).toEqual({ view: 'guides' });
    expect(parseListSearch({ trigger: 'schedule', action: 'scan_library' })).toEqual({
      trigger: 'schedule',
      action: 'scan_library',
    });
  });
});

describe('filtering and selection', () => {
  it('puts yours first, then the built-in ones', () => {
    expect(visibleAutomations(LIST, {}).map((a) => a.id)).toEqual([1, 2, 3, 4, 9]);
  });

  it('filters by show, group, type and words', () => {
    const ids = (search: Parameters<typeof visibleAutomations>[1]) =>
      visibleAutomations(LIST, search).map((a) => a.id);
    expect(ids({ show: 'attention' })).toEqual([4]);
    expect(ids({ show: 'paused' })).toEqual([3]);
    expect(ids({ show: 'builtin' })).toEqual([9]);
    expect(ids({ show: 'mine', group: NO_GROUP })).toEqual([1, 4]);
    expect(ids({ group: 'Nightly' })).toEqual([2, 3]);
    expect(ids({ action: 'scan_watchlist' })).toEqual([2]);
    expect(ids({ q: 'every 6 hours' })).toEqual([1, 2, 3, 4, 9]);
    expect(ids({ q: 'new releases' })).toEqual([2]);
    expect(countFor(LIST, 'attention')).toBe(1);
    expect(groupNames(LIST)).toEqual(['Nightly']);
  });

  it('selects the URL one when it is on screen, else the first', () => {
    const visible = visibleAutomations(LIST, {});
    expect(selectedAutomation(visible, 3)?.id).toBe(3);
    expect(selectedAutomation(visible, 99)?.id).toBe(1);
    expect(selectedAutomation([], 1)).toBeUndefined();
  });
});
