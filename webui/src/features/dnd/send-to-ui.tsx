/**
 * "Send to…": the keyboard's and the phone's way to another surface (32d,
 * 32e). On a desktop it is a submenu in every track's "…" (the working set
 * "adds as #9", Up next "after Static Bloom", DJ now when step 5 lands,
 * Another set…); on a phone the sheet's Send to… opens the tray at the foot
 * (the working set · Up next · Other sets · DJ now, laptop only), the same
 * tray a long-press drag drops on.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { openAddToMixSet } from '@/features/sets/add-to-mix-set';

import type { DragItem } from './dnd-model';

import { showDropResult, type DropResult } from './dnd-engine';
import styles from './dnd.module.css';
import { sendToContext, sendToUpNext, sendToWorkingSet, setRefusal } from './send-to';

export interface SendToEntry {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  reason?: string;
}

async function run(go: () => Promise<DropResult | null>): Promise<void> {
  try {
    const result = await go();
    if (result) showDropResult(result);
  } catch (err) {
    window.showToast?.(err instanceof Error ? err.message : "That didn't go in.", 'error');
  }
}

/** Another set… (the Add to set… picker, for these tracks). */
export function sendToAnotherSet(items: DragItem[], anchor?: HTMLElement | null): void {
  openAddToMixSet(
    items.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist ?? '',
      fileMissing: t.fileMissing,
    })),
    anchor ?? null,
  );
}

/** What the working set's row says: "adds as #9", or "after Night Ferry" while it plays (293). */
export function workingWords(): { name: string; sub: string; reason: string | null } {
  const c = sendToContext();
  if (!c.working) return { name: 'A new set', sub: 'starts your working set', reason: null };
  const reason = setRefusal(c.working);
  const sub = c.after
    ? `after ${c.after.title} · adds as #${c.after.number + 1}`
    : c.working.next
      ? `adds as #${c.working.next}`
      : 'goes last';
  return { name: c.working.name, sub, reason };
}

/** Up next's row: "after Static Bloom" (its last row), or "plays next" when it's empty. */
export function upNextWords(): string {
  const c = sendToContext();
  return c.upNextLast ? `after ${c.upNextLast}` : 'plays next';
}

/**
 * DJ now's place in Send to… (32d: "DJ now · cue as next"). Brief E (step
 * 5) provides it with `provideDjNowEntry`; until then the menu doesn't name
 * DJ now at all (absent, not disabled), and dnd-engine's DJ_TARGET_READY
 * keeps it out of the drag's targets.
 */
let djNowEntry: ((items: DragItem[]) => SendToEntry) | null = null;

export function provideDjNowEntry(make: ((items: DragItem[]) => SendToEntry) | null): void {
  djNowEntry = make;
}

/** The desktop "…"'s Send to… submenu (32d). */
export function sendToEntries(
  items: DragItem[],
  anchor?: () => HTMLElement | null | undefined,
): SendToEntry[] {
  const ws = workingWords();
  return [
    {
      key: 'send-working',
      label: sendToContext().working ? `${ws.name} (working set)` : 'A new working set',
      reason: ws.reason ?? ws.sub,
      disabled: Boolean(ws.reason),
      onSelect: () => void run(() => sendToWorkingSet(items)),
    },
    {
      key: 'send-upnext',
      label: 'Up next',
      reason: upNextWords(),
      disabled: !items.some((t) => t.queue),
      onSelect: () => void run(() => sendToUpNext(items, 'end')),
    },
    ...(djNowEntry ? [djNowEntry(items)] : []),
    {
      key: 'send-other',
      label: 'Another set…',
      onSelect: () => sendToAnotherSet(items, anchor?.() ?? null),
    },
  ];
}

/* ── the phone's tray, opened from the sheet's Send to… ───────────────── */

let open: DragItem[] | null = null;
const listeners = new Set<() => void>();

export function openSendToTray(items: DragItem[]): void {
  open = items.length ? items : null;
  listeners.forEach((l) => l());
}

export function closeSendToTray(): void {
  open = null;
  listeners.forEach((l) => l());
}

function useOpen(): DragItem[] | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => null,
  );
}

export interface TrayTargetView {
  key: 'working' | 'upnext' | 'other' | 'dj';
  name: string;
  sub: string;
  disabled?: boolean;
}

/**
 * 32e's four: the working set · Up next · Other sets · DJ now. On a phone
 * DJ now says "laptop only" (Ross's rule: DJ now is laptop and desktop
 * only); on a desktop it isn't named until step 5 provides it.
 */
export function trayTargets(phone = true): TrayTargetView[] {
  const ws = workingWords();
  return [
    {
      key: 'working',
      name: ws.name,
      sub: ws.reason ?? `working set · ${ws.sub}`,
      disabled: Boolean(ws.reason),
    },
    { key: 'upnext', name: 'Up next', sub: 'play next' },
    { key: 'other', name: 'Other sets', sub: 'choose…' },
    ...(phone ? [{ key: 'dj' as const, name: 'DJ now', sub: 'laptop only', disabled: true }] : []),
  ];
}

const PHONE = '(max-width: 640px)';

/**
 * The tray for Send to… without a drag (the phone sheet's, and Space on a
 * row of a list that only lifts, 32d): choose a target. Its first target
 * takes the focus; Escape closes it and gives the focus back.
 */
export function SendToTray() {
  const items = useOpen();
  const first = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!items) return;
    back.current = document.activeElement as HTMLElement | null;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeSendToTray();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      back.current?.focus?.();
    };
  }, [items]);
  if (!items) return null;
  const phone = typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE).matches);
  const title = items.length === 1 ? items[0].title : `${items.length} tracks`;
  const choose = (key: TrayTargetView['key']) => {
    closeSendToTray();
    if (key === 'working') void run(() => sendToWorkingSet(items));
    else if (key === 'upnext') void run(() => sendToUpNext(items, 'next'));
    else if (key === 'other') sendToAnotherSet(items);
  };
  return (
    <div
      className={styles.tray}
      role="dialog"
      aria-label={`Send ${title} to…`}
      data-dnd-send-tray=""
    >
      <p className={styles.trayHead}>
        <span>Send {title} to…</span>
        <button type="button" className={styles.trayClose} onClick={closeSendToTray}>
          Cancel
        </button>
      </p>
      <ul className={styles.trayGrid}>
        {trayTargets(phone).map((t, i) => (
          <li key={t.key}>
            <button
              ref={i === 0 ? first : undefined}
              type="button"
              className={styles.trayTarget}
              data-first={i === 0 ? '' : undefined}
              aria-disabled={t.disabled ? 'true' : undefined}
              onClick={t.disabled ? undefined : () => choose(t.key)}
            >
              <span className={styles.trayName}>{t.name}</span>
              <span className={styles.traySub}>{t.sub}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
