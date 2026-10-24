/**
 * The Visuals routes (api/visuals.py; docs/design/CONTRACTS.md, "Visuals").
 * The index is asked for once, when MilkDrop is first opened; each preset is
 * fetched by key when it's picked and kept (the browser's cache, plus this
 * page's memory for the session).
 */

import { appURL } from '@/platform/url-base';

import type { OwnFolderState, PresetIndex, PresetSet } from './visuals.types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export class VisualsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

async function json<T>(
  res: Response,
): Promise<T & { success?: boolean; message?: string; error?: string }> {
  try {
    return (await res.json()) as T & {
      success?: boolean;
      message?: string;
      error?: string;
    };
  } catch {
    return {} as T & { success?: boolean };
  }
}

/**
 * MilkDrop's list: the curated packs and your own, or every preset (101).
 * `keep` names Recent's presets, so the curated set still hands them back
 * (in `kept`) when it leaves them out; the server adds the favourites.
 */
export async function fetchIndex(
  opts: { set?: PresetSet; keep?: readonly string[] } = {},
  f: FetchLike = defaultFetch,
): Promise<PresetIndex> {
  const set = opts.set ?? 'curated';
  // only the curated set leaves presets out
  const keep =
    set === 'curated'
      ? (opts.keep ?? []).filter((k) => /^md-[0-9a-f]{16}$/.test(k)).slice(0, 50)
      : [];
  const query = `family=milkdrop&set=${set}${keep.length ? `&keep=${keep.join(',')}` : ''}`;
  let res: Response;
  try {
    res = await f(appURL(`/api/visuals/presets?${query}`), {
      credentials: 'same-origin',
    });
  } catch {
    throw new VisualsApiError('offline', 'SYNCHRO.S didn’t answer. Try again.');
  }
  const body = await json<PresetIndex>(res);
  if (!res.ok || body.success === false || !Array.isArray(body.presets)) {
    throw new VisualsApiError(
      body.error || 'index_failed',
      body.message || 'The preset list couldn’t be read. Try again.',
      res.status,
    );
  }
  return { ...body, kept: Array.isArray(body.kept) ? body.kept : [] };
}

/** A preset: Butterchurn JSON, or one of your own as .milk text to convert. */
export type FetchedPreset =
  | { format: 'json'; preset: Record<string, unknown> }
  | { format: 'milk'; text: string };

const memory = new Map<string, FetchedPreset>();

export async function fetchPreset(
  key: string,
  f: FetchLike = defaultFetch,
): Promise<FetchedPreset> {
  const kept = memory.get(key);
  if (kept) return kept;
  let res: Response;
  try {
    res = await f(appURL(`/api/visuals/presets/${encodeURIComponent(key)}`), {
      credentials: 'same-origin',
    });
  } catch {
    throw new VisualsApiError('offline', 'SYNCHRO.S didn’t answer.');
  }
  if (!res.ok)
    throw new VisualsApiError('not_found', 'That preset isn’t here any more.', res.status);
  let out: FetchedPreset;
  if (res.headers.get('X-Preset-Format') === 'milk' || key.startsWith('own-')) {
    out = { format: 'milk', text: await res.text() };
  } else {
    let preset: unknown;
    try {
      preset = await res.json();
    } catch {
      throw new VisualsApiError('bad_preset', 'That preset isn’t readable.');
    }
    if (!preset || typeof preset !== 'object')
      throw new VisualsApiError('bad_preset', 'That preset isn’t readable.');
    out = { format: 'json', preset: preset as Record<string, unknown> };
  }
  memory.set(key, out);
  return out;
}

export function forgetPreset(key: string): void {
  memory.delete(key);
}

/** @internal tests start with nothing kept */
export function clearPresetMemory(): void {
  memory.clear();
}

export async function fetchFavourites(f: FetchLike = defaultFetch): Promise<string[]> {
  try {
    const res = await f(appURL('/api/visuals/favourites?family=milkdrop'), {
      credentials: 'same-origin',
    });
    const body = await json<{ keys: string[] }>(res);
    return res.ok && Array.isArray(body.keys) ? body.keys : [];
  } catch {
    return [];
  }
}

export async function setFavourite(
  key: string,
  on: boolean,
  f: FetchLike = defaultFetch,
): Promise<boolean> {
  let res: Response;
  try {
    res = await f(appURL(`/api/visuals/favourites/milkdrop/${encodeURIComponent(key)}`), {
      method: on ? 'PUT' : 'DELETE',
      credentials: 'same-origin',
    });
  } catch {
    throw new VisualsApiError('offline', 'SYNCHRO.S didn’t answer.');
  }
  const body = await json<{ favourite: boolean }>(res);
  if (!res.ok || body.success === false)
    throw new VisualsApiError(
      body.error || 'failed',
      body.message || 'That didn’t save.',
      res.status,
    );
  return Boolean(body.favourite);
}

export interface VisualsSettings {
  admin: boolean;
  own: OwnFolderState;
  own_presets_dir?: string;
}

export async function fetchSettings(f: FetchLike = defaultFetch): Promise<VisualsSettings | null> {
  try {
    const res = await f(appURL('/api/visuals/settings'), {
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    return await json<VisualsSettings>(res);
  } catch {
    return null;
  }
}

export async function saveOwnFolder(
  folder: string,
  f: FetchLike = defaultFetch,
): Promise<VisualsSettings> {
  let res: Response;
  try {
    res = await f(appURL('/api/visuals/settings'), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ own_presets_dir: folder }),
    });
  } catch {
    throw new VisualsApiError('offline', 'SYNCHRO.S didn’t answer. Try again.');
  }
  const body = await json<VisualsSettings>(res);
  if (!res.ok || body.success === false)
    throw new VisualsApiError(
      body.error || 'failed',
      body.message || 'That folder wasn’t saved.',
      res.status,
    );
  return body;
}
