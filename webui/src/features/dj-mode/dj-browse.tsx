/**
 * DJ mode's Browse (Brief F, 37f; 418): an 820px dialog over the stage,
 * opened by Browse… on empty B, the B key and "Browse another…". Tracks
 * that suit the playing one, closest first, from `GET /api/library/dj/browse`
 * (dj-browse.logic.ts), with the search, the chips, and per row the art,
 * title / artist · readiness, the key chip, the BPM and its step, the length
 * and **Load** (`store.loadB`). ↑↓ then Enter loads; Esc closes (the
 * overlay's Esc asks the store, which asks here first).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { KeyChip } from '@/features/dj/key-chip';
import { appURL } from '@/platform/url-base';

import type { DjModeStore } from './dj-mode-store';

import {
  browseQuery,
  closestFirst,
  countLine,
  DEFAULT_CHIPS,
  lengthWords,
  mixKeys,
  nearWords,
  readinessWords,
  rowAsLaneTrack,
  rowFromApi,
  stepWords,
  type BrowseChips,
  type BrowseRef,
  type BrowseRow,
} from './dj-browse.logic';
import styles from './dj-mixer.module.css';
import { useDjMode } from './dj-stage';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** How long typing settles before Browse asks (ms). */
export const SEARCH_DELAY_MS = 200;
/** How long the count waits before it's said, so a run of chips is said once (ms). */
export const SAY_DELAY_MS = 600;

export function DjBrowse({ store, fetchImpl }: { store: DjModeStore; fetchImpl?: FetchLike }) {
  const s = useDjMode(store);
  const [open, setOpen] = useState(false);
  const back = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const close = useCallback(() => {
    if (!openRef.current) return false;
    setOpen(false);
    const to = back.current;
    back.current = null;
    window.setTimeout(() => {
      // back where it was opened from, else lane B
      if (to && to.isConnected && to !== document.body && !to.closest('[hidden]')) to.focus();
      else document.querySelector<HTMLElement>('[data-dj-lane="b"]')?.focus();
    }, 0);
    return true;
  }, []);

  useEffect(() => {
    store.setBrowseOpener(() => {
      back.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    }, close);
    return () => store.setBrowseOpener(null);
  }, [store, close]);

  if (!open || !s.on) return null;
  const a = s.a;
  const ref: BrowseRef = {
    id: a?.track.id ?? null,
    title: a?.track.title ?? '',
    bpm: a?.info?.bpm ?? a?.grid?.bpm ?? null,
    key: a?.info?.key ?? null,
  };
  return (
    <BrowseDialog
      store={store}
      refTrack={ref}
      onClose={close}
      fetchImpl={fetchImpl ?? ((u, i) => window.fetch(u, i))}
    />
  );
}

