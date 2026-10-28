/**
 * "Add to set…" (boards 28a, 28b, 28d, 28g): the fourth item of every
 * track's "…" in the DJ area (24a), the player's "…", and Tracks' selection
 * bar's primary. One picker for the whole app, like Add to playlist: React
 * pages call `openAddToMixSet`, the shell and the legacy pages call
 * `window.openAddToMixSet` with the same shape.
 *
 * "Add Copper Sky to…": a search field (focused), Recent (your sets, the
 * last edited first) with where the track would land ("adds as #25") or
 * that it's there ("In it already · #4", with Add again; the row itself does
 * nothing new), then New set… (named in place, then added). Many at
 * once: a set holding some of them opens the choice in place, "Add 4" (the
 * default) or "Add all 6". A track whose file isn't here is left out and
 * said (the downloaded-only rule). Then a toast with Open it. A popover on
 * a desktop, a sheet on a phone.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { StatusTag } from '@/components/primitives';
import { askForAdded } from '@/features/dj/analysis.api';
import { addedAnalysisWords } from '@/features/dj/analysis.format';
import { starStore } from '@/features/stars/stars-store';
import { appURL } from '@/platform/url-base';
import { usePopoverDismiss } from '@/routes/sync/-ui/use-popover-dismiss';
import { usePopoverPosition } from '@/routes/sync/-ui/use-popover-position';

import styles from './add-to-mix-set.module.css';
import {
  MIX_SET_CHANGED,
  addToSet,
  createSet,
  fetchHolding,
  fetchWorkingSetId,
  type HoldingSet,
} from './sets.api';
import { addedWords, leftOutWords, pickerLine, whenWords } from './sets.format';

export interface MixSetTrack {
  /** the library track's id */
  id: string;
  title: string;
  artist: string;
  /** its file isn't on this computer (left out, and said) */
  fileMissing?: boolean;
}

declare global {
  interface Window {
    /** open the "Add to set…" picker; `anchor` is what it pops from */
    openAddToMixSet?: (tracks: MixSetTrack | MixSetTrack[], anchor?: HTMLElement | null) => void;
  }
}

const PICKER_WIDTH = 360;
/** Recent: the working set first (the Mix tab's), then the last edited */
const RECENT = 5;
const PHONE_QUERY = '(max-width: 640px)';

interface Request {
  id: number;
  tracks: MixSetTrack[];
  anchor: HTMLElement | null;
  top: number;
  left: number;
}

let current: Request | null = null;
let opened = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The tracks as the picker takes them: an id each, the first of each id once. */
export function cleanMixTracks(
  tracks: MixSetTrack | MixSetTrack[] | null | undefined,
): MixSetTrack[] {
  const list = Array.isArray(tracks) ? tracks : tracks ? [tracks] : [];
  const seen = new Set<string>();
  const out: MixSetTrack[] = [];
  for (const t of list) {
    const id = String(t?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...t, id, title: String(t.title ?? ''), artist: String(t.artist ?? '') });
  }
  return out;
}

export function openAddToMixSet(
  tracks: MixSetTrack | MixSetTrack[],
  anchor?: HTMLElement | null,
): void {
  const clean = cleanMixTracks(tracks);
  if (!clean.length) {
    window.showToast?.('Only tracks in your library can go in a set', 'info');
    return;
  }
  if (current && anchor && current.anchor === anchor) {
    closeAddToMixSet();
    return;
  }
  const box = anchor?.getBoundingClientRect();
  opened += 1;
  current = {
    id: opened,
    tracks: clean,
    anchor: anchor ?? null,
    top: box ? box.bottom + 6 : window.innerHeight / 4,
    left: box ? box.right - PICKER_WIDTH : (window.innerWidth - PICKER_WIDTH) / 2,
  };
  emit();
}

export function closeAddToMixSet(): void {
  if (!current) return;
  current = null;
  emit();
}

function useRequest(): Request | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE_QUERY).matches),
  );
  useEffect(() => {
    const list = window.matchMedia?.(PHONE_QUERY);
    if (!list) return;
    const on = () => setPhone(list.matches);
    list.addEventListener?.('change', on);
    return () => list.removeEventListener?.('change', on);
  }, []);
  return phone;
}

/** Where a set opens: Library → Sets, that set. */
export function setHref(id: number): string {
  return appURL(`/library?view=sets&set=${id}`);
}

/**
 * The toast, then the set's page on Open it (6 s, 28a). A track going in
 * jumps the analysis line, and the toast says where it is, once:
 * "Added Canopy to Sunday Set · #7 · analysing, 2nd in line" (Brief A,
 * 31b, 31d); a track ready to mix says only where it went.
 */
async function announce(
  words: string,
  id: number,
  asking: ReturnType<typeof askForAdded> | null = null,
): Promise<void> {
  window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: { id } }));
  const analysing = addedAnalysisWords(asking ? await asking : null);
  window.showToast?.(analysing ? `${words} · ${analysing}` : words, 'success', null, {
    action: { label: 'Open it', run: () => window.location.assign(setHref(id)) },
  });
}

