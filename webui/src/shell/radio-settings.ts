/**
 * Settings → Radio (boards 5b–5d), on the legacy Settings page, restyled in
 * place like Modules and AI. Markup in index.html (#radio-settings), look in
 * static/radio-settings.css.
 *
 * - Track identification: the switch, the AcoustID key (the existing
 *   acoustid.api_key; write-only here, shown masked), and the status line
 *   from Setup check's radio rows.
 * - Auto-add: the daily limit per station, and the stations with it on.
 * - Streams: the relay rule, prefer lossless, how long Heard is kept.
 * - Your stream links: name and address, quality or a warning, who added it,
 *   Check, and a "…" with Change logo… (HANDOFF 66: the address under the
 *   row, checked and fetched like adding a link) and Remove.
 * - Scan now services (board 11c, HANDOFF 58): AcoustID, AudD and ACRCloud
 *   in the order a scan asks them, as numbered rows: the name over one line
 *   of what it needs ("Token set, 14 March 2026 · Replace the token…"), a
 *   StatusTag (Ready / Not set up / Refused / No requests left), this
 *   month's requests and finds, Test and (paid) Remove. An unset service
 *   opens its fields under its row with "Save and test", the card's one
 *   primary. Keys are write-only: the page is told only whether each is set
 *   and when it was saved. Members see the rows and tags, nothing else.
 * - Under the rows, "Listen automatically when the station doesn't say":
 *   automatic AudD's switch and daily cap (0 turns it off), with today's
 *   count on AudD's row ("12 of 100 automatic today") and why it stopped for
 *   the day. Members read its line only.
 *
 * Each control saves as soon as it changes (PUT /api/radio/settings). The tab
 * shows while the Internet radio module is on; the routes are admins only.
 * Station names and addresses go in with textContent.
 */

import { MODULES_CHANGED_EVENT } from '@/features/modules/modules.helpers';
import { appURL } from '@/platform/url-base';

export interface RadioSettingsBody {
  success?: boolean;
  error?: string;
  message?: string;
  settings?: {
    identification: boolean;
    daily_limit: number;
    relay: 'when_needed' | 'always';
    prefer_lossless: boolean;
    keep_heard_days: number;
    /** automatic AudD: the switch and the daily cap (0 turns it off) */
    audd_auto?: boolean;
    audd_auto_daily_cap?: number;
    acoustid_api_key: { set: boolean; masked: string };
    scan_services?: {
      audd_api_token: { set: boolean };
      acrcloud_host: { set: boolean };
      acrcloud_access_key: { set: boolean };
      acrcloud_access_secret: { set: boolean };
      audd_ready: boolean;
      acrcloud_ready: boolean;
    };
  };
  /** false for a member: the answer is Scan now's rows and tags only (11c) */
  is_admin?: boolean;
  scan?: {
    order: ScanServiceId[];
    labels: Record<ScanServiceId, string>;
    ready?: Record<ScanServiceId, boolean>;
    usage?: Record<ScanServiceId, { requests: number; found: number }>;
    services?: Partial<Record<ScanServiceId, { state: ScanServiceState; set_at?: number | null }>>;
    month?: string;
    /** automatic AudD; a member's answer carries `on` and `daily_cap` only */
    audd_auto?: AuddAuto;
  };
  status?: {
    fpcalc: { found: boolean; detail: string };
    acoustid: { state: string; detail: string; checked_at: number | null };
  };
  auto_add?: { stations: { station_id: string; station_name: string }[]; added_this_week: number };
  links?: {
    id: number;
    name: string;
    url: string;
    codec: string;
    bitrate_kbps: number;
    check_ok: boolean | null;
    checked_at: number | null;
    check_error: string | null;
    added_by: string | null;
    added_at: number | null;
    /** the logo address an admin gave, or null (HANDOFF 55, 66) */
    logo_url?: string | null;
  }[];
}

export type ScanServiceId = 'acoustid' | 'audd' | 'acrcloud';

export interface AuddAuto {
  on: boolean;
  daily_cap: number;
  used_today?: number;
  ready?: boolean;
  stopped?: 'bad_key' | 'out_of_credit' | 'cap_reached' | null;
}

const TAB_ID = 'stg-tab-radio';
let body: RadioSettingsBody | null = null;
let bound = false;
/** The link whose "Change logo…" panel is open under its row (HANDOFF 66). */
let logoOpen: number | null = null;
let logoError: string | null = null;
let logoBusy = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function moduleOn(): boolean {
  const list = (window as Window & { SOULSYNC_MODULES?: { name: string; enabled: boolean }[] })
    .SOULSYNC_MODULES;
  const radio = Array.isArray(list) ? list.find((m) => m && m.name === 'radio') : undefined;
  return radio ? radio.enabled !== false : true;
}

function showTab(): void {
  const tab = $(TAB_ID);
  if (tab) tab.hidden = !moduleOn();
}

// ── words ───────────────────────────────────────────────────────────────

function dayWords(unix: number | null | undefined): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/** "fpcalc found · AcoustID answered · checked by Setup check today 09:00". */
export function statusLine(status: RadioSettingsBody['status']): { text: string; tone: string } {
  if (!status) return { text: '', tone: 'neutral' };
  const parts = [status.fpcalc.detail, status.acoustid.detail];
  const when = status.acoustid.checked_at
    ? `checked by Setup check ${dayWords(status.acoustid.checked_at)}`
    : '';
  if (when) parts.push(when);
  const tone =
    status.acoustid.state === 'refused'
      ? 'danger'
      : status.fpcalc.found && status.acoustid.state === 'ok'
        ? 'success'
        : status.acoustid.state === 'missing' || !status.fpcalc.found
          ? 'warning'
          : 'neutral';
  return { text: parts.join(' · '), tone };
}

