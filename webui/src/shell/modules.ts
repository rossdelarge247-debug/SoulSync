/**
 * Module switches in the legacy shell (core/modules.py, GET/PUT /api/modules).
 *
 * - Settings -> Modules: one row per module with an on/off switch. Turning a
 *   module off asks first; the result, and any restart a module still needs,
 *   shows in its row. Non-admins get the states read-only.
 * - The sidebar: a turned-off module's entries (and the Audio/Video switch
 *   while Video is off) are hidden by one <style> built from each module's
 *   `pages`. index.html's head script builds the same rules before first
 *   paint from the states the page shell rendered with.
 * - Legacy module pages (#chat-page) show a "turned off" notice in place of
 *   the page; React module pages do the same through ModuleGate.
 *
 * The states start as window.SOULSYNC_MODULES (rendered into the page) and
 * are kept current: after a change here, after GET /api/modules, and when any
 * API call answers 409 module_disabled (the React api client announces it on
 * window; legacy callers use noteModuleDisabled).
 */

import {
  changeResultCopy,
  findModule,
  MODULE_DISABLED_EVENT,
  moduleDisabledPayload,
  moduleOffCopy,
  MODULES_CHANGED_EVENT,
  MODULES_SETTINGS_PATH,
  navGuardCss,
  NAV_GUARD_STYLE_ID,
  normalizeModule,
  normalizeModules,
  restartCopy,
  turnOffCopy,
  withModuleOff,
  withModuleState,
  type ModuleState,
} from '@/features/modules/modules.helpers';
import { appURL } from '@/platform/url-base';

const LIST_ID = 'modules-settings-list';
const READONLY_NOTE_ID = 'modules-settings-readonly';
const LOAD_ERROR_ID = 'modules-settings-error';

let modules: ModuleState[] = normalizeModules(window.SOULSYNC_MODULES);
// bumped by every switch change, so a GET that started before one can't undo it
let changes = 0;

export function getModuleStates(): ModuleState[] {
  return modules;
}

/** True only when the module is known to be off: unknown means on. */
export function moduleIsOff(name: string): boolean {
  const state = findModule(modules, name);
  return !!state && !state.enabled;
}

function isAdmin(): boolean {
  const ctx = window.SoulSyncWebShellBridge?.getCurrentProfileContext?.() ?? null;
  // no profile context means no profiles to tell apart; the server decides
  return ctx ? !!ctx.isAdmin || ctx.profileId === 1 : true;
}

function isVisible(el: Element | null): boolean {
  return !!el && (el as HTMLElement).offsetParent !== null;
}

function setModules(next: ModuleState[]): void {
  modules = next;
  window.SOULSYNC_MODULES = next;
  applyModuleStates();
  syncSettingsRows();
  window.dispatchEvent(new CustomEvent(MODULES_CHANGED_EVENT, { detail: { modules: next } }));
}

// ── sidebar + pages ──────────────────────────────────────────────────────────

function applyNavGuard(): void {
  let style = document.getElementById(NAV_GUARD_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = NAV_GUARD_STYLE_ID;
    document.head.appendChild(style);
  }
  const css = navGuardCss(modules);
  if (style.textContent !== css) style.textContent = css;
}

function leaveVideoSide(): void {
  // Turned off from the video side's Settings: land on the same section of
  // the music side's Settings rather than whatever music page was last open.
  const onSettings = isVisible(document.getElementById('settings-page'));
  window._switchAppSide?.('music', { force: true });
  if (onSettings) {
    window.requestSettingsTab?.('modules');
    void window.navigateToPage?.('settings');
  }
}

/** Hide a turned-off module's entry points, or bring them back. */
export function applyModuleStates(): void {
  applyNavGuard();
  if (moduleIsOff('video') && document.body?.getAttribute('data-side') === 'video') {
    leaveVideoSide();
  }
  for (const state of modules) {
    for (const page of state.pages) {
      const el = document.getElementById(`${page}-page`);
      if (!el || !el.classList.contains('page')) continue;
      if (state.enabled) {
        if (clearModuleOffNotice(el) && isVisible(el)) void window.loadPageData?.(page);
      } else {
        showModuleOffNotice(el, state.name);
      }
    }
  }
}

