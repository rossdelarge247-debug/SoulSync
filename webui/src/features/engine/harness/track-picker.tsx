/**
 * The lab's track picker, one per deck (Ross, 27 October: two search boxes
 * side by side were hard to use, and nobody knows a library by heart).
 * Each deck picks from:
 *
 * - **Playing & Up next**: the player's queue from the playing track on;
 * - **Recent**: Listening history's last plays of your library tracks;
 * - **Starred**: your starred tracks;
 * - **Sets & playlists**: one of your sets or playlists, then its rows
 *   (a playlist's rows matched to your library by title and artist, as the
 *   stars match them);
 * - **Mixes well with** (the incoming deck): the outgoing track's matches in
 *   the Mix tab's order, with their reasons;
 * - **Search**, as a fallback.
 *
 * Every row says its BPM, key and analysis state; a track in line or being
 * analysed shows the shared indicator. Picking an unanalysed track asks for
 * it at once (analyse on demand, the lab's own hook). Plain fetches, no
 * query cache: the lab is a bench and opens on its own.
 */
import { useEffect, useId, useMemo, useState } from 'react';

import type { DjInfo, DjTrack } from '@/features/dj/dj.api';

import { apiClient, readJson } from '@/app/api-client';
import { AnalysisLine, useAnalysis } from '@/features/dj/analysis-line';
import { bpmNumber } from '@/features/dj/dj.format';

import styles from './automix-lab.module.css';

export type PickSource = 'queue' | 'recent' | 'starred' | 'lists' | 'mixes' | 'search';

export const SOURCE_LABELS: Record<PickSource, string> = {
  queue: 'Playing & Up next',
  recent: 'Recent',
  starred: 'Starred',
  lists: 'Sets & playlists',
  mixes: 'Mixes well with',
  search: 'Search',
};

/** One row a source offers: a library track, maybe with its DJ data and why. */
export interface PickRow {
  id: string;
  title: string;
  artist: string;
  dj?: DjInfo | null;
  /** Mixes well with's reason, or "Playing" / "Up next" */
  note?: string | null;
}

interface QueueRow {
  id?: string | number | null;
  title?: string | null;
  artist?: string | null;
  file_path?: string | null;
  is_library?: boolean;
}

interface PlayerLike {
  state?: () => { queue?: QueueRow[]; index?: number; track?: QueueRow | null } | null;
}

const LIMIT = 30;

/** The player's queue from the playing track on (library tracks with a file). */
export function queueRows(): PickRow[] {
  const st = (window as unknown as { SoulSyncPlayer?: PlayerLike }).SoulSyncPlayer?.state?.();
  if (!st) return [];
  const queue = st.queue ?? [];
  const from = Math.max(0, st.index ?? 0);
  const rows: PickRow[] = [];
  queue.slice(from, from + LIMIT).forEach((t, i) => {
    if (!t || t.id == null || t.id === '' || !t.file_path || t.is_library === false) return;
    rows.push({
      id: String(t.id),
      title: String(t.title ?? ''),
      artist: String(t.artist ?? ''),
      note: i === 0 && st.index != null && st.index >= 0 ? 'Playing' : 'Up next',
    });
  });
  return rows;
}

async function recentRows(): Promise<PickRow[]> {
  const page = await readJson<{
    items?: { track_id: string | null; title: string; artist: string; in_library?: boolean }[];
  }>(
    apiClient.get('library/listening-history', {
      searchParams: { range: '30d', offset: 0, limit: 50, tz: new Date().getTimezoneOffset() },
    }),
  );
  const seen = new Set<string>();
  const rows: PickRow[] = [];
  for (const p of page.items ?? []) {
    if (!p.track_id || seen.has(String(p.track_id))) continue;
    seen.add(String(p.track_id));
    rows.push({ id: String(p.track_id), title: p.title, artist: p.artist });
    if (rows.length >= LIMIT) break;
  }
  return rows;
}

function fromDj(t: DjTrack, note: string | null = null): PickRow {
  return { id: String(t.id), title: t.title, artist: t.artist_name, dj: t.dj, note };
}

async function browseRows(searchParams: Record<string, string | number>): Promise<PickRow[]> {
  const page = await readJson<{ tracks?: DjTrack[] }>(
    apiClient.get('library/dj/browse', { searchParams: { limit: LIMIT, ...searchParams } }),
  );
  return (page.tracks ?? []).filter((t) => !t.file_missing).map((t) => fromDj(t));
}

async function mixesRows(outId: string): Promise<PickRow[]> {
  const page = await readJson<{
    matches?: (DjTrack & { reason?: string | null })[];
    reason?: string | null;
  }>(
    apiClient.get(`library/dj/mixes/${encodeURIComponent(outId)}`, {
      searchParams: { rank: 'mix', limit: 20 },
    }),
  );
  return (page.matches ?? []).map((m) => fromDj(m, m.reason ?? null));
}