export function autoStationsLine(auto: RadioSettingsBody['auto_add']): string {
  if (!auto || !auto.stations.length) return 'None. Turn it on from a station’s page.';
  const names = [...new Set(auto.stations.map((s) => s.station_name))];
  return `${names.join(', ')} · ${auto.added_this_week} added this week`;
}

// ── Scan now services (board 11c, HANDOFF 58) ───────────────────────────

export type ScanServiceState = 'ready' | 'not_set_up' | 'refused' | 'no_requests_left';

const SCAN_ORDER: ScanServiceId[] = ['acoustid', 'audd', 'acrcloud'];
const SCAN_LABELS: Record<ScanServiceId, string> = {
  acoustid: 'AcoustID',
  audd: 'AudD',
  acrcloud: 'ACRCloud',
};
const PAID: readonly ScanServiceId[] = ['audd', 'acrcloud'];

/** The service whose fields are open under its row (one at a time: the card has one primary). */
let openFields: ScanServiceId | null = null;
/** An admin opened them (Replace…, Set up…); else they follow the first unset service. */
let fieldsChosen = false;

function admin(): boolean {
  return body?.is_admin !== false;
}

/** The StatusTag's word and tone for a service's state. */
export function serviceTag(state: ScanServiceState): {
  label: string;
  tone: 'success' | 'neutral' | 'danger' | 'warning';
} {
  switch (state) {
    case 'ready':
      return { label: 'Ready', tone: 'success' };
    case 'refused':
      return { label: 'Refused', tone: 'danger' };
    case 'no_requests_left':
      return { label: 'No requests left', tone: 'warning' };
    default:
      return { label: 'Not set up', tone: 'neutral' };
  }
}

/** The service's state: the server's, or worked out from "ready" on an older answer. */
export function serviceState(id: ScanServiceId, data: RadioSettingsBody): ScanServiceState {
  const known = data.scan?.services?.[id]?.state;
  if (known) return known;
  return data.scan?.ready?.[id] ? 'ready' : 'not_set_up';
}

/** Whether a paid service's keys are all saved (an unset one opens its fields). */
export function serviceSaved(id: ScanServiceId, data: RadioSettingsBody): boolean {
  const svc = data.settings?.scan_services;
  if (id === 'audd') return Boolean(svc?.audd_api_token.set);
  if (id === 'acrcloud')
    return Boolean(
      svc?.acrcloud_host.set && svc.acrcloud_access_key.set && svc.acrcloud_access_secret.set,
    );
  return Boolean(data.settings?.acoustid_api_key.set);
}

/** "14 March 2026". */
export function setOnWords(unix: number | null | undefined): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const month = d.toLocaleDateString('en-GB', { month: 'long' });
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

/**
 * The one line of what a service needs, under its name: "Token set, 14 March
 * 2026" with "Replace the token…" once a key is saved; what to get otherwise.
 * Members get what kind of service it is, nothing about keys.
 */
export function serviceNeeds(
  id: ScanServiceId,
  data: RadioSettingsBody,
  isAdmin = true,
): { text: string; replace: string | null } {
  if (id === 'acoustid') {
    const head = 'Free · a fingerprint';
    if (!isAdmin) return { text: head, replace: null };
    if (!data.settings?.acoustid_api_key.set)
      return {
        text: `${head} · add the AcoustID key in Track identification above`,
        replace: null,
      };
    if (data.status && !data.status.fpcalc.found)
      return { text: `${head} · needs fpcalc on the server (Setup check says how)`, replace: null };
    if (serviceState(id, data) === 'refused')
      return {
        text: `${head} · AcoustID refused the key in Track identification above`,
        replace: null,
      };
    return {
      text: `${head} · uses the AcoustID key from Track identification above`,
      replace: null,
    };
  }
  if (!isAdmin) return { text: 'Paid · an account with a monthly allowance', replace: null };
  const when = setOnWords(data.scan?.services?.[id]?.set_at);
  if (id === 'audd') {
    return serviceSaved(id, data)
      ? { text: when ? `Token set, ${when}` : 'Token set', replace: 'Replace the token…' }
      : { text: 'An API token from your AudD dashboard (audd.io)', replace: null };
  }
  return serviceSaved(id, data)
    ? { text: when ? `Keys set, ${when}` : 'Keys set', replace: 'Replace the keys…' }
    : {
        text: 'A project’s host, access key and secret, from the ACRCloud console',
        replace: null,
      };
}

/** "41 requests in October · 29 found the track"; "Not asked" before a service is set up. */
export function usageLine(
  usage: { requests: number; found: number } | undefined,
  month: string | undefined,
  setUp = true,
): string {
  const n = usage?.requests ?? 0;
  const when = month ? ` in ${month}` : ' this month';
  if (!n) return setUp ? `Not asked${when}` : 'Not asked';
  return `${n} request${n === 1 ? '' : 's'}${when} · ${usage?.found ?? 0} found the track`;
}

// ── automatic AudD ──────────────────────────────────────────────────────

