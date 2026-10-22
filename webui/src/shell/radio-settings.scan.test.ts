import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRadioSettingsForTests,
  loadRadioSettings,
  serviceLine,
  usageLine,
  type RadioSettingsBody,
} from './radio-settings';

function body(over: { audd?: boolean; acr?: boolean } = {}): RadioSettingsBody {
  return {
    success: true,
    settings: {
      identification: true,
      daily_limit: 50,
      relay: 'when_needed',
      prefer_lossless: true,
      keep_heard_days: 90,
      acoustid_api_key: { set: true, masked: 'x9Kf•••••••Q2' },
      scan_services: {
        audd_api_token: { set: over.audd ?? true },
        acrcloud_host: { set: over.acr ?? false },
        acrcloud_access_key: { set: over.acr ?? false },
        acrcloud_access_secret: { set: over.acr ?? false },
        audd_ready: over.audd ?? true,
        acrcloud_ready: over.acr ?? false,
      },
    },
    status: {
      fpcalc: { found: true, detail: 'fpcalc found' },
      acoustid: { state: 'ok', detail: 'AcoustID answered', checked_at: null },
    },
    auto_add: { stations: [], added_this_week: 0 },
    links: [],
    scan: {
      order: ['acoustid', 'audd', 'acrcloud'],
      labels: { acoustid: 'AcoustID', audd: 'AudD', acrcloud: 'ACRCloud' },
      ready: { acoustid: true, audd: over.audd ?? true, acrcloud: over.acr ?? false },
      usage: {
        acoustid: { requests: 4, found: 1 },
        audd: { requests: 1, found: 1 },
        acrcloud: { requests: 0, found: 0 },
      },
      month: 'October',
    },
  };
}

function markup() {
  document.body.innerHTML = `
    <div id="settings-page"><button id="stg-tab-radio" hidden></button>
    <div id="radio-settings">
      <p id="radio-settings-error" hidden></p>
      <ul id="radio-scan-services"></ul>
      <input id="radio-audd-token"><button id="radio-audd-save"></button>
      <input id="radio-acr-host"><input id="radio-acr-key"><input id="radio-acr-secret">
      <button id="radio-acr-save"></button>
      <p id="radio-scan-status"></p>
      <p id="radio-save-status"></p>
      <ul id="radio-links"></ul>
    </div></div>`;
}

describe('Settings → Radio: Scan now services', () => {
  const sent: { url: string; method: string; body: unknown }[] = [];
  let current = body();
  beforeEach(() => {
    markup();
    _resetRadioSettingsForTests();
    sent.length = 0;
    current = body();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const payload = init?.body ? JSON.parse(String(init.body)) : null;
        sent.push({ url, method: init?.method ?? 'GET', body: payload });
        if (url.endsWith('/api/radio/scan/test')) {
          return new Response(
            JSON.stringify({
              success: true,
              ok: false,
              state: 'bad_key',
              message: 'AudD refused the key. An admin can check it in Settings → Radio.',
              usage: { ...current.scan!.usage, audd: { requests: 2, found: 1 } },
            }),
            { status: 200 },
          );
        }
        if (init?.method === 'PUT') {
          if (payload?.remove) current = body({ audd: false });
          return new Response(JSON.stringify(current), { status: 200 });
        }
        return new Response(JSON.stringify(current), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('words each service and this month’s requests', () => {
    expect(usageLine({ requests: 3, found: 1 }, 'October')).toBe('3 requests in October · 1 found');
    expect(usageLine({ requests: 0, found: 0 }, 'October')).toBe('No requests in October');
    expect(serviceLine('acoustid', body())).toEqual({ text: 'Free · ready', tone: 'success' });
    expect(serviceLine('audd', body()).text).toBe(
      'Paid · ready · only when someone presses Scan now',
    );
    expect(serviceLine('acrcloud', body()).text).toBe('Paid · not set up');
  });

  it('lists the three in order, keeps keys hidden, and Test and Remove work', async () => {
    await loadRadioSettings();
    const rows = [...document.querySelectorAll<HTMLElement>('#radio-scan-services li')];
    expect(rows.map((r) => r.dataset.service)).toEqual(['acoustid', 'audd', 'acrcloud']);
    expect(rows[0]!.textContent).toContain('4 requests in October · 1 found');
    expect((document.getElementById('radio-audd-token') as HTMLInputElement).placeholder).toBe(
      'Saved (hidden)',
    );
    expect((document.getElementById('radio-audd-token') as HTMLInputElement).value).toBe('');
    const acrTest = rows[2]!.querySelector<HTMLButtonElement>('[data-radio-scan-test]')!;
    expect(acrTest.hidden).toBe(true);
    const auddTest = rows[1]!.querySelector<HTMLButtonElement>('[data-radio-scan-test]')!;
    expect(auddTest.getAttribute('aria-label')).toBe('Test AudD: uses one request');
    auddTest.click();
    await vi.waitFor(() =>
      expect(document.getElementById('radio-scan-status')!.textContent).toContain(
        'refused the key',
      ),
    );
    expect(sent.find((s) => s.url.endsWith('/scan/test'))!.body).toEqual({ service: 'audd' });
    document.querySelector<HTMLElement>('[data-service="audd"] [data-radio-scan-remove]')!.click();
    await vi.waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true));
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({ remove: ['audd'] });
  });

  it('saves the AudD token and the ACRCloud keys write-only', async () => {
    await loadRadioSettings();
    const token = document.getElementById('radio-audd-token') as HTMLInputElement;
    token.value = 'auddTOKEN1234567890';
    document.getElementById('radio-audd-save')!.click();
    await vi.waitFor(() =>
      expect(sent.filter((s) => s.method === 'PUT').map((s) => s.body)).toContainEqual({
        audd_api_token: 'auddTOKEN1234567890',
      }),
    );
    await vi.waitFor(() => expect(token.value).toBe(''));
    (document.getElementById('radio-acr-host') as HTMLInputElement).value =
      'identify-eu-west-1.acrcloud.com';
    (document.getElementById('radio-acr-key') as HTMLInputElement).value = 'key123456789';
    (document.getElementById('radio-acr-secret') as HTMLInputElement).value = 'secret123456789';
    document.getElementById('radio-acr-save')!.click();
    await vi.waitFor(() =>
      expect(sent.filter((s) => s.method === 'PUT').map((s) => s.body)).toContainEqual({
        acrcloud_host: 'identify-eu-west-1.acrcloud.com',
        acrcloud_access_key: 'key123456789',
        acrcloud_access_secret: 'secret123456789',
      }),
    );
  });
});