interface ListChoice {
  key: string;
  label: string;
}

async function listChoices(): Promise<ListChoice[]> {
  const [sets, playlists] = await Promise.all([
    readJson<{ sets?: { id: number; name: string }[] }>(apiClient.get('sets'))
      .then((p) => p.sets ?? [])
      .catch(() => []),
    readJson<unknown>(apiClient.get('mirrored-playlists'))
      .then(
        (rows) =>
          (Array.isArray(rows) ? rows : []) as {
            id: number;
            name?: string;
            display_name?: string;
          }[],
      )
      .catch(() => []),
  ]);
  return [
    ...sets.map((s) => ({ key: `set:${s.id}`, label: `Set: ${s.name}` })),
    ...playlists.map((p) => ({
      key: `playlist:${p.id}`,
      label: `Playlist: ${p.display_name || p.name || p.id}`,
    })),
  ];
}

async function listRows(key: string): Promise<PickRow[]> {
  const [kind, raw] = key.split(':');
  const id = Number(raw);
  if (!Number.isFinite(id)) return [];
  if (kind === 'set') {
    const view = await readJson<{ rows?: { track: DjTrack | null }[] }>(
      apiClient.get(`sets/${id}`),
    );
    return (view.rows ?? []).flatMap((r) => (r.track ? [fromDj(r.track)] : []));
  }
  const detail = await readJson<{ tracks?: { track_name?: string; artist_name?: string }[] }>(
    apiClient.get(`mirrored-playlists/${id}`),
  );
  const songs = (detail.tracks ?? [])
    .slice(0, 200)
    .map((t) => ({ title: t.track_name ?? '', artist: t.artist_name ?? '' }));
  if (!songs.length) return [];
  // matched to your library by title and artist (the stars' own rule)
  const found = await readJson<{ songs?: { track_id: string | null }[] }>(
    apiClient.post('stars/status', { json: { songs } }),
  );
  const rows: PickRow[] = [];
  const seen = new Set<string>();
  (found.songs ?? []).forEach((s, i) => {
    if (!s.track_id || seen.has(String(s.track_id))) return;
    seen.add(String(s.track_id));
    rows.push({
      id: String(s.track_id),
      title: songs[i]?.title ?? '',
      artist: songs[i]?.artist ?? '',
    });
  });
  return rows;
}

