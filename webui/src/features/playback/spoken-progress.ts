/**
 * Where this profile got to in podcast episodes and audiobooks (HANDOFF 46),
 * for the pages that list them: POST /api/player/progress/lookup. The
 * player saves it as it plays (static/media-player.js) and starts from it.
 */

import { useEffect, useMemo, useState } from 'react';

export interface SpokenProgress {
  position_s: number;
  duration_s: number | null;
  finished: boolean;
  resume_at: number;
  updated_at: number;
}

export type SpokenKind = 'podcast' | 'audiobook';

/** the server takes this many ids at a time */
const CHUNK = 100;

export async function fetchSpokenProgress(
  kind: SpokenKind,
  ids: readonly string[],
): Promise<Record<string, SpokenProgress>> {
  const out: Record<string, SpokenProgress> = {};
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const res = await fetch('/api/player/progress/lookup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, ids: unique.slice(i, i + CHUNK) }),
    });
    if (!res.ok) continue;
    const body = (await res.json().catch(() => null)) as {
      items?: Record<string, SpokenProgress>;
    } | null;
    Object.assign(out, body?.items ?? {});
  }
  return out;
}

/**
 * Progress for these ids, read again when `refreshKey` changes (the page
 * passes what the player is doing, so a pause shows the new place).
 */
export function useSpokenProgress(
  kind: SpokenKind,
  ids: readonly string[],
  refreshKey: unknown = null,
): Record<string, SpokenProgress> {
  const [progress, setProgress] = useState<Record<string, SpokenProgress>>({});
  const key = useMemo(
    () =>
      ids
        .filter((id) => id && !id.includes('\n'))
        .slice(0, 400)
        .join('\n'),
    [ids],
  );
  useEffect(() => {
    if (!key) {
      setProgress({});
      return;
    }
    let live = true;
    const timer = window.setTimeout(
      () => {
        fetchSpokenProgress(kind, key.split('\n'))
          .then((next) => {
            if (live) setProgress(next);
          })
          .catch(() => undefined);
      },
      refreshKey === null ? 0 : 800,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [kind, key, refreshKey]);
  return progress;
}
