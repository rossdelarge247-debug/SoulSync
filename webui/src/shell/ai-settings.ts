/**
 * Settings → AI (board 5a), on the legacy Settings page, restyled in place
 * like Modules. Markup in index.html (#ai-settings), look in
 * static/ai-settings.css.
 *
 * - The Assistant card: provider, the API key (write-only: the browser only
 *   ever sees "sk-ant-••••…3f9"), Replace / Test / Save and test with a
 *   status line, the model as two radio cards and who can use it.
 * - Usage this month, once a key is saved, with the optional monthly cap.
 * - What's sent to the provider: static copy.
 *
 * Each choice saves as soon as it's made (PUT /api/ai/settings), like the
 * Modules switches; Save Settings doesn't touch this tab. Admins only: the
 * tab stays hidden for everyone else, and the routes refuse them anyway.
 */

import { appURL } from '@/platform/url-base';

export interface AiKeyStatus {
  state: 'missing' | 'untested' | 'ok' | 'refused';
  message: string | null;
  tested_at: string | null;
  tested_by: string | null;
  added_at: string | null;
  added_by: string | null;
}

export interface AiSettings {
  provider: string;
  api_key: { set: boolean; masked: string };
  model: 'fast' | 'best';
  who_can_use: 'admins' | 'everyone';
  monthly_cap_usd: number | null;
  key_status: AiKeyStatus;
}

export interface AiUsage {
  month: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  drafts_saved: number;
  cap_usd: number | null;
}

interface SettingsResponse {
  success?: boolean;
  error?: string;
  settings?: AiSettings;
  usage?: AiUsage | null;
}

interface TestResponse {
  ok?: boolean;
  message?: string;
  key_status?: AiKeyStatus | null;
}

const ROOT_ID = 'ai-settings';
const TAB_ID = 'stg-tab-ai';

let settings: AiSettings | null = null;
let usage: AiUsage | null = null;
let replacing = false;
let busy: 'saving' | 'testing' | null = null;
let bound = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function isAdmin(): boolean {
  const ctx = window.SoulSyncWebShellBridge?.getCurrentProfileContext?.() ?? null;
  // no profile context means a single-profile install: its one profile is the admin
  return ctx ? !!ctx.isAdmin || ctx.profileId === 1 : true;
}

