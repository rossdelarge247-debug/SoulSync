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
 *   Check and Remove.
 * - Scan now services: AcoustID, AudD and ACRCloud in the order a scan asks
 *   them, whether each is ready, this month's requests, a Test each, and the
 *   paid services' keys (write-only: the page is told only whether each is
 *   set) with Remove.
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
  scan?: {
    order: ScanServiceId[];
    labels: Record<ScanServiceId, string>;
    ready: Record<ScanServiceId, boolean>;
    usage: Record<ScanServiceId, { requests: number; found: number }>;
    month: string;
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
  }[];
}

export type ScanServiceId = 'acoustid' | 'audd' | 'acrcloud';

const TAB_ID = 'stg-tab-radio';
let body: RadioSettingsBody | null = null;
let bound = false;

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

/** "3 requests in October · 1 found", or "None in October". */
export function usageLine(
  usage: { requests: number; found: number } | undefined,
  month: string | undefined,
): string {
  const n = usage?.requests ?? 0;
  const when = month ? ` in ${month}` : ' this month';
  if (!n) return `No requests${when}`;
  return `${n} request${n === 1 ? '' : 's'}${when} · ${usage?.found ?? 0} found`;
}

/** The words under a service's name: what it costs and whether it's ready. */
export function serviceLine(
  id: ScanServiceId,
  data: RadioSettingsBody,
): { text: string; tone: 'success' | 'warning' | 'neutral' | 'danger' } {
  const ready = Boolean(data.scan?.ready[id]);
  if (id === 'acoustid') {
    if (data.status?.acoustid.state === 'refused')
      return { text: 'Free · AcoustID refused the key', tone: 'danger' };
    if (!data.settings?.acoustid_api_key.set)
      return { text: 'Free · add the AcoustID key above', tone: 'neutral' };
    if (!data.status?.fpcalc.found)
      return { text: 'Free · fpcalc isn’t installed', tone: 'warning' };
    return { text: 'Free · ready', tone: 'success' };
  }
  const svc = data.settings?.scan_services;
  if (id === 'acrcloud' && !ready && svc && (svc.acrcloud_host.set || svc.acrcloud_access_key.set))
    return { text: 'Paid · needs its host, access key and access secret', tone: 'warning' };
  return ready
    ? { text: 'Paid · ready · only when someone presses Scan now', tone: 'success' }
    : { text: 'Paid · not set up', tone: 'neutral' };
}

function renderScan(): void {
  const list = $('radio-scan-services');
  if (!list || !body) return;
  list.replaceChildren();
  const scan = body.scan;
  const order: ScanServiceId[] = scan?.order ?? ['acoustid', 'audd', 'acrcloud'];
  const labels: Record<ScanServiceId, string> = scan?.labels ?? {
    acoustid: 'AcoustID',
    audd: 'AudD',
    acrcloud: 'ACRCloud',
  };
  order.forEach((id, i) => {
    const li = document.createElement('li');
    li.className = 'radio-scan-row';
    li.dataset.service = id;
    const step = document.createElement('span');
    step.className = 'radio-scan-step';
    step.textContent = String(i + 1);
    step.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'radio-scan-text';
    const name = document.createElement('span');
    name.className = 'radio-scan-name';
    name.textContent = labels[id];
    const line = serviceLine(id, body!);
    const meta = document.createElement('span');
    meta.className = 'radio-status';
    meta.dataset.tone = line.tone;
    meta.textContent = line.text;
    text.append(name, meta);
    const usage = document.createElement('span');
    usage.className = 'radio-scan-usage';
    usage.textContent = usageLine(scan?.usage[id], scan?.month);
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'radio-button radio-button--ghost';
    test.textContent = 'Test';
    test.dataset.radioScanTest = id;
    const configured =
      id === 'acoustid'
        ? Boolean(body!.settings?.acoustid_api_key.set)
        : id === 'audd'
          ? Boolean(body!.settings?.scan_services?.audd_api_token.set)
          : Boolean(scan?.ready.acrcloud);
    test.hidden = !configured; // nothing to test until its keys are saved
    test.setAttribute(
      'aria-label',
      id === 'acoustid'
        ? `Test ${labels[id]}: a free check of the key`
        : `Test ${labels[id]}: uses one request`,
    );
    test.title = id === 'acoustid' ? 'A free check of the key' : 'A test uses one request';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'radio-button radio-button--ghost';
    remove.textContent = 'Remove';
    remove.dataset.radioScanRemove = id;
    remove.setAttribute('aria-label', `Remove ${labels[id]}’s keys`);
    const svc = body!.settings?.scan_services;
    remove.hidden =
      id === 'acoustid' ||
      !(id === 'audd'
        ? svc?.audd_api_token.set
        : svc?.acrcloud_host.set ||
          svc?.acrcloud_access_key.set ||
          svc?.acrcloud_access_secret.set);
    li.append(step, text, usage, test, remove);
    list.append(li);
  });
  const svc = body.settings?.scan_services;
  const placeholder = (id: string, set: boolean | undefined, empty: string) => {
    const input = $<HTMLInputElement>(id);
    if (input && document.activeElement !== input) {
      input.value = '';
      input.placeholder = set ? 'Saved (hidden)' : empty;
    }
  };
  placeholder('radio-audd-token', svc?.audd_api_token.set, 'Not set');
  placeholder('radio-acr-host', svc?.acrcloud_host.set, 'identify-eu-west-1.acrcloud.com');
  placeholder('radio-acr-key', svc?.acrcloud_access_key.set, 'Not set');
  placeholder('radio-acr-secret', svc?.acrcloud_access_secret.set, 'Not set');
}

