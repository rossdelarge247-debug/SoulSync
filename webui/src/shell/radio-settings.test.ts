import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRadioSettingsForTests,
  autoStationsLine,
  loadRadioSettings,
  statusLine,
  type RadioSettingsBody,
} from './radio-settings';

const BODY: RadioSettingsBody = {
  success: true,
  settings: {
    identification: true,
    daily_limit: 50,
    relay: 'when_needed',
    prefer_lossless: true,
    keep_heard_days: 90,
    acoustid_api_key: { set: true, masked: 'x9Kf•••••••Q2' },
  },
  status: {
    fpcalc: { found: true, detail: 'fpcalc found' },
    acoustid: { state: 'ok', detail: 'AcoustID answered', checked_at: null },
  },
  auto_add: {
    stations: [{ station_id: 'fip-jazz', station_name: 'FIP Jazz' }],
    added_this_week: 23,
  },
  links: [
    {
      id: 1,
      name: 'Lowlands <b>Radio</b>',
      url: 'https://stream.example.org/live.mp3',
      codec: 'MP3',
      bitrate_kbps: 320,
      check_ok: true,
      checked_at: null,
      check_error: null,
      added_by: 'ross',
      added_at: null,
    },
    {
      id: 2,
      name: 'Cashmere Radio',
      url: 'https://cashmere.example.org/s',
      codec: '',
      bitrate_kbps: 0,
      check_ok: false,
      checked_at: Date.now() / 1000,
      check_error: 'The stream didn’t answer.',
      added_by: 'ross',
      added_at: null,
    },
  ],
};

function markup() {
  document.body.innerHTML = `
    <div id="settings-page"><button id="stg-tab-radio" hidden></button>
    <div id="radio-settings">
      <button id="radio-identification" role="switch" aria-checked="true"><span class="radio-switch-text">On</span></button>
      <p id="radio-settings-error" hidden></p>
      <input id="radio-acoustid"><button id="radio-acoustid-save"></button>
      <p id="radio-id-status"></p>
      <input id="radio-daily-limit"><p id="radio-auto-stations"></p>
      <select id="radio-relay"><option value="when_needed"></option><option value="always"></option></select>
      <input type="checkbox" id="radio-prefer-lossless">
      <select id="radio-keep"><option value="7"></option><option value="30"></option><option value="90"></option><option value="365"></option></select>
      <p id="radio-save-status"></p>
      <ul id="radio-links"></ul>
    </div></div>`;
}