function buildOffNotice(state: ModuleState, admin: boolean): HTMLElement {
  const copy = moduleOffCopy(state, admin);
  const titleId = `module-off-title-${state.name}`;
  const notice = document.createElement('section');
  notice.className = 'module-off-notice';
  notice.dataset.module = state.name;
  notice.dataset.admin = admin ? 'yes' : 'no';
  notice.setAttribute('aria-labelledby', titleId);

  const status = document.createElement('p');
  status.className = 'module-off-status';
  const dot = document.createElement('span');
  dot.className = 'module-off-dot';
  dot.setAttribute('aria-hidden', 'true');
  status.append(dot, 'Module off');

  const title = document.createElement('h2');
  title.className = 'module-off-title';
  title.id = titleId;
  title.textContent = copy.title;

  const body = document.createElement('p');
  body.className = 'module-off-body';
  body.textContent = copy.body;

  const hint = document.createElement('p');
  hint.className = 'module-off-hint';
  hint.textContent = copy.hint;

  notice.append(status, title, body, hint);
  if (copy.action) {
    const link = document.createElement('a');
    link.className = 'module-off-action';
    link.href = appURL(MODULES_SETTINGS_PATH);
    link.textContent = copy.action;
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      openModulesSettings();
    });
    notice.append(link);
  }
  return notice;
}

/** Show the "turned off" notice in place of a legacy page's content. */
export function showModuleOffNotice(container: Element, name: string): void {
  const state = findModule(modules, name) ?? withModuleOff([], name)[0];
  const admin = isAdmin();
  container.classList.add('module-off-page');
  const current = container.querySelector(':scope > .module-off-notice');
  if (
    current instanceof HTMLElement &&
    current.dataset.module === state.name &&
    current.dataset.admin === (admin ? 'yes' : 'no')
  ) {
    return;
  }
  current?.remove();
  container.prepend(buildOffNotice(state, admin));
}

/** Remove the notice. True when there was one. */
export function clearModuleOffNotice(container: Element): boolean {
  const notice = container.querySelector(':scope > .module-off-notice');
  container.classList.remove('module-off-page');
  if (!notice) return false;
  notice.remove();
  return true;
}

/** Settings -> Modules, from any page. */
export function openModulesSettings(): void {
  const settings = document.getElementById('settings-page');
  if (isVisible(settings)) {
    window.switchSettingsTab?.('modules');
    return;
  }
  window.requestSettingsTab?.('modules');
  if (document.body?.getAttribute('data-side') === 'video' && !moduleIsOff('video')) {
    document.dispatchEvent(
      new CustomEvent('soulsync:video-navigate', { detail: 'video-settings' }),
    );
    return;
  }
  if (window.navigateToPage) {
    void window.navigateToPage('settings');
    return;
  }
  window.location.assign(appURL(MODULES_SETTINGS_PATH));
}

// ── keeping the states current ───────────────────────────────────────────────

