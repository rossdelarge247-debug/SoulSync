import { describe, expect, it } from 'vitest';

import type { HomeTarget } from './-home.api';

import { normalizeTarget } from './-home.api';
import { soonestSearchShort, targetCardView, targetTag, type LiveCardView } from './-home.targets';

const NOW = new Date(2026, 9, 21, 19, 30).getTime();
const at = (day: number, hh: number, mm = 0) => new Date(2026, 9, day, hh, mm).getTime() / 1000;

function target(raw: Record<string, unknown>): HomeTarget {
  return normalizeTarget(raw.key as HomeTarget['key'], {
    set_up: true,
    status: 'ok',
    items: 0,
    have: 0,
    in_progress: 0,
    not_found_yet: 0,
    next_search_at: null,
    schedule_paused: false,
    ...raw,
  });
}

const wanted = target({
  key: 'wanted',
  status: 'searching',
  items: 312,
  have: 248,
  in_progress: 41,
  not_found_yet: 23,
  next_search_at: at(21, 21, 30),
});

function live(t: HomeTarget): LiveCardView {
  const view = targetCardView(t, NOW);
  if (view.kind !== 'live') throw new Error('expected a live card');
  return view;
}

describe('a live card', () => {
  it('Wanted: tracks, Searching, three numbers, next search and Open Wanted', () => {
    const view = live(wanted);
    expect(view.label).toBe('Wanted');
    expect(view.title).toBe('312 tracks');
    expect(view.tag).toEqual({ word: 'Searching', tone: 'info', live: true });
    expect(view.percent).toBe(79);
    expect(view.stats.map((s) => [s.label, s.value])).toEqual([
      ['You have', 248],
      ['Searching', 41],
      ['Not found yet', 23],
    ]);
    expect(view.stats[2].shortLabel).toBe('Not found');
    expect(view.meta).toEqual(['Next search in about 2 hours']);
    expect(view.link).toEqual({ route: 'wanted', label: 'Open Wanted' });
    expect(view.problem).toBeNull();
  });

  it('Mirrored playlists and Followed artists say how many playlists and artists', () => {
    const mirrored = live(
      target({ key: 'mirrored', items: 1140, have: 1140, playlists: 3, next_search_at: at(22, 6) }),
    );
    expect(mirrored.title).toBe('3 playlists · 1,140 tracks');
    expect(mirrored.tag).toEqual({ word: 'Complete', tone: 'success' });
    expect(mirrored.meta).toEqual(['Next search tomorrow at 06:00']);
    expect(mirrored.link.label).toBe('Open Mirrored playlists');

    const followed = live(
      target({ key: 'followed', artists: 1, items: 52, have: 45, not_found_yet: 7 }),
    );
    expect(followed.title).toBe('1 artist · 52 new tracks');
    expect(followed.tag).toEqual({ word: 'Not found yet', tone: 'neutral' });
    expect(followed.meta).toEqual(['No search scheduled']);
    expect(followed.link).toEqual({ route: 'followed', label: 'Open Followed artists' });
  });

  it('Quality reads its real name and how many tracks were checked', () => {
    const view = live(
      target({
        key: 'quality',
        status: 'searching',
        name: 'MP3 192 or better',
        tracks_checked: 4980,
        items: 4980,
        have: 4512,
        in_progress: 120,
        not_found_yet: 348,
        next_search_at: at(22, 2),
      }),
    );
    expect(view.title).toBe('MP3 192 or better');
    expect(view.tag.word).toBe('Upgrading');
    expect(view.stats.map((s) => s.label)).toEqual(['At target', 'Upgrading', 'Not found yet']);
    expect(view.meta).toEqual(['4,980 tracks checked', 'Next search tonight at 02:00']);
    // the quality target is changed in its dialog, on Home
    expect(view.link).toEqual({ dialog: 'quality', label: 'Change target' });
    expect(targetTag(target({ key: 'quality', items: 10, have: 10 })).word).toBe('At target');
  });

  it('says when the schedule is paused, and when there is nothing to get', () => {
    const paused = target({
      key: 'wanted',
      status: 'searching',
      items: 3,
      in_progress: 3,
      schedule_paused: true,
    });
    expect(targetTag(paused)).toEqual({ word: 'Paused', tone: 'neutral' });
    expect(live(paused).meta).toEqual(['Automations are paused']);
    const empty = live(target({ key: 'followed', artists: 4 }));
    expect(empty.tag).toEqual({ word: 'Up to date', tone: 'success' });
    expect(empty.percent).toBe(0);
  });
});

describe("the can't search card", () => {
  it('keeps its numbers, says "—" for what is not known, and says why', () => {
    const view = live(
      target({
        key: 'wanted',
        status: 'cant_search',
        items: 312,
        have: 248,
        in_progress: 41,
        not_found_yet: 23,
        reason:
          "Soulseek (slskd) didn't answer when SYNCHRO.S last checked, 4 minutes ago, so searches can't run.",
      }),
    );
    expect(view.tag).toEqual({ word: "Can't search", tone: 'danger' });
    expect(view.stats.map((s) => s.value)).toEqual([248, null, 64]);
    expect(view.problem).toMatch(/^Soulseek \(slskd\) didn't answer/);
    expect(view.percent).toBe(79);
  });
});

describe('a card that is not set up', () => {
  it('has one sentence and one button that goes where the job is done today', () => {
    // a page to go to, or the dialog that does the job on Home
    const cases = [
      ['wanted', 'Add to Wanted', { route: 'search' }],
      ['mirrored', 'Mirror a playlist', { dialog: 'mirror' }],
      ['followed', 'Follow an artist', { route: 'followArtist' }],
      ['quality', 'Set a quality target', { dialog: 'quality' }],
    ] as const;
    for (const [key, label, where] of cases) {
      const view = targetCardView(
        normalizeTarget(key, { set_up: false, status: 'not_set_up' }),
        NOW,
      );
      expect(view.kind).toBe('not-set-up');
      if (view.kind !== 'not-set-up') continue;
      expect(view.tag).toEqual({ word: 'Not set up', tone: 'neutral' });
      expect(view.action).toEqual({ ...where, label });
      expect(view.sentence.split('. ').length).toBeLessThanOrEqual(2);
    }
    const mirrored = targetCardView(normalizeTarget('mirrored', undefined), NOW);
    expect(mirrored.kind === 'not-set-up' && mirrored.title).toBe(
      'Keep a playlist complete in your library',
    );
  });
});

describe('the phone heading', () => {
  it('says the soonest next search once, among targets that can search', () => {
    const quality = target({ key: 'quality', items: 1, have: 1, next_search_at: at(22, 2) });
    expect(soonestSearchShort([wanted, quality], NOW)).toBe('Next search in 2 h');
    const cant = target({
      key: 'wanted',
      status: 'cant_search',
      items: 1,
      next_search_at: at(21, 20),
    });
    expect(soonestSearchShort([cant], NOW)).toBeNull();
    const paused = target({ key: 'wanted', items: 1, schedule_paused: true });
    expect(soonestSearchShort([paused], NOW)).toBe('Automations paused');
  });
});
