/** The Spotify pause in words: whose number the time is, what triggered it,
 *  and a countdown that never says 0 while still waiting. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canClearSpotifyPause,
  clearSpotifyPause,
  formatBackAt,
  formatWait,
  formatWaitExact,
  lengthWords,
  spotifyPauseView,
  TRY_AGAIN_NOTE,
} from './spotify-pause';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'SoulSyncWebShellBridge');
});

describe('formatWait', () => {
  it('reads like a person would say it', () => {
    expect(formatWait(45)).toBe('45 s');
    expect(formatWait(60)).toBe('1 min');
    expect(formatWait(200)).toBe('4 min');
    expect(formatWait(4800)).toBe('1 h 20 min');
    expect(formatWait(720)).toBe('12 min');
    expect(formatWait(3600)).toBe('1 h');
    expect(formatWait(7500)).toBe('2 h 5 min');
    expect(formatWait(14400)).toBe('4 h');
  });

  it('rounds up, so a running pause never reads 0', () => {
    expect(formatWait(0.2)).toBe('1 s');
    expect(formatWait(659)).toBe('11 min');
    expect(formatWait(0)).toBe('0 s');
    expect(formatWait(null)).toBe('0 s');
  });
});

describe('the dialog’s exact time and sentence lengths', () => {
  it('counts the seconds under an hour', () => {
    expect(formatWaitExact(702)).toBe('11 min 42 s');
    expect(formatWaitExact(720)).toBe('12 min');
    expect(formatWaitExact(40)).toBe('40 s');
    expect(formatWaitExact(4800)).toBe('1 h 20 min');
  });

  it('writes a length out for a sentence', () => {
    expect(lengthWords(600)).toBe('10 minutes');
    expect(lengthWords(60)).toBe('1 minute');
    expect(lengthWords(3600)).toBe('1 hour');
    expect(lengthWords(4800)).toBe('1 hour 20 minutes');
    expect(lengthWords(14400)).toBe('4 hours');
  });
});

describe('spotifyPauseView', () => {
  const fromSpotify = {
    rate_limited: true,
    rate_limit: {
      active: true,
      remaining_seconds: 720,
      retry_after: 720,
      source: 'spotify',
      trigger: "checking an artist's albums",
    },
  };

  it('says Spotify asked, and after what', () => {
    const view = spotifyPauseView(fromSpotify)!;
    expect(view.kind).toBe('paused');
    expect(view.fromSpotify).toBe(true);
    expect(view.sentence).toBe(
      "Spotify asked us to wait 12 min (after checking an artist's albums)",
    );
    expect(view.short).toBe('Spotify paused · 12 min');
    expect(view.timeLeft).toBe('12 min');
    expect(view.detail).toContain('That time came from Spotify');
  });

  it('says when the time is our own estimate', () => {
    const view = spotifyPauseView({
      rate_limited: true,
      rate_limit: { remaining_seconds: 600, source: 'estimate', trigger: 'searching for tracks' },
    })!;
    expect(view.fromSpotify).toBe(false);
    expect(view.sentence).toBe('Paused Spotify for 10 min to be safe (after searching for tracks)');
    expect(view.detail).toContain('SYNCHRO.S’s estimate');
  });

  it('counts down from when the status arrived', () => {
    expect(spotifyPauseView(fromSpotify, 61)!.timeLeft).toBe('11 min');
    expect(spotifyPauseView(fromSpotify, 600)!.timeLeft).toBe('2 min');
    expect(spotifyPauseView(fromSpotify, 719.5)!.timeLeft).toBe('1 s');
    expect(spotifyPauseView(fromSpotify, 720)).toBeNull();
  });

  it('works without a trigger (older servers)', () => {
    const view = spotifyPauseView({ rate_limited: true, rate_limit: { remaining_seconds: 90 } })!;
    expect(view.sentence).toBe('Paused Spotify for 2 min to be safe');
    expect(view.setOffBy).toBe('A Spotify request');
    expect(view.body).toContain('after a Spotify request');
  });

  it('after the pause: easing back in', () => {
    const view = spotifyPauseView({ rate_limited: false, post_ban_cooldown: 300 })!;
    expect(view.kind).toBe('easing');
    expect(view.short).toBe('Spotify easing back in · 5 min');
    expect(view.sentence).toBe('Spotify is back. Background jobs wait 5 min more');
    expect(spotifyPauseView({ post_ban_cooldown: 300 }, 300)).toBeNull();
  });

  it('nothing when Spotify is fine', () => {
    expect(spotifyPauseView(null)).toBeNull();
    expect(spotifyPauseView({ rate_limited: false, rate_limit: null })).toBeNull();
  });
});

describe('the boards’ words (Spotify pause 12a–12d)', () => {
  const told = {
    rate_limited: true,
    rate_limit: {
      remaining_seconds: 702,
      retry_after: 720,
      source: 'spotify',
      trigger: "checking an artist's albums for the watchlist scan",
      feature: 'the watchlist scan',
    },
  };

  it('told: the title, the tag, the card and the dialog', () => {
    const v = spotifyPauseView(told)!;
    expect(v.title).toBe('Spotify asked us to wait 12 min');
    expect(v.tone).toBe('warning');
    expect(v.tag).toBe('Paused by Spotify · 12 min');
    // the tile's own tag is shorter (15a)
    expect(v.tileTag).toBe('Paused · 12 min');
    expect(v.tryAgainNote).toBe(TRY_AGAIN_NOTE);
    expect(v.cardSentence).toBe(
      "Spotify asked us to wait 12 min, after checking an artist's albums for the watchlist scan. " +
        'Background jobs wait it out; your own lookups go first when it ends.',
    );
    expect(v.cardNote).toBe('If Spotify is still limiting, the pause comes back.');
    expect(v.timeLeftExact).toBe('11 min 42 s');
    expect(v.whose).toBe('Spotify’s');
    expect(v.setOffBy).toBe("Checking an artist's albums, for the watchlist scan");
    expect(v.dialogSentence).toBe(
      'Spotify said how long to wait (12 minutes), and SYNCHRO.S obeys that exactly: waiting is ' +
        'how the limit lifts. Searches and downloads carry on meanwhile.',
    );
  });

  it('estimate: a guess, "longer" on the notes, and no doubling at the longest step', () => {
    const v = spotifyPauseView({
      rate_limited: true,
      rate_limit: {
        remaining_seconds: 540,
        retry_after: 600,
        source: 'estimate',
        trigger: 'searching for tracks',
      },
    })!;
    expect(v.title).toBe('Paused Spotify for 9 min to be safe');
    expect(v.tag).toBe('Paused to be safe · 9 min');
    expect(v.tileTag).toBe('Paused · 9 min');
    expect(v.whose).toBe('SYNCHRO.S’s guess');
    expect(v.tryAgainNote).toMatch(/comes back, longer\.$/);
    expect(v.cardNote).toMatch(/comes back, longer\.$/);
    expect(v.bodyMember).toMatch(/An admin can try again sooner\.$/);
    const longest = spotifyPauseView({
      rate_limited: true,
      rate_limit: { remaining_seconds: 14000, retry_after: 14400, source: 'estimate' },
    })!;
    expect(longest.body).toContain('4 hours, the longest it waits.');
  });

  it('a wait of an hour or more also says when it ends (Spotify throttling, 27 October)', () => {
    // 21:40 on a fixed day, 15 hours ahead of 06:40 the same day
    const now = new Date(2026, 9, 27, 6, 40, 0).getTime();
    const v = spotifyPauseView(
      {
        rate_limited: true,
        rate_limit: {
          remaining_seconds: 15 * 3600,
          retry_after: 15 * 3600,
          source: 'spotify',
          trigger: 'reading your liked songs',
        },
      },
      0,
      now,
    )!;
    expect(v.backAt).toBe('21:40');
    expect(v.title).toBe('Spotify asked us to wait 15 h, until 21:40');
    expect(v.sentence).toBe(
      'Spotify asked us to wait 15 h, until 21:40 (after reading your liked songs)',
    );
    expect(v.cardSentence).toMatch(
      /^Spotify asked us to wait 15 h, until 21:40, after reading your liked songs\./,
    );
    // the short tags stay short
    expect(v.tag).toBe('Paused by Spotify · 15 h');
    expect(v.short).toBe('Spotify paused · 15 h');
    // counting down keeps the same end
    expect(
      spotifyPauseView(
        { rate_limited: true, rate_limit: { remaining_seconds: 15 * 3600, source: 'spotify' } },
        3600,
        now + 3600_000,
      )!.backAt,
    ).toBe('21:40');
  });

  it('says tomorrow for a wait past midnight', () => {
    const now = new Date(2026, 9, 27, 22, 0, 0).getTime();
    expect(formatBackAt(now + 11 * 3600_000 + 12 * 60_000, now)).toBe('tomorrow 09:12');
    expect(formatBackAt(now + 30 * 60_000, now)).toBe('22:30');
  });

  it('easing back in: info, no button', () => {
    const v = spotifyPauseView({ rate_limited: false, post_ban_cooldown: 300 })!;
    expect(v.title).toBe('Spotify is back');
    expect(v.tone).toBe('info');
    expect(v.tag).toBe('Easing back in · 5 min');
    expect(v.tileTag).toBe('Easing back in');
    expect(v.tryAgainNote).toBeNull();
    expect(v.cardNote).toBeNull();
  });
});

describe('Try again now', () => {
  it('is for admins (and profile 1)', () => {
    expect(canClearSpotifyPause()).toBe(false);
    const ctx = { profileId: 2, isAdmin: false };
    window.SoulSyncWebShellBridge = {
      getCurrentProfileContext: () => ctx,
    } as unknown as typeof window.SoulSyncWebShellBridge;
    expect(canClearSpotifyPause()).toBe(false);
    ctx.isAdmin = true;
    expect(canClearSpotifyPause()).toBe(true);
    ctx.isAdmin = false;
    ctx.profileId = 1;
    expect(canClearSpotifyPause()).toBe(true);
  });

  it('posts to the clear endpoint and explains a refusal', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await clearSpotifyPause()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/spotify/rate-limit/clear'),
      { method: 'POST' },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    expect(await clearSpotifyPause()).toBe('Only an admin can do that.');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    expect(await clearSpotifyPause()).toContain('didn’t answer');
  });

  it('says the pause can come back', () => {
    expect(TRY_AGAIN_NOTE).toContain('If Spotify is still limiting, the pause comes back');
  });
});
