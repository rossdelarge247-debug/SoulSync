/**
 * Brief B's host (32a–32g), rendered once by the router's root: the ghost,
 * the insertion line, the amber notes, auto-scroll's cue, the player bar's
 * "Up next · drop to play next" while something is lifted, the sidebar's
 * Your sets unfolded under its Sets row during a drag, the phone's Send to…
 * tray (during a long-press drag, and from the sheet's Send to…), ⌘Z for
 * the last drop while its toast shows, and Up next's own binding. It also
 * keeps Send to…'s words fresh (the working set, where a track would go).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { apiClient } from '@/app/api-client';
import { usePlayingTrack } from '@/features/dj/playing-track';
import { playingRowIndex, rowNumbers } from '@/features/mix/mix-model';
import { useQueueFrom } from '@/features/mix/mix-subject';
import { useWorkingSet } from '@/features/mix/mix.api';
import {
  fetchHolding,
  setQueryOptions,
  setsListQueryOptions,
  type SetListItem,
} from '@/features/sets/sets.api';
import { useProfile } from '@/platform/shell/route-controllers';

import {
  getTarget,
  refreshOver,
  showDropResult,
  undoLast,
  useDndSelect,
  useDropTarget,
  type Drag,
} from './dnd-engine';
import { REASONS, ghostWords, textOf } from './dnd-model';
import styles from './dnd.module.css';
import { moveRefusal, player, sendToUpNext, sendToWorkingSet, setSendToContext } from './send-to';
import { SendToTray, sendToAnotherSet, trayTargets, type TrayTargetView } from './send-to-ui';
import { setHoldings, setTarget } from './set-targets';
import { bindUpNext, mixing } from './up-next-dnd';

declare global {
  interface Window {
    /** the legacy player's way to Brief B's toast and Undo (the Move mode, 32f) */
    SoulSyncDnd?: { showDropResult: typeof showDropResult };
  }
}

const PHONE = '(max-width: 640px)';

function useMedia(query: string): boolean {
  const [on, setOn] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const change = () => setOn(list.matches);
    change();
    list.addEventListener?.('change', change);
    return () => list.removeEventListener?.('change', change);
  }, [query]);
  return on;
}

function SideSet({ set }: { set: SetListItem }) {
  const ref = useRef<HTMLLIElement>(null);
  const overState = useDndSelect((s) => s.over);
  const id = `side-set:${set.id}`;
  useDropTarget(id, () => setTarget(id, set, () => ref.current));
  const over = overState?.id === id ? overState : null;
  const sub = over
    ? over.verdict.ok
      ? (over.hint ?? 'drop to add · goes last')
      : (over.verdict.reason ?? '')
    : set.kind === 'famous'
      ? "famous mix · can't edit"
      : `${set.tracks} ${set.tracks === 1 ? 'track' : 'tracks'}`;
  return (
    <li ref={ref} className={styles.sideSet} data-dnd-target={id}>
      <span className={styles.sideSetName}>{set.name}</span>
      <span className={styles.sideSetSub}>{sub}</span>
    </li>
  );
}

/** 32a: the sidebar's Your sets, unfolded under its Sets row while something is lifted. */
function SidebarSets({ profileId, workingId }: { profileId: number; workingId: number | null }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const list = useQuery({ ...setsListQueryOptions(profileId), staleTime: 30_000, retry: false });
  useEffect(() => {
    const row = document.querySelector<HTMLElement>('a[data-nav-row="sets"]');
    // a collapsed sidebar has no room for them
    if (!row || row.getBoundingClientRect().width < 140) return;
    const box = document.createElement('div');
    box.setAttribute('data-dnd-side-sets', '');
    row.after(box);
    setHost(box);
    return () => {
      box.remove();
      setHost(null);
    };
  }, []);
  if (!host || !list.data?.length) return null;
  const sets = [...list.data]
    .sort((a, b) =>
      a.id === workingId ? -1 : b.id === workingId ? 1 : (b.updated_at ?? 0) - (a.updated_at ?? 0),
    )
    .slice(0, 8);
  return createPortal(
    <>
      <p className={styles.sideSetsLabel}>Your sets</p>
      <ul className={styles.sideSets} aria-label="Your sets: drop to add">
        {sets.map((s) => (
          <SideSet key={s.id} set={s} />
        ))}
      </ul>
    </>,
    host,
  );
}