export async function refreshModuleStates(): Promise<ModuleState[]> {
  const startedAt = changes;
  const res = await fetch('/api/modules', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { modules?: unknown };
  const next = normalizeModules(body?.modules);
  if (!next.length) throw new Error('no modules in the answer');
  if (changes === startedAt) setModules(next);
  return modules;
}

function disabledModuleName(payload: unknown): string | null {
  const body = moduleDisabledPayload(payload);
  if (body) return body.module;
  // the window event's detail: { module, message }
  const name =
    payload && typeof payload === 'object' ? (payload as { module?: unknown }).module : null;
  return typeof name === 'string' && name ? name : null;
}

/**
 * A 409 module_disabled answer (its body, or the window event's detail): the
 * module is off now, whatever we thought.
 */
export function noteModuleDisabled(payload: unknown): void {
  const name = disabledModuleName(payload);
  if (!name || moduleIsOff(name)) return;
  setModules(withModuleOff(modules, name));
  // the rest may have changed too; the answer replaces the guess
  refreshModuleStates().catch(() => {
    /* keep the guess */
  });
}

// ── Settings -> Modules ──────────────────────────────────────────────────────

interface RowRefs {
  row: HTMLLIElement;
  name: HTMLElement;
  desc: HTMLElement;
  control: HTMLElement;
  confirm: HTMLElement;
  confirmTitle: HTMLElement;
  confirmBody: HTMLElement;
  confirmButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  status: HTMLElement;
  restart: HTMLElement;
  restartTitle: HTMLElement;
  restartBody: HTMLElement;
  readOnly: boolean;
}

const rows = new Map<string, RowRefs>();
const busy = new Map<string, boolean>(); // module -> the state it is being turned to
let readOnly = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function switchButton(name: string): HTMLElement {
  const button = el('button', 'module-switch');
  button.type = 'button';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-labelledby', `module-row-name-${name}`);
  button.setAttribute('aria-describedby', `module-row-desc-${name}`);
  const track = el('span', 'module-switch-track');
  track.setAttribute('aria-hidden', 'true');
  track.append(el('span', 'module-switch-thumb'));
  button.append(track, el('span', 'module-switch-label'));
  button.addEventListener('click', () => onSwitch(name));
  return button;
}

function readOnlyState(): HTMLElement {
  const state = el('span', 'module-state');
  const dot = el('span', 'module-state-dot');
  dot.setAttribute('aria-hidden', 'true');
  state.append(dot, el('span', 'module-state-word'));
  return state;
}

function buildRow(state: ModuleState): RowRefs {
  const { name } = state;
  const row = el('li', 'module-row');
  row.dataset.module = name;

  const main = el('div', 'module-row-main');
  const text = el('div', 'module-row-text');
  const title = el('h4', 'module-row-name');
  title.id = `module-row-name-${name}`;
  const desc = el('p', 'module-row-desc');
  desc.id = `module-row-desc-${name}`;
  text.append(title, desc);
  const control = el('div', 'module-row-control');
  control.append(readOnly ? readOnlyState() : switchButton(name));
  main.append(text, control);

  const confirm = el('div', 'module-confirm');
  confirm.hidden = true;
  confirm.setAttribute('role', 'group');
  confirm.setAttribute('aria-labelledby', `module-confirm-title-${name}`);
  const confirmTitle = el('p', 'module-confirm-title');
  confirmTitle.id = `module-confirm-title-${name}`;
  const confirmBody = el('p', 'module-confirm-body');
  const actions = el('div', 'module-confirm-actions');
  const confirmButton = el('button', 'module-btn module-btn--primary');
  confirmButton.type = 'button';
  confirmButton.addEventListener('click', () => {
    closeConfirm(name, true);
    void changeModule(name, false);
  });
  const cancelButton = el('button', 'module-btn module-btn--secondary');
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => closeConfirm(name, true));
  actions.append(confirmButton, cancelButton);
  confirm.append(confirmTitle, confirmBody, actions);
  confirm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeConfirm(name, true);
    }
  });

  const status = el('p', 'module-row-status');
  status.setAttribute('role', 'status');

  const restart = el('div', 'module-restart');
  restart.hidden = true;
  const badge = el('p', 'module-restart-badge');
  const badgeDot = el('span', 'module-restart-dot');
  badgeDot.setAttribute('aria-hidden', 'true');
  badge.append(badgeDot, 'Restart needed');
  const restartTitle = el('p', 'module-restart-title');
  const restartBody = el('p', 'module-restart-body');
  restart.append(badge, restartTitle, restartBody);

  row.append(main, confirm, status, restart);
  return {
    row,
    name: title,
    desc,
    control,
    confirm,
    confirmTitle,
    confirmBody,
    confirmButton,
    cancelButton,
    status,
    restart,
    restartTitle,
    restartBody,
    readOnly,
  };
}

function updateRow(refs: RowRefs, state: ModuleState): void {
  refs.name.textContent = state.display_name;
  refs.desc.textContent = state.description ?? '';
  const pending = busy.get(state.name);
  const word =
    pending === undefined
      ? state.enabled
        ? 'On'
        : 'Off'
      : pending
        ? 'Turning on…'
        : 'Turning off…';
  const button = refs.control.querySelector<HTMLButtonElement>('.module-switch');
  if (button) {
    button.setAttribute('aria-checked', String(state.enabled));
    // aria-disabled, not disabled: a disabled button drops keyboard focus,
    // and the switch is where focus should still be when the answer comes
    if (pending === undefined) {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-busy');
    } else {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-busy', 'true');
    }
    const label = button.querySelector('.module-switch-label');
    if (label) label.textContent = word;
  }
  const stateEl = refs.control.querySelector<HTMLElement>('.module-state');
  if (stateEl) {
    stateEl.dataset.state = state.enabled ? 'on' : 'off';
    const label = stateEl.querySelector('.module-state-word');
    if (label) label.textContent = state.enabled ? 'On' : 'Off';
  }
  const offCopy = turnOffCopy(state);
  refs.confirmTitle.textContent = offCopy.title;
  refs.confirmBody.textContent = offCopy.body;
  refs.confirmButton.textContent = offCopy.confirm;
  refs.cancelButton.textContent = offCopy.cancel;
  if (!state.enabled || readOnly) refs.confirm.hidden = true;

  const restart = restartCopy(state);
  refs.restart.hidden = !restart;
  refs.restartTitle.textContent = restart?.title ?? '';
  refs.restartBody.textContent = restart?.body ?? '';
}

function setRowStatus(name: string, text: string, tone: 'success' | 'error' | 'info'): void {
  const refs = rows.get(name);
  if (!refs) return;
  refs.status.dataset.tone = tone;
  refs.status.textContent = text;
}

function focusSwitch(name: string): void {
  rows.get(name)?.control.querySelector<HTMLButtonElement>('.module-switch')?.focus();
}

