/**
 * The star (boards 28a–28d; 24a's "the star": one control on legacy and
 * React pages alike). One store per page, shared by the shell bundle and the
 * React app through `window.SoulSyncStars` (whichever loads first makes it),
 * so a star toggled in the player bar shows on the Tracks row at once.
 *
 * It knows, per library track id, whether this profile starred it and
 * whether it can be starred (in your library with its file present). Rows
 * ask for their ids with `want()`: the ids a page needs are gathered and
 * looked up in one request (POST /api/stars/status), never one per row. A
 * page that already has the answer (Tracks' browse) `prime()`s it instead.
 *
 * Toggling is optimistic: the star changes at once and goes back, with a
 * toast, if the server refuses. The keyboard's S (`starPlaying`) stars the
 * focused row's track, else the playing one.
 */
import { appURL } from '@/platform/url-base';

export interface StarState {
  starred: boolean;
  /** a library track with its file present: the only kind that can be starred */
  canStar: boolean;
}

export interface SongMatch {
  title: string;
  artist: string;
}

type Listener = () => void;

export interface StarStore {
  /** what's known for a track, or undefined until it's been looked up */
  get(id: string): StarState | undefined;
  /** ask for these ids' state (batched into one request a moment later) */
  want(ids: Iterable<string>): void;
  /** answers a page already has (``{id: {starred, can_star}}``) */
  prime(
    entries: Record<string, { starred?: boolean; can_star?: boolean; canStar?: boolean }>,
  ): void;
  /** match a playlist's rows to library tracks; their states are primed too */
  resolveSongs(songs: SongMatch[]): Promise<(string | null)[]>;
  /** star or unstar one track; resolves to the new state (or the old one, refused) */
  toggle(id: string, title?: string): Promise<boolean>;
  /** star many (Star all); resolves to how many were starred */
  starMany(ids: string[]): Promise<number>;
  /** the Starred chip's count, once known */
  count(): number | null;
  refreshCount(): Promise<number | null>;
  /** forget everything (a profile switch) */
  reset(): void;
  subscribe(listener: Listener): () => void;
  /** a number that moves on with every change (for useSyncExternalStore) */
  version(): number;
}

declare global {
  interface Window {
    SoulSyncStars?: StarStore;
  }
}

/** the most ids one status request carries (api/stars.py) */
export const STATUS_BATCH = 500;

type Fetch = typeof fetch;

