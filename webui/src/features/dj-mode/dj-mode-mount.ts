/**
 * DJ mode's way in (37a, 37l, 37p), in the entry chunk: the store fed by the
 * player's `ss:player` events, the phone query and the drives' state; the
 * Visuals header's DJ mode button and DJ mode's head (Back, the name, one
 * line); the overlay's `data-dj-mode` mark (player.css hides Lyrics' layer
 * and keeps the header and transport up); and the keys through
 * `window.SoulSyncDj`:
 *
 * - **D** (NP_LETTER_KEYS in static/media-player.js): in the overlay, DJ mode
 *   on or off; from the tray, the overlay opens in DJ mode. Elsewhere the key
 *   stays the page's (the Artist map's D, the Import inbox's).
 * - **B** opens Browse while DJ mode is on (step 3 registers it).
 * - **⇧P** is Play B (or Pause B) while DJ mode is on with B loaded; else
 *   P and ⇧P stay the player's Previous.
 * - **M** (headphones), **L** (key lock) and **1–4** (cues) act on the
 *   focused lane, else on B when it's loaded; **Z**, **−** and **+** zoom
 *   the focused lane (3b, 37p). Otherwise M mutes and L is the A–B loop.
 * - **T** while DJ mode is on says "Lyrics come back when DJ mode is off".
 * - **H** is Hand over while DJ mode is on with B loaded (step 4, 37p).
 * - **Esc** (static/media-player-v2.js) closes Browse first; mid-blend it
 *   only says "Back ends it over a bar" (413: a stray key never ends a
 *   blend); otherwise it's Back. D mid-blend says the same.
 * - **The player bar** (37o): with DJ mode on, the Visuals closed and B
 *   loaded, one line, "DJ mode · blending into Harbour Lights · Open";
 *   nothing with DJ mode off. Closing the Visuals keeps DJ mode on (37j).
 *
 * The lanes themselves are dj-stage.tsx, mounted with the Visuals' pieces.
 */
import { useDriveStatusStore } from '@/features/drives/drive-status';

import type { DjModeStore } from './dj-mode-store';

import { djModeStore, PHONE_LANDSCAPE_QUERY, PHONE_QUERY } from './dj-mode-store';
import { barLine, headerLine, LYRICS_WAIT } from './dj-mode.logic';

export interface SoulSyncDjBridge {
  /** a letter key (D, B, T): true when it acted, else the key is the page's */
  key(k: string): boolean;
  /** Esc in the overlay: true when it was DJ mode's Back */
  escape(): boolean;
  on(): boolean;
  /** A is on DJ mode's deck: auto-mix, starting now, holds (Brief F step 3) */
  holdsTrack(): boolean;
  /** A's end is DJ mode's (A ran out while B plays: a Hand over, 37j) */
  ownsAdvance(): boolean;
  store: DjModeStore;
}

declare global {
  interface Window {
    SoulSyncDj?: SoulSyncDjBridge;
  }
}

interface NpV2Like {
  openVisuals?: () => void;
  wakeVisuals?: () => void;
}

function overlayOf(doc: Document): HTMLElement | null {
  return doc.getElementById('np-modal-overlay');
}

function overlayOpen(doc: Document): boolean {
  const o = overlayOf(doc);
  return Boolean(o && !o.classList.contains('hidden'));
}

/** The tray is up (the player has the floor, as media-player-v2.js's keys say). */
function trayOpen(doc: Document): boolean {
  return doc.documentElement.getAttribute('data-player') === 'tray';
}

