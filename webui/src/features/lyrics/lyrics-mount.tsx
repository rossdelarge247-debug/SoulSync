/**
 * Puts the lyrics layer on the page (27a–27g): the store, fed by the
 * player's `ss:player` events; the Visuals header's Lyrics button; the layer
 * inside the overlay; the phone's record (27e) with its Lyrics button and
 * the record "…"'s text size and Earlier / Later; turning the phone to
 * landscape opens the Visuals with the lyrics over them (27f); and T
 * (`window.SoulSyncLyrics.key`, from NP_LETTER_KEYS in static/media-player.js).
 *
 * Small and in the entry chunk, since the phone's record needs it without the
 * Visuals ever opening; it fetches nothing (the player already fetched the
 * lyrics) and draws nothing until the layer shows.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { LyricsSnapshot, LyricsStore } from './lyrics-store';

import { LyricsLayer, LyricsRecord, useLyrics } from './lyrics-layer';
import { lyricsStore } from './lyrics-store';
import { offsetWords, SIZES } from './lyrics.logic';

export interface SoulSyncLyricsBridge {
  key(k: string): boolean;
  store: LyricsStore;
}

declare global {
  interface Window {
    SoulSyncLyrics?: SoulSyncLyricsBridge;
  }
}

const PHONE = '(max-width: 768px)';
const LANDSCAPE = '(orientation: landscape) and (max-height: 500px)';

function useAttr(el: Element | null, attr: string, read: (el: Element) => string): string {
  const [v, setV] = useState(() => (el ? read(el) : ''));
  useEffect(() => {
    if (!el) return;
    const sync = () => setV(read(el));
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: [attr] });
    sync();
    return () => mo.disconnect();
  }, [el, attr, read]);
  return v;
}

const overlayOpen = (el: Element) => (el.classList.contains('hidden') ? '' : 'open');
const engineOf = (el: Element) => el.getAttribute('data-visuals-engine') || 'synchros';
const sheetOf = (el: Element) => (el.hasAttribute('data-player-sheet') ? 'sheet' : '');

function useMedia(query: string): boolean {
  const [m, setM] = useState(() => Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const q = window.matchMedia?.(query);
    if (!q) return;
    const on = () => setM(q.matches);
    q.addEventListener?.('change', on);
    on();
    return () => q.removeEventListener?.('change', on);
  }, [query]);
  return m;
}

/** The legacy markup the store drives: buttons, the overlay's marks, the "…" rows. */
export function syncChrome(doc: Document, s: LyricsSnapshot, phone: boolean): void {
  const head = doc.getElementById('np-v2-visuals-lyrics-btn');
  if (head) {
    head.hidden = !s.available;
    head.setAttribute('aria-pressed', s.on ? 'true' : 'false');
  }
  for (const b of doc.querySelectorAll<HTMLElement>('[data-lyrics-toggle]')) {
    b.hidden = !s.available;
    b.setAttribute('aria-pressed', s.on ? 'true' : 'false');
  }
  const overlay = doc.getElementById('np-modal-overlay');
  overlay?.toggleAttribute('data-lyrics', s.showing);
  overlay?.toggleAttribute('data-lyrics-only', s.onlyActive);
  const record = doc.querySelector('.ss-player-record');
  record?.toggleAttribute('data-lyrics-on', s.on && s.available);
  // the record's "…" on a phone: text size and Earlier / Later (27e)
  const words = s.state === 'synced' || s.state === 'plain';
  const rows = phone && s.on && s.available && words;
  for (const el of doc.querySelectorAll<HTMLElement>('[data-lyrics-menu]')) {
    const which = el.getAttribute('data-lyrics-menu');
    const timedOnly = which === 'earlier' || which === 'later';
    el.hidden = !rows || (timedOnly && s.state !== 'synced');
    if (which === 'smaller') el.setAttribute('aria-disabled', String(s.size === SIZES[0]));
    if (which === 'larger')
      el.setAttribute('aria-disabled', String(s.size === SIZES[SIZES.length - 1]));
  }
  const state = doc.querySelector('[data-lyrics-offset-state]');
  if (state) state.textContent = offsetWords(s.offset);
  const size = doc.querySelector('[data-lyrics-size-state]');
  if (size) size.textContent = String(s.size);
}

function Root({
  store,
  modal,
  record,
}: {
  store: LyricsStore;
  modal: HTMLElement;
  record: HTMLElement | null;
}) {
  const s = useLyrics(store);
  const overlay = document.getElementById('np-modal-overlay');
  const open = useAttr(overlay, 'class', overlayOpen) === 'open';
  const engine = useAttr(overlay, 'data-visuals-engine', engineOf);
  const sheet = useAttr(document.documentElement, 'data-player-sheet', sheetOf) === 'sheet';
  const phone = useMedia(PHONE);
  const landscape = useMedia(LANDSCAPE);

  useEffect(() => {
    syncChrome(document, s, phone);
  }, [s, phone]);

  // 27f: turning the phone opens the Visuals full screen, lyrics over them;
  // turning it back closes what the turn opened
  useEffect(() => {
    const v2 = (
      window as Window & { npV2?: { openVisuals?: () => void; closeVisuals?: () => void } }
    ).npV2;
    const w = window as Window & { __ssLyricsTurned?: boolean };
    if (landscape && sheet && s.on && s.available && !open) {
      w.__ssLyricsTurned = true;
      v2?.openVisuals?.();
    } else if (!landscape && w.__ssLyricsTurned) {
      w.__ssLyricsTurned = false;
      if (open) v2?.closeVisuals?.();
    }
  }, [landscape, sheet, s.on, s.available, open]);

  return (
    <>
      {createPortal(<LyricsLayer store={store} open={open} engine={engine} />, modal)}
      {record
        ? createPortal(<LyricsRecord store={store} active={phone && sheet && !open} />, record)
        : null}
    </>
  );
}

let mounted: LyricsStore | null = null;

export function mountLyrics(win: Window = window): LyricsStore | null {
  if (mounted) return mounted;
  const doc = win.document;
  const modal = doc.querySelector<HTMLElement>('#np-modal-overlay .np-modal');
  if (!modal) return null;
  const store = lyricsStore(win);
  mounted = store;

  const refresh = () => store.refresh();
  win.addEventListener('ss:player', refresh);
  refresh();

  win.SoulSyncLyrics = { key: (k) => store.key(k), store };

  doc.getElementById('np-v2-visuals-lyrics-btn')?.addEventListener('click', () => store.toggle());
  for (const b of doc.querySelectorAll<HTMLElement>('[data-lyrics-toggle]'))
    b.addEventListener('click', () => store.toggle());
  for (const el of doc.querySelectorAll<HTMLElement>('[data-lyrics-menu]')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (el.getAttribute('aria-disabled') === 'true') return;
      const which = el.getAttribute('data-lyrics-menu');
      if (which === 'smaller') store.stepSize(-1);
      else if (which === 'larger') store.stepSize(1);
      else if (which === 'earlier') store.nudge(1);
      else if (which === 'later') store.nudge(-1);
    });
  }

  const host = doc.createElement('div');
  host.id = 'ss-lyrics-root';
  host.hidden = true;
  doc.body.appendChild(host);
  const record = doc.querySelector<HTMLElement>('[data-lyrics-record]');
  createRoot(host).render(<Root store={store} modal={modal} record={record} />);
  return store;
}