/** Which tracks go in: those with their file here. */
export function splitMissing(tracks: MixSetTrack[]): {
  ok: MixSetTrack[];
  missing: MixSetTrack[];
} {
  const store = starStore();
  const missing = tracks.filter((t) => {
    if (t.fileMissing) return true;
    const s = store.get(t.id);
    // the star's lookup says it has no file here (and it isn't unknown)
    return s ? !s.canStar : false;
  });
  const gone = new Set(missing.map((t) => t.id));
  return { ok: tracks.filter((t) => !gone.has(t.id)), missing };
}

/** The set's name, with "Working set" on the Mix tab's (29a). */
function SetName({ set, working }: { set: HoldingSet; working: boolean }) {
  return (
    <span className={styles.setName}>
      {set.name}
      {working ? (
        <>
          {' '}
          <StatusTag tone="neutral" data-working-set="">
            Working set
          </StatusTag>
        </>
      ) : null}
    </span>
  );
}

function SetRowView({
  set,
  working = false,
  tracks,
  busy,
  choosing,
  onChoose,
  onAdd,
}: {
  set: HoldingSet;
  working?: boolean;
  tracks: MixSetTrack[];
  busy: boolean;
  choosing: boolean;
  onChoose: () => void;
  onAdd: (again: boolean) => void;
}) {
  const held = tracks.map((t) => set.holds[t.id] ?? []);
  const { line, already } = pickerLine({
    count: tracks.length,
    next: set.next,
    held,
    when: tracks.length === 1 || !already_(held) ? editedWords(set.updated_at) : '',
  });
  const single = tracks.length === 1;
  const fresh = tracks.length - already;
  // one track already in it: the row says so and offers Add again (28a, 28g)
  if (single && already) {
    return (
      <li className={styles.setRow} data-mix-set={set.id} data-held="">
        <span className={styles.setText}>
          <SetName set={set} working={working} />
          <span className={styles.setMeta}>{line}</span>
        </span>
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => onAdd(true)}
          aria-label={`Add ${tracks[0].title} to ${set.name} again`}
        >
          Add again
        </button>
      </li>
    );
  }
  if (!single && already) {
    // 28b: the choice opens in place; adding the new ones is the default
    return (
      <li className={styles.setRow} data-mix-set={set.id} data-open={choosing ? '' : undefined}>
        <button
          type="button"
          className={styles.setButton}
          aria-expanded={choosing}
          disabled={busy}
          onClick={onChoose}
        >
          <SetName set={set} working={working} />
          <span className={styles.setMeta}>{line}</span>
        </button>
        {choosing ? (
          <span className={styles.choice}>
            {fresh ? (
              <button
                type="button"
                className={styles.primary}
                disabled={busy}
                autoFocus
                onClick={() => onAdd(false)}
              >
                Add {fresh}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              autoFocus={!fresh}
              onClick={() => onAdd(true)}
            >
              {fresh ? `Add all ${tracks.length}` : `Add all ${tracks.length} again`}
            </button>
          </span>
        ) : null}
      </li>
    );
  }
  return (
    <li className={styles.setRow} data-mix-set={set.id}>
      <button
        type="button"
        className={styles.setButton}
        disabled={busy}
        onClick={() => onAdd(false)}
      >
        <SetName set={set} working={working} />
        <span className={styles.setMeta}>{line}</span>
      </button>
    </li>
  );
}

function already_(held: number[][]): boolean {
  return held.some((n) => n.length);
}

function editedWords(at: number | null): string {
  const when = whenWords(at);
  return when ? `edited ${when}` : '';
}

function Picker({ request }: { request: Request }) {
  const ref = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  const pos = usePopoverPosition({ top: request.top, left: request.left }, ref);
  const searchId = useId();
  const [sets, setSets] = useState<HoldingSet[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState<number | null>(null);
  const [working, setWorking] = useState<number | null>(null);
  const { ok, missing } = useMemo(() => splitMissing(request.tracks), [request.tracks]);

  usePopoverDismiss({ ref, anchor: request.anchor, onClose: closeAddToMixSet });

  useEffect(() => {
    const anchor = request.anchor;
    return () => {
      if (anchor && document.contains(anchor)) anchor.focus();
    };
  }, [request.anchor]);

  useEffect(() => {
    let live = true;
    if (!ok.length) {
      setSets([]);
      return;
    }
    Promise.all([fetchHolding(ok.map((t) => t.id)), fetchWorkingSetId().catch(() => null)])
      .then(([list, workingId]) => {
        if (!live) return;
        setWorking(workingId);
        setSets(list);
        // what the picker read may be newer than an open set page: it reads itself again
        window.dispatchEvent(new CustomEvent(MIX_SET_CHANGED, { detail: {} }));
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [ok]);

  const add = async (set: HoldingSet, again: boolean) => {
    setBusy(true);
    try {
      const done = await addToSet(
        set.id,
        ok.map((t) => t.id),
        again,
      );
      closeAddToMixSet();
      // analyse on demand: a track in a set jumps the analysis queue
      const asking = done.added.length
        ? askForAdded(
            done.added.map((a) => a.track_id),
            { source: 'set', setId: done.id },
          )
        : null;
      if (!done.added.length) {
        window.showToast?.(`Already in ${done.name}. Nothing was added.`, 'info');
        return;
      }
      const title =
        done.added.length === 1
          ? (ok.find((t) => t.id === done.added[0].track_id)?.title ?? null)
          : null;
      void announce(
        addedWords({
          title,
          count: done.added.length,
          set: done.name,
          first: done.added[0].number,
        }),
        done.id,
        asking,
      );
    } catch (err) {
      setBusy(false);
      window.showToast?.(err instanceof Error ? err.message : "It wasn't added.", 'error');
    }
  };

  const create = async () => {
    const name = (newName ?? '').trim();
    if (!name || !ok.length) return;
    setBusy(true);
    try {
      const made = await createSet({
        name,
        kind: 'hand',
        rows: ok.map((t) => ({
          track_id: t.id,
          artist: t.artist || null,
          title: t.title || null,
          state: 'owned',
          want: 'yours',
        })),
      });
      closeAddToMixSet();
      void announce(
        addedWords({
          title: ok.length === 1 ? ok[0].title : null,
          count: ok.length,
          set: name,
          first: 1,
        }),
        made.id,
        askForAdded(
          ok.map((t) => t.id),
          { source: 'set', setId: made.id },
        ),
      );
    } catch (err) {
      setBusy(false);
      window.showToast?.(err instanceof Error ? err.message : "The set wasn't made.", 'error');
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = (sets ?? []).filter((s) => !needle || s.name.toLowerCase().includes(needle));
  // the working set (the Mix tab's) first, then the last edited
  const ordered = needle
    ? shown
    : [...shown.filter((s) => s.id === working), ...shown.filter((s) => s.id !== working)];
  const list = needle ? shown : ordered.slice(0, RECENT);
  const heading =
    request.tracks.length === 1
      ? `Add ${request.tracks[0].title || 'this track'} to…`
      : `Add ${ok.length} track${ok.length === 1 ? '' : 's'} to…`;

  return (
    <>
      {phone ? (
        <div className={styles.scrim} aria-hidden="true" onClick={closeAddToMixSet} />
      ) : null}
      <div
        ref={ref}
        className={styles.picker}
        data-phone={phone ? '' : undefined}
        style={
          phone
            ? undefined
            : { top: `${pos.top}px`, left: `${pos.left}px`, width: `${PICKER_WIDTH}px` }
        }
        role="dialog"
        aria-label={heading}
        data-popover-layer=""
        data-add-to-mix-set=""
      >
        {phone ? <span className={styles.grabber} aria-hidden="true" /> : null}
        <p className={styles.heading}>{heading}</p>
        {ok.length ? (
          <>
            <label className={styles.srOnly} htmlFor={searchId}>
              Find a set
            </label>
            <input
              id={searchId}
              className={styles.search}
              type="search"
              placeholder="Find a set"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {!needle && list.length ? <p className={styles.overline}>Recent</p> : null}
            {error ? (
              <p className={styles.note}>{error}</p>
            ) : sets === null ? (
              <p className={styles.note}>Loading your sets…</p>
            ) : !list.length ? (
              <p className={styles.note}>
                {needle ? `No set matches “${query.trim()}”.` : 'No sets yet. Make one below.'}
              </p>
            ) : (
              <ul className={styles.list} aria-label="Your sets">
                {list.map((set) => (
                  <SetRowView
                    key={set.id}
                    set={set}
                    working={set.id === working}
                    tracks={ok}
                    busy={busy}
                    choosing={choosing === set.id}
                    onChoose={() => setChoosing(choosing === set.id ? null : set.id)}
                    onAdd={(again) => void add(set, again)}
                  />
                ))}
              </ul>
            )}
            {newName === null ? (
              <button
                type="button"
                className={styles.newSet}
                disabled={busy}
                onClick={() => setNewName(needle ? query.trim() : '')}
              >
                <span aria-hidden="true">+</span> New set…
              </button>
            ) : (
              <form
                className={styles.create}
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
              >
                <input
                  className={styles.search}
                  autoFocus
                  maxLength={200}
                  placeholder="Name the set"
                  aria-label="The new set's name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <button type="submit" className={styles.primary} disabled={busy || !newName.trim()}>
                  Make it
                </button>
              </form>
            )}
          </>
        ) : null}
        {missing.length ? <p className={styles.note}>{leftOutWords(missing.length)}</p> : null}
      </div>
    </>
  );
}

export function AddToMixSetHost() {
  const request = useRequest();
  return request ? <Picker key={request.id} request={request} /> : null;
}

const HOST_ID = 'add-to-mix-set-root';

/** Mount once, and give the shell and the legacy pages the same way in. */
export function mountAddToMixSetHost(): void {
  if (typeof document === 'undefined' || document.getElementById(HOST_ID)) return;
  const el = document.createElement('div');
  el.id = HOST_ID;
  document.body.appendChild(el);
  createRoot(el).render(<AddToMixSetHost />);
  window.openAddToMixSet = openAddToMixSet;
}