function BrowseDialog({
  store,
  refTrack,
  onClose,
  fetchImpl,
}: {
  store: DjModeStore;
  refTrack: BrowseRef;
  onClose: () => boolean;
  fetchImpl: FetchLike;
}) {
  const [q, setQ] = useState('');
  const [chips, setChips] = useState<BrowseChips>({ ...DEFAULT_CHIPS });
  const [rows, setRows] = useState<BrowseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  /** the first answer is the opening's: only later ones (chips, search) are said */
  const asked = useRef(false);
  const sayTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(sayTimer.current), []);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const listId = useId();
  const hintId = useId();
  const query = useMemo(
    () => browseQuery(refTrack, chips, q).toString(),
    // the reference is the playing track's id, BPM and key
    [refTrack.id, refTrack.bpm, refTrack.key, chips, q], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    setState('loading');
    const timer = window.setTimeout(
      () => {
        fetchImpl(appURL(`/api/library/dj/browse?${query}`), { signal: ctl.signal })
          .then(async (res) => {
            if (!res.ok) throw new Error(String(res.status));
            const body = (await res.json()) as { tracks?: unknown[]; total?: number };
            if (ctl.signal.aborted) return;
            const list = (body.tracks ?? []).map((t) => rowFromApi(t as never));
            // the server orders them; the same order here keeps a stale cache honest
            // a starred track whose file has gone can't be loaded: never offered (review L3)
            const gone = list.filter((r) => r.fileMissing).length;
            setRows(
              closestFirst(refTrack, list).filter(
                (r) => r.id && r.id !== refTrack.id && !r.fileMissing,
              ),
            );
            const total = Math.max(0, (Number(body.total) || list.length) - gone);
            setTotal(total);
            // a change the person made (a chip, the search) is said once it lands, not on opening (review L7)
            if (asked.current) {
              const words = countLine(total, Boolean(q.trim()));
              window.clearTimeout(sayTimer.current);
              sayTimer.current = window.setTimeout(() => store.announce(words), SAY_DELAY_MS);
            }
            setActive(0);
            setState('ready');
          })
          .catch(() => {
            if (ctl.signal.aborted) return;
            setState('error');
            if (asked.current) store.announce('Couldn’t read your library: try again in a moment');
          });
      },
      q ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      ctl.abort();
      window.clearTimeout(timer);
    };
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = (row: BrowseRow | undefined) => {
    if (!row) return;
    if (store.loadB(rowAsLaneTrack(row))) onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      // the focus stays in the dialog
      // only what Tab really reaches (review M6)
      const items = dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"])',
      );
      if (!items || items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.target !== input.current) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(rows.length - 1, i + step)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      load(rows[active]);
    }
  };

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, listId]);

  const toggle = (k: keyof BrowseChips) => {
    asked.current = true;
    setChips((c) => ({ ...c, [k]: !c[k] }));
  };
  const aBpm = refTrack.bpm;
  const keys = mixKeys(refTrack.key);
  const activeId = rows[active] ? `${listId}-${active}` : undefined;

  return (
    <div className={styles.browseScrim} data-dj-browse="">
      <div
        ref={dialog}
        className={styles.browseDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-open=""
        onKeyDown={onKeyDown}
      >
        <div className={styles.browseHead}>
          <div>
            <h2 id={titleId} className={styles.browseTitle}>
              Browse for the second track
            </h2>
            <p className={styles.browseSub}>
              Tracks that suit {refTrack.title || 'the playing track'}
              {refTrack.key ? ` · ${refTrack.key}` : ''}
              {aBpm ? ` · ${aBpm.toFixed(1)} BPM` : ''}
            </p>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Close Browse"
            onClick={() => onClose()}
          >
            ×
          </button>
        </div>
        <label className={styles.search}>
          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.searchIcon}>
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            type="search"
            value={q}
            placeholder="Search your tracks…"
            aria-label="Search your tracks"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-describedby={hintId}
            autoComplete="off"
            onChange={(e) => {
              asked.current = true;
              setQ(e.target.value);
            }}
          />
          <span id={hintId} className={styles.searchHint}>
            type to search; ↑↓ then Enter loads
          </span>
        </label>
        <div className={styles.chips} role="group" aria-label="Filters">
          {aBpm ? (
            <button
              type="button"
              className={styles.chip}
              aria-pressed={chips.near}
              onClick={() => toggle('near')}
            >
              Near {Math.round(aBpm)} BPM <span className={styles.chipNote}>{nearWords(aBpm)}</span>
            </button>
          ) : null}
          {keys.length ? (
            <button
              type="button"
              className={styles.chip}
              aria-pressed={chips.keys}
              onClick={() => toggle('keys')}
            >
              Keys that mix with {keys[0]}{' '}
              <span className={styles.chipNote}>{keys.join(' · ')}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={styles.chip}
            aria-pressed={chips.starred}
            onClick={() => toggle('starred')}
          >
            Starred
          </button>
          <button
            type="button"
            className={styles.chip}
            aria-pressed={chips.recent}
            onClick={() => toggle('recent')}
          >
            Recently played
          </button>
          <span className={styles.sort}>
            Sort <strong>Closest first</strong>
          </span>
        </div>
        <p className={styles.count} data-dj-browse-count="">
          {state === 'loading' && !rows.length
            ? 'Looking…'
            : state === 'error'
              ? 'Couldn’t read your library: try again in a moment'
              : countLine(total, Boolean(q.trim()))}
        </p>
        <div className={styles.table}>
          <div className={styles.thead} aria-hidden="true">
            <span />
            <span>Track</span>
            <span>Key</span>
            <span>BPM · step</span>
            <span className={styles.right}>Length</span>
            <span />
          </div>
          <ul id={listId} className={styles.rows} role="listbox" aria-label="Tracks that suit">
            {rows.map((row, i) => {
              const step = stepWords(refTrack, row);
              return (
                <li
                  key={row.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={styles.row}
                  data-active={i === active ? '' : undefined}
                  aria-label={`${row.title}${row.artist ? `, ${row.artist}` : ''}${step ? `, ${step}` : ''}: Enter loads it as B`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => load(row)}
                >
                  {row.image ? (
                    <img className={styles.rowArt} src={row.image} alt="" />
                  ) : (
                    <span className={styles.rowArt} aria-hidden="true" />
                  )}
                  <span className={styles.rowWho}>
                    <span className={styles.rowTitle}>{row.title}</span>
                    <span className={styles.rowArtist}>
                      <span
                        className={styles.readyDot}
                        data-ready={row.gridReady ? '' : undefined}
                        aria-hidden="true"
                      />
                      {row.artist ? `${row.artist} · ` : ''}
                      {readinessWords(row, refTrack)}
                    </span>
                  </span>
                  <span>
                    {row.key ? <KeyChip code={row.key} uncertain={row.keyUncertain} /> : '–'}
                  </span>
                  <span className={styles.rowBpm}>
                    <span className={styles.mono}>{row.bpm ? row.bpm.toFixed(1) : '–'}</span>
                    {step ? <span className={styles.step}> {step}</span> : null}
                  </span>
                  <span className={`${styles.mono} ${styles.right}`}>
                    {lengthWords(row.durationS)}
                  </span>
                  {/* an option holds no button (review L7): the row is the Load */}
                  <span
                    className={styles.load}
                    data-primary={i === active ? '' : undefined}
                    data-dj-load=""
                    aria-hidden="true"
                  >
                    Load
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <p className={styles.browseFoot}>
          A track without its grid loads and is analysed in the lane. Half and double time count as
          near. Energy isn’t used.
        </p>
      </div>
    </div>
  );
}