/** The line under "Listen automatically when the station doesn't say". */
export function autoLine(auto: AuddAuto | undefined): string {
  if (!auto || !auto.on) return 'Off. AudD is asked only when someone presses Scan now.';
  return (
    'Only when the station doesn’t name the track and AcoustID didn’t know it. ' +
    `Up to ${auto.daily_cap} a day; Scan now by hand doesn’t count.`
  );
}

/** "12 of 100 automatic today" on AudD's row; '' while it's off. */
export function autoUsageLine(auto: AuddAuto | undefined): string {
  if (!auto || !auto.on) return '';
  return `${auto.used_today ?? 0} of ${auto.daily_cap} automatic today`;
}

/** Why it isn't listening today, for admins; '' when nothing's in the way. */
export function autoStateWords(auto: AuddAuto | undefined): string {
  if (!auto || !auto.on) return '';
  if (auto.ready === false) return 'Needs AudD’s token, above.';
  switch (auto.stopped) {
    case 'bad_key':
      return 'Stopped for today: AudD refused the token.';
    case 'out_of_credit':
      return 'Stopped for today: AudD says the account has no requests left.';
    case 'cap_reached':
      return `Today’s ${auto.daily_cap} are used. It starts again at midnight.`;
    default:
      return '';
  }
}

function renderAuto(): void {
  if (!body) return;
  const isAdmin = admin();
  const scanAuto = body.scan?.audd_auto;
  const s = body.settings;
  // the admin's saved settings lead (the switch may be on with a cap of 0)
  const switchOn = isAdmin && s ? s.audd_auto !== false : Boolean(scanAuto?.on);
  const cap = isAdmin && s ? (s.audd_auto_daily_cap ?? 100) : (scanAuto?.daily_cap ?? 100);
  const line = $('radio-audd-auto-line');
  if (line) line.textContent = autoLine(scanAuto ?? { on: switchOn && cap > 0, daily_cap: cap });
  const state = $('radio-audd-auto-state');
  if (state) {
    const words = isAdmin ? autoStateWords(scanAuto) : '';
    state.textContent = words;
    state.hidden = !words;
    state.dataset.tone =
      scanAuto?.stopped && scanAuto.stopped !== 'cap_reached' ? 'danger' : 'neutral';
  }
  const controls = $('radio-audd-auto-controls');
  if (controls) controls.hidden = !isAdmin;
  const sw = $('radio-audd-auto');
  if (sw) {
    sw.setAttribute('aria-checked', switchOn ? 'true' : 'false');
    const text = sw.querySelector('.radio-switch-text');
    if (text) text.textContent = switchOn ? 'On' : 'Off';
  }
  const field = $<HTMLInputElement>('radio-audd-auto-cap');
  if (field && document.activeElement !== field) field.value = String(cap);
}

/** Which paid service's fields are open: the one an admin chose, else the first unset one. */
export function fieldsFor(
  data: RadioSettingsBody,
  chosen: ScanServiceId | null,
): ScanServiceId | null {
  if (data.is_admin === false) return null;
  if (chosen) return chosen;
  return PAID.find((id) => !serviceSaved(id, data)) ?? null;
}

interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'password';
  placeholder: string;
  saved: boolean;
}

function fieldSpecs(id: ScanServiceId, data: RadioSettingsBody): FieldSpec[] {
  const svc = data.settings?.scan_services;
  if (id === 'audd')
    return [
      {
        key: 'audd_api_token',
        label: 'API token',
        type: 'password',
        placeholder: '',
        saved: Boolean(svc?.audd_api_token.set),
      },
    ];
  return [
    {
      key: 'acrcloud_host',
      label: 'Host',
      type: 'text',
      placeholder: 'identify-eu-west-1.acrcloud.com',
      saved: Boolean(svc?.acrcloud_host.set),
    },
    {
      key: 'acrcloud_access_key',
      label: 'Access key',
      type: 'text',
      placeholder: '',
      saved: Boolean(svc?.acrcloud_access_key.set),
    },
    {
      key: 'acrcloud_access_secret',
      label: 'Access secret',
      type: 'password',
      placeholder: '',
      saved: Boolean(svc?.acrcloud_access_secret.set),
    },
  ];
}

function fieldsPanel(id: ScanServiceId, data: RadioSettingsBody): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'radio-scan-fields';
  panel.id = `radio-scan-fields-${id}`;
  panel.dataset.fields = id;
  const specs = fieldSpecs(id, data);
  panel.style.setProperty('--radio-scan-fields', String(specs.length));
  for (const spec of specs) {
    const label = document.createElement('label');
    label.className = 'radio-scan-field';
    const word = document.createElement('span');
    word.className = 'radio-scan-field-label';
    word.textContent = spec.label;
    const input = document.createElement('input');
    input.className = 'radio-input';
    input.type = spec.type;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.radioScanField = spec.key;
    // a saved key is never shown, nor sent back: the field says it's there
    input.placeholder = spec.saved ? 'Saved (hidden)' : spec.placeholder;
    if (spec.type === 'password' || spec.key.endsWith('_key'))
      input.classList.add('radio-key-input');
    label.append(word, input);
    panel.append(label);
  }
  const actions = document.createElement('div');
  actions.className = 'radio-scan-field-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'radio-button radio-button--primary';
  save.textContent = 'Save and test';
  save.dataset.radioScanSave = id;
  actions.append(save);
  if (serviceSaved(id, data)) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'radio-button radio-button--ghost';
    cancel.textContent = 'Cancel';
    cancel.dataset.radioScanCancel = id;
    actions.append(cancel);
  }
  panel.append(actions);
  const help = document.createElement('p');
  help.className = 'radio-help radio-scan-fields-help';
  if (id === 'audd') {
    help.textContent = 'Saved encrypted and never shown again. Paid by the request.';
  } else {
    help.append('Saved encrypted and never shown again. The host has to be one of ACRCloud’s (');
    const code = document.createElement('span');
    code.className = 'radio-mono';
    code.textContent = '…acrcloud.com';
    help.append(code, ').');
  }
  panel.append(help);
  return panel;
}

