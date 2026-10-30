/**
 * Where Data's readout comes from (30i). A library track: the player's own
 * read, `GET /api/library/tracks/<id>/details` (format, sample rate, bit
 * depth, channels, bitrate, bitrate on disk; read from the file once and kept
 * on the track, scoped to the caller's library). A radio station: its
 * stream's codec and bitrate. Anything else (a stream from a search): the
 * file name's extension, and the rest unknown.
 */

import type { FetchLike } from './visuals-api';

import { EMPTY_INFO, type DataInfo } from './data-viz';

const LOSSY = new Set(['MP3', 'AAC', 'OGG', 'Opus', 'WMA']);
const EXT: Record<string, string> = {
  flac: 'FLAC',
  mp3: 'MP3',
  m4a: 'AAC',
  aac: 'AAC',
  ogg: 'OGG',
  opus: 'Opus',
  wav: 'WAV',
  aif: 'AIFF',
  aiff: 'AIFF',
  wma: 'WMA',
};

interface PlayerTrack {
  id?: string | number | null;
  kind?: string | null;
  is_library?: boolean;
  filename?: string | null;
  file_path?: string | null;
  format?: string | null;
  bitrate?: number | null;
  sample_rate?: number | null;
}

interface Hooks {
  SoulSyncPlayer?: { state?: () => { track?: PlayerTrack | null; kind?: string | null } };
  SoulSyncRadio?: {
    state(): {
      station?: { name?: string } | null;
      stream?: { codec?: string; bitrate_kbps?: number; lossless?: boolean } | null;
    };
  };
}

/** What identifies the playing thing, so the readout is read once per track. */
export function infoKey(win: Window): string {
  const w = win as Window & Hooks;
  try {
    const st = w.SoulSyncPlayer?.state?.();
    const t = st?.track;
    if (!t) return '';
    if (st?.kind === 'radio') {
      const r = w.SoulSyncRadio?.state();
      return `radio:${r?.station?.name ?? ''}:${r?.stream?.codec ?? ''}`;
    }
    return `${st?.kind ?? ''}:${String(t.id ?? '')}:${t.filename ?? t.file_path ?? ''}`;
  } catch {
    return '';
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function loadDataInfo(win: Window, fetcher?: FetchLike): Promise<DataInfo> {
  const w = win as Window & Hooks;
  let st: ReturnType<NonNullable<NonNullable<Hooks['SoulSyncPlayer']>['state']>> | undefined;
  try {
    st = w.SoulSyncPlayer?.state?.();
  } catch {
    st = undefined;
  }
  const t = st?.track;
  if (!t) return EMPTY_INFO;
  const kind = st?.kind ?? (t.is_library ? 'library' : 'stream');
  if (kind === 'radio') {
    let r: ReturnType<NonNullable<Hooks['SoulSyncRadio']>['state']> | undefined;
    try {
      r = w.SoulSyncRadio?.state();
    } catch {
      r = undefined;
    }
    return {
      ...EMPTY_INFO,
      format: r?.stream?.codec || 'Stream',
      bitrateKbps: num(r?.stream?.bitrate_kbps),
      station: r?.station?.name || 'the station',
      lossless: Boolean(r?.stream?.lossless),
    };
  }
  const ext = String(t.filename || t.file_path || '')
    .split('.')
    .pop()
    ?.toLowerCase();
  const guess: DataInfo = {
    ...EMPTY_INFO,
    format: (ext && EXT[ext]) || t.format || null,
    fileRate: num(t.sample_rate),
    bitrateKbps: num(t.bitrate),
  };
  guess.lossless = Boolean(guess.format && !LOSSY.has(guess.format));
  if (kind !== 'library' || t.id === undefined || t.id === null || t.id === '') return guess;
  const f = fetcher ?? ((u: string) => win.fetch(u));
  try {
    const res = await f(`/api/library/tracks/${encodeURIComponent(String(t.id))}/details`);
    if (!res.ok) return guess;
    const d = (await res.json()) as Record<string, unknown>;
    const format = typeof d.format === 'string' && d.format ? d.format : guess.format;
    const depth = num(d.bit_depth);
    return {
      format,
      fileRate: num(d.sample_rate) ?? guess.fileRate,
      bitDepth: depth,
      channels: num(d.channels),
      bitrateKbps: num(d.bitrate_kbps) ?? guess.bitrateKbps,
      onDiskKbps: num(d.on_disk_kbps),
      station: null,
      lossless: Boolean(depth && format && !LOSSY.has(format)),
    };
  } catch {
    return guess;
  }
}