/** The rows' DJ data where a source didn't bring it (queue, recent, playlists). */
function useDjFor(rows: PickRow[]): Record<string, DjInfo> {
  const missing = rows.filter((r) => r.dj === undefined).map((r) => r.id);
  const key = [...new Set(missing)].sort().join(',');
  const [found, setFound] = useState<Record<string, DjInfo>>({});
  useEffect(() => {
    if (!key) return;
    let live = true;
    readJson<{ tracks?: Record<string, DjInfo> }>(
      apiClient.post('library/dj/tracks', { json: { track_ids: key.split(',') } }),
    )
      .then((p) => live && setFound((was) => ({ ...was, ...p.tracks })))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);
  return found;
}

function djWords(dj: DjInfo | null | undefined): string {
  const bpm = dj?.bpm ? `${bpmNumber(dj.bpm)} BPM` : '— BPM';
  const key = dj?.key ? `${dj.key}${dj.key_uncertain ? '?' : ''}` : '—';
  return `${bpm} · ${key}`;
}

/** The pick as the lab keeps it (a library track with what's known of it). */
export function pickedTrack(row: PickRow, dj: DjInfo | null | undefined): DjTrack {
  return {
    id: row.id,
    title: row.title,
    artist_name: row.artist,
    album_title: '',
    artist_id: null,
    album_id: null,
    duration_ms: null,
    file_path: null,
    bitrate: null,
    image_url: null,
    dj: dj ?? null,
  };
}

export function TrackPicker({
  label,
  deck,
  chosen,
  onPick,
  outgoing = null,
}: {
  label: string;
  deck: 'out' | 'in';
  chosen: DjTrack | null;
  onPick: (t: DjTrack) => void;
  /** the outgoing deck's track, for Mixes well with (the incoming deck) */
  outgoing?: DjTrack | null;
}) {
  const id = useId();
  const sources: PickSource[] =
    deck === 'in'
      ? ['mixes', 'queue', 'recent', 'starred', 'lists', 'search']
      : ['queue', 'recent', 'starred', 'lists', 'search'];
  const [source, setSource] = useState<PickSource>(deck === 'in' && outgoing ? 'mixes' : 'queue');
  const [rows, setRows] = useState<PickRow[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [q, setQ] = useState('');
  const [lists, setLists] = useState<ListChoice[] | null>(null);
  const [list, setList] = useState('');
  const outId = outgoing?.id ?? null;

  useEffect(() => {
    let live = true;
    const load = (p: Promise<PickRow[]>) => {
      setState('loading');
      p.then((r) => {
        if (!live) return;
        setRows(r);
        setState('idle');
      }).catch(() => {
        if (!live) return;
        setRows([]);
        setState('error');
      });
    };
    if (source === 'queue') {
      setRows(queueRows());
      setState('idle');
    } else if (source === 'recent') load(recentRows());
    else if (source === 'starred') load(browseRows({ starred: 1, sort: 'recent' }));
    else if (source === 'mixes') {
      if (outId) load(mixesRows(outId));
      else setRows([]);
    } else if (source === 'lists') {
      if (lists === null)
        listChoices()
          .then((l) => live && setLists(l))
          .catch(() => live && setLists([]));
      if (list) load(listRows(list));
      else setRows([]);
    } else if (source === 'search') {
      if (q.trim().length < 2) {
        setRows([]);
        return;
      }
      const timer = setTimeout(() => load(browseRows({ q: q.trim(), sort: 'title' })), 250);
      return () => {
        live = false;
        clearTimeout(timer);
      };
    }
    return () => {
      live = false;
    };
  }, [source, outId, list, q, lists]);

  const dj = useDjFor(rows);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const progress = useAnalysis(chosen ? [...ids, chosen.id] : ids);
  const djOf = (r: PickRow) => (r.dj !== undefined ? r.dj : (dj[r.id] ?? null));
  const chosenEntry = chosen ? progress[chosen.id] : null;

  return (
    <fieldset className={styles.pick} data-deck={deck}>
      <legend>{label}</legend>
      <p className={styles.chosen}>
        {chosen ? `${chosen.title} · ${chosen.artist_name} · ${djWords(chosen.dj)}` : 'None yet'}
      </p>
      {chosen ? (
        <AnalysisLine
          size="line"
          entry={chosenEntry}
          title={chosen.title}
          trackId={chosen.id}
          className={styles.chosenLine}
        />
      ) : null}
      <div
        className={styles.sources}
        role="radiogroup"
        aria-label={`Pick the ${label.toLowerCase()} from`}
      >
        {sources.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={source === s}
            className={styles.source}
            disabled={s === 'mixes' && !outgoing}
            title={s === 'mixes' && !outgoing ? 'Pick the outgoing track first' : undefined}
            onClick={() => setSource(s)}
          >
            {SOURCE_LABELS[s]}
          </button>
        ))}
      </div>
      {source === 'search' ? (
        <input
          className={styles.input}
          aria-label={`Find the ${label.toLowerCase()}`}
          placeholder="Title or artist in your library"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      ) : null}
      {source === 'lists' ? (
        <select
          aria-label={`A set or playlist for the ${label.toLowerCase()}`}
          value={list}
          onChange={(e) => setList(e.target.value)}
        >
          <option value="">
            {lists === null ? 'Loading…' : lists.length ? 'Choose one…' : 'None yet'}
          </option>
          {(lists ?? []).map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </select>
      ) : null}
      {source === 'mixes' && outgoing ? (
        <p className={styles.meta}>Mixes well with {outgoing.title}, in the Mix tab&apos;s order</p>
      ) : null}
      {state === 'loading' ? <p className={styles.meta}>Loading…</p> : null}
      {state === 'error' ? (
        <p className={styles.error}>Couldn&apos;t read these just now.</p>
      ) : null}
      {state === 'idle' && !rows.length ? (
        <p className={styles.meta} id={`${id}-empty`}>
          {source === 'queue'
            ? 'Nothing playing or up next from your library.'
            : source === 'search'
              ? 'Type two letters or more.'
              : source === 'lists' && !list
                ? 'Choose a set or a playlist.'
                : 'Nothing here.'}
        </p>
      ) : null}
      <ul
        className={styles.results}
        aria-label={`${SOURCE_LABELS[source]} for the ${label.toLowerCase()}`}
      >
        {rows.map((r) => {
          const info = djOf(r);
          const entry = progress[r.id];
          return (
            <li key={`${source}-${r.id}`} className={styles.pickRow} data-pick-row={r.id}>
              <button
                type="button"
                className={styles.result}
                aria-label={`Pick ${r.title}`}
                onClick={() => onPick(pickedTrack(r, info))}
              >
                <span className={styles.pickTitle}>
                  {r.title} · {r.artist || 'Unknown artist'}
                </span>
                <span className={styles.pickMeta}>
                  {djWords(info)}
                  {r.note ? ` · ${r.note}` : ''}
                </span>
              </button>
              {/* each row's marker says why a plan would wait (31c) */}
              <AnalysisLine
                size="marker"
                entry={entry}
                showReady
                trackId={r.id}
                moveUp
                className={styles.pickMarker}
              />
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