/** The legacy markup the store drives. */
export function syncDjChrome(doc: Document, store: DjModeStore): void {
  const s = store.snapshot();
  const on = s.on;
  const btn = doc.getElementById('np-v2-visuals-dj-btn');
  if (btn) {
    btn.hidden = !s.availability.offered && !on;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'DJ mode is on · D or Back turns it off' : 'DJ mode (D)';
  }
  const head = doc.getElementById('np-v2-visuals-dj-head');
  if (head) head.hidden = !on;
  const close = doc.getElementById('np-v2-visuals-dj-close');
  if (close) close.hidden = !on;
  const line = doc.getElementById('np-v2-visuals-dj-line');
  if (line) {
    const words = on
      ? headerLine({
          a: s.a?.track.title || null,
          aPhase: s.a?.phase ?? null,
          b: s.b?.track.title || null,
          bPhase: s.b?.phase ?? null,
          browse: s.browse,
          mix: s.mix.phase,
          solo: Boolean(s.mix.solo),
        })
      : '';
    if (line.textContent !== words) line.textContent = words;
  }
  // the player bar's one line with the Visuals closed (37o)
  const bar = doc.getElementById('ss-player-dj-line');
  if (bar) {
    const words = barLine({ on, open: s.open, b: s.b?.track.title || null, mix: s.mix.phase });
    bar.hidden = words === null;
    const text = doc.getElementById('ss-player-dj-text');
    if (text && text.textContent !== (words ?? '')) text.textContent = words ?? '';
  }
  const overlay = overlayOf(doc);
  overlay?.toggleAttribute('data-dj-mode', on);
  // the drag layers sit over the overlay while DJ mode is on (dnd.module.css)
  doc.documentElement.toggleAttribute('data-dj-mode', on);
  // 37l: the visual stops, so its ‹ › step nothing; Lyrics waits
  for (const id of ['np-v2-visuals-theme-prev', 'np-v2-visuals-theme-next']) {
    const el = doc.getElementById(id) as HTMLButtonElement | null;
    if (el && el.disabled !== on) el.disabled = on;
  }
  const lyrics = doc.getElementById('np-v2-visuals-lyrics-btn');
  if (lyrics) {
    if (on) {
      lyrics.setAttribute('aria-disabled', 'true');
      lyrics.dataset.djTitle ??= lyrics.title;
      lyrics.title = LYRICS_WAIT;
    } else if (lyrics.dataset.djTitle !== undefined) {
      lyrics.removeAttribute('aria-disabled');
      lyrics.title = lyrics.dataset.djTitle;
      delete lyrics.dataset.djTitle;
    }
  }
  const theme = doc.getElementById('np-v2-visuals-theme-switch');
  if (theme) {
    if (on) theme.setAttribute('title', 'The visual stops while DJ mode is on');
    else theme.removeAttribute('title');
  }
}

let mounted: DjModeStore | null = null;
let cleanups: (() => void)[] = [];

