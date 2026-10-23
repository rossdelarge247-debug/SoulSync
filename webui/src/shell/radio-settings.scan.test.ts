import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRadioSettingsForTests,
  fieldsFor,
  loadRadioSettings,
  serviceNeeds,
  serviceTag,
  setOnWords,
  usageLine,
  type RadioSettingsBody,
  type ScanServiceState,
} from './radio-settings';

// 14 March 2026, midday UTC (a date that reads the same in every time zone)
const MARCH_14 = Date.UTC(2026, 2, 14, 12) / 1000;

function body(
  over: {
    audd?: boolean;
    acr?: boolean;
    states?: Partial<Record<'acoustid' | 'audd' | 'acrcloud', ScanServiceState>>;
  } = {},
): RadioSettingsBody {
  const audd = over.audd ?? true;
  const acr = over.acr ?? false;
  return {
    success: true,
    is_admin: true,
    settings: {
      identification: true,
      daily_limit: 50,
      relay: 'when_needed',
      prefer_lossless: true,
      keep_heard_days: 90,
      acoustid_api_key: { set: true, masked: 'x9Kf•••••••Q2' },
      scan_services: {
        audd_api_token: { set: audd },
        acrcloud_host: { set: acr },
        acrcloud_access_key: { set: acr },
        acrcloud_access_secret: { set: acr },
        audd_ready: audd,
        acrcloud_ready: acr,
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
      ready: { acoustid: true, audd, acrcloud: acr },
      usage: {
        acoustid: { requests: 41, found: 29 },
        audd: { requests: 12, found: 10 },
        acrcloud: { requests: 0, found: 0 },
      },
      services: {
        acoustid: { state: over.states?.acoustid ?? 'ready', set_at: null },
        audd: { state: over.states?.audd ?? (audd ? 'ready' : 'not_set_up'), set_at: MARCH_14 },
        acrcloud: { state: over.states?.acrcloud ?? (acr ? 'ready' : 'not_set_up'), set_at: null },
      },
      month: 'October',
    },
  };
}

const MEMBER: RadioSettingsBody = {
  success: true,
  is_admin: false,
  scan: {
    order: ['acoustid', 'audd', 'acrcloud'],
    labels: { acoustid: 'AcoustID', audd: 'AudD', acrcloud: 'ACRCloud' },
    services: {
      acoustid: { state: 'ready' },
      audd: { state: 'refused' },
      acrcloud: { state: 'not_set_up' },
    },
  },
};

function markup() {
  document.body.innerHTML = `
    <div id="settings-page"><button id="stg-tab-radio" hidden></button>
    <div id="radio-settings">
      <section class="radio-card" id="card-id"><p id="radio-settings-error" hidden></p></section>
      <section class="radio-card radio-scan-card">
        <ul id="radio-scan-services"></ul>
        <p id="radio-scan-status"></p>
        <p id="radio-scan-foot">Test sends AudD or ACRCloud one second of silence…</p>
      </section>
      <section class="radio-card" id="card-streams"><p id="radio-save-status"></p></section>
      <section class="radio-card" id="card-links"><ul id="radio-links"></ul></section>
    </div></div>`;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-service="${id}"]`)!;

describe('Settings → Radio: Scan now services (11c)', () => {
  const sent: { url: string; method: string; body: unknown }[] = [];
  let current = body();
  let testAnswer: Record<string, unknown> = {};
  beforeEach(() => {
    markup();
    _resetRadioSettingsForTests();
    sent.length = 0;
    current = body();
    testAnswer = {
      success: true,
      ok: false,
      state: 'bad_key',
      message: 'AudD refused the key. An admin can check it in Settings → Radio.',
      usage: { ...current.scan!.usage!, audd: { requests: 13, found: 10 } },
      services: body({ states: { audd: 'refused' } }).scan!.services,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const payload = init?.body ? JSON.parse(String(init.body)) : null;
        sent.push({ url, method: init?.method ?? 'GET', body: payload });
        if (url.endsWith('/api/radio/scan/test'))
          return new Response(JSON.stringify(testAnswer), { status: 200 });
        if (init?.method === 'PUT') {
          if (payload?.remove) current = body({ audd: false });
          if (payload?.acrcloud_access_secret) current = body({ acr: true });
          if (payload?.audd_api_token) current = body();
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

  it('words the tags, the counts and what each service needs', () => {
    expect(serviceTag('ready')).toEqual({ label: 'Ready', tone: 'success' });
    expect(serviceTag('not_set_up')).toEqual({ label: 'Not set up', tone: 'neutral' });
    expect(serviceTag('refused')).toEqual({ label: 'Refused', tone: 'danger' });
    expect(serviceTag('no_requests_left')).toEqual({ label: 'No requests left', tone: 'warning' });
    expect(usageLine({ requests: 41, found: 29 }, 'October')).toBe(
      '41 requests in October · 29 found the track',
    );
    expect(usageLine({ requests: 0, found: 0 }, 'October', false)).toBe('Not asked');
    expect(usageLine({ requests: 0, found: 0 }, 'October')).toBe('Not asked in October');
    expect(setOnWords(MARCH_14)).toBe('14 March 2026');
    expect(serviceNeeds('audd', body())).toEqual({
      text: 'Token set, 14 March 2026',
      replace: 'Replace the token…',
    });
    expect(serviceNeeds('acoustid', body()).text).toBe(
      'Free · a fingerprint · uses the AcoustID key from Track identification above',
    );
    expect(serviceNeeds('acrcloud', body()).text).toBe(
      'A project’s host, access key and secret, from the ACRCloud console',
    );
    // a key saved before dates were kept still says it's set
    const old = body({ acr: true });
    expect(serviceNeeds('acrcloud', old)).toEqual({
      text: 'Keys set',
      replace: 'Replace the keys…',
    });
    // members: what kind of service it is, nothing about keys
    expect(serviceNeeds('audd', body(), false)).toEqual({
      text: 'Paid · an account with a monthly allowance',
      replace: null,
    });
    // the first unset paid service opens; a chosen one wins; members never get fields
    expect(fieldsFor(body(), null)).toBe('acrcloud');
    expect(fieldsFor(body({ audd: false }), null)).toBe('audd');
    expect(fieldsFor(body({ acr: true }), null)).toBeNull();
    expect(fieldsFor(body(), 'audd')).toBe('audd');
    expect(fieldsFor(MEMBER, 'audd')).toBeNull();
  });

  it('draws the three numbered rows with their tag, counts, Test and (paid) Remove', async () => {
    await loadRadioSettings();
    const items = [...document.querySelectorAll<HTMLElement>('#radio-scan-services > li')];
    expect(items.map((r) => r.dataset.service)).toEqual(['acoustid', 'audd', 'acrcloud']);
    expect(items.map((r) => r.querySelector('.radio-scan-step')!.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(row('acoustid').querySelector('.radio-tag')!.textContent).toBe('Ready');
    expect(row('acoustid').querySelector('.radio-scan-usage')!.textContent).toBe(
      '41 requests in October · 29 found the track',
    );
    // AcoustID is free: Test, no Remove
    expect(row('acoustid').querySelector('[data-radio-scan-test]')).not.toBeNull();
    expect(row('acoustid').querySelector('[data-radio-scan-remove]')).toBeNull();
    expect(row('audd').querySelector('.radio-scan-needs')!.textContent).toBe(
      'Token set, 14 March 2026 · Replace the token…',
    );
    expect(row('audd').querySelector('[data-radio-scan-remove]')!.textContent).toBe('Remove');
    // ACRCloud isn't set up: its tag, "Not asked", no buttons, and its fields under the row
    expect(row('acrcloud').querySelector('.radio-tag')!.textContent).toBe('Not set up');
    expect(row('acrcloud').querySelector('.radio-scan-usage')!.textContent).toBe('Not asked');
    expect(row('acrcloud').querySelectorAll('.radio-scan-actions button')).toHaveLength(0);
    const fields = row('acrcloud').querySelector('[data-fields="acrcloud"]')!;
    expect(
      [...fields.querySelectorAll('.radio-scan-field-label')].map((l) => l.textContent),
    ).toEqual(['Host', 'Access key', 'Access secret']);
    expect(fields.querySelector<HTMLInputElement>('input')!.placeholder).toBe(
      'identify-eu-west-1.acrcloud.com',
    );
    // the card's one primary
    const primaries = document.querySelectorAll('#radio-scan-services .radio-button--primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.textContent).toBe('Save and test');
    expect(document.getElementById('radio-scan-foot')!.hidden).toBe(false);
  });

  it('Save and test saves the fields write-only, then tests the service', async () => {
    testAnswer = { ...testAnswer, ok: true, state: 'ok', message: 'ACRCloud accepted the keys.' };
    await loadRadioSettings();
    const fields = row('acrcloud').querySelector<HTMLElement>('[data-fields="acrcloud"]')!;
    const [host, key, secret] = [...fields.querySelectorAll<HTMLInputElement>('input')];
    host!.value = 'identify-eu-west-1.acrcloud.com';
    key!.value = 'key123456789';
    // one missing: says which, and sends nothing
    fields.querySelector<HTMLElement>('[data-radio-scan-save]')!.click();
    await vi.waitFor(() =>
      expect(document.getElementById('radio-scan-status')!.textContent).toBe(
        'Fill in the access secret first.',
      ),
    );
    expect(sent.some((s) => s.method === 'PUT')).toBe(false);
    secret!.value = 'secret123456789';
    fields.querySelector<HTMLElement>('[data-radio-scan-save]')!.click();
    await vi.waitFor(() => expect(sent.some((s) => s.url.endsWith('/scan/test'))).toBe(true));
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({
      acrcloud_host: 'identify-eu-west-1.acrcloud.com',
      acrcloud_access_key: 'key123456789',
      acrcloud_access_secret: 'secret123456789',
    });
    expect(sent.find((s) => s.url.endsWith('/scan/test'))!.body).toEqual({ service: 'acrcloud' });
    await vi.waitFor(() =>
      expect(document.getElementById('radio-scan-status')!.textContent).toBe(
        'Saved. ACRCloud accepted the keys.',
      ),
    );
    // set up now: the fields close and its row gets Test and Remove
    expect(document.querySelector('[data-fields]')).toBeNull();
    expect(row('acrcloud').querySelector('[data-radio-scan-remove]')).not.toBeNull();
    // the keys never come back into a field
    for (const input of document.querySelectorAll<HTMLInputElement>('#radio-settings input'))
      expect(input.value).toBe('');
  });

  it('Replace the token… opens its field in place, one primary at a time; Cancel closes it', async () => {
    await loadRadioSettings();
    const replace = row('audd').querySelector<HTMLElement>('[data-radio-scan-replace]')!;
    expect(replace.getAttribute('aria-expanded')).toBe('false');
    replace.click();
    const fields = row('audd').querySelector('[data-fields="audd"]')!;
    expect(fields).not.toBeNull();
    expect(fields.querySelector<HTMLInputElement>('input')!.placeholder).toBe('Saved (hidden)');
    expect(document.activeElement).toBe(fields.querySelector('input'));
    expect(
      row('audd').querySelector('[data-radio-scan-replace]')!.getAttribute('aria-expanded'),
    ).toBe('true');
    // ACRCloud's fields fold to a "Set up…" button
    expect(row('acrcloud').querySelector('[data-fields]')).toBeNull();
    expect(row('acrcloud').querySelector('[data-radio-scan-setup]')!.textContent).toBe('Set up…');
    expect(document.querySelectorAll('.radio-button--primary')).toHaveLength(1);
    row('audd').querySelector<HTMLElement>('[data-radio-scan-cancel]')!.click();
    expect(row('audd').querySelector('[data-fields]')).toBeNull();
    expect(row('acrcloud').querySelector('[data-fields="acrcloud"]')).not.toBeNull();
    // Enter in a field is Save and test
    row('audd').querySelector<HTMLElement>('[data-radio-scan-replace]')!.click();
    const input = row('audd').querySelector<HTMLInputElement>('[data-fields] input')!;
    input.value = 'auddTOKEN1234567890';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() =>
      expect(sent.filter((s) => s.method === 'PUT').map((s) => s.body)).toContainEqual({
        audd_api_token: 'auddTOKEN1234567890',
      }),
    );
  });

  it('a refused key and an empty allowance show in the tag; Test and Remove still work', async () => {
    current = body({ states: { audd: 'no_requests_left', acoustid: 'refused' } });
    await loadRadioSettings();
    expect(row('audd').querySelector('.radio-tag')!.textContent).toBe('No requests left');
    expect(row('audd').querySelector<HTMLElement>('.radio-tag')!.dataset.tone).toBe('warning');
    expect(row('acoustid').querySelector('.radio-tag')!.textContent).toBe('Refused');
    expect(row('acoustid').querySelector('.radio-scan-needs')!.textContent).toContain(
      'AcoustID refused the key',
    );
    const test = row('audd').querySelector<HTMLElement>('[data-radio-scan-test]')!;
    expect(test.getAttribute('aria-label')).toBe('Test AudD: uses one request');
    test.click();
    await vi.waitFor(() =>
      expect(document.getElementById('radio-scan-status')!.textContent).toContain(
        'refused the key',
      ),
    );
    // the answer's tags and counts take over
    expect(row('audd').querySelector('.radio-tag')!.textContent).toBe('Refused');
    expect(row('audd').querySelector('.radio-scan-usage')!.textContent).toBe(
      '13 requests in October · 10 found the track',
    );
    row('audd').querySelector<HTMLElement>('[data-radio-scan-remove]')!.click();
    await vi.waitFor(() => expect(sent.some((s) => s.method === 'PUT')).toBe(true));
    expect(sent.find((s) => s.method === 'PUT')!.body).toEqual({ remove: ['audd'] });
    await vi.waitFor(() =>
      expect(row('audd').querySelector('[data-fields="audd"]')).not.toBeNull(),
    );
  });

  it('members see the rows and tags, with no fields, buttons or counts', async () => {
    current = MEMBER;
    await loadRadioSettings();
    expect(
      [...document.querySelectorAll('#radio-scan-services .radio-tag')].map((t) => t.textContent),
    ).toEqual(['Ready', 'Refused', 'Not set up']);
    expect(document.querySelectorAll('#radio-scan-services button')).toHaveLength(0);
    expect(document.querySelectorAll('#radio-scan-services input')).toHaveLength(0);
    expect(document.querySelector('.radio-scan-usage')).toBeNull();
    expect(row('audd').querySelector('.radio-scan-needs')!.textContent).toBe(
      'Paid · an account with a monthly allowance',
    );
    expect(document.getElementById('radio-scan-foot')!.hidden).toBe(true);
    // the other cards are admins' settings
    expect(document.getElementById('card-streams')!.hidden).toBe(true);
    expect(document.getElementById('card-links')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.radio-scan-card')!.hidden).toBe(false);
  });
});
