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
