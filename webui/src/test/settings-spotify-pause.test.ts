/**
 * Settings → Connections' Spotify card while paused (board 12c), against the
 * real settings.js: the header tag with the time in its three states and
 * back to Connected, the warning box with the sentence, an admin's Try again
 * now and its note, a member's line instead. The modal around it is the
 * shared service frame (15a, HANDOFF 85 and 132).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canClearSpotifyPause,
  spotifyPauseView,
  type SpotifyPauseStatus,
} from '@/features/spotify-pause/spotify-pause';

import { buildFrame, head, mountModal, type Frame } from './service-frame-harness';

type Api = Frame & {
  render: (status: SpotifyPauseStatus) => void;
  modal: (payload: unknown) => void;
};

function build(): Api {
  const frame = buildFrame();
  return {
    ...frame,
    render: (status: SpotifyPauseStatus) => frame.pause(status),
    modal: (payload: unknown) => {
      frame.setStatus(payload);
      frame.render();
    },
  } as Api;
}

const TOLD: SpotifyPauseStatus & { authenticated: boolean } = {
  authenticated: true,
  rate_limited: true,
  rate_limit: {
    remaining_seconds: 660,
    retry_after: 720,
    source: 'spotify',
    trigger: "checking an artist's albums for the watchlist scan",
    feature: 'the watchlist scan',
  },
};

function as(admin: boolean) {
  window.SoulSyncWebShellBridge = {
    getCurrentProfileContext: () => ({ profileId: admin ? 1 : 2, isAdmin: admin }),
  } as unknown as typeof window.SoulSyncWebShellBridge;
}

beforeEach(() => {
  mountModal('spotify', {
    title: 'Spotify',
    form: '<div class="form-group"></div><div class="form-actions"><button data-svc-foot="disconnect">Disconnect</button><button data-svc-foot="test">Test Connection</button></div>',
  });
  Object.assign(window, {
    ssSpotifyPauseView: spotifyPauseView,
    ssCanClearSpotifyPause: canClearSpotifyPause,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'SoulSyncWebShellBridge');
  Reflect.deleteProperty(window, 'ssSpotifyPauseView');
  Reflect.deleteProperty(window, 'ssCanClearSpotifyPause');
});

const tag = () => document.querySelector<HTMLElement>('.stg-spotify-pause-tag');
const box = () => document.querySelector<HTMLElement>('.stg-spotify-pause');

describe('the Connections Spotify card (12c)', () => {
  it('told: the warning tag before the chevron and the box with the button and note', () => {
    as(true);
    build().render(TOLD);
    expect(tag()!.textContent).toBe('Paused by Spotify · 11 min');
    expect(tag()!.dataset.tone).toBe('warning');
    expect(tag()!.nextElementSibling!.className).toBe('stg-service-chevron');
    // the service modal's head carries it too, beside the name (15a)
    const modalTag = head().tag!;
    expect(modalTag.textContent).toBe('Paused by Spotify · 11 min');
    expect(modalTag.dataset.tone).toBe('warning');
    expect(modalTag.parentElement!.className).toBe('src-modal-titlerow');
    expect(modalTag.previousElementSibling!.id).toBe('svc-modal-title');
    // and the tile in the grid, shorter
    const tile = document.querySelector<HTMLElement>('.svc-tile-tag')!;
    expect(tile.textContent).toBe('Paused · 11 min');
    expect(tile.dataset.tone).toBe('warning');
    expect(box()!.dataset.tone).toBe('warning');
    expect(box()!.querySelector('.stg-spotify-pause-sentence')!.textContent).toBe(
      "Spotify asked us to wait 11 min, after checking an artist's albums for the watchlist scan. " +
        'Background jobs wait it out; your own lookups go first when it ends.',
    );
    expect(box()!.querySelector<HTMLElement>('.stg-spotify-pause-actions')!.hidden).toBe(false);
    expect(box()!.querySelector('.stg-spotify-pause-note')!.textContent).toBe(
      'If Spotify is still limiting, the pause comes back.',
    );
    expect(box()!.querySelector<HTMLElement>('.stg-spotify-pause-member')!.hidden).toBe(true);
  });

  it('estimate: "Paused to be safe" and "…, longer."', () => {
    as(true);
    build().render({
      ...TOLD,
      rate_limit: {
        remaining_seconds: 540,
        retry_after: 600,
        source: 'estimate',
        trigger: 'searching for tracks',
      },
    });
    expect(tag()!.textContent).toBe('Paused to be safe · 9 min');
    expect(box()!.querySelector('.stg-spotify-pause-note')!.textContent).toBe(
      'If Spotify is still limiting, the pause comes back, longer.',
    );
  });

  it('a member reads "An admin can try again sooner." and no button', () => {
    as(false);
    build().render(TOLD);
    expect(box()!.querySelector<HTMLElement>('.stg-spotify-pause-actions')!.hidden).toBe(true);
    const member = box()!.querySelector<HTMLElement>('.stg-spotify-pause-member')!;
    expect(member.hidden).toBe(false);
    expect(member.textContent).toBe('An admin can try again sooner.');
  });

  it('easing back in: info, no button; then back to Connected', () => {
    as(true);
    const api = build();
    api.render({
      authenticated: true,
      rate_limited: false,
      post_ban_cooldown: 300,
    } as SpotifyPauseStatus);
    expect(tag()!.textContent).toBe('Easing back in · 5 min');
    expect(tag()!.dataset.tone).toBe('info');
    expect(box()!.dataset.tone).toBe('info');
    expect(box()!.querySelector<HTMLElement>('.stg-spotify-pause-actions')!.hidden).toBe(true);
    api.render({ authenticated: true, rate_limited: false } as SpotifyPauseStatus);
    expect(tag()!.textContent).toBe('Connected');
    expect(tag()!.dataset.tone).toBe('success');
    expect(box()).toBeNull();
  });
});

describe('the Spotify service modal (15a, HANDOFF 85)', () => {
  it('the tile says "Easing back in", and is rebuilt (to "Connected") after', () => {
    as(true);
    const api = build();
    api.render({
      authenticated: true,
      rate_limited: false,
      post_ban_cooldown: 300,
    } as SpotifyPauseStatus);
    expect(document.querySelector('.svc-tile-tag')!.textContent).toBe('Easing back in');
    expect(document.querySelector<HTMLElement>('.svc-tile-tag')!.dataset.tone).toBe('info');
    const before = api.rebuilt();
    api.render({ authenticated: true, rate_limited: false } as SpotifyPauseStatus);
    expect(api.rebuilt()).toBe(before + 1);
  });

  it('heads with "Connected as ross · 14 playlists · metadata source" and puts Disconnect, Test connection and Save in the footer', async () => {
    as(true);
    const api = build();
    api.modal({
      spotify: { authenticated: true, account: { name: 'ross <b>', playlists: 14 } },
      metadata_source: { source: 'spotify' },
    });
    const { sub, tag, buttons } = { ...head(), tag: head().tag! };
    expect(sub.textContent).toBe('Connected as ross <b> · 14 playlists · metadata source');
    // the name is text, never markup
    expect(sub.querySelector('strong')!.textContent).toBe('ross <b>');
    expect(sub.querySelectorAll('b')).toHaveLength(0);
    expect(tag.textContent).toBe('Connected');
    expect(tag.dataset.tone).toBe('success');
    const foot = document.getElementById('svc-modal-foot')!;
    expect(foot.hidden).toBe(false);
    expect(buttons()).toEqual(['Disconnect', 'Test connection', 'Save']);
    const all = [...foot.querySelectorAll<HTMLButtonElement>('button')];
    expect(all[0]!.className).toContain('src-modal-btn--ghost');
    expect(all[2]!.className).toContain('src-modal-btn--primary');
    all[0]!.click();
    all[1]!.click();
    all[2]!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(api.calls).toEqual(['disconnect spotify', 'test spotify', 'save']);
    // another metadata source, one playlist, no name yet
    api.modal({
      spotify: { authenticated: true, account: { name: null, playlists: 1 } },
      metadata_source: { source: 'deezer' },
    });
    expect(sub.textContent).toBe('Connected · 1 playlist');
    // not connected: no line, no Disconnect, and no tag without an app set up
    api.modal({ spotify: { authenticated: false }, metadata_source: { source: 'deezer' } });
    expect(sub.hidden).toBe(true);
    expect(buttons()).toEqual(['Test connection', 'Save']);
    expect(head().tag).toBeNull();
  });

  it('a passing test never says Connected while no account is (the fallback source passes)', async () => {
    as(true);
    const api = build();
    api.answers.spotify = {
      success: true,
      message: 'Deezer connection successful! (Spotify not configured)',
    };
    api.modal({ spotify: { authenticated: false } });
    await api.test('spotify');
    expect(head().tag).toBeNull();
    expect(head().box).toBeNull();
  });
});