function openConfirm(name: string): void {
  const refs = rows.get(name);
  if (!refs) return;
  refs.confirm.hidden = false;
  refs.confirmButton.focus();
}

function closeConfirm(name: string, focus: boolean): void {
  const refs = rows.get(name);
  if (!refs) return;
  if (focus) focusSwitch(name);
  refs.confirm.hidden = true;
}

function onSwitch(name: string): void {
  const state = findModule(modules, name);
  if (!state || readOnly || busy.has(name)) return;
  if (state.enabled) {
    openConfirm(name);
  } else {
    void changeModule(name, true);
  }
}

async function changeModule(name: string, enabled: boolean): Promise<void> {
  const state = findModule(modules, name);
  if (!state || busy.has(name)) return;
  const displayName = state.display_name;
  busy.set(name, enabled);
  syncSettingsRows();
  setRowStatus(name, `Turning ${displayName} ${enabled ? 'on' : 'off'}…`, 'info');
  try {
    const res = await fetch(`/api/modules/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      module?: unknown;
      message?: unknown;
      error?: unknown;
    };
    if (res.status === 403) {
      busy.delete(name);
      setReadOnly(true);
      setRowStatus(name, 'Only an admin can turn modules on or off.', 'error');
      return;
    }
    const next = res.ok ? normalizeModule(body.module) : null;
    if (!next) {
      const reason =
        (typeof body.message === 'string' && body.message) ||
        (typeof body.error === 'string' && body.error) ||
        `SoulSync answered ${res.status}.`;
      throw new Error(reason);
    }
    busy.delete(name);
    changes += 1;
    setModules(withModuleState(modules, next));
    setRowStatus(name, changeResultCopy(next), 'success');
  } catch (error) {
    busy.delete(name);
    syncSettingsRows();
    const reason =
      error instanceof Error && error.message ? error.message : 'Something went wrong.';
    setRowStatus(
      name,
      `Couldn't turn ${displayName} ${enabled ? 'on' : 'off'}. ${reason.replace(/\.?$/, '.')} Nothing changed.`,
      'error',
    );
  }
}

function setReadOnly(next: boolean): void {
  if (readOnly === next) return;
  readOnly = next;
  syncSettingsRows();
}

/** Bring the rows in line with the module states (built once, then updated in place). */
function syncSettingsRows(): void {
  const list = document.getElementById(LIST_ID);
  if (!list) return;
  const note = document.getElementById(READONLY_NOTE_ID);
  if (note) note.hidden = !readOnly;
  const names = modules.map((m) => m.name);
  const reuse =
    names.length === rows.size &&
    names.every((n) => rows.get(n)?.readOnly === readOnly && list.contains(rows.get(n)!.row));
  if (!reuse) {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '.module-row',
    )?.dataset.module;
    rows.clear();
    list.replaceChildren(
      ...modules.map((m) => {
        const refs = buildRow(m);
        rows.set(m.name, refs);
        return refs.row;
      }),
    );
    if (focused) focusSwitch(focused);
  }
  for (const m of modules) {
    const refs = rows.get(m.name);
    if (refs) updateRow(refs, m);
  }
}

function setLoadError(text: string | null): void {
  const box = document.getElementById(LOAD_ERROR_ID);
  if (!box) return;
  box.hidden = !text;
  box.textContent = text ?? '';
}

/** Settings -> Modules was opened: render what we have, then ask the server. */
export async function loadModulesSettings(): Promise<void> {
  if (!document.getElementById(LIST_ID)) return;
  readOnly = !isAdmin();
  syncSettingsRows();
  try {
    await refreshModuleStates();
    setLoadError(null);
  } catch {
    setLoadError(
      modules.length
        ? "Couldn't load the latest module states. These are the states from when the page loaded."
        : "Couldn't load the modules. Reload the page to try again.",
    );
    syncSettingsRows();
  }
}

/** Wire the window listeners and apply the rendered states (shell boot). */
export function initModules(): void {
  window.addEventListener(MODULE_DISABLED_EVENT, (event) => {
    noteModuleDisabled((event as CustomEvent<unknown>).detail);
  });
  // who is signed in decides whether a notice offers the Settings link
  window.addEventListener('ss:webui-shell-bridge-ready', applyModuleStates);
  window.addEventListener('ss:webui-profile-context-changed', applyModuleStates);
  applyModuleStates();
}

/** Tests only: start over from the given states. */
export function _resetModulesForTests(next: unknown = window.SOULSYNC_MODULES): void {
  modules = normalizeModules(next);
  changes = 0;
  rows.clear();
  busy.clear();
  readOnly = false;
}
