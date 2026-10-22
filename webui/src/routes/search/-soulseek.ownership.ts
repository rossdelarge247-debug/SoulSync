/**
 * Which of the files Soulseek found you already have, or want: the library
 * check (POST /api/enhanced-search/library-check) for each file's title and
 * artist, asked in batches as results stream in, first rows first. Best
 * effort: a failed batch reads as "not known" and the rows just say less.
 */

import { useEffect, useRef, useState } from 'react';

import { apiClient, readJson } from '@/app/api-client';

import type { BasicResult } from './-basic.types';
import type { FileOwnership } from './-soulseek.model';

import { DOWNLOADS_FINISHED_EVENT } from './-search.use-library-check';
import { checkRowsFor } from './-soulseek.model';

/** Rows per request: the check costs per row, so a big result set goes in pieces. */
export const OWNERSHIP_BATCH = 400;

export async function checkFiles(
  rows: readonly { name: string; artist: string }[],
  signal?: AbortSignal,
): Promise<FileOwnership[]> {
  const body = await readJson<{ tracks?: FileOwnership[] }>(
    apiClient.post('enhanced-search/library-check', {
      json: { albums: [], tracks: rows.map(({ name, artist }) => ({ name, artist })) },
      signal,
      timeout: 60_000,
    }),
  );
  return body.tracks ?? [];
}

export function useFileOwnership(
  results: readonly BasicResult[],
): ReadonlyMap<string, FileOwnership | null> {
  const [known, setKnown] = useState<ReadonlyMap<string, FileOwnership | null>>(() => new Map());
  const knownRef = useRef(known);
  knownRef.current = known;
  const asked = useRef(new Set<string>());
  const [round, setRound] = useState(0);

  // a finished download changes the answers: ask again
  useEffect(() => {
    const reset = () => {
      asked.current.clear();
      setKnown(new Map());
      setRound((n) => n + 1);
    };
    window.addEventListener(DOWNLOADS_FINISHED_EVENT, reset);
    return () => window.removeEventListener(DOWNLOADS_FINISHED_EVENT, reset);
  }, []);

  // one batch at a time; new results wait for it rather than cancelling it
  const inFlight = useRef(false);
  const unmounted = useRef<AbortController | null>(null);
  useEffect(() => {
    unmounted.current = new AbortController();
    return () => unmounted.current?.abort();
  }, []);

  useEffect(() => {
    if (inFlight.current) return;
    const timer = window.setTimeout(() => {
      const seen = new Set<string>();
      const batch: { key: string; name: string; artist: string }[] = [];
      for (const result of results) {
        for (const row of checkRowsFor(result)) {
          if (seen.has(row.key) || asked.current.has(row.key) || knownRef.current.has(row.key))
            continue;
          seen.add(row.key);
          batch.push(row);
          if (batch.length >= OWNERSHIP_BATCH) break;
        }
        if (batch.length >= OWNERSHIP_BATCH) break;
      }
      if (!batch.length) return;
      batch.forEach((row) => asked.current.add(row.key));
      inFlight.current = true;
      const signal = unmounted.current?.signal;
      void checkFiles(batch, signal)
        .then((answers) => {
          setKnown((prev) => {
            const next = new Map(prev);
            batch.forEach((row, i) =>
              next.set(row.key, answers[i] ?? { in_library: false, in_wishlist: false }),
            );
            return next;
          });
        })
        .catch(() => {
          if (signal?.aborted) return;
          setKnown((prev) => {
            const next = new Map(prev);
            batch.forEach((row) => next.set(row.key, null));
            return next;
          });
        })
        .finally(() => {
          inFlight.current = false;
          if (!signal?.aborted) setRound((n) => n + 1);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [results, round]);

  return known;
}
