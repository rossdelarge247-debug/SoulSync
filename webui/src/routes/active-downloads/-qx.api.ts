/**
 * Quarantine explained (api/quarantine_explained.py): the quarantine grouped
 * by what to do, one song's tries, the bulk actions and the AcoustID re-check.
 * Admin only on the server: a 403 means "show the plain list instead".
 */
import { HTTPError } from 'ky';

import { apiClient, readJson } from '@/app/api-client';

import type { AdlQuarantineEntry, QxKind } from './-adl.types';

export interface QxGroup {
  kind: QxKind;
  files: number;
  songs: number;
  example: { title: string; length: string; spotify_length: string; size_bytes: number } | null;
}

export interface QxRecheck {
  status: 'idle' | 'running' | 'paused' | 'cancelled' | 'done' | 'key_refused' | 'interrupted';
  total: number;
  done: number;
  confirmed: number;
  different: number;
  no_match: number;
  errors: number;
  key_refused: boolean;
  active: boolean;
  /** held files AcoustID hasn't answered for yet (overview only) */
  pending?: number;
}

export interface QxAcoustid {
  available: boolean;
  reason: string;
  refused: boolean;
  working: boolean;
  settings_url: string;
}

export interface QxKeepBest {
  status: 'idle' | 'running' | 'done' | 'cancelled';
  songs?: number;
  done?: number;
  kept?: number;
  deleted?: number;
  skipped?: number;
  errors?: number;
}

export interface QxOverview {
  ready: boolean;
  files?: number;
  songs?: number;
  groups?: QxGroup[];
  acoustid?: QxAcoustid;
  recheck?: QxRecheck;
  keep_best?: QxKeepBest;
}

export interface QxSong {
  key: string;
  title: string;
  artist: string;
  best: string | null;
  summary: string;
  tries: AdlQuarantineEntry[];
  kinds: QxKind[];
}

export interface QxSongsPage {
  ready: boolean;
  kind?: QxKind | null;
  total?: number;
  offset?: number;
  songs?: QxSong[];
}

export type QxBulkAction = 'delete' | 'keep_best';

export interface QxPlan {
  plan_id: string | null;
  action: QxBulkAction;
  kind: QxKind;
  songs: number;
  files?: number;
  keep?: number;
  delete?: number;
  bytes: number;
  ready?: boolean;
}

/** Not allowed here (a profile that isn't an admin): use the plain list. */
export class QxForbidden extends Error {}

async function read<T>(promise: ReturnType<typeof apiClient.get>): Promise<T> {
  try {
    return await readJson<T>(promise);
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 403) throw new QxForbidden();
    throw error;
  }
}

export function fetchQxOverview(): Promise<QxOverview> {
  return read<QxOverview>(apiClient.get('quarantine/explained/overview', { timeout: 30_000 }));
}

export function fetchQxSongs(kind: QxKind, offset = 0, limit = 25): Promise<QxSongsPage> {
  return read<QxSongsPage>(
    apiClient.get('quarantine/explained/songs', {
      timeout: 30_000,
      searchParams: { kind, offset, limit },
    }),
  );
}

export function fetchQxSong(entryId: string): Promise<{ song: QxSong | null }> {
  return read<{ song: QxSong | null }>(
    apiClient.get('quarantine/explained/song', {
      timeout: 60_000,
      searchParams: { entry: entryId },
    }),
  );
}

export function previewQxBulk(kind: QxKind, action: QxBulkAction): Promise<QxPlan> {
  return read<QxPlan>(
    apiClient.post('quarantine/explained/bulk/preview', { json: { kind, action } }),
  );
}

export function confirmQxBulk(
  planId: string,
  action: QxBulkAction,
): Promise<{ success: boolean; files_removed?: number; songs?: number; error?: string }> {
  return read(
    apiClient.post('quarantine/explained/bulk/confirm', { json: { plan_id: planId, action } }),
  );
}

export function cancelQxKeepBest(): Promise<{ success: boolean }> {
  return read(apiClient.post('quarantine/explained/bulk/cancel'));
}

export function qxRecheck(
  action: 'start' | 'pause' | 'resume' | 'cancel',
): Promise<{ success: boolean; recheck?: QxRecheck; error?: string }> {
  return read(apiClient.post('quarantine/explained/recheck', { json: { action } }));
}