// ── words ───────────────────────────────────────────────────────────────────

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "today 10:52", "yesterday 09:00", "on 22 October" (no time: "today"). */
export function whenWords(
  value: string | null | undefined,
  now = new Date(),
  withTime = true,
): string {
  const date = parseTime(value);
  if (!date) return '';
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  const time = withTime ? ` ${clock(date)}` : '';
  if (day(date) === day(now)) return `today${time}`;
  if (day(date) === day(yesterday)) return `yesterday${time}`;
  return `on ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** The status line under the key, and its tone. */
export function keyStatusLine(
  status: AiKeyStatus,
  now = new Date(),
): { text: string; tone: 'success' | 'danger' | 'neutral' } {
  const added = status.added_by
    ? `added by ${status.added_by}${status.added_at ? ` ${whenWords(status.added_at, now, false)}` : ''}`
    : '';
  const tested = status.tested_at ? `tested ${whenWords(status.tested_at, now)}` : '';
  switch (status.state) {
    case 'ok':
      return { text: ['Key works', tested, added].filter(Boolean).join(' · '), tone: 'success' };
    case 'refused':
      return { text: 'Anthropic refused this key', tone: 'danger' };
    case 'untested':
      return { text: ['Not tested yet', added].filter(Boolean).join(' · '), tone: 'neutral' };
    default:
      return {
        text: 'No key yet. Paste one from your Anthropic account, then Save and test.',
        tone: 'neutral',
      };
  }
}

/** "about $1.80" ("under $0.01" for a sliver). */
export function costWords(usd: number): string {
  if (!usd) return 'about $0.00';
  if (usd < 0.01) return 'under $0.01';
  return `about $${usd.toFixed(2)}`;
}

export function capText(cap: number | null): string {
  if (cap == null) return '';
  return `$${Number.isInteger(cap) ? cap : cap.toFixed(2)}`;
}

function sinceWords(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `1 ${MONTHS[Number(m[2]) - 1]}` : 'the 1st';
}

// ── the server ─────────────────────────────────────────────────────────────

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

async function getSettings(): Promise<SettingsResponse> {
  const res = await fetch(appURL('/api/ai/settings'), { headers: { Accept: 'application/json' } });
  const body = await readJson<SettingsResponse>(res);
  if (!res.ok || !body.settings) throw new Error(body.error || 'Couldn’t read Settings → AI.');
  return body;
}

async function putSettings(patch: Record<string, unknown>): Promise<SettingsResponse> {
  const res = await fetch(appURL('/api/ai/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await readJson<SettingsResponse>(res);
  if (!res.ok || !body.settings)
    throw new Error(body.error || 'Couldn’t save. Nothing was changed.');
  return body;
}

async function postTest(): Promise<TestResponse> {
  const res = await fetch(appURL('/api/ai/test'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  });
  return readJson<TestResponse>(res);
}

// ── drawing ────────────────────────────────────────────────────────────────

function setSaveStatus(text: string, tone: 'success' | 'danger' | 'neutral' = 'neutral'): void {
  const el = $('ai-save-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

function syncRadios(groupId: string, value: string): void {
  const group = $(groupId);
  if (!group) return;
  for (const radio of group.querySelectorAll<HTMLElement>('[role="radio"]')) {
    const on = radio.dataset.value === value;
    radio.setAttribute('aria-checked', String(on));
    radio.tabIndex = on ? 0 : -1;
  }
}

export function renderAiSettings(): void {
  const root = $(ROOT_ID);
  if (!root || !settings) return;
  const status = settings.key_status;
  const editing = !settings.api_key.set || replacing;
  const input = $<HTMLInputElement>('ai-key');
  if (input) {
    if (editing) {
      if (input.readOnly) input.value = '';
      input.readOnly = false;
      input.type = 'password';
      input.setAttribute('aria-label', replacing ? 'New API key' : 'API key');
    } else {
      input.readOnly = true;
      input.type = 'text';
      input.value = settings.api_key.masked;
      input.removeAttribute('aria-label');
    }
    const refused = !editing && status.state === 'refused';
    if (refused) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  const show = (id: string, on: boolean) => {
    const el = $(id);
    if (el) el.hidden = !on;
  };
  show('ai-key-replace', !editing);
  show('ai-key-test', !editing);
  show('ai-key-save', editing);
  show('ai-key-cancel', editing && settings.api_key.set);
  for (const id of ['ai-key-save', 'ai-key-test', 'ai-key-replace']) {
    const button = $(id);
    if (!button) continue;
    if (busy) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }

  const line = $('ai-key-status');
  if (line) {
    if (busy === 'testing') {
      line.textContent = 'Testing…';
      line.dataset.tone = 'neutral';
      line.dataset.busy = 'true';
    } else if (busy === 'saving') {
      line.textContent = 'Saving…';
      line.dataset.tone = 'neutral';
      line.dataset.busy = 'true';
    } else {
      const { text, tone } = keyStatusLine(
        editing && replacing ? { ...status, state: 'untested' } : status,
      );
      line.textContent =
        editing && replacing
          ? 'Paste the new key, then Save and test. The old one stays until then.'
          : text;
      line.dataset.tone = editing && replacing ? 'neutral' : tone;
      delete line.dataset.busy;
    }
  }

  syncRadios('ai-model-cards', settings.model);
  syncRadios('ai-who', settings.who_can_use);
  const provider = $<HTMLSelectElement>('ai-provider');
  if (provider) provider.value = settings.provider;

  const card = $('ai-usage-card');
  if (card) card.hidden = !settings.api_key.set;
  if (usage) {
    const set = (id: string, text: string) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    set('ai-usage-requests', usage.requests.toLocaleString());
    set('ai-usage-cost', costWords(usage.estimated_cost_usd));
    set('ai-usage-drafts', usage.drafts_saved.toLocaleString());
    set(
      'ai-usage-note',
      `Counted here from the tokens each request used and the provider’s list prices, since ${sinceWords(usage.month)}. Your provider’s own billing page is the final word.`,
    );
  }
  const cap = $<HTMLInputElement>('ai-cap');
  if (cap && document.activeElement !== cap) cap.value = capText(settings.monthly_cap_usd);
}

function apply(body: SettingsResponse): void {
  if (body.settings) settings = body.settings;
  if (body.usage !== undefined) usage = body.usage ?? null;
  renderAiSettings();
}

function showLoadError(message: string | null): void {
  const el = $('ai-settings-error');
  if (!el) return;
  el.hidden = !message;
  el.textContent = message ?? '';
}

/** The tab opened: read the settings fresh. */
export async function loadAiSettings(): Promise<void> {
  syncTabVisibility();
  if (!isAdmin()) return;
  try {
    apply(await getSettings());
    showLoadError(null);
  } catch (error) {
    showLoadError(
      `${(error as Error).message} Nothing was changed; the Assistant keeps the settings it had.`,
    );
  }
}

// ── doing ──────────────────────────────────────────────────────────────────

async function save(patch: Record<string, unknown>, done = 'Saved.'): Promise<boolean> {
  try {
    apply(await putSettings(patch));
    setSaveStatus(done, 'success');
    return true;
  } catch (error) {
    setSaveStatus((error as Error).message, 'danger');
    renderAiSettings();
    return false;
  }
}

async function runTest(): Promise<void> {
  if (!settings) return;
  busy = 'testing';
  renderAiSettings();
  let result: TestResponse = {};
  try {
    result = await postTest();
  } catch {
    result = { ok: false, message: 'The test didn’t run. Try again.' };
  }
  busy = null;
  if (result.key_status && settings) settings = { ...settings, key_status: result.key_status };
  renderAiSettings();
  if (!result.ok && !result.key_status) {
    const line = $('ai-key-status');
    if (line) {
      line.textContent = result.message || 'The test didn’t run. Try again.';
      line.dataset.tone = 'danger';
    }
  }
}

async function saveAndTest(): Promise<void> {
  const input = $<HTMLInputElement>('ai-key');
  const key = input?.value.trim() ?? '';
  if (!key) {
    const line = $('ai-key-status');
    if (line) {
      line.textContent = 'Paste a key first.';
      line.dataset.tone = 'danger';
    }
    input?.focus();
    return;
  }
  busy = 'saving';
  renderAiSettings();
  let saved = false;
  try {
    apply(await putSettings({ provider: settings?.provider ?? 'anthropic', api_key: key }));
    saved = true;
  } catch (error) {
    busy = null;
    renderAiSettings();
    const line = $('ai-key-status');
    if (line) {
      line.textContent = (error as Error).message;
      line.dataset.tone = 'danger';
    }
    return;
  }
  if (input) input.value = '';
  replacing = false;
  busy = null;
  if (saved) await runTest();
  $('ai-key-test')?.focus();
}

function bindRadioGroup(groupId: string, onPick: (value: string) => void): void {
  const group = $(groupId);
  if (!group) return;
  const radios = () => Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
  group.addEventListener('click', (event) => {
    const radio = (event.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    if (radio?.dataset.value && radio.getAttribute('aria-checked') !== 'true')
      onPick(radio.dataset.value);
  });
  group.addEventListener('keydown', (event) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const list = radios();
    const current = list.findIndex((r) => r.getAttribute('aria-checked') === 'true');
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = (current + 1) % list.length;
    else next = (current - 1 + list.length) % list.length;
    const target = list[next];
    if (!target?.dataset.value) return;
    onPick(target.dataset.value);
    target.focus();
  });
}

function syncTabVisibility(): void {
  const tab = $(TAB_ID);
  if (tab) tab.hidden = !isAdmin();
}

/** Once, when the page has loaded. */
export function initAiSettings(): void {
  syncTabVisibility();
  if (bound || !$(ROOT_ID)) return;
  bound = true;
  bindRadioGroup('ai-model-cards', (value) => {
    if (!settings) return;
    settings = { ...settings, model: value as AiSettings['model'] };
    renderAiSettings();
    void save(
      { model: value },
      value === 'best'
        ? 'Saved. The Assistant uses Best answers.'
        : 'Saved. The Assistant uses Faster and cheaper.',
    );
  });
  bindRadioGroup('ai-who', (value) => {
    if (!settings) return;
    settings = { ...settings, who_can_use: value as AiSettings['who_can_use'] };
    renderAiSettings();
    void save(
      { who_can_use: value },
      value === 'everyone'
        ? 'Saved. Everyone with a profile can use it.'
        : 'Saved. Only admins can use it.',
    );
  });
  $('ai-provider')?.addEventListener('change', (event) => {
    void save({ provider: (event.target as HTMLSelectElement).value });
  });
  $('ai-key-replace')?.addEventListener('click', () => {
    if (busy) return;
    replacing = true;
    renderAiSettings();
    $('ai-key')?.focus();
  });
  $('ai-key-cancel')?.addEventListener('click', () => {
    replacing = false;
    const input = $<HTMLInputElement>('ai-key');
    if (input) input.value = '';
    renderAiSettings();
    $('ai-key-replace')?.focus();
  });
  $('ai-key-save')?.addEventListener('click', () => {
    if (!busy) void saveAndTest();
  });
  $('ai-key')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !(event.target as HTMLInputElement).readOnly && !busy) {
      event.preventDefault();
      void saveAndTest();
    }
  });
  $('ai-key-test')?.addEventListener('click', () => {
    if (!busy) void runTest();
  });
  const cap = $<HTMLInputElement>('ai-cap');
  const saveCap = async () => {
    if (!cap || !settings) return;
    const raw = cap.value.trim();
    if (raw === capText(settings.monthly_cap_usd)) return;
    const error = $('ai-cap-error');
    const ok = await save(
      { monthly_cap_usd: raw === '' ? null : raw },
      raw === ''
        ? 'Saved. No monthly cap.'
        : `Saved. The cap is ${raw.startsWith('$') ? raw : `$${raw}`} a month.`,
    );
    if (error) {
      error.hidden = ok;
      error.textContent = ok ? '' : ($('ai-save-status')?.textContent ?? '');
    }
    if (ok) cap.removeAttribute('aria-invalid');
    else cap.setAttribute('aria-invalid', 'true');
  };
  cap?.addEventListener('change', () => void saveCap());
  cap?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveCap();
    }
  });
}

/** Settings → AI from anywhere (the Assistant's "Open Settings → AI"). */
export function openAiSettings(): void {
  const page = document.getElementById('settings-page');
  if (page && page.offsetParent !== null && typeof window.switchSettingsTab === 'function') {
    window.switchSettingsTab('ai');
    return;
  }
  window.requestSettingsTab?.('ai');
  if (typeof window.navigateToPage === 'function') {
    void window.navigateToPage('settings');
    return;
  }
  window.location.assign(appURL('/settings?tab=ai'));
}

/** Test seam. */
export function _resetAiSettingsForTests(): void {
  settings = null;
  usage = null;
  replacing = false;
  busy = null;
  bound = false;
}
