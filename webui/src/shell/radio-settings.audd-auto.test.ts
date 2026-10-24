import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRadioSettingsForTests,
  autoLine,
  autoStateTone,
  autoStateWords,
  autoUsageLine,
  loadRadioSettings,
  type AuddAuto,
  type RadioSettingsBody,
} from './radio-settings';

function body(
  auto: Partial<AuddAuto> = {},
  settings: { on?: boolean; cap?: number } = {},
): RadioSettingsBody {
  const on = settings.on ?? true;
  const cap = settings.cap ?? 100;
  return {
    success: true,
    is_admin: true,
    settings: {
      identification: true,
      daily_limit: 50,
      relay: 'when_needed',
      prefer_lossless: true,
      keep_heard_days: 90,
      audd_auto: on,
      audd_auto_daily_cap: cap,
      acoustid_api_key: { set: true, masked: 'x9Kf•••••••Q2' },
      scan_services: {
        audd_api_token: { set: true },
        acrcloud_host: { set: false },
        acrcloud_access_key: { set: false },
        acrcloud_access_secret: { set: false },
        audd_ready: true,
        acrcloud_ready: false,
      },
    },
    auto_add: { stations: [], added_this_week: 0 },
    links: [],
    scan: {
      order: ['acoustid', 'audd', 'acrcloud'],
      labels: { acoustid: 'AcoustID', audd: 'AudD', acrcloud: 'ACRCloud' },
      ready: { acoustid: true, audd: true, acrcloud: false },
      usage: {
        acoustid: { requests: 41, found: 29 },
        audd: { requests: 30, found: 21 },
        acrcloud: { requests: 0, found: 0 },
      },
      services: {
        acoustid: { state: 'ready', set_at: null },
        audd: { state: 'ready', set_at: null },
        acrcloud: { state: 'not_set_up', set_at: null },
      },
      month: 'October',
      audd_auto: {
        on: on && cap > 0,
        daily_cap: cap,
        used_today: 12,
        ready: true,
        stopped: null,
        ...auto,
      },
    },
  };
}

function markup() {
  document.body.innerHTML = `
    <div id="settings-page"><button id="stg-tab-radio" hidden></button>
    <div id="radio-settings">
      <section class="radio-card" id="card-id"><p id="radio-settings-error" hidden></p></section>
      <section class="radio-card radio-scan-card">
        <ul id="radio-scan-services"></ul>
        <div id="radio-scan-auto">
          <p id="radio-audd-auto-title">Listen automatically when the station doesn't say</p>
          <p id="radio-audd-auto-line"></p>
          <p id="radio-audd-auto-state" hidden></p>
          <div id="radio-audd-auto-controls">
            <input id="radio-audd-auto-cap" type="number">
            <button id="radio-audd-auto" role="switch" aria-checked="true"><span class="radio-switch-text">On</span></button>
          </div>
        </div>
        <p id="radio-scan-status"></p>
        <p id="radio-scan-foot"></p>
      </section>
      <section class="radio-card" id="card-streams"><p id="radio-save-status"></p></section>
      <section class="radio-card" id="card-links"><ul id="radio-links"></ul></section>
    </div></div>`;
}

const $ = (id: string) => document.getElementById(id)!;