function button(text: string, cls: string, data: Record<string, string>): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  for (const [k, v] of Object.entries(data)) b.dataset[k] = v;
  return b;
}

function renderScan(): void {
  const list = $('radio-scan-services');
  if (!list || !body) return;
  const isAdmin = admin();
  list.replaceChildren();
  const scan = body.scan;
  const order: ScanServiceId[] = scan?.order ?? SCAN_ORDER;
  const labels: Record<ScanServiceId, string> = scan?.labels ?? SCAN_LABELS;
  const open = fieldsFor(body, fieldsChosen ? openFields : null);
  openFields = open;
  order.forEach((id, i) => {
    const li = document.createElement('li');
    li.className = 'radio-scan-item';
    li.dataset.service = id;
    const row = document.createElement('div');
    row.className = 'radio-scan-row';
    const step = document.createElement('span');
    step.className = 'radio-scan-step';
    step.textContent = String(i + 1);
    step.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'radio-scan-name';
    name.textContent = labels[id];
    const needs = serviceNeeds(id, body!, isAdmin);
    const line = document.createElement('span');
    line.className = 'radio-scan-needs';
    line.textContent = needs.text;
    if (needs.replace) {
      line.append(' · ');
      const replace = button(needs.replace, 'radio-scan-replace', { radioScanReplace: id });
      replace.setAttribute('aria-expanded', open === id ? 'true' : 'false');
      replace.setAttribute('aria-controls', `radio-scan-fields-${id}`);
      line.append(replace);
    }
    const state = serviceState(id, body!);
    const tagView = serviceTag(state);
    const tag = document.createElement('span');
    tag.className = 'radio-tag';
    tag.dataset.tone = tagView.tone;
    tag.textContent = tagView.label;
    row.append(step, name, line, tag);
    if (isAdmin) {
      const usage = document.createElement('span');
      usage.className = 'radio-scan-usage';
      const setUp = id === 'acoustid' ? state !== 'not_set_up' : serviceSaved(id, body!);
      usage.textContent = usageLine(scan?.usage?.[id], scan?.month, setUp);
      if (!scan?.usage?.[id]?.requests) usage.dataset.quiet = 'true';
      const today = id === 'audd' && setUp ? autoUsageLine(scan?.audd_auto) : '';
      if (today) {
        const auto = document.createElement('span');
        auto.className = 'radio-scan-usage-auto';
        auto.textContent = today;
        usage.append(auto);
      }
      const actions = document.createElement('div');
      actions.className = 'radio-scan-actions';
      // nothing to test until its keys are saved
      if (serviceSaved(id, body!)) {
        const test = button('Test', 'radio-button', { radioScanTest: id });
        test.setAttribute(
          'aria-label',
          id === 'acoustid'
            ? `Test ${labels[id]}: a free check of the key`
            : `Test ${labels[id]}: uses one request`,
        );
        actions.append(test);
        if (PAID.includes(id)) {
          const remove = button('Remove', 'radio-button radio-button--outline', {
            radioScanRemove: id,
          });
          remove.setAttribute('aria-label', `Remove ${labels[id]}’s keys`);
          actions.append(remove);
        } else {
          const gap = document.createElement('span');
          gap.className = 'radio-scan-gap';
          gap.setAttribute('aria-hidden', 'true');
          actions.append(gap);
        }
      } else if (PAID.includes(id) && open !== id) {
        // another unset service: its fields open on a press (one primary at a time)
        const setup = button('Set up…', 'radio-button radio-button--outline', {
          radioScanSetup: id,
        });
        setup.setAttribute('aria-label', `Set up ${labels[id]}`);
        setup.setAttribute('aria-expanded', 'false');
        setup.setAttribute('aria-controls', `radio-scan-fields-${id}`);
        actions.append(setup);
      }
      row.append(usage, actions);
    }
    li.append(row);
    if (open === id) {
      li.dataset.open = 'true';
      li.append(fieldsPanel(id, body!));
    }
    list.append(li);
  });
  const foot = $('radio-scan-foot');
  if (foot) foot.hidden = !isAdmin;
  renderAuto();
}