export function mountDjMode(win: Window = window): DjModeStore {
  if (mounted) return mounted;
  const doc = win.document;
  const store = djModeStore({
    win,
    libraryAway: () => Boolean(useDriveStatusStore.getState().status?.library_away),
  });
  mounted = store;

  // focus never falls to the page: a control that went (the stage, the
  // header's ×) hands it to DJ mode's button, or on the way in to Back
  const lost = () => {
    const a = doc.activeElement as HTMLElement | null;
    return !a || a === doc.body || !a.isConnected || a.offsetParent === null;
  };
  let wasOn = store.snapshot().on;
  const sync = () => {
    syncDjChrome(doc, store);
    const on = store.snapshot().on;
    if (on === wasOn) return;
    wasOn = on;
    if (!overlayOpen(doc)) return;
    setTimeout(() => {
      if (!lost()) return;
      if (on) {
        doc.getElementById('np-v2-visuals-dj-back')?.focus();
        return;
      }
      // turned off because it isn't offered any more, its button is gone too:
      // the overlay's own close takes the focus (review L4)
      const btn = doc.getElementById('np-v2-visuals-dj-btn');
      (btn && !btn.hidden ? btn : doc.getElementById('np-v2-visuals-exit'))?.focus();
    }, 0);
  };
  cleanups.push(store.subscribe(sync));

  const refresh = () => store.refresh();
  win.addEventListener('ss:player', refresh);
  cleanups.push(() => win.removeEventListener('ss:player', refresh));
  cleanups.push(useDriveStatusStore.subscribe(refresh));
  // a phone upright or on its side (review L9)
  for (const q of [PHONE_QUERY, PHONE_LANDSCAPE_QUERY]) {
    const mq = win.matchMedia?.(q);
    mq?.addEventListener?.('change', refresh);
    cleanups.push(() => mq?.removeEventListener?.('change', refresh));
  }

  const overlay = overlayOf(doc);
  if (overlay) {
    const watch = () => store.setOpen(!overlay.classList.contains('hidden'));
    const mo = new MutationObserver(watch);
    mo.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    cleanups.push(() => mo.disconnect());
    watch();
  }

  // said where it can be seen: the toast (it's also the polite region's)
  const say = (words: string) => win.showToast?.(words, 'info');
  doc.getElementById('np-v2-visuals-dj-btn')?.addEventListener('click', () => {
    store.refresh();
    store.toggle();
  });
  doc.getElementById('np-v2-visuals-dj-back')?.addEventListener('click', () => {
    store.back();
    doc.getElementById('np-v2-visuals-dj-btn')?.focus();
  });
  // the bar's Open (37o): the Visuals again, in DJ mode as they were
  doc.getElementById('ss-player-dj-open')?.addEventListener('click', () => {
    (win as Window & { npV2?: NpV2Like }).npV2?.openVisuals?.();
  });
  doc.getElementById('np-v2-visuals-dj-close')?.addEventListener('click', () => {
    doc.getElementById('np-v2-visuals-exit')?.click();
  });
  // Lyrics waits while DJ mode is on (37l): the click says so instead
  doc.getElementById('np-v2-visuals-lyrics-btn')?.addEventListener(
    'click',
    (e) => {
      if (!store.snapshot().on) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      say(LYRICS_WAIT);
    },
    true,
  );

  win.SoulSyncDj = {
    key(k: string): boolean {
      const s = store.snapshot();
      const open = overlayOpen(doc);
      if (k === 'D') {
        store.refresh();
        if (open) {
          if (!s.on && !store.snapshot().availability.offered) return false;
          store.toggle();
          (win as Window & { npV2?: NpV2Like }).npV2?.wakeVisuals?.();
          return true;
        }
        // from the player (37l): the overlay opens in DJ mode
        if (!trayOpen(doc) || !store.snapshot().availability.offered) return false;
        (win as Window & { npV2?: NpV2Like }).npV2?.openVisuals?.();
        if (!overlayOpen(doc)) return false;
        return store.setOn(true);
      }
      if (!s.on || !open) return false;
      if (k === 'B') return store.openBrowse();
      if (k === '⇧P') return store.playB();
      // H (37p): Hand over to B; with no B the key is nobody's
      if (k === 'H') return store.handOver();
      // 3b (37p): M headphones, L key lock and 1–4 cues on the focused lane
      // (else B, when it's loaded); Z, − and + zoom the focused lane. Without
      // a lane to act on the key stays the player's (M mutes, L is the A–B loop)
      if (
        ['M', 'L', '1', '2', '3', '4', 'Z', '-', '+', 'O', '⇧O', 'I', '⇧I', '[', ']', 'Q'].includes(
          k,
        )
      ) {
        const lane = (doc.activeElement as HTMLElement | null)?.closest?.<HTMLElement>(
          '[data-dj-lane]',
        );
        const focused = (lane?.dataset.djLane as 'a' | 'b' | undefined) ?? null;
        return store.laneKey(k, focused);
      }
      if (k === 'T') {
        say(LYRICS_WAIT);
        return true;
      }
      return false;
    },
    escape(): boolean {
      return store.escape();
    },
    on: () => store.snapshot().on,
    holdsTrack: () => store.holdsTrack(),
    ownsAdvance: () => store.ownsAdvance(),
    store,
  };

  store.refresh();
  sync();
  return store;
}

/** @internal tests */
export function resetDjModeMount(): void {
  for (const c of cleanups.splice(0)) c();
  mounted = null;
}
