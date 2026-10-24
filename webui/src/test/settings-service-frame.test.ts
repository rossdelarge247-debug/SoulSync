/**
 * Every Connections service modal on 15a's frame (HANDOFF 132), against the
 * real settings.js and index.html: the head's tag and line, the warning box,
 * the footer, what Test connection's answer turns into, and that no key or
 * token reaches the frame.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SETTINGS_JS, buildFrame, head, mountModal } from './service-frame-harness';

const INDEX = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

const TEST_BUTTON =
  '<div class="form-actions"><button data-svc-foot="test">Test Connection</button></div>';
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

describe("Test connection's answer (no call of its own)", () => {
  const f = buildFrame();
  const tag = (answer: unknown) => f.outcome(answer)?.tag;

  it('names what went wrong in a word', () => {
    expect(tag({ success: false, error: 'Invalid Discogs personal token.' })).toEqual({
      text: 'Refused',
      tone: 'danger',
    });
    expect(tag({ success: false, error: 'Invalid ListenBrainz token (unauthorized).' })!.text).toBe(
      'Refused',
    );
    expect(
      tag({ success: false, error: 'Could not connect to ListenBrainz (HTTP 401)' })!.text,
    ).toBe('Refused');
    expect(
      tag({ success: false, error: 'Deezer is rate limited right now — try again shortly' }),
    ).toEqual({
      text: 'Rate-limited',
      tone: 'warning',
    });
    expect(tag({ success: false, error: 'Genius connection error: timed out' })).toEqual({
      text: "Can't reach",
      tone: 'danger',
    });
    expect(tag({ success: false, error: 'iTunes returned HTTP 503' })!.text).toBe("Can't reach");
    expect(tag({ success: false, error: 'Missing Last.fm API key.' })).toEqual({
      text: 'Not set up',
      tone: 'neutral',
    });
    expect(tag({ success: false, error: 'Something odd' })).toEqual({
      text: 'Test failed',
      tone: 'danger',
    });
    expect(tag({ success: true, message: 'Successfully connected to Genius!' })).toEqual({
      text: 'Connected',
      tone: 'success',
    });
    const warned = f.outcome({
      success: true,
      message: '⚠ Deezer public API works, but your Deezer login expired.',
    })!;
    expect(warned.tag).toEqual({ text: 'Needs a look', tone: 'warning' });
    expect(warned.text).toBe('Deezer public API works, but your Deezer login expired.');
    expect(f.outcome(undefined)).toBeNull();
  });

  it('never carries a key or token into the frame', () => {
    const text = f.safe(
      'Genius connection error: Max retries exceeded with url: /search?q=a&access_token=Zx9QpLmN7rT2vB8kW4 (Caused by X)',
    );
    expect(text).toBe(
      'Genius connection error: Max retries exceeded with url: /search?q=a&access_token=… (Caused by X)',
    );
    expect(f.safe('/2.0/?method=x&api_key=abc123&format=json')).toBe(
      '/2.0/?method=x&api_key=…&format=json',
    );
    expect(f.safe('token 0123456789abcdef0123456789abcdef0123 refused')).toBe('token … refused');
    expect(f.safe('Invalid Discogs personal token.')).toBe('Invalid Discogs personal token.');
  });
});

describe("each service's head, tag and footer", () => {
  const f = buildFrame();

  it('Tidal: Connected from config-status (a token), Disconnect only then; "Not connected" with an app set up', () => {
    const on = f.view('tidal', {
      config: { configured: true },
      detail: 'Playlists & Metadata',
      hasTest: true,
    });
    expect(on.tag).toEqual({ text: 'Connected', tone: 'success' });
    expect(on.line).toEqual([{ text: 'Playlists & Metadata' }]);
    expect(on.disconnect).toBe(true);
    const off = f.view('tidal', { config: { configured: false }, hasApp: true });
    expect(off.tag).toEqual({ text: 'Not connected', tone: 'neutral' });
    expect(off.disconnect).toBe(false);
    expect(f.view('tidal', { config: { configured: false } }).tag).toBeNull();
  });

  it('Qobuz: "Connected as Ross · Studio" from what the server kept at sign-in', () => {
    const v = f.view('qobuz', { qobuz: { authenticated: true, name: 'Ross', plan: 'Studio' } });
    expect(v.line).toEqual([{ lead: 'Connected as ', strong: 'Ross' }, { text: 'Studio' }]);
    expect(v.disconnect).toBe(true);
    expect(
      f.view('qobuz', { qobuz: { authenticated: true, name: null, plan: 'Unknown' } }).line,
    ).toEqual([{ text: 'Connected' }]);
    expect(f.view('qobuz', { qobuz: { authenticated: false }, configured: true }).tag!.text).toBe(
      'Not connected',
    );
  });

  it('Last.fm: scrobbling on but not authorized is a warning; authorized says who', () => {
    const waiting = f.view('lastfm', {
      lastfm: { authorized: false, scrobble: true, username: 'ross' },
    });
    expect(waiting.tag).toEqual({ text: 'Not authorized', tone: 'warning' });
    expect(waiting.warning!.lead).toBe("Last.fm hasn't authorized SYNCHRO.S yet.");
    expect(waiting.line).toEqual([]);
    const on = f.view('lastfm', { lastfm: { authorized: true, scrobble: true, username: 'ross' } });
    expect(on.line).toEqual([
      { lead: 'Connected as ', strong: 'ross' },
      { text: 'scrobbling your plays' },
    ]);
    expect(on.disconnect).toBe(false);
    // a passed test doesn't override the missing authorisation
    expect(
      f.view('lastfm', {
        lastfm: { authorized: false, scrobble: true },
        test: f.outcome({ success: true, message: 'Successfully connected to Last.fm!' }),
      }).tag!.text,
    ).toBe('Not authorized');
  });

  it('what it is used for: the service line, the metadata source, nothing for "No Key"', () => {
    expect(
      f.view('deezer', { detail: 'Favorites & Playlists', metadataSource: 'deezer' }).line,
    ).toEqual([{ text: 'Favorites & Playlists' }, { text: 'metadata source' }]);
    expect(f.view('nokey', { detail: 'No Key' }).line).toEqual([]);
    expect(f.view('genius', {}).line).toEqual([]);
    expect(f.view('genius', {}).tag).toBeNull();
  });

  it('a required video key that is empty gets the warning box, not a tag', () => {
    const v = f.view('tvdb', { required: true, configured: false });
    expect(v.warning).toEqual({
      tone: 'warning',
      lead: 'Required.',
      text: 'Nothing on the video side works until this key is set.',
    });
    expect(v.tag).toBeNull();
    expect(f.view('tvdb', { required: true, configured: true }).warning).toBeNull();
  });

  it('reads only named fields: a token in a status answer never reaches the line', () => {
    const v = f.view('spotify', {
      spotify: {
        authenticated: true,
        access_token: 'SECRET',
        account: { name: 'ross', token: 'SECRET', playlists: 2 },
      },
    });
    expect(JSON.stringify(v)).not.toContain('SECRET');
    const q = f.view('qobuz', {
      qobuz: { authenticated: true, name: 'Ross', user_auth_token: 'SECRET' },
    });
    expect(JSON.stringify(q)).not.toContain('SECRET');
  });
});

describe('the frame in the page', () => {
  it('Discogs: Test, then Refused beside the name and the box on top; typing clears them; Save saves', async () => {
    mountModal('discogs', {
      title: 'Discogs',
      form: `<input type="password" id="discogs-token">${TEST_BUTTON}`,
    });
    const f = buildFrame();
    f.answers.discogs = { success: false, error: 'Invalid Discogs personal token.' };
    f.render();
    expect(head().buttons()).toEqual(['Test connection', 'Save']);
    expect(head().tag).toBeNull();
    expect(head().sub.hidden).toBe(true);
    await f.test('discogs');
    expect(f.calls).toEqual(['test discogs']);
    expect(head().tag!.textContent).toBe('Refused');
    expect(head().tag!.dataset.tone).toBe('danger');
    const box = head().box!;
    expect(box.dataset.tone).toBe('danger');
    expect(box.getAttribute('role')).toBe('note');
    expect(box.textContent).toBe(
      'The service refused what it was given. Invalid Discogs personal token.',
    );
    expect(document.getElementById('svc-modal-body')!.firstElementChild).toBe(box);
    // a new value: the old answer was about the old one
    delete f.tests.discogs;
    f.render();
    expect(head().tag).toBeNull();
    expect(head().box).toBeNull();
    f.save('discogs');
    expect(f.calls).toEqual(['test discogs', 'save']);
  });

  it('Deezer tests both logins, as its form did; Hydrabase has no Test (its Connect is the check)', async () => {
    mountModal('deezer', { form: TEST_BUTTON });
    const f = buildFrame();
    f.render();
    await f.test('deezer');
    expect(f.calls).toEqual(['test deezer and its ARL']);
    mountModal('hydrabase', {
      form: '<button onclick="toggleHydrabaseFromSettings()">Connect</button>',
    });
    f.render();
    expect(head().buttons()).toEqual(['Save']);
  });

  it('a video service tests what its own button named and saves through the page Save button', async () => {
    mountModal('nokey', {
      video: true,
      form: '<button data-video-test-service="tvmaze,anilist,wikidata">Test Connections</button>',
    });
    const save = document.createElement('button');
    save.id = 'save-settings';
    let clicked = 0;
    save.addEventListener('click', () => (clicked += 1));
    document.body.append(save);
    const f = buildFrame();
    f.render();
    expect(head().buttons()).toEqual(['Test connection', 'Save']);
    await f.test('nokey');
    expect(f.calls).toEqual(['test tvmaze,anilist,wikidata']);
    f.save('nokey');
    expect(clicked).toBe(1);
    expect(f.calls).not.toContain('save');
  });

  it('Tidal: Disconnect on the left while connected, then config-status is read again', async () => {
    mountModal('tidal', { form: TEST_BUTTON });
    const f = buildFrame();
    f.setConfig({ tidal: { configured: true } });
    f.render();
    expect(head().buttons()).toEqual(['Disconnect', 'Test connection', 'Save']);
    expect(head().tag!.textContent).toBe('Connected');
    document.querySelector<HTMLButtonElement>('#svc-modal-foot [data-svc-disconnect]')!.click();
    await flush();
    await flush();
    expect(f.calls).toEqual(['disconnect tidal', 'config-status']);
  });

  it('the footer is built once per service, so a re-render keeps the focus', () => {
    mountModal('genius', { form: TEST_BUTTON });
    const f = buildFrame();
    f.render();
    const save = document.querySelector<HTMLButtonElement>('#svc-modal-foot [data-svc-save]')!;
    save.focus();
    f.render();
    expect(document.activeElement).toBe(save);
  });
});

describe('the page wiring', () => {
  it('the footer disconnects the services whose forms had a Disconnect, with the same functions', () => {
    const map = SETTINGS_JS.split('const SERVICE_DISCONNECT = {', 2)[1]!.split('};', 1)[0]!;
    expect(map).toContain('spotify: () => disconnectSpotify()');
    expect(map).toContain('tidal: () => disconnectTidal()');
    expect(map).toContain('qobuz: () => logoutQobuz()');
    const marked = [
      ...INDEX.matchAll(/<button data-svc-foot="disconnect"[^>]*onclick="([a-zA-Z]+)\(\)"/g),
    ].map((m) => m[1]);
    expect(marked.sort()).toEqual(['disconnectSpotify', 'disconnectTidal', 'logoutQobuz']);
  });

  it("every form test button the footer stands in for runs the footer's call", () => {
    const frames = [
      ...INDEX.matchAll(/class="api-service-frame stg-service"[^>]*?data-service="([^"]+)"/g),
    ];
    const sources = INDEX.indexOf('data-stg="sources"');
    let checked = 0;
    frames.forEach((m, i) => {
      const end =
        frames[i + 1]?.index ?? INDEX.indexOf('<!-- Test Connection Buttons -->', m.index);
      if (m.index! > sources) return;
      const body = INDEX.slice(m.index, end);
      for (const b of body.matchAll(/<button data-svc-foot="test"[^>]*onclick="([^"]+)"/g)) {
        const want = m[1] === 'deezer' ? 'testDeezerConnection()' : `testConnection('${m[1]}')`;
        expect(b[1], m[1]).toBe(want);
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(12);
  });
});