/* ── the player bar's zone (32a: "Up next · drop to play next") ──────── */

function BarZones() {
  const [box, setBox] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = document.getElementById('ss-player-bar');
    const player2 = document.getElementById('media-player');
    if (!bar || !player2 || player2.classList.contains('idle')) return;
    const r = bar.getBoundingClientRect();
    if (r.height > 0) setBox(r);
  }, []);
  useDropTarget(box ? 'bar-upnext' : null, () => ({
    id: 'bar-upnext',
    kind: 'upnext',
    listId: 'bar-upnext',
    name: 'Up next',
    el: () => ref.current,
    accepts: (drag: Drag) => {
      if (!drag.items.every((t) => t.queue)) return { ok: false, reason: REASONS.notInLibrary };
      const st = player()?.state();
      if (st && st.index >= 0 && mixing()) return { ok: false, reason: REASONS.incoming };
      return { ok: true };
    },
    hint: () => 'drop to play next',
    drop: async (drag: Drag) => {
      const p = player();
      // an Up next row itself: it moves to the top
      if (drag.source.kind === 'upnext' && p?.moveTrack) {
        const st = p.state();
        if (st.index >= 0 && mixing()) throw new Error(REASONS.incoming);
        // the row itself (H1): the queue may have moved on since the lift
        const row = drag.items[0]?.queue ?? st.queue[drag.source.indexes[0]];
        const from = row ? st.queue.indexOf(row) : -1;
        if (!row || from < 0) return null;
        const at = p.moveTrack(row, st.index + 1);
        const why = moveRefusal(at);
        if (why) throw new Error(why);
        return {
          words: `Playing next: ${drag.items[0]?.title || 'the track'}`,
          undo: () => {
            const why2 = moveRefusal(p.moveTrack?.(row, from) ?? -1, true);
            if (why2) throw new Error(why2);
          },
        };
      }
      return sendToUpNext(drag.items, 'next');
    },
  }));
  if (!box) return null;
  return (
    <div
      className={styles.barZones}
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    >
      <div ref={ref} className={styles.barZone} data-dnd-target="bar-upnext">
        Up next · drop to play next
      </div>
      {/* "DJ now · drop to cue" joins here with step 5 (dnd-engine's DJ_TARGET_READY) */}
    </div>
  );
}

/* ── the phone's tray during a long-press drag (32e) ──────────────────── */