async function post<T>(fetcher: Fetch, path: string, body: unknown): Promise<T> {
  const response = await fetcher(appURL(`/api/${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
  } & T;
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || "That didn't work. Try again in a moment.");
  }
  return payload;
}

function toast(message: string, kind: 'success' | 'error' | 'info'): void {
  try {
    window.showToast?.(message, kind);
  } catch {
    /* no toasts on this page: the star itself says what happened */
  }
}

export function createStarStore(fetcher: Fetch = (...args) => window.fetch(...args)): StarStore {
  const states = new Map<string, StarState>();
  const pending = new Set<string>();
  const asked = new Set<string>();
  const listeners = new Set<Listener>();
  let starredCount: number | null = null;
  let tick = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => {
    tick += 1;
    for (const listener of [...listeners]) listener();
  };

  const put = (id: string, state: StarState) => {
    states.set(id, state);
    asked.add(id);
  };

  const flush = async () => {
    timer = null;
    // a page may have primed some of them meanwhile (its own rows say)
    const ids = [...pending].filter((id) => !states.has(id));
    pending.clear();
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += STATUS_BATCH) {
      const chunk = ids.slice(i, i + STATUS_BATCH);
      try {
        const body = await post<{
          tracks: Record<string, { starred: boolean; can_star: boolean }>;
        }>(fetcher, 'stars/status', { track_ids: chunk });
        for (const id of chunk) {
          const s = body.tracks?.[id];
          put(id, { starred: Boolean(s?.starred), canStar: Boolean(s?.can_star) });
        }
      } catch {
        // unknown stays unknown (no star shown); asked again on the next want
        for (const id of chunk) asked.delete(id);
      }
    }
    emit();
  };

  const store: StarStore = {
    get: (id) => states.get(id),
    want(ids) {
      let added = false;
      for (const raw of ids) {
        const id = String(raw ?? '');
        if (!id || asked.has(id) || pending.has(id)) continue;
        pending.add(id);
        asked.add(id);
        added = true;
      }
      if (added && timer === null) timer = setTimeout(() => void flush(), 0);
    },
    prime(entries) {
      let changed = false;
      for (const [id, s] of Object.entries(entries)) {
        const next = { starred: Boolean(s.starred), canStar: Boolean(s.can_star ?? s.canStar) };
        const was = states.get(id);
        if (!was || was.starred !== next.starred || was.canStar !== next.canStar) changed = true;
        put(id, next);
      }
      if (changed) emit();
    },
    async resolveSongs(songs) {
      const out: (string | null)[] = [];
      for (let i = 0; i < songs.length; i += STATUS_BATCH) {
        const chunk = songs.slice(i, i + STATUS_BATCH);
        const body = await post<{
          songs: { track_id: string | null; starred: boolean; can_star: boolean }[];
        }>(fetcher, 'stars/status', {
          songs: chunk.map((s) => ({ title: s.title, artist: s.artist })),
        });
        for (const s of body.songs ?? []) {
          out.push(s.track_id);
          if (s.track_id) put(s.track_id, { starred: s.starred, canStar: s.can_star });
        }
      }
      emit();
      return out;
    },
    async toggle(id, title) {
      const was = states.get(id);
      if (!was || (!was.starred && !was.canStar)) return Boolean(was?.starred);
      const on = !was.starred;
      put(id, { ...was, starred: on });
      if (starredCount !== null) starredCount = Math.max(0, starredCount + (on ? 1 : -1));
      emit();
      try {
        const body = await post<{ count?: number }>(fetcher, on ? 'stars' : 'stars/remove', {
          track_ids: [id],
        });
        if (typeof body.count === 'number') starredCount = body.count;
        emit();
        return on;
      } catch (err) {
        put(id, was);
        if (starredCount !== null) starredCount = Math.max(0, starredCount + (on ? -1 : 1));
        emit();
        const words = err instanceof Error && err.message ? err.message : "The star wasn't saved.";
        toast(title ? `${title}: ${words}` : words, 'error');
        return was.starred;
      }
    },
    async starMany(ids) {
      const can = ids.filter((id) => {
        const s = states.get(id);
        return !s || s.canStar || s.starred;
      });
      if (!can.length) return 0;
      let starred = 0;
      for (let i = 0; i < can.length; i += STATUS_BATCH) {
        const chunk = can.slice(i, i + STATUS_BATCH);
        try {
          const body = await post<{ starred: string[]; count?: number }>(fetcher, 'stars', {
            track_ids: chunk,
          });
          for (const id of body.starred ?? []) {
            put(id, { starred: true, canStar: true });
            starred += 1;
          }
          if (typeof body.count === 'number') starredCount = body.count;
        } catch (err) {
          toast(err instanceof Error ? err.message : "Those weren't starred.", 'error');
        }
      }
      emit();
      return starred;
    },
    count: () => starredCount,
    async refreshCount() {
      try {
        const response = await fetcher(appURL('/api/stars/count'), { credentials: 'same-origin' });
        const body = (await response.json().catch(() => ({}))) as { count?: number };
        if (response.ok && typeof body.count === 'number') {
          starredCount = body.count;
          emit();
        }
      } catch {
        /* the chip shows no number */
      }
      return starredCount;
    },
    reset() {
      states.clear();
      pending.clear();
      asked.clear();
      starredCount = null;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => tick,
  };
  return store;
}

/** The page's one store (made by the shell bundle or the React app, whichever runs first). */
export function starStore(): StarStore {
  if (typeof window === 'undefined') return createStarStore();
  if (!window.SoulSyncStars) window.SoulSyncStars = createStarStore();
  return window.SoulSyncStars;
}

/** Whether a row shows its star at all: a track with a file, or one already starred (28c). */
export function showsStar(state: StarState | undefined): boolean {
  return Boolean(state && (state.starred || state.canStar));
}

export function starLabel(starred: boolean, title?: string): string {
  const what = title?.trim() ? ` ${title.trim()}` : '';
  return starred ? `Unstar${what}` : `Star${what}`;
}