describe('Settings → Radio', () => {
  const puts: unknown[] = [];
  beforeEach(() => {
    markup();
    _resetRadioSettingsForTests();
    puts.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const patch = JSON.parse(String(init.body));
          puts.push(patch);
          return new Response(
            JSON.stringify({ ...BODY, settings: { ...BODY.settings!, ...patch } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(BODY), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('words the status and the auto-add stations', () => {
    expect(statusLine(BODY.status)).toEqual({
      text: 'fpcalc found · AcoustID answered',
      tone: 'success',
    });
    expect(
      statusLine({
        fpcalc: { found: false, detail: 'fpcalc not installed' },
        acoustid: { state: 'missing', detail: 'No AcoustID key', checked_at: null },
      }).tone,
    ).toBe('warning');
    expect(autoStationsLine(BODY.auto_add)).toBe('FIP Jazz · 23 added this week');
    expect(autoStationsLine({ stations: [], added_this_week: 0 })).toMatch(/^None/);
  });

  it('shows the tab while the module is on and fills the cards', async () => {
    (window as unknown as { SOULSYNC_MODULES: unknown }).SOULSYNC_MODULES = [
      { name: 'radio', enabled: true },
    ];
    await loadRadioSettings();
    expect(document.getElementById('stg-tab-radio')!.hidden).toBe(false);
    expect((document.getElementById('radio-acoustid') as HTMLInputElement).placeholder).toBe(
      'x9Kf•••••••Q2',
    );
    expect((document.getElementById('radio-daily-limit') as HTMLInputElement).value).toBe('50');
    const rows = document.querySelectorAll('#radio-links li');
    expect(rows).toHaveLength(2);
    // names are text, never markup
    expect(rows[0]!.querySelector('b')).toBeNull();
    expect(rows[0]!.textContent).toContain('Lowlands <b>Radio</b>');
    expect(rows[1]!.textContent).toContain('Didn’t answer');
  });

  it('hides the tab while the module is off', async () => {
    (window as unknown as { SOULSYNC_MODULES: unknown }).SOULSYNC_MODULES = [
      { name: 'radio', enabled: false },
    ];
    await loadRadioSettings();
    expect(document.getElementById('stg-tab-radio')!.hidden).toBe(true);
  });

  it('each control saves on its own', async () => {
    await loadRadioSettings();
    (document.getElementById('radio-identification') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(puts).toContainEqual({ identification: false }));
    const limit = document.getElementById('radio-daily-limit') as HTMLInputElement;
    limit.value = '20';
    limit.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(puts).toContainEqual({ daily_limit: 20 }));
  });
});

describe('what a relay costs (HANDOFF 54)', () => {
  it('says it in one meta line under the relay select, tied to it', () => {
    const markup = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    const select = doc.getElementById('radio-relay')!;
    const help = doc.getElementById('radio-relay-help')!;
    expect(select.getAttribute('aria-describedby')).toBe('radio-relay-help');
    expect(help.classList.contains('radio-help')).toBe(true);
    expect(help.textContent).toBe(
      "Each relayed station holds one of the server's 8 threads; two at a time.",
    );
    expect(select.parentElement!.contains(help)).toBe(true);
  });
});

describe('Change logo… in the links table (HANDOFF 66)', () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let refuse = false;
  beforeEach(() => {
    markup();
    document
      .getElementById('radio-links')!
      .insertAdjacentHTML('afterend', '<p id="radio-links-status"></p>');
    _resetRadioSettingsForTests();
    calls.length = 0;
    refuse = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const payload = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init?.method ?? 'GET', body: payload });
        if (init?.method === 'PUT' && url.includes('/api/radio/links/')) {
          if (refuse)
            return new Response(
              JSON.stringify({
                success: false,
                error: 'logo_failed',
                message: 'SVG logos can’t be used: PNG, JPEG, GIF, WebP or ICO only.',
              }),
              { status: 400 },
            );
          return new Response(
            JSON.stringify({
              success: true,
              link: { ...BODY.links![0], logo_url: payload.logo_url || null },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(BODY), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('puts Change logo… and Remove in the row’s "…" menu, keyboard and all', async () => {
    await loadRadioSettings();
    const more = document.querySelector<HTMLElement>('[data-radio-link-more="1"]')!;
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-label')).toBe('More for Lowlands <b>Radio</b>');
    more.click();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const menu = more.nextElementSibling as HTMLElement;
    expect(menu.hidden).toBe(false);
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual([
      'Change logo…',
      'Remove',
    ]);
    expect(document.activeElement!.textContent).toBe('Change logo…');
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    expect(document.activeElement!.textContent).toBe('Remove');
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(more);
    // the station's name stays text
    expect(document.querySelector('#radio-links b')).toBeNull();
  });

  it('Change logo… sends the address through PUT /api/radio/links/<id> and says so', async () => {
    await loadRadioSettings();
    document.querySelector<HTMLElement>('[data-radio-link-more="1"]')!.click();
    document.querySelector<HTMLElement>('[data-radio-link-logo="1"]')!.click();
    const input = document.getElementById('radio-logo-1') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('');
    input.value = 'https://lowlands.example.org/logo.png';
    document.querySelector<HTMLElement>('[data-radio-logo-save="1"]')!.click();
    await vi.waitFor(() =>
      expect(document.getElementById('radio-links-status')!.textContent).toBe(
        'Logo changed. Lowlands <b>Radio</b> shows it in everyone’s Favourites.',
      ),
    );
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toMatch(/\/api\/radio\/links\/1$/);
    expect(put.body).toEqual({ logo_url: 'https://lowlands.example.org/logo.png' });
    expect(document.querySelector('[data-radio-logo-panel]')).toBeNull();
    // opened again, the field holds the address and the preview asks our own logo route
    document.querySelector<HTMLElement>('[data-radio-link-more="1"]')!.click();
    document.querySelector<HTMLElement>('[data-radio-link-logo="1"]')!.click();
    expect((document.getElementById('radio-logo-1') as HTMLInputElement).value).toBe(
      'https://lowlands.example.org/logo.png',
    );
    expect(
      document.querySelector<HTMLImageElement>('.radio-logo-preview img')!.getAttribute('src'),
    ).toMatch(/\/api\/radio\/stations\/link-1\/logo$/);
  });

  it('a refused logo stays in the panel, in words, with the address kept', async () => {
    refuse = true;
    await loadRadioSettings();
    document.querySelector<HTMLElement>('[data-radio-link-more="1"]')!.click();
    document.querySelector<HTMLElement>('[data-radio-link-logo="1"]')!.click();
    const input = document.getElementById('radio-logo-1') as HTMLInputElement;
    input.value = 'https://lowlands.example.org/logo.svg';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-radio-logo-panel] [role="alert"]')!.textContent).toBe(
        'SVG logos can’t be used: PNG, JPEG, GIF, WebP or ICO only.',
      ),
    );
    expect((document.getElementById('radio-logo-1') as HTMLInputElement).value).toBe(
      'https://lowlands.example.org/logo.svg',
    );
    // Cancel closes it and gives the focus back to the "…"
    document.querySelector<HTMLElement>('[data-radio-logo-cancel="1"]')!.click();
    expect(document.querySelector('[data-radio-logo-panel]')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-radio-link-more="1"]'));
  });
});
