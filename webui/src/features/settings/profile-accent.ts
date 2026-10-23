/**
 * Each profile's own accent (HANDOFF 35): what this profile picked, and the
 * install's accent that profiles without a pick use.
 *
 * `GET` / `PUT /api/profiles/me/appearance` read and write the signed-in
 * profile's pick (`accent: "#rrggbb"`, or `null` to follow the install's).
 * The install's accent stays where it was, in Settings → Appearance's form
 * (`ui_appearance.accent_preset` / `accent_color`, admins only).
 *
 * One store per page, shared by Settings → Appearance, My Account and Home's
 * quick swatches, so a pick made in one shows in the others.
 */

import { DEFAULT_ACCENT, accentReport, normaliseHex } from './accent';

export interface ProfileAppearance {
  /** this profile's own pick, or null for the install's */
  accent: string | null;
  /** the install's accent: the default for profiles without a pick */
  install_accent: string;
  effective_accent: string;
  is_admin: boolean;
}

export interface AccentStore {
  mine: string | null;
  install: string;
  isAdmin: boolean;
  loaded: boolean;
}

const URL = '/api/profiles/me/appearance';

const store: AccentStore = { mine: null, install: DEFAULT_ACCENT, isAdmin: false, loaded: false };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

export function accentStore(): Readonly<AccentStore> {
  return store;
}

/** The accent this profile sees: its own pick, else the install's. */
export function appliedAccent(): string {
  return store.mine ?? store.install;
}

export function onAccentStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

function take(body: Partial<ProfileAppearance> | null | undefined): void {
  if (!body) return;
  store.mine = normaliseHex(body.accent ?? null);
  store.install = normaliseHex(body.install_accent ?? null) ?? store.install;
  store.isAdmin = Boolean(body.is_admin);
  store.loaded = true;
}

/** Read this profile's pick (once per page unless `force`). */
export function loadProfileAccent(force = false): Promise<void> {
  if (store.loaded && !force) return Promise.resolve();
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const res = await fetch(URL, { credentials: 'same-origin' });
      if (!res.ok) return;
      take((await res.json()) as ProfileAppearance);
      notify();
    } catch {
      // the page shell already painted the right colour; the cards wait
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Settings → Appearance's form says what the install's accent is. */
export function setInstallAccent(hex: string): void {
  const clean = normaliseHex(hex);
  if (!clean || clean === store.install) return;
  store.install = clean;
  notify();
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * Save this profile's pick (`null` follows the install's). The store changes
 * first, so the cards follow at once; a refusal puts it back.
 */
export async function saveProfileAccent(hex: string | null): Promise<SaveResult> {
  const next = hex === null ? null : normaliseHex(hex);
  if (hex !== null && !next) return { ok: false, error: "That isn't a hex colour." };
  if (next && !accentReport(next).passes) {
    return { ok: false, error: `${next} is too dark for an accent.` };
  }
  const before = store.mine;
  store.mine = next;
  notify();
  try {
    const res = await fetch(URL, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accent: next }),
    });
    const body = (await res.json().catch(() => null)) as
      | (ProfileAppearance & { success?: boolean; error?: string })
      | null;
    if (!res.ok || !body || body.success === false) {
      store.mine = before;
      notify();
      return { ok: false, error: body?.error || "Couldn't save your accent." };
    }
    take(body);
    notify();
    return { ok: true };
  } catch {
    store.mine = before;
    notify();
    return { ok: false, error: "Couldn't save your accent. Check the connection and try again." };
  }
}

/** Tests only. */
export function _resetProfileAccentForTests(): void {
  store.mine = null;
  store.install = DEFAULT_ACCENT;
  store.isAdmin = false;
  store.loaded = false;
  loading = null;
  listeners.clear();
}
