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

type Api = { render: (status: SpotifyPauseStatus) => void };

function build(): Api {
  return new Function(
    `let _stgSpotifyPauseStatus = null;
     let _stgSpotifyPauseAt = 0;
     let _stgSpotifyPauseTimer = null;
     function retryStgSpotifyPause() {}
     ${extractFunction('renderStgSpotifyPause', settings)}
     return { render(status) { _stgSpotifyPauseStatus = status; _stgSpotifyPauseAt = Date.now(); renderStgSpotifyPause(); } };`,
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
    <div id="service-config-modal"><div class="src-modal-header"><h3 id="svc-modal-title">Spotify</h3><button class="src-modal-close"></button></div></div></div>`;
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
    // the service modal's head carries it too, before its close button
    const modalTag = document.querySelector('.src-modal-header .stg-spotify-pause-tag')!;
    expect(modalTag.textContent).toBe('Paused by Spotify · 11 min');
    expect(modalTag.nextElementSibling!.className).toBe('src-modal-close');
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
