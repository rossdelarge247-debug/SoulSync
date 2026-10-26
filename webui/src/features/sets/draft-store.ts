/**
 * The draft set ("Draft · not saved", 22c), kept in this browser per profile
 * until it's saved as a mix set. Design asked for drafts on the server for a
 * week; whether that's wanted is HANDOFF 246, so for now a draft lives here
 * and a different browser doesn't see it.
 */
import { useSyncExternalStore } from 'react';

import type { MixMeta, SetKind, SetRow, SetSource } from './sets.api';

export interface Draft {
  name: string;
  kind: SetKind;
  rows: SetRow[];
  source?: SetSource | null;
  source_id?: string | null;
  source_url?: string | null;
  source_meta?: MixMeta;
  shape?: string | null;
  /** ms since the epoch */
  updatedAt: number;
}

export const DRAFT_STORAGE_PREFIX = 'soulsync.sets.draft.';
/** what one draft may hold, so a stored draft can't grow without end */
const MAX_ROWS = 500;

const listeners = new Set<() => void>();
const cache = new Map<number, Draft | null>();

function key(profileId: number): string {
  return `${DRAFT_STORAGE_PREFIX}${profileId}`;
}

function valid(raw: unknown): Draft | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<Draft>;
  if (typeof d.name !== 'string' || !Array.isArray(d.rows)) return null;
  return {
    name: d.name.slice(0, 200),
    kind: d.kind === 'famous' || d.kind === 'suggested' ? d.kind : 'hand',
    rows: d.rows.filter((r) => r && typeof r === 'object').slice(0, MAX_ROWS),
    source: d.source ?? null,
    source_id: d.source_id ?? null,
    source_url: d.source_url ?? null,
    source_meta: d.source_meta && typeof d.source_meta === 'object' ? d.source_meta : {},
    shape: typeof d.shape === 'string' ? d.shape : null,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
  };
}

export function readDraft(profileId: number): Draft | null {
  if (cache.has(profileId)) return cache.get(profileId) ?? null;
  let draft: Draft | null = null;
  try {
    const raw = window.localStorage.getItem(key(profileId));
    draft = raw ? valid(JSON.parse(raw)) : null;
  } catch {
    draft = null;
  }
  cache.set(profileId, draft);
  return draft;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function writeDraft(profileId: number, draft: Omit<Draft, 'updatedAt'>): void {
  const next = valid({ ...draft, updatedAt: Date.now() });
  cache.set(profileId, next);
  try {
    if (next) window.localStorage.setItem(key(profileId), JSON.stringify(next));
  } catch {
    /* private window or full: kept for this visit only */
  }
  emit();
}

export function clearDraft(profileId: number): void {
  cache.set(profileId, null);
  try {
    window.localStorage.removeItem(key(profileId));
  } catch {
    /* nothing kept */
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDraft(profileId: number): Draft | null {
  return useSyncExternalStore(
    subscribe,
    () => readDraft(profileId),
    () => null,
  );
}

/** Tests: forget what was read. */
export function resetDraftsForTests(): void {
  cache.clear();
  emit();
}