function setScanStatus(text: string, tone: 'success' | 'danger' | 'neutral' = 'neutral'): void {
  const el = $('radio-scan-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

async function testService(id: ScanServiceId, saved = false): Promise<void> {
  const label = body?.scan?.labels?.[id] ?? SCAN_LABELS[id];
  const prefix = saved ? 'Saved. ' : '';
  setScanStatus(`${prefix}Testing ${label}…`);
  try {
    const res = await fetch(appURL('/api/radio/scan/test'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: id }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      usage?: Record<ScanServiceId, { requests: number; found: number }>;
      services?: NonNullable<RadioSettingsBody['scan']>['services'];
    };
    if (!res.ok) {
      setScanStatus(data.message || 'The test couldn’t run.', 'danger');
      return;
    }
    if (body?.scan) {
      if (data.usage) body.scan.usage = data.usage;
      if (data.services) body.scan.services = data.services;
      renderScan();
    }
    setScanStatus(
      prefix + (data.message || (data.ok ? `${label} answered.` : `${label} didn’t accept it.`)),
      data.ok ? 'success' : 'danger',
    );
  } catch {
    setScanStatus('SYNCHRO.S didn’t answer. Try again in a moment.', 'danger');
  }
}

/** Save and test: the open fields' values (empty ones leave a saved key alone), then a Test. */
async function saveService(id: ScanServiceId): Promise<void> {
  const panel = document.querySelector<HTMLElement>(`[data-fields="${id}"]`);
  if (!panel || !body) return;
  const patch: Record<string, string> = {};
  const missing: string[] = [];
  for (const spec of fieldSpecs(id, body)) {
    const input = panel.querySelector<HTMLInputElement>(`[data-radio-scan-field="${spec.key}"]`);
    const value = input?.value.trim() ?? '';
    if (value) patch[spec.key] = value;
    else if (!spec.saved) missing.push(spec.label.toLowerCase());
  }
  if (!Object.keys(patch).length || missing.length) {
    setScanStatus(
      id === 'audd'
        ? 'Paste the AudD token first.'
        : `Fill in the ${missing.length ? missing.join(', ') : 'host, access key and access secret'} first.`,
    );
    panel.querySelector<HTMLInputElement>('input')?.focus();
    return;
  }
  const ok = await save(patch, 'Saved.', setScanStatus);
  if (!ok) return;
  fieldsChosen = false;
  openFields = null;
  renderScan();
  await testService(id, true);
  document.querySelector<HTMLElement>(`[data-service="${id}"] [data-radio-scan-test]`)?.focus();
}

function openServiceFields(id: ScanServiceId | null): void {
  openFields = id;
  fieldsChosen = id !== null;
  renderScan();
  if (id) document.querySelector<HTMLInputElement>(`[data-fields="${id}"] input`)?.focus();
}

// ── reading and writing ─────────────────────────────────────────────────

async function readJson(res: Response): Promise<RadioSettingsBody> {
  try {
    return (await res.json()) as RadioSettingsBody;
  } catch {
    return { success: false, error: `The server answered ${res.status}.` };
  }
}

function setStatus(text: string, tone: 'success' | 'danger' | 'neutral' = 'neutral'): void {
  const el = $('radio-save-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

function render(): void {
  // members read Scan now's rows and tags; the other cards are admins' settings
  const isAdmin = admin();
  for (const card of document.querySelectorAll<HTMLElement>(
    '#radio-settings > .radio-card:not(.radio-scan-card)',
  ))
    card.hidden = !isAdmin;
  renderScan();
  const s = body?.settings;
  if (!s) return;
  const sw = $('radio-identification');
  if (sw) {
    sw.setAttribute('aria-checked', s.identification ? 'true' : 'false');
    const text = sw.querySelector('.radio-switch-text');
    if (text) text.textContent = s.identification ? 'On' : 'Off';
  }
  const key = $<HTMLInputElement>('radio-acoustid');
  if (key && document.activeElement !== key) {
    key.value = '';
    key.placeholder = s.acoustid_api_key.set ? s.acoustid_api_key.masked : 'Not set';
  }
  const status = $('radio-id-status');
  if (status) {
    const line = statusLine(body?.status);
    status.textContent = line.text;
    status.dataset.tone = line.tone;
  }
  const limit = $<HTMLInputElement>('radio-daily-limit');
  if (limit && document.activeElement !== limit) limit.value = String(s.daily_limit);
  const auto = $('radio-auto-stations');
  if (auto) auto.textContent = autoStationsLine(body?.auto_add);
  const relay = $<HTMLSelectElement>('radio-relay');
  if (relay) relay.value = s.relay;
  const lossless = $<HTMLInputElement>('radio-prefer-lossless');
  if (lossless) lossless.checked = s.prefer_lossless;
  const keep = $<HTMLSelectElement>('radio-keep');
  if (keep) keep.value = String(s.keep_heard_days);
  renderLinks();
}

function renderLinks(): void {
  const list = $('radio-links');
  if (!list) return;
  list.replaceChildren();
  const links = body?.links ?? [];
  if (!links.length) {
    const empty = document.createElement('li');
    empty.className = 'radio-links-empty';
    empty.textContent =
      'No links yet. Add a station’s direct stream address to put it in everyone’s Favourites.';
    list.append(empty);
    return;
  }
  for (const link of links) {
    const li = document.createElement('li');
    li.className = 'radio-link-row';
    const text = document.createElement('div');
    text.className = 'radio-link-text';
    const name = document.createElement('span');
    name.className = 'radio-link-name';
    name.textContent = link.name;
    const url = document.createElement('span');
    url.className = 'radio-link-url';
    url.textContent = link.url;
    url.title = link.url;
    text.append(name, url);
    const quality = document.createElement('span');
    quality.className = 'radio-link-quality';
    if (link.check_ok === false) {
      quality.dataset.tone = 'warning';
      quality.textContent = link.checked_at
        ? `Didn’t answer ${dayWords(link.checked_at)}`
        : 'Didn’t answer';
      if (link.check_error) quality.title = link.check_error;
    } else {
      quality.textContent = [link.codec, link.bitrate_kbps ? `${link.bitrate_kbps} kbps` : '']
        .filter(Boolean)
        .join(' ');
    }
    const who = document.createElement('span');
    who.className = 'radio-link-who';
    who.textContent = [
      link.added_by ? `Added by ${link.added_by}` : 'Added',
      dayWords(link.added_at),
    ]
      .filter(Boolean)
      .join(' · ');
    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'radio-button radio-button--ghost';
    check.textContent = 'Check';
    check.dataset.radioLinkCheck = String(link.id);
    check.setAttribute('aria-label', `Check ${link.name}`);
    li.append(text, quality, who, check, rowMenu(link));
    list.append(li);
    if (logoOpen === link.id) list.append(logoPanel(link));
  }
}

type RadioLink = NonNullable<RadioSettingsBody['links']>[number];

/** The row's "…": Change logo… (HANDOFF 66) and Remove. */
function rowMenu(link: RadioLink): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'radio-menu-wrap';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'radio-button radio-button--ghost radio-more';
  more.dataset.radioLinkMore = String(link.id);
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', `More for ${link.name}`);
  more.innerHTML =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
  const menu = document.createElement('div');
  menu.className = 'radio-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', link.name);
  menu.hidden = true;
  const item = (label: string, attr: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'radio-menu-item';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.textContent = label;
    b.setAttribute(attr, String(link.id));
    return b;
  };
  menu.append(
    item('Change logo…', 'data-radio-link-logo'),
    item('Remove', 'data-radio-link-remove'),
  );
  wrap.append(more, menu);
  return wrap;
}

function closeMenus(focusButton = false): void {
  for (const menu of document.querySelectorAll<HTMLElement>('#radio-links .radio-menu')) {
    if (menu.hidden) continue;
    menu.hidden = true;
    const more = menu.previousElementSibling as HTMLElement | null;
    more?.setAttribute('aria-expanded', 'false');
    if (focusButton) more?.focus();
  }
}

function openMenu(more: HTMLElement): void {
  closeMenus();
  const menu = more.nextElementSibling as HTMLElement | null;
  if (!menu) return;
  menu.hidden = false;
  more.setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
}

/** "Change logo…" under the row: the address, checked and fetched like adding a link. */
function logoPanel(link: RadioLink): HTMLElement {
  const li = document.createElement('li');
  li.className = 'radio-logo-panel';
  li.dataset.radioLogoPanel = String(link.id);
  const preview = document.createElement('span');
  preview.className = 'radio-logo-preview';
  preview.setAttribute('aria-hidden', 'true');
  preview.textContent = linkLetters(link.name);
  if (link.logo_url) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = appURL(`/api/radio/stations/link-${link.id}/logo`);
    img.onload = () => img.classList.add('is-loaded');
    img.onerror = () => img.remove();
    preview.append(img);
  }
  const field = document.createElement('div');
  field.className = 'radio-field';
  const label = document.createElement('label');
  label.className = 'radio-label';
  label.htmlFor = `radio-logo-${link.id}`;
  label.textContent = `Logo for ${link.name}`;
  const row = document.createElement('div');
  row.className = 'radio-key-row';
  const input = document.createElement('input');
  input.id = `radio-logo-${link.id}`;
  input.className = 'radio-input';
  input.type = 'url';
  input.inputMode = 'url';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'https://…/logo.png';
  input.value = link.logo_url ?? '';
  input.dataset.radioLogoInput = String(link.id);
  input.setAttribute('aria-describedby', `radio-logo-help-${link.id}`);
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'radio-button radio-button--primary';
  saveBtn.textContent = logoBusy ? 'Checking…' : 'Save logo';
  saveBtn.dataset.radioLogoSave = String(link.id);
  if (logoBusy) saveBtn.setAttribute('aria-disabled', 'true');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'radio-button radio-button--ghost';
  cancel.textContent = 'Cancel';
  cancel.dataset.radioLogoCancel = String(link.id);
  row.append(input, saveBtn, cancel);
  const help = document.createElement('p');
  help.className = 'radio-help';
  help.id = `radio-logo-help-${link.id}`;
  help.textContent = link.logo_url
    ? 'A PNG, JPEG, GIF, WebP or ICO image up to 512 KB. SYNCHRO.S fetches it once and keeps it. Empty the field to show the letters instead.'
    : 'A PNG, JPEG, GIF, WebP or ICO image up to 512 KB. SYNCHRO.S fetches it once and keeps it. Until then the station shows its letters.';
  field.append(label, row, help);
  if (logoError) {
    const err = document.createElement('p');
    err.className = 'radio-save-status';
    err.dataset.tone = 'danger';
    err.setAttribute('role', 'alert');
    err.textContent = logoError;
    field.append(err);
  }
  li.append(preview, field);
  return li;
}

function linkLetters(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function openLogo(id: number | null): void {
  logoOpen = id;
  logoError = null;
  renderLinks();
  if (id !== null) document.getElementById(`radio-logo-${id}`)?.focus();
}

function setLinksStatus(text: string, tone: 'success' | 'danger' | 'neutral' = 'neutral'): void {
  const el = $('radio-links-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

/** PUT /api/radio/links/<id> {logo_url}: the same check and fetch as adding a link. */
async function saveLogo(id: number): Promise<void> {
  if (logoBusy) return;
  const input = document.getElementById(`radio-logo-${id}`) as HTMLInputElement | null;
  const value = input?.value.trim() ?? '';
  const name = body?.links?.find((l) => l.id === id)?.name ?? 'the station';
  logoBusy = true;
  logoError = null;
  renderLinks();
  const keep = document.getElementById(`radio-logo-${id}`) as HTMLInputElement | null;
  if (keep) keep.value = value;
  try {
    const res = await fetch(appURL(`/api/radio/links/${id}`), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logo_url: value }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      link?: RadioLink;
    };
    logoBusy = false;
    if (!res.ok) {
      logoError = data.message || 'That logo couldn’t be used. Nothing was changed.';
      renderLinks();
      const again = document.getElementById(`radio-logo-${id}`) as HTMLInputElement | null;
      if (again) {
        again.value = value;
        again.focus();
      }
      return;
    }
    if (data.link && body?.links) {
      body.links = body.links.map((l) => (l.id === id ? { ...l, ...data.link } : l));
    }
    logoOpen = null;
    renderLinks();
    setLinksStatus(
      value
        ? `Logo changed. ${name} shows it in everyone’s Favourites.`
        : `${name} shows its letters again.`,
      'success',
    );
    document.querySelector<HTMLElement>(`[data-radio-link-more="${id}"]`)?.focus();
  } catch {
    logoBusy = false;
    logoError = 'SYNCHRO.S didn’t answer, so nothing was changed.';
    renderLinks();
  }
}

function showError(message: string | null): void {
  const el = $('radio-settings-error');
  if (!el) return;
  el.hidden = !message;
  el.textContent = message ?? '';
}

export async function loadRadioSettings(): Promise<void> {
  showTab();
  bind();
  try {
    const res = await fetch(appURL('/api/radio/settings'), { credentials: 'same-origin' });
    const data = await readJson(res);
    if (!res.ok || data.success === false) {
      showError(data.message || data.error || 'Settings → Radio couldn’t be read.');
      return;
    }
    showError(null);
    body = data;
    render();
  } catch {
    showError('SYNCHRO.S didn’t answer. Try again in a moment.');
  }
}

async function save(
  patch: Record<string, unknown>,
  done: string,
  status: (text: string, tone?: 'success' | 'danger' | 'neutral') => void = setStatus,
): Promise<boolean> {
  const setStatus = status;
  setStatus('Saving…');
  try {
    const res = await fetch(appURL('/api/radio/settings'), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await readJson(res);
    if (!res.ok || data.success === false) {
      setStatus(data.message || data.error || 'It wasn’t saved. Nothing was changed.', 'danger');
      render();
      return false;
    }
    body = data;
    render();
    setStatus(done, 'success');
    return true;
  } catch {
    setStatus('SYNCHRO.S didn’t answer, so nothing was saved.', 'danger');
    return false;
  }
}

async function linkAction(id: string, action: 'check' | 'remove'): Promise<void> {
  const res = await fetch(
    appURL(action === 'check' ? `/api/radio/links/${id}/check` : `/api/radio/links/${id}`),
    {
      method: action === 'check' ? 'POST' : 'DELETE',
      credentials: 'same-origin',
    },
  );
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
  };
  if (action === 'check') {
    setStatus(
      data.ok ? 'The link answered with audio.' : data.error || 'The link didn’t answer.',
      data.ok ? 'success' : 'danger',
    );
  } else if (res.ok) {
    setStatus('Removed. It’s gone from everyone’s Favourites.', 'success');
  } else {
    setStatus(data.message || 'It wasn’t removed.', 'danger');
  }
  await loadRadioSettings();
}

function bind(): void {
  if (bound) return;
  bound = true;
  $('radio-identification')?.addEventListener('click', () => {
    const on = !(body?.settings?.identification ?? true);
    void save(
      { identification: on },
      on ? 'Saved. Tracks are identified.' : 'Saved. Identification is off.',
    );
  });
  const key = $<HTMLInputElement>('radio-acoustid');
  const saveKey = () => {
    const value = key?.value.trim() ?? '';
    if (!value) {
      setStatus('Paste a key first.');
      return;
    }
    void save({ acoustid_api_key: value }, 'Saved. Run Setup check to test the key.').then((ok) => {
      if (ok && key) key.value = '';
    });
  };
  $('radio-acoustid-save')?.addEventListener('click', saveKey);
  key?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveKey();
    }
  });
  const limit = $<HTMLInputElement>('radio-daily-limit');
  limit?.addEventListener('change', () => {
    const n = Number(limit.value);
    void save({ daily_limit: n }, `Saved. At most ${n} a day from each station.`);
  });
  $('radio-relay')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    void save(
      { relay: value },
      value === 'always' ? 'Saved. Every station goes through the server.' : 'Saved.',
    );
  });
  $('radio-prefer-lossless')?.addEventListener('change', (event) => {
    void save({ prefer_lossless: (event.target as HTMLInputElement).checked }, 'Saved.');
  });
  $('radio-audd-auto')?.addEventListener('click', () => {
    const on = !(body?.settings?.audd_auto ?? true);
    void save(
      { audd_auto: on },
      on
        ? 'Saved. AudD listens when a station doesn’t say what’s playing.'
        : 'Saved. AudD is asked only when someone presses Scan now.',
      setScanStatus,
    );
  });
  const cap = $<HTMLInputElement>('radio-audd-auto-cap');
  cap?.addEventListener('change', () => {
    const n = Number(cap.value);
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      setScanStatus('The daily cap is a whole number from 0 to 1000. 0 turns it off.', 'danger');
      return;
    }
    void save(
      { audd_auto_daily_cap: n },
      n === 0 ? 'Saved. A cap of 0 turns automatic AudD off.' : `Saved. Up to ${n} a day.`,
      setScanStatus,
    );
  });
  $('radio-keep')?.addEventListener('change', (event) => {
    const days = Number((event.target as HTMLSelectElement).value);
    void save({ keep_heard_days: days }, `Saved. Heard on radio keeps ${days} days.`);
  });
  $('radio-scan-services')?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const pick = (attr: string) =>
      target.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) as ScanServiceId | undefined;
    const test = pick('data-radio-scan-test');
    if (test) {
      void testService(test);
      return;
    }
    const saveId = pick('data-radio-scan-save');
    if (saveId) {
      void saveService(saveId);
      return;
    }
    const replace = pick('data-radio-scan-replace') ?? pick('data-radio-scan-setup');
    if (replace) {
      openServiceFields(openFields === replace && fieldsChosen ? null : replace);
      return;
    }
    const cancel = pick('data-radio-scan-cancel');
    if (cancel) {
      openServiceFields(null);
      document
        .querySelector<HTMLElement>(`[data-service="${cancel}"] [data-radio-scan-replace]`)
        ?.focus();
      return;
    }
    const remove = pick('data-radio-scan-remove');
    if (remove) {
      const label = body?.scan?.labels?.[remove] ?? SCAN_LABELS[remove];
      void save(
        { remove: [remove] },
        `Removed. Scan now won’t ask ${label} until its keys are added again.`,
        setScanStatus,
      );
    }
  });
  $('radio-scan-services')?.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    const field = target.closest<HTMLElement>('[data-fields]');
    if (event.key === 'Enter' && field && target.tagName === 'INPUT') {
      event.preventDefault();
      void saveService(field.dataset.fields as ScanServiceId);
    }
  });
  $('radio-links')?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const check = target.closest<HTMLElement>('[data-radio-link-check]');
    if (check) void linkAction(check.dataset.radioLinkCheck!, 'check');
    const more = target.closest<HTMLElement>('[data-radio-link-more]');
    if (more) {
      if (more.getAttribute('aria-expanded') === 'true') closeMenus(true);
      else openMenu(more);
      return;
    }
    const remove = target.closest<HTMLElement>('[data-radio-link-remove]');
    if (remove) {
      closeMenus();
      void linkAction(remove.dataset.radioLinkRemove!, 'remove');
    }
    const logo = target.closest<HTMLElement>('[data-radio-link-logo]');
    if (logo) {
      closeMenus();
      openLogo(Number(logo.dataset.radioLinkLogo));
    }
    const saveLogoBtn = target.closest<HTMLElement>('[data-radio-logo-save]');
    if (saveLogoBtn) void saveLogo(Number(saveLogoBtn.dataset.radioLogoSave));
    const cancel = target.closest<HTMLElement>('[data-radio-logo-cancel]');
    if (cancel) {
      const id = cancel.dataset.radioLogoCancel;
      openLogo(null);
      document.querySelector<HTMLElement>(`[data-radio-link-more="${id}"]`)?.focus();
    }
  });
  $('radio-links')?.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('[data-radio-logo-input]') && event.key === 'Enter') {
      event.preventDefault();
      void saveLogo(Number(target.dataset.radioLogoInput));
      return;
    }
    if (target.matches('[data-radio-logo-input]') && event.key === 'Escape') {
      event.preventDefault();
      const id = target.dataset.radioLogoInput;
      openLogo(null);
      document.querySelector<HTMLElement>(`[data-radio-link-more="${id}"]`)?.focus();
      return;
    }
    const menu = target.closest<HTMLElement>('.radio-menu');
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(target);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenus(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      closeMenus();
    }
  });
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('#radio-links .radio-menu-wrap')) closeMenus();
  });
  // links into React pages stay in the app
  for (const id of ['radio-run-setup', 'radio-auto-activity', 'radio-add-link']) {
    $(id)?.addEventListener('click', (event) => {
      const a = event.currentTarget as HTMLAnchorElement;
      const href = a.getAttribute('href') as `/${string}` | null;
      const router = window.SoulSyncWebRouter;
      if (!href || !router?.navigateHref) return;
      event.preventDefault();
      void router.navigateHref(href);
    });
  }
}

/** Settings → Radio from anywhere ("Open Settings → Radio"). */
export function openRadioSettings(): void {
  const page = document.getElementById('settings-page');
  if (page && page.offsetParent !== null && typeof window.switchSettingsTab === 'function') {
    window.switchSettingsTab('radio');
    return;
  }
  window.requestSettingsTab?.('radio');
  if (typeof window.navigateToPage === 'function') {
    void window.navigateToPage('settings');
    return;
  }
  window.location.assign(appURL('/settings?tab=radio'));
}

export function initRadioSettings(): void {
  showTab();
  window.addEventListener(MODULES_CHANGED_EVENT, () => {
    // the shell's module list is updated in place before this event
    setTimeout(showTab, 0);
  });
}

/** Test seam. */
export function _resetRadioSettingsForTests(): void {
  body = null;
  bound = false;
  openFields = null;
  fieldsChosen = false;
  logoOpen = null;
  logoError = null;
  logoBusy = false;
}