describe('Settings → Radio: AudD listens automatically', () => {
  const sent: { method: string; body: Record<string, unknown> | null }[] = [];
  let current = body();
  beforeEach(() => {
    markup();
    _resetRadioSettingsForTests();
    sent.length = 0;
    current = body();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const payload = init?.body ? JSON.parse(init.body as string) : null;
        sent.push({ method: init?.method ?? 'GET', body: payload });
        if (init?.method === 'PUT') {
          const s = current.settings!;
          current = body(
            {},
            {
              on: payload.audd_auto ?? s.audd_auto,
              cap: payload.audd_auto_daily_cap ?? s.audd_auto_daily_cap,
            },
          );
        }
        return new Response(JSON.stringify(current), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('words the line, today’s count and why it stopped', () => {
    expect(autoLine({ on: true, daily_cap: 100 })).toBe(
      'Only when the station doesn’t name the track and AcoustID didn’t know it. Up to 100 a day; Scan now by hand doesn’t count.',
    );
    expect(autoLine({ on: false, daily_cap: 100 })).toBe(
      'Off. AudD is asked only when someone presses Scan now.',
    );
    expect(autoUsageLine({ on: true, daily_cap: 100, used_today: 12 })).toBe(
      '12 of 100 automatic today',
    );
    expect(autoUsageLine({ on: false, daily_cap: 100, used_today: 12 })).toBe('');
    expect(
      autoStateWords({
        on: true,
        daily_cap: 100,
        ready: true,
        stopped: 'bad_key',
      }),
    ).toBe('Stopped for today: AudD refused the token.');
    expect(
      autoStateWords({
        on: true,
        daily_cap: 100,
        ready: true,
        stopped: 'out_of_credit',
      }),
    ).toBe('Stopped for today: AudD says the account has no requests left.');
    expect(
      autoStateWords({
        on: true,
        daily_cap: 100,
        ready: true,
        stopped: 'cap_reached',
      }),
    ).toBe('Stopped for today: today’s 100 are used. It starts again at midnight.');
    expect(autoStateWords({ on: true, daily_cap: 100, ready: false })).toBe(
      'Needs AudD’s token, above.',
    );
    expect(autoStateWords({ on: true, daily_cap: 100, ready: true, stopped: null })).toBe('');
  });

  it('draws the switch, the cap and today’s count on AudD’s row', async () => {
    await loadRadioSettings();
    expect($('radio-audd-auto').getAttribute('aria-checked')).toBe('true');
    expect($('radio-audd-auto').textContent).toBe('On');
    expect(($('radio-audd-auto-cap') as HTMLInputElement).value).toBe('100');
    expect($('radio-audd-auto-line').textContent).toContain('Up to 100 a day');
    expect($('radio-audd-auto-state').hidden).toBe(true);
    const usage = document.querySelector('[data-service="audd"] .radio-scan-usage')!;
    expect(usage.querySelector('.radio-scan-usage-auto')!.textContent).toBe(
      '12 of 100 automatic today',
    );
    // only AudD's row has it
    expect(document.querySelectorAll('.radio-scan-usage-auto')).toHaveLength(1);
  });

  it('the switch and the cap save at once', async () => {
    await loadRadioSettings();
    $('radio-audd-auto').click();
    await vi.waitFor(() => expect(sent.at(-1)?.method).toBe('PUT'));
    expect(sent.at(-1)!.body).toEqual({ audd_auto: false });
    await vi.waitFor(() => expect($('radio-audd-auto').getAttribute('aria-checked')).toBe('false'));
    expect($('radio-audd-auto-line').textContent).toBe(
      'Off. AudD is asked only when someone presses Scan now.',
    );
    expect(document.querySelector('.radio-scan-usage-auto')).toBeNull();
    $('radio-audd-auto').click();
    await vi.waitFor(() => expect($('radio-audd-auto').getAttribute('aria-checked')).toBe('true'));
    const cap = $('radio-audd-auto-cap') as HTMLInputElement;
    cap.value = '40';
    cap.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(sent.at(-1)!.body).toEqual({ audd_auto_daily_cap: 40 }));
    await vi.waitFor(() =>
      expect($('radio-audd-auto-line').textContent).toContain('Up to 40 a day'),
    );
    // a bad number isn't sent
    const before = sent.length;
    cap.value = '-3';
    cap.dispatchEvent(new Event('change'));
    expect(sent.length).toBe(before);
    expect($('radio-scan-status').textContent).toContain('0 to 1000');
  });

  it('shows why it stopped for today', async () => {
    current = body({ stopped: 'out_of_credit' });
    await loadRadioSettings();
    expect($('radio-audd-auto-state').hidden).toBe(false);
    expect($('radio-audd-auto-state').textContent).toBe(
      'Stopped for today: AudD says the account has no requests left.',
    );
    expect($('radio-audd-auto-state').dataset.tone).toBe('danger');
  });

  it('gives the stopped line’s dot its tone (111): warning for the cap, danger for refused or none left', async () => {
    current = body({ stopped: 'cap_reached' });
    await loadRadioSettings();
    expect($('radio-audd-auto-state').dataset.tone).toBe('warning');
    expect(autoStateTone({ on: true, daily_cap: 100, ready: true, stopped: 'bad_key' })).toBe(
      'danger',
    );
    expect(autoStateTone({ on: true, daily_cap: 100, ready: true, stopped: 'out_of_credit' })).toBe(
      'danger',
    );
    expect(autoStateTone({ on: true, daily_cap: 100, ready: false })).toBe('neutral');
    expect(autoStateTone({ on: true, daily_cap: 100, ready: true, stopped: null })).toBe('neutral');
    expect(autoStateTone(undefined)).toBe('neutral');
  });
});
