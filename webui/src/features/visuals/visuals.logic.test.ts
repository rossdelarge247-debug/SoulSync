import { describe, expect, it } from 'vitest';

import type { PresetEntry } from './visuals.types';

import {
  agoWords,
  autocycleChoices,
  autocycleSeconds,
  autocycleWords,
  browserSummary,
  byLine,
  creditLine,
  filterPresets,
  formatSize,
  FrameRateGuard,
  isSilent,
  listSummary,
  lowerQuality,
  matchesQuery,
  normaliseAutocycle,
  normaliseQuality,
  overlayKey,
  ownFolderLine,
  pushRecent,
  qualityPixelRatio,
  randomKey,
  RECENT_MAX,
  stepKey,
  stillReason,
  withKept,
} from './visuals.logic';

const p = (key: string, name: string, author: string | null, size = 2000): PresetEntry => ({
  key,
  name,
  author,
  full_name: author ? `${author} - ${name}` : name,
  size,
  source: 'bundled',
});

const ALL = [
  p('a', 'Angel Rails', 'Hapax'),
  p('d', 'Diffusion Field', 'Orrery'),
  p('h', 'Hive Logic', 'Flux'),
  p('s', 'Spiral Artefact', 'flux'),
  p('x', '11', null),
];

describe('the list (10a)', () => {
  it('search matches every word against names and authors', () => {
    expect(matchesQuery(ALL[2]!, 'hive')).toBe(true);
    expect(matchesQuery(ALL[2]!, 'flux logic')).toBe(true);
    expect(matchesQuery(ALL[2]!, 'flux rails')).toBe(false);
    expect(matchesQuery(ALL[0]!, '  ')).toBe(true);
  });

  it('All is A–Z as given; Favourites keep that order; Recent is newest first', () => {
    const base = {
      query: '',
      author: '',
      favourites: new Set(['h', 'a']),
      recent: ['s', 'a'],
    };
    expect(filterPresets(ALL, { ...base, show: 'all' }).map((x) => x.key)).toEqual([
      'a',
      'd',
      'h',
      's',
      'x',
    ]);
    expect(filterPresets(ALL, { ...base, show: 'favourites' }).map((x) => x.key)).toEqual([
      'a',
      'h',
    ]);
    expect(filterPresets(ALL, { ...base, show: 'recent' }).map((x) => x.key)).toEqual(['s', 'a']);
  });

  it('the author filter ignores case and combines with the search', () => {
    const base = {
      show: 'all' as const,
      favourites: new Set<string>(),
      recent: [],
    };
    expect(filterPresets(ALL, { ...base, query: '', author: 'FLUX' }).map((x) => x.key)).toEqual([
      'h',
      's',
    ]);
    expect(
      filterPresets(ALL, { ...base, query: 'spiral', author: 'flux' }).map((x) => x.key),
    ).toEqual(['s']);
  });

  it('the count line says how many presets and authors (board 10a)', () => {
    expect(listSummary(ALL, 'all')).toBe('5 presets · A–Z · 3 authors');
    expect(listSummary(ALL.slice(0, 1), 'recent')).toBe('1 preset · newest first · 1 author');
    const many = Array.from({ length: 2412 }, (_, i) => p(`k${i}`, `n${i}`, `a${i % 38}`));
    expect(listSummary(many, 'all')).toBe('2,412 presets · A–Z · 38 authors');
  });

  it('Recent keeps each preset once, newest first, capped', () => {
    expect(pushRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
    const long = Array.from({ length: RECENT_MAX }, (_, i) => `k${i}`);
    expect(pushRecent(long, 'new')).toHaveLength(RECENT_MAX);
    expect(pushRecent(long, 'new')[0]).toBe('new');
  });

  it('V and Shift+V step through the list, wrap, and skip presets that won’t load', () => {
    expect(stepKey(ALL, 'a', 1)).toBe('d');
    expect(stepKey(ALL, 'x', 1)).toBe('a');
    expect(stepKey(ALL, 'a', -1)).toBe('x');
    expect(stepKey(ALL, 'a', 1, new Set(['d', 'h']))).toBe('s');
    expect(stepKey(ALL, null, 1)).toBe('a');
    expect(stepKey(ALL, 'missing', -1)).toBe('x');
    expect(stepKey([], 'a', 1)).toBeNull();
    expect(stepKey([{ key: 'a' }], 'a', 1)).toBeNull();
  });

  it('Random never repeats the current preset or picks a broken one', () => {
    expect(randomKey(ALL, 'a', new Set(['d', 'h', 's']), () => 0.99)).toBe('x');
    expect(randomKey([{ key: 'a' }], 'a')).toBeNull();
  });

  it('sizes and the by-line read like the board', () => {
    expect(formatSize(2.1 * 1024 * 1024)).toBe('2.1 MB');
    expect(formatSize(400 * 1024)).toBe('0.4 MB');
    expect(formatSize(12 * 1024)).toBe('12 KB');
    expect(formatSize(0)).toBe('');
    expect(byLine({ author: 'Flux' })).toBe('by Flux');
    expect(byLine({ author: null })).toBe('author unknown');
  });
});

describe('auto-cycle (Ross: Off by default)', () => {
  it('reads anything unknown as Off', () => {
    expect(normaliseAutocycle(undefined)).toBe('off');
    expect(normaliseAutocycle('nonsense')).toBe('off');
    expect(normaliseAutocycle('120')).toBe('120');
  });

  it('offers the board’s four, plus an older saved value', () => {
    expect(autocycleChoices('off').map((c) => c.label)).toEqual([
      'Off',
      'Every 30 s',
      'Every 2 min',
      'On track change',
    ]);
    expect(autocycleChoices('300').map((c) => c.label)).toContain('Every 5 min');
  });

  it('says how often in words, and in seconds for the timer', () => {
    expect(autocycleSeconds('30')).toBe(30);
    expect(autocycleSeconds('track')).toBe(0);
    expect(autocycleSeconds('off')).toBe(0);
    expect(autocycleWords('120')).toBe('every 2 min');
    expect(autocycleWords('30')).toBe('every 30 s');
    expect(autocycleWords('track')).toBe('on track change');
    expect(autocycleWords('off')).toBe('');
  });
});

describe('Quality and the frame-rate guard', () => {
  it('phones start at Full like desktop; the scale follows the screen, capped at 2', () => {
    expect(normaliseQuality(null)).toBe('full');
    expect(qualityPixelRatio('full', 3)).toBe(2);
    expect(qualityPixelRatio('half', 2)).toBe(1);
    expect(qualityPixelRatio('quarter', 1)).toBe(0.25);
    expect(lowerQuality('full')).toBe('half');
    expect(lowerQuality('half')).toBe('quarter');
    expect(lowerQuality('quarter')).toBeNull();
  });

  const run = (guard: FrameRateGuard, fps: number, seconds: number, start = 0) => {
    let fired = 0;
    let t = start;
    const step = 1000 / fps;
    while (t < start + seconds * 1000) {
      if (guard.frame(t)) fired += 1;
      t += step;
    }
    return { fired, t };
  };

  it('under 24 fps for 5 s drops Quality once', () => {
    const g = new FrameRateGuard();
    expect(run(g, 15, 4.5).fired).toBe(0);
    const g2 = new FrameRateGuard();
    expect(run(g2, 15, 7).fired).toBe(1);
    // once per preset: still slow, nothing more
    expect(run(g2, 10, 10, 7000).fired).toBe(0);
    expect(g2.armed).toBe(false);
  });

  it('a smooth picture, or a brief stutter, leaves it alone', () => {
    expect(run(new FrameRateGuard(), 60, 20).fired).toBe(0);
    const g = new FrameRateGuard();
    const a = run(g, 15, 3);
    const b = run(g, 60, 2, a.t);
    expect(run(g, 15, 3, b.t).fired).toBe(0);
  });

  it('a new preset arms it again; "Put it back" disarms it', () => {
    const g = new FrameRateGuard();
    run(g, 10, 7);
    g.reset();
    expect(g.armed).toBe(true);
    g.disarm();
    expect(run(g, 10, 10).fired).toBe(0);
  });

  it('a hidden tab is a gap, not slowness', () => {
    const g = new FrameRateGuard();
    run(g, 15, 4);
    g.pause();
    expect(run(g, 15, 4, 60_000).fired).toBe(0);
  });
});

describe('the credit (10c)', () => {
  it('names the author, the family, n of N and what moved it', () => {
    expect(
      creditLine({
        author: 'Hapax',
        family: 'milkdrop',
        position: 4,
        total: 2412,
        moved: 'track',
        autocycle: 'track',
      }),
    ).toBe('by Hapax · MilkDrop · 4 of 2,412 · on track change');
    expect(
      creditLine({
        author: null,
        family: 'classic',
        position: 1,
        total: 2,
        moved: 'next',
        autocycle: 'off',
      }),
    ).toBe('Classic · drawn by SYNCHRO.S · 1 of 2 · next');
    expect(
      creditLine({
        author: null,
        family: 'synchros',
        position: 6,
        total: 18,
        moved: 'random',
        autocycle: 'off',
      }),
    ).toBe('drawn by SYNCHRO.S · 6 of 18 · random');
    expect(
      creditLine({
        author: null,
        family: 'milkdrop',
        position: 0,
        total: 0,
        moved: 'picked',
        autocycle: 'off',
      }),
    ).toBe('author unknown · MilkDrop · you picked it');
  });
});

describe('the overlay keys (10a; HANDOFF 83)', () => {
  it('V next, Shift+V previous, R random, S favourite; L is never the overlay’s', () => {
    expect(overlayKey({ key: 'v' })).toBe('next');
    expect(overlayKey({ key: 'V', shiftKey: true })).toBe('previous');
    expect(overlayKey({ key: 'r' })).toBe('random');
    expect(overlayKey({ key: 'S' })).toBe('favourite');
    expect(overlayKey({ key: 's' })).toBe('favourite');
    expect(overlayKey({ key: 'S', shiftKey: true })).toBeNull();
    expect(overlayKey({ key: 'l' })).toBeNull();
    expect(overlayKey({ key: 'L' })).toBeNull();
  });

  it('nothing with a modifier, in a field, or for other keys', () => {
    expect(overlayKey({ key: 'v', ctrlKey: true })).toBeNull();
    expect(overlayKey({ key: 's', inField: true })).toBeNull();
    expect(overlayKey({ key: 'f' })).toBeNull();
  });
});

describe('the states (10d)', () => {
  it('Reduce motion opens the overlay still, unless played this time', () => {
    expect(
      stillReason({
        systemReduce: true,
        settingReduce: false,
        playAnyway: false,
      }),
    ).toBe('system');
    expect(
      stillReason({
        systemReduce: false,
        settingReduce: true,
        playAnyway: false,
      }),
    ).toBe('setting');
    expect(
      stillReason({
        systemReduce: true,
        settingReduce: true,
        playAnyway: true,
      }),
    ).toBeNull();
    expect(
      stillReason({
        systemReduce: false,
        settingReduce: false,
        playAnyway: false,
      }),
    ).toBeNull();
  });

  it('silence is 128 in a time-domain buffer', () => {
    expect(isSilent(new Uint8Array(64).fill(128))).toBe(true);
    const sound = new Uint8Array(64).fill(128);
    sound[10] = 200;
    expect(isSilent(sound)).toBe(false);
  });
});

describe('MilkDrop’s curated list and your own presets (18a, 18b)', () => {
  const own = (key: string, name: string): PresetEntry => ({
    ...p(key, name, 'ross'),
    source: 'own',
  });
  const LISTED = [
    p('a', 'Angel Rails', 'Hapax'),
    own('o', 'Kelp Forest'),
    p('h', 'Hive Logic', 'Flux'),
  ];
  const KEPT = [p('z', 'Bad Words', 'Anon')];
  const base = {
    query: '',
    author: '',
    favourites: new Set<string>(),
    recent: [] as string[],
  };

  it('Favourites and Recent keep a preset the curated set leaves out; All doesn’t list it', () => {
    expect(filterPresets(LISTED, { ...base, show: 'all', kept: KEPT }).map((x) => x.key)).toEqual([
      'a',
      'o',
      'h',
    ]);
    expect(
      filterPresets(LISTED, {
        ...base,
        show: 'favourites',
        favourites: new Set(['z', 'h']),
        kept: KEPT,
      }).map((x) => x.key),
    ).toEqual(['z', 'h']);
    expect(
      filterPresets(LISTED, {
        ...base,
        show: 'recent',
        recent: ['z', 'a'],
        kept: KEPT,
      }).map((x) => x.key),
    ).toEqual(['z', 'a']);
    expect(withKept(LISTED, [LISTED[0]!])).toHaveLength(3);
  });

  it('Yours lists only your own', () => {
    expect(filterPresets(LISTED, { ...base, show: 'yours' }).map((x) => x.key)).toEqual(['o']);
  });

  it('the count line says where the list comes from while All lists everything', () => {
    const f = {
      show: 'all' as const,
      query: '',
      author: '',
      everyPreset: false,
    };
    expect(browserSummary(LISTED, f)).toBe('2 from the curated packs and 1 of yours · A–Z');
    expect(
      browserSummary(
        LISTED.filter((x) => x.source !== 'own'),
        f,
      ),
    ).toBe('2 from the curated packs · A–Z');
    expect(browserSummary(LISTED, { ...f, everyPreset: true })).toBe(
      '2 from every pack and 1 of yours · A–Z',
    );
    expect(browserSummary(LISTED.slice(0, 1), { ...f, query: 'angel' })).toBe(
      '1 preset · A–Z · 1 author',
    );
  });

  it('the own-presets line: read, empty (warning), unreadable (danger), in words', () => {
    const now = 1_000_000;
    expect(ownFolderLine(null, '/config/milkdrop')).toBeNull();
    expect(ownFolderLine({ configured: false, count: 0, problem: null }, '')?.tone).toBeNull();
    expect(
      ownFolderLine(
        {
          configured: true,
          count: 12,
          problem: null,
          too_big: 1,
          read_at: now - 130,
        },
        '/config/milkdrop',
        now,
      ),
    ).toEqual({
      tone: 'success',
      words: '12 presets, read 2 minutes ago. 1 is too big (over 512 KB) and was left out.',
    });
    expect(
      ownFolderLine({ configured: true, count: 0, problem: null }, '/config/milkdrop'),
    ).toEqual({
      tone: 'warning',
      words:
        'The folder has no .milk files yet. Put them in it; SYNCHRO.S reads it again when MilkDrop next opens.',
    });
    expect(
      ownFolderLine({ configured: true, count: 0, problem: 'missing' }, '/config/milkdrop'),
    ).toEqual({
      tone: 'danger',
      words:
        'SYNCHRO.S can’t open /config/milkdrop: it isn’t there inside the container. Check the folder is in your set-up’s volumes.',
    });
    expect(
      ownFolderLine({ configured: true, count: 0, problem: 'unreadable' }, '/config/milkdrop')
        ?.tone,
    ).toBe('danger');
  });

  it('says how long ago in words', () => {
    expect(agoWords(5)).toBe('just now');
    expect(agoWords(60)).toBe('1 minute ago');
    expect(agoWords(7300)).toBe('2 hours ago');
    expect(agoWords(3 * 86400)).toBe('3 days ago');
  });
});
