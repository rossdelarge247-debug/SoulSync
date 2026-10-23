/**
 * Settings → Connections' Spotify card while paused (board 12c), against the
 * real settings.js: the header tag with the time in its three states and
 * back to Connected, the warning box with the sentence, an admin's Try again
 * now and its note, a member's line instead.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canClearSpotifyPause,
  spotifyPauseView,
  type SpotifyPauseStatus,
} from '@/features/spotify-pause/spotify-pause';

import { extractFunction } from './vanilla-extract';

const settings = readFileSync(resolve(process.cwd(), 'static/settings.js'), 'utf8');

type Api = {
  render: (status: SpotifyPauseStatus) => void;
  modal: (payload: unknown) => void;
  calls: string[];
  rebuilt: () => number;
};

function build(): Api {
  return new Function(
    `let _stgSpotifyPauseStatus = null;
     let _stgSpotifyPauseAt = 0;
     let _stgSpotifyPauseTimer = null;
     let _lastStatusPayload = null;
     let rebuilt = 0;
     const calls = [];
     function retryStgSpotifyPause() {}
     function buildServiceTiles() { rebuilt += 1; }
     function disconnectSpotify() { calls.push('disconnect'); }
     function testConnection(s) { calls.push('test ' + s); }
     function saveSettings() { calls.push('save'); }
     ${extractFunction('renderStgSpotifyPause', settings)}
     ${extractFunction('_stgSpotifyTileTag', settings)}
     ${extractFunction('renderStgSpotifyTile', settings)}
     ${extractFunction('spotifyAccountParts', settings)}
     ${extractFunction('renderStgSpotifyModal', settings)}
     return {
       render(status) { _stgSpotifyPauseStatus = status; _stgSpotifyPauseAt = Date.now(); renderStgSpotifyPause(); },
       modal(payload) { _lastStatusPayload = payload; renderStgSpotifyModal(); },
       calls,
       rebuilt: () => rebuilt,
     };`,
  )() as Api;
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
  document.body.innerHTML = `<div id="settings-page"><div class="stg-service" data-service="spotify">
    <div class="stg-service-header"><span class="stg-service-dot"></span><h4>Spotify</h4><span class="stg-service-chevron">›</span></div>
    <div class="stg-service-body"><div class="form-group"></div></div></div>
    <div id="service-config-modal" data-svc="spotify"><div class="src-modal-header"><span class="src-modal-titles"><span class="src-modal-titlerow"><h3 id="svc-modal-title">Spotify</h3></span><span class="src-modal-sub" id="svc-modal-sub">Playlists and metadata</span></span><button class="src-modal-close"></button></div>
    <div class="src-modal-body"></div><div class="src-modal-foot" id="svc-modal-foot" hidden></div></div>
    <div id="service-tile-grid"><button data-service-tile="spotify"><span class="src-tile-chip svc-tile-pause"></span></button></div></div>`;
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
    const modalTag = document.querySelector('.src-modal-header .stg-spotify-pause-tag')!;
    expect(modalTag.textContent).toBe('Paused by Spotify · 11 min');
    expect(modalTag.parentElement!.className).toBe('src-modal-titlerow');
    expect(modalTag.previousElementSibling!.id).toBe('svc-modal-title');
    // and the tile in the grid, shorter
    const tile = document.querySelector<HTMLElement>('.svc-tile-pause')!;
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
  it('the tile says "Easing back in", and goes back to its chip after', () => {
    as(true);
    const api = build();
    api.render({
      authenticated: true,
      rate_limited: false,
      post_ban_cooldown: 300,
    } as SpotifyPauseStatus);
    expect(document.querySelector('.svc-tile-pause')!.textContent).toBe('Easing back in');
    expect(document.querySelector<HTMLElement>('.svc-tile-pause')!.dataset.tone).toBe('info');
    const before = api.rebuilt();
    api.render({ authenticated: true, rate_limited: false } as SpotifyPauseStatus);
    expect(api.rebuilt()).toBe(before + 1);
  });

  it('heads with "Connected as ross · 14 playlists · metadata source" and puts Disconnect, Test connection and Save in the footer', () => {
    as(true);
    const api = build();
    api.modal({
      spotify: { authenticated: true, account: { name: 'ross <b>', playlists: 14 } },
      metadata_source: { source: 'spotify' },
    });
    const sub = document.getElementById('svc-modal-sub')!;
    expect(sub.textContent).toBe('Connected as ross <b> · 14 playlists · metadata source');
    // the name is text, never markup
    expect(sub.querySelector('strong')!.textContent).toBe('ross <b>');
    expect(sub.querySelectorAll('b')).toHaveLength(0);
    const foot = document.getElementById('svc-modal-foot')!;
    expect(foot.hidden).toBe(false);
    const buttons = [...foot.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Disconnect', 'Test connection', 'Save']);
    expect(buttons[0]!.className).toContain('src-modal-btn--ghost');
    expect(buttons[2]!.className).toContain('src-modal-btn--primary');
    buttons.forEach((b) => b.click());
    expect(api.calls).toEqual(['disconnect', 'test spotify', 'save']);
    // another metadata source, one playlist, no name yet
    api.modal({
      spotify: { authenticated: true, account: { name: null, playlists: 1 } },
      metadata_source: { source: 'deezer' },
    });
    expect(sub.textContent).toBe('Connected · 1 playlist');
    expect(foot.querySelectorAll('button')).toHaveLength(3);
    // not connected: the service's own line, no Disconnect
    api.modal({ spotify: { authenticated: false }, metadata_source: { source: 'deezer' } });
    expect(sub.textContent).toBe('Playlists and metadata');
    expect(foot.querySelector<HTMLElement>('[data-spotify-disconnect]')!.hidden).toBe(true);
  });

  it('does nothing while another service is open', () => {
    as(true);
    document.getElementById('service-config-modal')!.dataset.svc = 'tidal';
    build().modal({ spotify: { authenticated: true, account: { name: 'ross', playlists: 2 } } });
    expect(document.getElementById('svc-modal-sub')!.textContent).toBe('Playlists and metadata');
    expect(document.getElementById('svc-modal-foot')!.hidden).toBe(true);
  });
});
