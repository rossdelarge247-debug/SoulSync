/**
 * DJ mode's settings a person keeps (Brief F step 5), in this browser, per
 * profile (as the player's own settings are, `soulsync-npv2-…:<profile>`):
 *
 * - **each lane's zoom** (S3): the level last used, from a tighter default
 *   (16 bars: beats and bars to read, the sections strip as the overview);
 * - **the Tempo fader's direction** (M8): + at the bottom by default, as on
 *   a CDJ or a turntable (pulled towards you, faster); + at the top for
 *   those used to "up is more";
 * - **Auto-gain** (S6): B matched to A's analysed loudness, on by default;
 * - **Quantize** (step 6): jumps, cues and loops on the beat, on by default.
 *
 * Storage that's blocked or empty gives the defaults; nothing here is
 * needed for DJ mode to work.
 */
import { getShellProfileContext } from '@/platform/shell/bridge';

import { ZOOM_LEVELS, type ZoomLevel } from './dj-zoom';

export interface DjPrefs {
  zoom: { a: ZoomLevel; b: ZoomLevel };
  /** the Tempo fader's + end: 'down' (a CDJ's, the default) or 'up' */
  tempoPlus: 'down' | 'up';
  autoGain: boolean;
  quantize: boolean;
}

export const DEFAULT_ZOOM: ZoomLevel = 16;

export function defaultPrefs(): DjPrefs {
  return {
    zoom: { a: DEFAULT_ZOOM, b: DEFAULT_ZOOM },
    tempoPlus: 'down',
    autoGain: true,
    quantize: true,
  };
}

export const DJ_PREFS_KEY = 'soulsync-dj-prefs';

/** The key for the profile in use ("unscoped" before the shell says, as Discover's caches). */
export function prefsKey(profile: string | number | null | undefined): string {
  return `${DJ_PREFS_KEY}:${profile === null || profile === undefined ? 'unscoped' : String(profile)}`;
}

function currentProfile(): string | number | null {
  try {
    return getShellProfileContext()?.profileId ?? null;
  } catch {
    return null;
  }
}

function zoomOf(v: unknown, fallback: ZoomLevel): ZoomLevel {
  return (ZOOM_LEVELS as readonly unknown[]).includes(v) ? (v as ZoomLevel) : fallback;
}

export function readPrefs(
  store: Pick<Storage, 'getItem'> | null | undefined,
  profile: string | number | null = currentProfile(),
): DjPrefs {
  const d = defaultPrefs();
  let raw: unknown = null;
  try {
    raw = JSON.parse(store?.getItem(prefsKey(profile)) || 'null');
  } catch {
    raw = null;
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DjPrefs> & {
    zoom?: Partial<DjPrefs['zoom']>;
  };
  return {
    zoom: { a: zoomOf(r.zoom?.a, d.zoom.a), b: zoomOf(r.zoom?.b, d.zoom.b) },
    tempoPlus: r.tempoPlus === 'up' ? 'up' : 'down',
    autoGain: r.autoGain !== false,
    quantize: r.quantize !== false,
  };
}

export function savePrefs(
  store: Pick<Storage, 'setItem'> | null | undefined,
  prefs: DjPrefs,
  profile: string | number | null = currentProfile(),
): void {
  try {
    store?.setItem(prefsKey(profile), JSON.stringify(prefs));
  } catch {
    /* blocked: the choice holds for this visit */
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type Listener = () => void;

/** The page's prefs, read once and kept; a change is saved and said to whoever listens. */
export class DjPrefsStore {
  private p: DjPrefs;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly store: Pick<Storage, 'getItem' | 'setItem'> | null = storage()) {
    this.p = readPrefs(store);
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): DjPrefs => this.p;

  /** Read again (another profile is in use). */
  reload(): void {
    this.p = readPrefs(this.store);
    for (const fn of this.listeners) fn();
  }

  set(patch: Partial<DjPrefs>): void {
    this.p = { ...this.p, ...patch };
    savePrefs(this.store, this.p);
    for (const fn of this.listeners) fn();
  }
}

let shared: DjPrefsStore | null = null;

export function djPrefs(): DjPrefsStore {
  shared ??= new DjPrefsStore();
  return shared;
}

/** @internal tests */
export function resetDjPrefs(store?: Pick<Storage, 'getItem' | 'setItem'> | null): DjPrefsStore {
  shared = new DjPrefsStore(store === undefined ? storage() : store);
  return shared;
}
