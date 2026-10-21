/**
 * Module switches (core/modules.py, GET/PUT /api/modules): the shapes, the
 * pure lookups and the copy both runtimes share.
 *
 * The legacy shell (src/shell/modules.ts) uses these for the Settings ->
 * Modules section and the sidebar; the React pages use them to show a
 * friendly "turned off" message instead of a page whose API answers 409.
 */

export interface ModuleState {
  name: string;
  display_name: string;
  description?: string;
  enabled: boolean;
  restart_required?: boolean;
  restart_reason?: string | null;
  /** Shell page ids (data-page / data-video-page) the module owns. */
  pages: string[];
}

/** window event: the shell's module states changed. detail: { modules } */
export const MODULES_CHANGED_EVENT = 'soulsync:modules-changed';
/** window event: an API call answered 409 module_disabled. detail: { module, message } */
export const MODULE_DISABLED_EVENT = 'soulsync:module-disabled';

/** The <style> that hides a turned-off module's sidebar entries. */
export const NAV_GUARD_STYLE_ID = 'soulsync-module-guard';

/** Where the "turn it back on" links go. */
export const MODULES_SETTINGS_PATH = '/settings?tab=modules';

const PAGE_ID = /^[a-z0-9-]+$/;

function prettyName(name: string): string {
  const words = name.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

/** One module from an API or page-shell payload, or null if it isn't one. */
export function normalizeModule(raw: unknown): ModuleState | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const displayName =
    typeof value.display_name === 'string' && value.display_name.trim()
      ? value.display_name.trim()
      : prettyName(name);
  const pages = Array.isArray(value.pages)
    ? value.pages.filter((p): p is string => typeof p === 'string' && PAGE_ID.test(p))
    : [];
  const state: ModuleState = {
    name,
    display_name: displayName,
    // only an explicit false turns a module off, like the server
    enabled: value.enabled !== false,
    pages,
  };
  if (typeof value.description === 'string') state.description = value.description;
  if (typeof value.restart_required === 'boolean') state.restart_required = value.restart_required;
  if (typeof value.restart_reason === 'string' || value.restart_reason === null) {
    state.restart_reason = value.restart_reason;
  }
  return state;
}

export function normalizeModules(raw: unknown): ModuleState[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeModule).filter((m): m is ModuleState => m !== null);
}

export function findModule(modules: readonly ModuleState[], name: string): ModuleState | undefined {
  return modules.find((m) => m.name === name);
}

/** The module that owns a shell page id (e.g. 'podcasts', 'video-library'). */
export function moduleForPage(
  modules: readonly ModuleState[],
  pageId: string,
): ModuleState | undefined {
  return modules.find((m) => m.pages.includes(pageId));
}

/**
 * The module that owns a browser path: its first segment as a page id, and
 * /video-detail/... with the module that owns the video library.
 */
export function moduleForPath(
  modules: readonly ModuleState[],
  pathname: string,
): ModuleState | undefined {
  const first = pathname.replace(/^\/+/, '').split(/[/?#]/)[0] ?? '';
  if (!first) return undefined;
  const owner = moduleForPage(modules, first);
  if (owner) return owner;
  if (first === 'video-detail') return moduleForPage(modules, 'video-library');
  return undefined;
}

/** A copy with one module's state replaced (or added). */
export function withModuleState(modules: readonly ModuleState[], next: ModuleState): ModuleState[] {
  const found = modules.some((m) => m.name === next.name);
  return found ? modules.map((m) => (m.name === next.name ? next : m)) : [...modules, next];
}

/** A copy with one module marked off (after a 409 module_disabled). */
export function withModuleOff(modules: readonly ModuleState[], name: string): ModuleState[] {
  const current = findModule(modules, name);
  if (current && !current.enabled) return [...modules];
  const next: ModuleState = current
    ? { ...current, enabled: false }
    : { name, display_name: prettyName(name), enabled: false, pages: [] };
  return withModuleState(modules, next);
}

/**
 * The module a 409 body names, from either envelope:
 * { error: 'module_disabled', module, message } or the /api/v1
 * { error: { code: 'MODULE_DISABLED', module, message } }.
 */
export function moduleDisabledPayload(body: unknown): { module: string; message: string } | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (value.error === 'module_disabled' && typeof value.module === 'string') {
    return {
      module: value.module,
      message: typeof value.message === 'string' ? value.message : '',
    };
  }
  const nested = value.error;
  if (nested && typeof nested === 'object') {
    const err = nested as Record<string, unknown>;
    if (err.code === 'MODULE_DISABLED' && typeof err.module === 'string') {
      return { module: err.module, message: typeof err.message === 'string' ? err.message : '' };
    }
  }
  return null;
}

/**
 * The CSS that hides a turned-off module's sidebar entries, and the
 * Audio/Video switch while Video is off. index.html builds the same rules
 * before first paint (its head script); keep the two in step.
 */
export function navGuardCss(modules: readonly ModuleState[]): string {
  let css = '';
  for (const m of modules) {
    if (m.enabled !== false) continue;
    for (const page of m.pages) {
      if (!PAGE_ID.test(page)) continue;
      css += `.nav-button[data-page="${page}"],.nav-button[data-video-page="${page}"]{display:none!important}`;
    }
    if (m.name === 'video') css += '.side-toggle{display:none!important}';
  }
  return css;
}

// What stops while a module is off, as the subject of a sentence.
const STOPS: Record<string, string> = {
  video: 'Movies, TV and YouTube pages and video downloads',
  podcasts: "Podcasts' pages and downloads",
  audiobooks: "Audiobooks' pages and downloads",
  chat: 'Chat rooms, private messages and the arcade',
  sample_studio: "Sample Studio's page and track analysis",
};

export function whatStops(module: Pick<ModuleState, 'name' | 'display_name'>): string {
  return STOPS[module.name] ?? `${module.display_name}'s pages`;
}

/** The confirmation shown before turning a module off. */
export function turnOffCopy(module: Pick<ModuleState, 'name' | 'display_name'>): {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
} {
  return {
    title: `Turn off ${module.display_name}?`,
    body: `${whatStops(module)} stop until you turn it back on.`,
    confirm: `Turn off ${module.display_name}`,
    cancel: 'Keep it on',
  };
}

/** The message a turned-off module's page shows instead of the page. */
export function moduleOffCopy(
  module: Pick<ModuleState, 'name' | 'display_name'>,
  isAdmin: boolean,
): { title: string; body: string; action: string | null; hint: string } {
  return {
    title: `${module.display_name} is turned off`,
    body: `${whatStops(module)} are off until the module is turned back on.`,
    action: isAdmin ? 'Open Settings → Modules' : null,
    hint: isAdmin
      ? 'You can turn it back on in Settings → Modules.'
      : 'An admin can turn it back on in Settings → Modules.',
  };
}

/** The line shown after a switch changed. */
export function changeResultCopy(module: ModuleState): string {
  const name = module.display_name;
  const done = module.enabled
    ? `${name} is on. Its pages are back in the sidebar.`
    : `${name} is off. Its pages are hidden from the sidebar.`;
  return module.restart_required ? `${done} Restart SoulSync to finish.` : done;
}

/** The heading of the restart notice, when a module reports restart_required. */
export function restartCopy(module: ModuleState): { title: string; body: string } | null {
  if (!module.restart_required) return null;
  return {
    title: `Restart SoulSync to finish turning ${module.display_name} ${module.enabled ? 'on' : 'off'}.`,
    body:
      (module.restart_reason || '').trim() ||
      `Some of ${module.display_name}'s background work only ${module.enabled ? 'starts' : 'stops'} on a restart.`,
  };
}
