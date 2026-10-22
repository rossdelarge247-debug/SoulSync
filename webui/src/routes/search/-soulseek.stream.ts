/**
 * The streamed file search, POST /api/search/stream: newline-delimited JSON
 * with `progress` lines (the results so far, the file count and how many
 * users answered), then one `done` line, or an `error` line with a sentence
 * for the user (docs/design/CONTRACTS.md).
 *
 * `useFileSearch` runs one at a time per page and keeps finished searches for
 * the session, so coming back to a query doesn't search Soulseek again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { BasicResult } from './-basic.types';

export type FileSearchEvent =
  | { type: 'progress'; files: number; users: number | null; results: BasicResult[] }
  | { type: 'done'; files: number; users: number | null; results: BasicResult[] }
  | { type: 'error'; error: string };

export async function streamFileSearch(
  query: string,
  source: string | null,
  onEvent: (event: FileSearchEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body: { query: string; source?: string } = { query };
  if (source) body.source = source;
  const response = await fetch('/api/search/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    onEvent({ type: 'error', error: data.error || 'SoulSync didn’t answer the search.' });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last: Extract<FileSearchEvent, { type: 'progress' }> | null = null;
  let ended = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || signal?.aborted) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // the last piece is '' after a clean break, or half a line still coming
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: FileSearchEvent;
      try {
        event = JSON.parse(line) as FileSearchEvent;
      } catch {
        continue; // one bad line doesn't end the search
      }
      if (event.type === 'progress') last = event;
      if (event.type === 'done' || event.type === 'error') ended = true;
      onEvent(event);
    }
  }
  if (!ended && !signal?.aborted) {
    // the connection closed without a last line: what arrived is the answer
    onEvent({
      type: 'done',
      files: last?.files ?? 0,
      users: last?.users ?? null,
      results: last?.results ?? [],
    });
  }
}

export type FileSearchStatus = 'idle' | 'searching' | 'done' | 'stopped' | 'error';

export interface FileSearchState {
  status: FileSearchStatus;
  query: string;
  results: BasicResult[];
  files: number;
  users: number | null;
  error: string | null;
}

const IDLE: FileSearchState = {
  status: 'idle',
  query: '',
  results: [],
  files: 0,
  users: null,
  error: null,
};

/** Finished searches, for the session: `${source}|${query}`. */
const finished = new Map<string, FileSearchState>();

/** Test seam: a module-level cache would otherwise leak between tests. */
export function resetFileSearchCache(): void {
  finished.clear();
}

export interface FileSearch {
  state: FileSearchState;
  stop: () => void;
  retry: () => void;
}

/**
 * Search the download source for `query` (null: don't search), reporting as
 * the stream comes in. A new query or source aborts the one running.
 */
export function useFileSearch(query: string | null, source: string | null): FileSearch {
  const key = query ? `${source ?? ''}|${query}` : '';
  const [state, setState] = useState<FileSearchState>(() => (key && finished.get(key)) || IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (!query) {
      setState(IDLE);
      return;
    }
    const cached = finished.get(key);
    if (cached) {
      setState(cached);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...IDLE, status: 'searching', query });
    void streamFileSearch(
      query,
      source,
      (event) => {
        if (controller.signal.aborted) return;
        if (event.type === 'error') {
          setState((prev) => ({ ...prev, status: 'error', error: event.error }));
          return;
        }
        const next: FileSearchState = {
          status: event.type === 'done' ? 'done' : 'searching',
          query,
          results: event.results,
          files: event.files,
          users: event.users,
          error: null,
        };
        if (event.type === 'done') finished.set(key, next);
        setState(next);
      },
      controller.signal,
    ).catch((error: unknown) => {
      if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: 'SoulSync didn’t answer the search. Nothing was downloaded.',
      }));
    });
    return () => controller.abort();
    // `attempt` re-runs the same search on Try again
  }, [key, query, source, attempt]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((prev) => (prev.status === 'searching' ? { ...prev, status: 'stopped' } : prev));
  }, []);

  const retry = useCallback(() => {
    if (key) finished.delete(key);
    setAttempt((n) => n + 1);
  }, [key]);

  return { state, stop, retry };
}