function TrayTarget({ view, first }: { view: TrayTargetView; first: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const id = `tray:${view.key}`;
  useDropTarget(view.disabled ? null : id, () => ({
    id,
    kind: view.key === 'upnext' ? 'upnext' : view.key === 'working' ? 'working' : 'other',
    listId: id,
    name: view.name,
    el: () => ref.current,
    accepts: (drag: Drag) =>
      view.key === 'upnext' && !drag.items.every((t) => t.queue)
        ? { ok: false, reason: REASONS.notInLibrary }
        : { ok: true },
    hint: () => view.sub,
    drop: async (drag: Drag) => {
      if (view.key === 'working') return sendToWorkingSet(drag.items);
      if (view.key === 'upnext') return sendToUpNext(drag.items, 'next');
      sendToAnotherSet(drag.items);
      return null;
    },
  }));
  return (
    <li>
      <button
        ref={ref}
        type="button"
        className={styles.trayTarget}
        data-first={first ? '' : undefined}
        aria-disabled={view.disabled ? 'true' : undefined}
        tabIndex={-1}
      >
        <span className={styles.trayName}>{view.name}</span>
        <span className={styles.traySub}>{view.sub}</span>
      </button>
    </li>
  );
}

function DragTray() {
  return (
    <div className={styles.tray} data-dnd-drag-tray="">
      <p className={styles.trayHead}>
        <span>Send to…</span>
      </p>
      <ul className={styles.trayGrid}>
        {trayTargets().map((t, i) => (
          <TrayTarget key={t.key} view={t} first={i === 0} />
        ))}
      </ul>
      <p className={styles.trayFoot}>Let go anywhere else to cancel</p>
    </div>
  );
}

/* ── Send to…'s words, kept fresh ─────────────────────────────────────── */

function useSendToSync(profileId: number) {
  const working = useWorkingSet(profileId);
  const set = useQuery({
    ...setQueryOptions(profileId, working?.id ?? 0),
    enabled: Boolean(working),
    staleTime: 60_000,
    retry: false,
  });
  const from = useQueueFrom();
  const playing = usePlayingTrack();
  const rows = working && set.data?.set.id === working.id ? set.data.rows : null;
  useEffect(() => {
    if (!working) {
      setSendToContext({ profileId, working: null, after: null });
      return;
    }
    const numbers = rows ? rowNumbers(rows) : [];
    const count = numbers.filter((n) => n !== null).length;
    let after = null;
    if (rows && from && from.id === working.id && playing?.id) {
      const at = playingRowIndex(rows, from.row, String(playing.id));
      const n = at >= 0 ? numbers[at] : null;
      if (n)
        after = {
          track_id: String(playing.id),
          number: n,
          title: playing.title || 'the playing track',
        };
    }
    setSendToContext({
      profileId,
      working: {
        id: working.id,
        name: working.name,
        kind: working.kind,
        next: rows ? count + 1 : null,
      },
      after,
    });
  }, [profileId, working, rows, from, playing]);
  useEffect(() => {
    const read = () => {
      const st = player()?.state();
      const last = st?.queue?.[st.queue.length - 1];
      setSendToContext({
        upNextLast: last && st && st.queue.length - 1 > st.index ? textOf(last.title) : null,
      });
    };
    read();
    window.addEventListener('ss:player', read);
    return () => window.removeEventListener('ss:player', read);
  }, []);
}

/* ── the host ──────────────────────────────────────────────────────────── */

/** The ghost's place: the only part that follows every pointer move (L7). */
function useGhostTransform(): string {
  return useDndSelect((s) => `translate(${s.x - s.grabX}px, ${s.y - s.grabY}px) rotate(1.5deg)`);
}

function GhostAt({ children, touch }: { children: React.ReactNode; touch: boolean }) {
  const transform = useGhostTransform();
  return (
    <div
      className={styles.ghost}
      data-touch={touch ? '' : undefined}
      data-dnd-ghost=""
      style={{ transform }}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

export function DndHost() {
  // each part on its own (L7): a pointer move re-renders only the ghost
  const drag = useDndSelect((s) => s.drag);
  const over = useDndSelect((s) => s.over);
  const line = useDndSelect((s) => s.line);
  const note = useDndSelect((s) => s.note);
  const refused = useDndSelect((s) => s.refused);
  const scroll = useDndSelect((s) => s.scroll);
  const st = { over, line, note, refused, scroll };
  const phone = useMedia(PHONE);
  const qc = useQueryClient();
  const { profileId, isAdmin } = useProfile();
  const working = useWorkingSet(profileId);
  useSendToSync(profileId);

  // Up next (static/media-player.js) joins the drag
  useEffect(() => bindUpNext(qc), [qc]);

  // the legacy player's Move mode uses the same toast and Undo
  useEffect(() => {
    window.SoulSyncDnd = { showDropResult };
    return () => {
      delete window.SoulSyncDnd;
    };
  }, []);

  // ⌘Z / Ctrl Z undoes the last drop while its toast shows (32c), not in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z')
        return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)
      )
        return;
      if (undoLast()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // which of these the sets hold already, for "In it already · #4" (32b):
  // asked once a drag first comes over another set, so a reorder within one
  // list never asks (L7)
  const askedFor = useRef<Drag | null>(null);
  const overKind = over ? getTarget(over.id) : undefined;
  const wantHoldings = Boolean(
    drag &&
    drag.via !== 'keyboard' &&
    overKind &&
    (overKind.kind === 'set' || overKind.kind === 'working') &&
    overKind.listId !== drag.source.listId,
  );
  useEffect(() => {
    if (!drag) {
      askedFor.current = null;
      return;
    }
    if (!wantHoldings || askedFor.current === drag) return;
    askedFor.current = drag;
    setHoldings(new Map());
    fetchHolding(drag.items.map((t) => t.id))
      .then((sets) => {
        if (askedFor.current !== drag) return;
        setHoldings(new Map(sets.map((s) => [s.id, s.holds])));
        // the set under the ghost says "In it already" now, not a moment later
        refreshOver();
      })
      .catch(() => undefined);
  }, [drag, wantHoldings]);

  // a missing file's "Find it again" (32b state 5): an admin's rescan, as a set's row does (28e)
  useEffect(() => {
    const find = () => {
      if (!isAdmin) {
        window.showToast?.('An admin rescans the library to find it again.', 'info');
        return;
      }
      apiClient
        .post('database/update', { json: {}, throwHttpErrors: false })
        .then(async (response) => {
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error || "The library didn't start looking.");
          }
          window.showToast?.('Looking through your library again.', 'info');
        })
        .catch((err: unknown) =>
          window.showToast?.(err instanceof Error ? err.message : "That didn't work.", 'error'),
        );
    };
    window.addEventListener('ss:dnd-find-again', find);
    return () => window.removeEventListener('ss:dnd-find-again', find);
  }, [isAdmin]);

  const pointer = drag && drag.via !== 'keyboard';
  const ghostNo = st.over && !st.over.verdict.ok;
  const first = drag?.items[0];
  const ghost = drag ? ghostWords(drag.items) : null;
  return createPortal(
    <>
      {pointer && ghost ? (
        <GhostAt touch={drag.via === 'touch'}>
          {ghost.count > 1 ? <span className={styles.ghostCount}>{ghost.count}</span> : null}
          <span className={styles.ghostText}>
            <span className={styles.ghostTitle}>{ghost.title || first?.title}</span>
            {ghost.meta ? <span className={styles.ghostMeta}>{ghost.meta}</span> : null}
          </span>
          {ghostNo ? <span className={styles.ghostNo}>⊘</span> : null}
        </GhostAt>
      ) : null}
      {st.line ? (
        <div
          className={styles.line}
          data-dnd-line=""
          data-duplicate={st.line.duplicate ? '' : undefined}
          style={{ top: st.line.top, left: st.line.left, width: st.line.width }}
          aria-hidden="true"
        >
          {st.line.words ? <span className={styles.lineWords}>{st.line.words}</span> : null}
        </div>
      ) : null}
      {st.note ? (
        <div
          className={styles.note}
          data-dnd-note=""
          style={{ top: st.note.top, left: st.note.left, maxWidth: st.note.width }}
        >
          <i aria-hidden="true" />
          <span>{st.note.words}</span>
        </div>
      ) : null}
      {st.refused ? (
        <div
          className={styles.note}
          data-refused=""
          data-dnd-refused=""
          role="status"
          style={{ top: st.refused.top, left: st.refused.left, maxWidth: st.refused.width }}
        >
          <i aria-hidden="true" />
          <span>{st.refused.words}</span>
          {st.refused.action ? (
            <button type="button" className={styles.noteAction} onClick={st.refused.action.run}>
              {st.refused.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {st.scroll ? (
        <div
          className={styles.scrollCue}
          data-edge={st.scroll.edge}
          style={{ top: st.scroll.top, left: st.scroll.left, width: st.scroll.width }}
          aria-hidden="true"
        >
          <span className={styles.scrollCueWords}>
            {st.scroll.edge === 'up' ? '▲ scrolls' : '▼ scrolls'}
          </span>
        </div>
      ) : null}
      {pointer && drag.via === 'touch' && phone ? <DragTray /> : null}
      {pointer && !phone ? <BarZones /> : null}
      {pointer && !phone ? (
        <SidebarSets profileId={profileId} workingId={working?.id ?? null} />
      ) : null}
      <SendToTray />
    </>,
    document.body,
  );
}
