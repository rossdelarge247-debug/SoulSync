/**
 * What the engine asks the server for: a pair's plan and the two grids
 * (auto-mix stage A's routes), and each deck's window of audio
 * (`GET /api/library/dj/window/<id>`, stage B; CONTRACTS "Auto-mix stage B").
 */

import { apiClient, readJson } from '@/app/api-client';
import { appURL } from '@/platform/url-base';

import type { PlanLike } from './executor';
import type { ApiGrid } from './grid';

import { prepareDeck, type DeckData } from './engine';

export interface Plan extends PlanLike {
  requested?: string;
  chosen_by?: string;
  pair?: string;
  note?: string | null;
  confidence?: number;
  styles?: { style: string; label: string; available: boolean; why: string | null }[];
  waiting_for?: string;
  reason?: string;
}

/** The server's window cap (core/dj/window.py MAX_SECONDS). */
export const MAX_WINDOW_S = 180;

export async function fetchPlan(
  from: string,
  to: string,
  style = 'auto',
  bars?: number,
): Promise<Plan> {
  const searchParams: Record<string, string> = { from, to, style };
  if (bars) searchParams.bars = String(bars);
  return (await readJson<{ plan: Plan }>(apiClient.get('library/dj/plan', { searchParams }))).plan;
}

export async function fetchGrids(ids: string[]): Promise<Record<string, ApiGrid>> {
  const body = await readJson<{ grids: Record<string, ApiGrid> }>(
    apiClient.post('library/dj/grids', { json: { track_ids: ids, beats: true } }),
  );
  return body.grids;
}

/** The URL of a track's window. */
export function windowUrl(trackId: string, start: number, dur: number, rate: number): string {
  const q = new URLSearchParams({
    start: Math.max(0, start).toFixed(3),
    dur: Math.min(MAX_WINDOW_S, Math.max(0.5, dur)).toFixed(3),
    rate: rate === 44100 ? '44100' : '48000',
  });
  return appURL(`/api/library/dj/window/${encodeURIComponent(trackId)}?${q.toString()}`);
}

/**
 * Fetch and decode a window. The browser decodes at the context's rate, so
 * the server is asked for that rate where it can (44.1 or 48 kHz).
 * Retries once on 429 (two windows decoding already).
 */
export async function fetchWindow(
  ctx: BaseAudioContext,
  trackId: string,
  start: number,
  dur: number,
  fetchImpl: typeof fetch = fetch,
): Promise<DeckData> {
  const s = Math.max(0, start);
  const url = windowUrl(trackId, s, dur, ctx.sampleRate);
  let res = await fetchImpl(url, { credentials: 'same-origin' });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await fetchImpl(url, { credentials: 'same-origin' });
  }
  if (!res.ok) {
    let words = `couldn't load the audio (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) words = body.error;
    } catch {
      /* not JSON */
    }
    throw new Error(words);
  }
  const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
  const offset = Number(res.headers.get('X-Window-Start') ?? s);
  return prepareDeck(buffer, Number.isFinite(offset) ? offset : s);
}