function setScanStatus(text: string, tone: 'success' | 'danger' | 'neutral' = 'neutral'): void {
  const el = $('radio-scan-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone;
}

async function testService(id: ScanServiceId): Promise<void> {
  const label = body?.scan?.labels[id] ?? id;
  setScanStatus(
    id === 'acoustid'
      ? `Testing ${label}…`
      : `Testing ${label}… A test uses one request of its allowance.`,
  );
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
    };
    if (!res.ok) {
      setScanStatus(data.message || 'The test couldn’t run.', 'danger');
      return;
    }
    if (data.usage && body?.scan) {
      body.scan.usage = data.usage;
      renderScan();
    }
    setScanStatus(
      data.message || (data.ok ? `${label} answered.` : `${label} didn’t accept it.`),
      data.ok ? 'success' : 'danger',
    );
  } catch {
    setScanStatus('SYNCHRO.S didn’t answer. Try again in a moment.', 'danger');
  }
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
  renderScan();
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
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'radio-button radio-button--ghost';
    remove.textContent = 'Remove';
    remove.dataset.radioLinkRemove = String(link.id);
    remove.setAttribute('aria-label', `Remove ${link.name}`);
    li.append(text, quality, who, check, remove);
    list.append(li);
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
  $('radio-keep')?.addEventListener('change', (event) => {
    const days = Number((event.target as HTMLSelectElement).value);
    void save({ keep_heard_days: days }, `Saved. Heard on radio keeps ${days} days.`);
  });
  const audd = $<HTMLInputElement>('radio-audd-token');
  const saveAudd = () => {
    const value = audd?.value.trim() ?? '';
    if (!value) {
      setScanStatus('Paste the AudD token first.');
      return;
    }
    void save(
      { audd_api_token: value },
      'Saved. Test it to check AudD accepts it.',
      setScanStatus,
    ).then((ok) => {
      if (ok && audd) audd.value = '';
    });
  };
  $('radio-audd-save')?.addEventListener('click', saveAudd);
  audd?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveAudd();
    }
  });
  $('radio-acr-save')?.addEventListener('click', () => {
    const patch: Record<string, string> = {};
    const fields: [string, string][] = [
      ['radio-acr-host', 'acrcloud_host'],
      ['radio-acr-key', 'acrcloud_access_key'],
      ['radio-acr-secret', 'acrcloud_access_secret'],
    ];
    for (const [id, key] of fields) {
      const value = $<HTMLInputElement>(id)?.value.trim();
      if (value) patch[key] = value;
    }
    if (!Object.keys(patch).length) {
      setScanStatus('Fill in the host, access key and access secret first.');
      return;
    }
    void save(patch, 'Saved. Test it to check ACRCloud accepts it.', setScanStatus).then((ok) => {
      if (ok) for (const [id] of fields) $<HTMLInputElement>(id)!.value = '';
    });
  });
  $('radio-scan-services')?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const test = target.closest<HTMLButtonElement>('[data-radio-scan-test]');
    if (test && !test.hidden) void testService(test.dataset.radioScanTest as ScanServiceId);
    const remove = target.closest<HTMLElement>('[data-radio-scan-remove]');
    if (remove) {
      const id = remove.dataset.radioScanRemove as ScanServiceId;
      const label = body?.scan?.labels[id] ?? id;
      void save(
        { remove: [id] },
        `Removed. Scan now won’t ask ${label} until its keys are added again.`,
        setScanStatus,
      );
    }
  });
  $('radio-links')?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const check = target.closest<HTMLElement>('[data-radio-link-check]');
    if (check) void linkAction(check.dataset.radioLinkCheck!, 'check');
    const remove = target.closest<HTMLElement>('[data-radio-link-remove]');
    if (remove) void linkAction(remove.dataset.radioLinkRemove!, 'remove');
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
}
