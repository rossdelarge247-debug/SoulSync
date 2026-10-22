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

async function save(patch: Record<string, unknown>, done: string): Promise<boolean> {
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
