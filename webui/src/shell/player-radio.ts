/**
 * The player's radio mode (build e; boards 4a, 4b, 4i, 4j), on the seam the
 * player left for it (player-state.ts sourceView('radio'): a Live tag for the
 * times, a level meter for the waveform, one action slot).
 *
 * - The bar: the identified track with "identified 40 s ago" and ONE action,
 *   the primary Add to Wanted or the In your library tag; then Station and
 *   Stop on the right (index.html; static/player.css hides Up next, Expand
 *   and Pause for radio).
 * - The phone's mini bar: Add (or the tag) and Stop; it opens the sheet
 *   (11d, 11e; HANDOFF 82): 9c's head (the 56px logo, the name, Live, "kind ·
 *   city · quality", a 44px Close), Now playing as a 56px row with its label
 *   ("Now playing · found by AudD") and source line, Add to Wanted full width
 *   (disabled-neutral with "Nothing identified to add yet." until something
 *   is), Scan now full width under it (in a 4% card with the bar and the
 *   words while it runs; its answer becomes Now playing; "Scan again"
 *   after), the auto-add switch row, volume and Stop, and two link rows:
 *   Heard on <station> today · N and Station page. Switching auto-add on
 *   swaps the switch row for the confirm with the three numbers (9c); off is
 *   at once.
 * - The level meter, drawn from the player's analyser while radio plays.
 * - Scan now (11a, HANDOFF 58): the quiet 132px control after the one
 *   action (icon-only by room, 148: when the track block would get under
 *   240px), and full width in the sheet. While it
 *   runs the scan takes the track's place in the bar (title: "Capturing 10
 *   seconds · 6 s left" over a 220px progress bar, then "Identifying…" over
 *   the service being asked) and the action slot empties. After, the answer
 *   sits in the track block with its source phrase, Add to Wanted or the tag
 *   beside it, and the control reads "Scan again". No Done: the answer lasts
 *   until the station names the next track, the next scan, or Stop. Not
 *   found, Failed (in the danger colour, naming the service and who can fix
 *   it) and disabled (its reason as the title). Each change is announced in
 *   the player's live region.
 *
 * - The tray (Ross, 2026-10-23, reversing 4a's "radio has no tray on a
 *   desktop"; no board yet): the bar expands into 6a's 360px tray like music,
 *   filled with radio. The record: the station's 112px logo (its letters,
 *   our logo route over them), Now playing with its source phrase, the title,
 *   the artist (a link to Search) and the release, the readout (Stream
 *   "AAC 256 kbps · relayed", Path), Add to Wanted or the tag, and "…" (so
 *   Visuals, F, is in reach). The deck: the meter, Live and the time
 *   listened, Stop and the stream picker, Scan now with the sheet's card
 *   while it runs, volume and output. The list: Heard today (N) / Recent
 *   stations, the auto-add switch row (9c's confirm swaps in), and "All of
 *   it on NTS 1’s page".
 * - The meter's bars are counted from its width (ResizeObserver), in the bar
 *   and the deck, so it fills the room it has (Ross, 2026-10-23).
 * - The Visuals overlay's header names the identified track and the station.
 *
 * Every word from a station or a track goes in with textContent.
 */

import type {
  AutoAddNumbers,
  RadioSessionApi,
  RadioSessionState,
  StationResponse,
} from '@/features/radio/radio.types';
import type { HeardItem, HeardResponse } from '@/features/radio/radio.types';

import {
  agoWords,
  cardSubline,
  heardFold,
  heardRowView,
  heardToday,
  logoText,
  nowLines,
  playerAction,
  secondsSince,
  stationPossessive,
  streamReadout,
} from '@/features/radio/radio.format';
import {
  keepRecentStations,
  mergeRecent,
  readRecentStations,
  RECENT_AFTER_MS,
  recentAsStation,
  rememberStation,
  serverRecent,
  type RecentStation,
} from '@/features/radio/radio.recent';
import {
  ownLogo,
  radioVisualsHeader,
  scanAnswer,
  scanButton,
  scanPanel,
  scanTrouble,
  sheetNowPlaying,
  sheetScanWords,
  type ScanPanel,
} from '@/features/radio/radio.scan';
import { RADIO_EVENT } from '@/features/radio/radio.types';
import { appURL } from '@/platform/url-base';

import {
  formatClock,
  meterBarCount,
  meterBarWidth,
  meterBin,
  pathLabel,
  scanIconOnly,
} from './player-state';

const SVG_STOP =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const SVG_NOTE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const SVG_SCAN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>';
const SPINNER = '<span class="ss-player-radio-spinner" aria-hidden="true"></span>';
const SVG_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
const SVG_VOLUME =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7"/></svg>';
const SVG_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>';
const SVG_CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

export interface RadioChromeOptions {
  win?: Window;
  root?: HTMLElement | null;
  radio?: () => RadioSessionApi | undefined;
  analyser?: () => AnalyserNode | null;
  fetchImpl?: typeof fetch;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A station's logo tile: its letters, with our own logo route over them once
 * the image has loaded. A logo that fails (or none) leaves the letters, never
 * the browser's broken-image glyph (Ross, 2026-10-23). `letters` is the
 * tile's own letters node when it has one (the record's); otherwise the tile
 * holds the letters as text and the image beside them.
 */
export function fillLogo(
  tile: HTMLElement,
  station: { name: string; logo_text?: string; logo_url?: string | null },
  letters?: HTMLElement | null,
): void {
  const doc = tile.ownerDocument;
  const text = logoText(station.name, station.logo_text);
  if (letters) {
    if (letters.textContent !== text) letters.textContent = text;
  } else {
    let span = tile.querySelector<HTMLElement>(':scope > .ss-player-logo-letters');
    if (!span) {
      span = doc.createElement('span');
      span.className = 'ss-player-logo-letters';
      tile.prepend(span);
    }
    if (span.textContent !== text) span.textContent = text;
  }
  const src = ownLogo(station.logo_url ?? '');
  const want = src ? appURL(src as `/${string}`) : '';
  let img = tile.querySelector<HTMLImageElement>('img');
  if (!want) {
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
      delete img.dataset.src;
      img.classList.remove('is-loaded');
    }
    return;
  }
  if (img?.dataset.src === want) return;
  if (!img) {
    img = doc.createElement('img');
    img.alt = '';
    tile.append(img);
  }
  const node = img;
  node.dataset.src = want;
  node.classList.remove('is-loaded');
  node.hidden = false;
  node.onload = () => node.classList.add('is-loaded');
  // the letters stay underneath; the image hides, so no broken-image glyph
  node.onerror = () => {
    node.hidden = true;
    node.classList.remove('is-loaded');
  };
  node.src = want;
}

/** The phone mini bar's two lines for radio: "track · station", "station · Live · …". */
export function radioMiniLines(
  st: RadioSessionState | null,
): { title: string; meta: string } | null {
  if (!st?.station) return null;
  const lines = nowLines(st.nowPlaying, st.skew);
  const np = st.nowPlaying;
  const title =
    lines.identified && np?.track ? `${np.track.title} · ${np.track.artist}` : st.station.name;
  const state =
    np?.state === 'identified'
      ? np.library?.in_library
        ? 'in your library'
        : np.on_wanted
          ? 'on Wanted'
          : 'not in your library'
      : lines.title === 'Listening…'
        ? 'listening…'
        : 'not identified';
  const scan = st.scan;
  if (st.scanStarting || scan?.state === 'listening') {
    return { title, meta: [st.station.name, 'Live', 'scanning…'].join(' · ') };
  }
  if (scan?.state === 'identified' && scan.track) {
    return {
      title: `${scan.track.title} · ${scan.track.artist}`,
      meta: [st.station.name, 'Live', `found by ${scan.source_label ?? 'Scan now'}`].join(' · '),
    };
  }
  return { title, meta: [st.station.name, 'Live', state].join(' · ') };
}

export function stationHref(stationId: string): `/${string}` {
  return `/radio/station/${encodeURIComponent(stationId)}`;
}

/** The sheet head's line (9c): "Eclectic · London · AAC 256"; a link says "Your link". */
export function sheetStationLine(st: RadioSessionState | null): string {
  const station = st?.station;
  if (!station) return '';
  const kind = station.source === 'your_link' ? 'Your link' : station.genre || station.kind_label;
  const place = station.city || station.country;
  const q = st?.stream ?? station.quality;
  const quality = q
    ? q.lossless
      ? q.codec || 'FLAC'
      : [q.codec, q.bitrate_kbps || ''].filter(Boolean).join(' ')
    : '';
  return [kind, place, quality].filter(Boolean).join(' · ');
}

function go(win: Window, href: `/${string}`): void {
  const router = win.SoulSyncWebRouter;
  if (router?.navigateHref) void router.navigateHref(href);
  else win.location.assign(appURL(href));
}

export function bootRadioChrome(
  options: RadioChromeOptions = {},
): { dispose(): void; draw(): void } | null {
  const win = options.win ?? window;
  const doc = win.document;
  const found = options.root ?? doc.getElementById('media-player');
  if (!found) return null;
  const root: HTMLElement = found;
  const radio =
    options.radio ?? (() => (win as Window & { SoulSyncRadio?: RadioSessionApi }).SoulSyncRadio);
  const analyser =
    options.analyser ??
    (() =>
      (
        win as Window & { SoulSyncPlayer?: { analyser?: () => AnalyserNode | null } }
      ).SoulSyncPlayer?.analyser?.() ?? null);
  const fetcher: typeof fetch = options.fetchImpl ?? ((...a) => win.fetch(...a));
  const cleanups: (() => void)[] = [];
  let meterFrame = 0;
  let tick: ReturnType<typeof setInterval> | null = null;
  let stationInfo: {
    id: string;
    data: StationResponse | null;
    auto: AutoAddNumbers | null;
  } | null = null;
  // the sheet's in-place auto-add confirm (9c), while it's up
  let autoConfirm: {
    stationId: string;
    numbers: AutoAddNumbers | null;
    failed: string | null;
    busy: boolean;
  } | null = null;
  // what the sheet just set, until the station's own answer catches up
  let autoSet: { stationId: string; on: boolean } | null = null;

  const isRadio = () => root.dataset.source === 'radio' && radio()?.state().station != null;

  // ── the bar's slot ─────────────────────────────────────────────────────
  function actionNode(st: RadioSessionState, compact: boolean): HTMLElement | null {
    const np = st.nowPlaying;
    const kind = playerAction(np);
    if (kind === 'in_library') {
      const tag = el(doc, 'span', 'ss-player-tag ss-player-radio-tag', 'In your library');
      tag.dataset.tone = 'success';
      return tag;
    }
    if (kind === 'on_wanted') {
      const tag = el(doc, 'span', 'ss-player-tag ss-player-radio-tag', 'On Wanted');
      tag.dataset.tone = 'info';
      return tag;
    }
    if (kind === 'add' || kind === 'adding_disabled') {
      const b = el(doc, 'button', 'ss-player-radio-add', compact ? 'Add' : 'Add to Wanted');
      b.type = 'button';
      b.dataset.playerRadioAdd = '';
      if (kind === 'adding_disabled' || st.adding) {
        b.setAttribute('aria-disabled', 'true');
        b.title = st.adding ? 'Adding…' : 'Once it’s in Heard on radio';
      }
      if (np?.track)
        b.setAttribute('aria-label', `Add ${np.track.title} by ${np.track.artist} to Wanted`);
      return b;
    }
    return null;
  }

  function scanButtonNode(st: RadioSessionState, wide: boolean): HTMLElement {
    const view = scanButton(st);
    const b = el(
      doc,
      'button',
      wide ? 'ss-player-radio-scan ss-player-radio-scan--wide' : 'ss-player-radio-scan',
    );
    b.type = 'button';
    b.dataset.playerRadioScan = '';
    // a pulsing waveform while it listens, a spinner while it identifies
    b.innerHTML = view.phase === 'identifying' ? SPINNER : SVG_SCAN;
    b.append(el(doc, 'span', '', view.label));
    if (view.disabled) {
      b.setAttribute('aria-disabled', 'true');
      if (view.reason) b.title = view.reason;
    }
    if (view.busy) b.dataset.busy = view.phase ?? 'true';
    b.setAttribute(
      'aria-label',
      view.busy
        ? `Scan now: ${view.label.replace('…', '').toLowerCase()}`
        : view.disabled
          ? `${view.label}. ${view.reason}`
          : `${view.label}: identify what’s playing`,
    );
    return b;
  }

  function scanActionNode(
    panel: ScanPanel,
    compact: boolean,
    st: RadioSessionState,
  ): HTMLElement | null {
    if (panel.action === 'in_library') {
      const tag = el(doc, 'span', 'ss-player-tag ss-player-radio-tag', 'In your library');
      tag.dataset.tone = 'success';
      return tag;
    }
    if (panel.action === 'on_wanted') {
      const tag = el(doc, 'span', 'ss-player-tag ss-player-radio-tag', 'On Wanted');
      tag.dataset.tone = 'info';
      return tag;
    }
    if (panel.action) {
      const label =
        panel.action === 'below_target' ? 'Upgrade via Wanted' : compact ? 'Add' : 'Add to Wanted';
      const b = el(doc, 'button', 'ss-player-radio-add', label);
      b.type = 'button';
      b.dataset.playerRadioScanAdd = '';
      if (panel.action === 'adding_disabled' || st.adding) b.setAttribute('aria-disabled', 'true');
      b.setAttribute('aria-label', `${label}: ${panel.title}, ${panel.line}`);
      return b;
    }
    return null;
  }

  // the slot and the sheet are redrawn on every change (a scan polls each
  // second): keep the keyboard focus on the same control when it's redrawn
  const FOCUS_KEYS = [
    'playerRadioScan',
    'playerRadioScanAdd',
    'playerRadioAdd',
    'playerRadioStop',
    'playerRadioAuto',
    'playerRadioAutoConfirm',
    'playerRadioAutoCancel',
    'playerRadioClose',
  ] as const;
  function focusKey(container: HTMLElement): string | null {
    const active = doc.activeElement as HTMLElement | null;
    if (!active || !container.contains(active)) return null;
    return FOCUS_KEYS.find((k) => k in active.dataset) ?? null;
  }
  function restoreFocus(container: HTMLElement, key: string | null): void {
    if (!key) return;
    const attr = `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const next =
      container.querySelector<HTMLElement>(`[${attr}]`) ??
      container.querySelector<HTMLElement>('[data-player-radio-scan]');
    next?.focus();
  }

  let announced = '';
  function announce(panel: ScanPanel | null): void {
    const text = panel?.announce ?? '';
    if (text === announced) return;
    announced = text;
    const live = doc.getElementById('ss-player-live');
    if (live && text) live.textContent = text;
  }

  /** The bar's track block: the station's name for what's on, or the scan in its place. */
  function trackBlock(st: RadioSessionState, panel: ScanPanel | null): HTMLElement {
    const now = el(doc, 'span', 'ss-player-radio-now');
    const answer = panel?.state === 'identified' ? scanAnswer(st.scan) : null;
    if (panel) now.dataset.scan = panel.state;
    if (answer) {
      // the answer reads like a name the station gave; its source phrase says who found it
      const lines = nowLines(answer, st.skew);
      now.append(
        el(doc, 'span', 'ss-player-title', lines.title),
        el(doc, 'span', 'ss-player-meta', lines.line),
      );
      now.title = `${lines.title} · ${lines.line}`;
      return now;
    }
    if (panel) {
      now.append(el(doc, 'span', 'ss-player-title', panel.title));
      if (panel.progress != null) {
        const bar = el(doc, 'span', 'ss-player-radio-now-bar');
        bar.setAttribute('aria-hidden', 'true');
        const fill = el(doc, 'span');
        fill.style.width = `${Math.round(panel.progress * 100)}%`;
        bar.append(fill);
        now.append(bar);
      } else {
        const meta = el(doc, 'span', 'ss-player-meta', panel.line);
        if (panel.danger) meta.dataset.tone = 'danger';
        now.append(meta);
      }
      now.title = [panel.title, panel.line].filter(Boolean).join(' · ');
      return now;
    }
    const lines = nowLines(st.nowPlaying, st.skew);
    now.append(
      el(doc, 'span', 'ss-player-title', lines.title),
      el(doc, 'span', 'ss-player-meta', lines.line),
    );
    return now;
  }

  function drawSlot(st: RadioSessionState): void {
    const services = st.nowPlaying?.scan?.services ?? [];
    const panel = scanPanel(st.scan, st.scanError, st.scanStarting, services);
    announce(panel);
    for (const slot of root.querySelectorAll<HTMLElement>('[data-player-action-slot]')) {
      const keep = focusKey(slot);
      slot.replaceChildren();
      if (!st.station) continue;
      slot.append(trackBlock(st, panel));
      // the action slot: the answer's own Add (or tag); empty while a scan
      // runs or after one that found nothing; else the station's track's
      const action = panel
        ? panel.state === 'identified'
          ? scanActionNode(panel, false, st)
          : null
        : actionNode(st, false);
      if (action) slot.append(action);
      slot.append(scanButtonNode(st, false));
      slot.hidden = false;
      restoreFocus(slot, keep);
    }
    fitScan();
    const mini = root.querySelector<HTMLElement>('[data-player-mini-slot]');
    if (mini) {
      mini.replaceChildren();
      const action = st.station ? actionNode(st, true) : null;
      if (action) mini.append(action);
      const stop = el(doc, 'button', 'ss-player-btn ss-player-radio-stop');
      stop.type = 'button';
      stop.dataset.playerRadioStop = '';
      stop.setAttribute('aria-label', 'Stop the station');
      stop.innerHTML = SVG_STOP;
      mini.append(stop);
    }
    const link = root.querySelector<HTMLAnchorElement>('[data-player-station]');
    if (link && st.station) {
      link.href = appURL(stationHref(st.station.id));
      link.setAttribute('aria-label', `Open ${st.station.name}’s page`);
    }
  }

  // ── the phone sheet (4j) ───────────────────────────────────────────────
  async function loadStation(id: string): Promise<void> {
    if (stationInfo?.id === id && stationInfo.data) return;
    stationInfo = { id, data: null, auto: null };
    try {
      const res = await fetcher(appURL(`/api/radio/stations/${encodeURIComponent(id)}`), {
        credentials: 'same-origin',
      });
      const data = (await res.json()) as StationResponse;
      if (stationInfo?.id !== id || !res.ok) return;
      stationInfo.data = data;
      if (autoSet?.stationId === id) autoSet = null;
      drawPanel();
    } catch {
      // the sheet shows what it has
    }
  }

  /** The auto-add switch row (4j, 11d). */
  function autoRow(stationName: string, on: boolean): HTMLElement {
    const auto = el(doc, 'div', 'ss-player-radio-auto');
    const sw = el(doc, 'button', 'ss-player-radio-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.dataset.playerRadioAuto = on ? 'on' : 'off';
    // the word first, the track right (11d)
    sw.append(
      el(doc, 'span', 'ss-player-radio-switch-text', on ? 'On' : 'Off'),
      el(doc, 'span', 'ss-player-radio-switch-track'),
    );
    const autoText = el(doc, 'div', 'ss-player-radio-auto-text');
    autoText.append(
      el(doc, 'span', 'ss-player-radio-auto-title', `Auto-add what ${stationName} plays`),
      el(doc, 'span', 'ss-player-meta', 'To Wanted, skipping what you have. Asks first.'),
    );
    sw.setAttribute('aria-label', `Auto-add what ${stationName} plays`);
    auto.append(sw, autoText);
    return auto;
  }

  /**
   * The confirm in place of the switch row (9c, HANDOFF 51): the station
   * page's question and three numbers (4d), stacked for the sheet, Turn on /
   * Not now. The numbers come from GET …/auto-add; until they do, the tiles
   * say "—" and Turn on waits.
   */
  function confirmCard(
    stationName: string,
    c: NonNullable<typeof autoConfirm>,
    where: 'sheet' | 'tray' = 'sheet',
  ): HTMLElement {
    const n = c.numbers;
    const card = el(doc, 'div', 'ss-player-radio-confirm');
    card.setAttribute('role', 'group');
    const titleId =
      where === 'sheet' ? 'ss-player-radio-confirm-title' : 'ss-player-rtray-confirm-title';
    card.setAttribute('aria-labelledby', titleId);
    const title = el(
      doc,
      'p',
      'ss-player-radio-confirm-title',
      `Add everything ${stationName} plays to Wanted?`,
    );
    title.id = titleId;
    const guard = el(
      doc,
      'p',
      'ss-player-radio-confirm-guard',
      `Skips what you have or already want, at your quality target. Stops at ${
        n?.daily_limit ?? 50
      } a day. Shows in Activity.`,
    );
    const text = el(doc, 'div', 'ss-player-radio-confirm-text');
    text.append(title, guard);
    card.append(text);

    const blocked = n && !n.can_download;
    if (blocked) {
      card.append(
        el(
          doc,
          'p',
          'ss-player-radio-confirm-note',
          'Auto-add needs download rights, so it can’t be turned on for your profile.',
        ),
      );
    } else {
      const tiles = el(doc, 'div', 'ss-player-radio-tiles');
      const tile = (label: string, value: number | undefined) => {
        const t = el(doc, 'div', 'ss-player-radio-tile');
        t.append(
          el(doc, 'span', 'ss-player-radio-tile-label', label),
          el(doc, 'span', 'ss-player-radio-tile-value', value == null ? '—' : String(value)),
        );
        return t;
      };
      tiles.append(
        tile('Identified yesterday', n?.identified_yesterday),
        tile('You already have', n?.already_have),
        tile('Would be added', n?.would_add),
      );
      card.append(tiles);
    }
    if (c.failed) card.append(el(doc, 'p', 'ss-player-radio-confirm-error', c.failed));

    const actions = el(doc, 'div', 'ss-player-radio-confirm-actions');
    if (!blocked) {
      const yes = el(
        doc,
        'button',
        'ss-player-radio-add ss-player-radio-add--wide',
        `Turn on auto-add for ${stationName}`,
      );
      yes.type = 'button';
      yes.dataset.playerRadioAutoConfirm = '';
      if (!n || c.busy) yes.setAttribute('aria-disabled', 'true');
      actions.append(yes);
    }
    const no = el(doc, 'button', 'ss-player-ghost ss-player-radio-confirm-cancel', 'Not now');
    no.type = 'button';
    no.dataset.playerRadioAutoCancel = '';
    actions.append(no);
    card.append(actions);
    return card;
  }

  async function openAutoConfirm(stationId: string): Promise<void> {
    autoConfirm = { stationId, numbers: null, failed: null, busy: false };
    drawPanel();
    focusHere('[data-player-radio-auto-cancel]');
    try {
      const res = await fetcher(
        appURL(`/api/radio/stations/${encodeURIComponent(stationId)}/auto-add`),
        { credentials: 'same-origin' },
      );
      const data = (await res.json()) as AutoAddNumbers & { message?: string };
      if (autoConfirm?.stationId !== stationId) return;
      // radio's errors carry the sentence to show in `message` (`error` is a code)
      if (!res.ok) autoConfirm.failed = data.message || 'SYNCHRO.S couldn’t count them.';
      else autoConfirm.numbers = data;
    } catch {
      if (autoConfirm?.stationId === stationId)
        autoConfirm.failed = 'SYNCHRO.S didn’t answer. Try again in a moment.';
    }
    drawPanel();
    focusHere('[data-player-radio-auto-confirm]');
  }

  const isPhone = () => Boolean(win.matchMedia?.('(max-width: 768px)').matches);

  /** Focus the control in the place that shows: the tray on a desktop, the sheet on a phone. */
  function focusHere(sel: string): void {
    const box = isPhone()
      ? root.querySelector<HTMLElement>('[data-player-radio-panel]')
      : root.querySelector<HTMLElement>('[data-player-radio-tray]');
    (box?.querySelector<HTMLElement>(sel) ?? root.querySelector<HTMLElement>(sel))?.focus();
  }

  async function setAutoAdd(stationId: string, enabled: boolean): Promise<string | null> {
    try {
      const res = await fetcher(
        appURL(`/api/radio/stations/${encodeURIComponent(stationId)}/auto-add`),
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        },
      );
      if (res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      return data.message || 'SYNCHRO.S didn’t take it.';
    } catch {
      return 'SYNCHRO.S didn’t answer. Try again in a moment.';
    }
  }

  /** The sheet head (9c): the 56px logo, the name, Live, "kind · city · quality", Close. */
  function headNode(st: RadioSessionState): HTMLElement {
    const station = st.station!;
    const head = el(doc, 'div', 'ss-player-radio-head');
    const logo = el(doc, 'span', 'ss-player-radio-logo');
    logo.setAttribute('aria-hidden', 'true');
    fillLogo(logo, station);
    const text = el(doc, 'div', 'ss-player-radio-head-text');
    const top = el(doc, 'div', 'ss-player-radio-head-top');
    const name = el(doc, 'a', 'ss-player-radio-name', station.name) as HTMLAnchorElement;
    name.href = appURL(stationHref(station.id));
    name.dataset.playerRadioGo = stationHref(station.id);
    const live = el(doc, 'span', 'ss-player-live-tag');
    live.append(el(doc, 'span', 'ss-player-live-dot'), doc.createTextNode('Live'));
    top.append(name, live);
    text.append(top, el(doc, 'span', 'ss-player-radio-head-meta', sheetStationLine(st)));
    const close = el(doc, 'button', 'ss-player-radio-close');
    close.type = 'button';
    close.dataset.playerRadioClose = '';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = SVG_CLOSE;
    head.append(logo, text, close);
    return head;
  }

  /** Now playing as a 56px row (11d, 11e): the label, the title, the source line. */
  function nowRow(st: RadioSessionState): HTMLElement {
    const view = sheetNowPlaying(st);
    const row = el(doc, 'div', 'ss-player-radio-nowrow');
    // a live region: "Listening…", the name that follows and a scan's answer are announced
    row.setAttribute('role', 'status');
    row.setAttribute('aria-live', 'polite');
    const art = el(doc, 'span', 'ss-player-radio-art');
    art.setAttribute('aria-hidden', 'true');
    if (view.art) {
      const img = el(doc, 'img');
      img.alt = '';
      img.src = view.art;
      img.onerror = () => {
        img.remove();
        art.innerHTML = SVG_NOTE;
      };
      art.append(img);
    } else {
      art.innerHTML = SVG_NOTE;
    }
    const text = el(doc, 'div', 'ss-player-radio-nowtext');
    text.append(
      el(doc, 'span', 'ss-player-radio-label', view.label),
      el(doc, 'span', 'ss-player-radio-title', view.title),
      el(doc, 'span', 'ss-player-radio-source', view.line),
    );
    row.append(art, text);
    return row;
  }

  /** Add to Wanted, full width (the tag instead once it's yours); disabled with its reason. */
  function addNode(st: RadioSessionState, panelView: ScanPanel | null): HTMLElement {
    const box = el(doc, 'div', 'ss-player-radio-addbox');
    const wide = (label: string, attr: string, disabled: boolean, reason: string | null) => {
      const b = el(doc, 'button', 'ss-player-radio-add ss-player-radio-add--wide', label);
      b.type = 'button';
      b.setAttribute(attr, '');
      if (disabled) b.setAttribute('aria-disabled', 'true');
      box.append(b);
      if (reason) {
        const why = el(doc, 'p', 'ss-player-radio-reason', reason);
        why.id = 'ss-player-radio-add-why';
        b.setAttribute('aria-describedby', why.id);
        box.append(why);
      }
      return b;
    };
    const tag = (label: string, tone: string) => {
      const t = el(doc, 'span', 'ss-player-tag ss-player-radio-tag', label);
      t.dataset.tone = tone;
      box.append(t);
    };
    if (panelView?.state === 'identified' && panelView.action) {
      const action = panelView.action;
      if (action === 'in_library') tag('In your library', 'success');
      else if (action === 'on_wanted') tag('On Wanted', 'info');
      else {
        const b = wide(
          action === 'below_target' ? 'Upgrade via Wanted' : 'Add to Wanted',
          'data-player-radio-scan-add',
          action === 'adding_disabled' || st.adding,
          action === 'adding_disabled' ? 'It can be added once it’s in Heard on radio.' : null,
        );
        b.setAttribute('aria-label', `${b.textContent}: ${panelView.title}, ${panelView.line}`);
      }
      return box;
    }
    const np = st.nowPlaying;
    const kind = playerAction(np);
    if (kind === 'in_library') tag('In your library', 'success');
    else if (kind === 'on_wanted') tag('On Wanted', 'info');
    else if (kind === 'add' || kind === 'adding_disabled') {
      const b = wide(
        'Add to Wanted',
        'data-player-radio-add',
        kind === 'adding_disabled' || st.adding,
        kind === 'adding_disabled' ? 'It can be added once it’s in Heard on radio.' : null,
      );
      if (np?.track)
        b.setAttribute('aria-label', `Add ${np.track.title} by ${np.track.artist} to Wanted`);
    } else {
      // nothing identified: disabled-neutral, with the reason under it (11d)
      wide('Add to Wanted', 'data-player-radio-add', true, 'Nothing identified to add yet.');
    }
    return box;
  }

  /** Scan now, full width under Add (11d): in a 4% card with the bar and the words while it runs. */
  function scanNode(st: RadioSessionState, panelView: ScanPanel | null): HTMLElement {
    const services = st.nowPlaying?.scan?.services ?? [];
    const running = panelView?.state === 'listening' || panelView?.state === 'identifying';
    const box = el(doc, 'div', running ? 'ss-player-radio-scancard' : 'ss-player-radio-scanbox');
    if (running) box.dataset.state = panelView!.state;
    box.append(scanButtonNode(st, true));
    if (running && panelView!.progress != null) {
      const bar = el(doc, 'span', 'ss-player-radio-scan-progress');
      bar.setAttribute('aria-hidden', 'true');
      const fill = el(doc, 'span');
      fill.style.width = `${Math.round(panelView!.progress * 100)}%`;
      bar.append(fill);
      box.append(bar);
    }
    const words = sheetScanWords(panelView, services);
    if (words) {
      const p = el(doc, 'p', 'ss-player-radio-scanwords', words.text);
      if (words.danger) p.dataset.tone = 'danger';
      box.append(p);
    } else if (!panelView) {
      const view = scanButton(st);
      if (view.disabled && view.reason)
        box.append(el(doc, 'p', 'ss-player-radio-reason', view.reason));
      else {
        // one line under Scan now, only when a service is refused or out of requests (15b)
        const trouble = scanTrouble(st.nowPlaying?.scan);
        if (trouble) box.append(el(doc, 'p', 'ss-player-radio-scantrouble', trouble.sheet));
      }
    }
    return box;
  }

  /** Volume and Stop (11d): kept across redraws so a drag isn't cut short by a poll. */
  function controlsNode(): HTMLElement {
    const row = el(doc, 'div', 'ss-player-radio-controls');
    row.dataset.radioSheet = 'controls';
    const icon = el(doc, 'span', 'ss-player-radio-volicon');
    icon.innerHTML = SVG_VOLUME;
    const deck = root.querySelector<HTMLInputElement>('.ss-player-volume--deck');
    const vol = el(doc, 'input', 'ss-player-volume ss-player-radio-volume') as HTMLInputElement;
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.step = '1';
    vol.value = deck?.value ?? '70';
    vol.style.setProperty('--vol', `${vol.value}%`);
    vol.setAttribute('aria-label', 'Volume');
    // the player keeps every [data-player-volume] in step; a change goes through the deck's own
    vol.dataset.playerVolume = '';
    vol.dataset.playerRadioVolume = '';
    const stop = el(doc, 'button', 'ss-player-radio-stop ss-player-radio-stop--sheet');
    stop.type = 'button';
    stop.dataset.playerRadioStop = '';
    stop.innerHTML = SVG_STOP;
    stop.append(el(doc, 'span', '', 'Stop'));
    row.append(icon, vol, stop);
    return row;
  }

  /** The two link rows: Heard on <station> today · N, and the Station page. */
  function linksNode(st: RadioSessionState): HTMLElement {
    const station = st.station!;
    const links = el(doc, 'div', 'ss-player-radio-links');
    const row = (text: string, href: `/${string}`, extra: string) => {
      const a = el(doc, 'a', `ss-player-radio-heard ${extra}`) as HTMLAnchorElement;
      a.href = appURL(href);
      a.dataset.playerRadioGo = href;
      a.append(el(doc, 'span', '', text));
      const chev = el(doc, 'span', 'ss-player-radio-chevron');
      chev.innerHTML = SVG_CHEVRON;
      a.append(chev);
      links.append(a);
    };
    const count = stationInfo?.data?.heard_today.identified;
    row(
      `Heard on ${station.name} today${count != null ? ` · ${count}` : ''}`,
      `${stationHref(station.id)}#heard` as `/${string}`,
      'ss-player-radio-link--heard',
    );
    row('Station page', stationHref(station.id), 'ss-player-radio-link--page');
    // Visuals (10e, 10f) from the sheet: the phone has no F key and no "…" here
    const visuals = el(doc, 'button', 'ss-player-radio-heard ss-player-radio-link--visuals');
    visuals.type = 'button';
    visuals.dataset.playerRadioVisuals = '';
    visuals.setAttribute('aria-haspopup', 'dialog');
    visuals.append(el(doc, 'span', '', 'Visuals'));
    const chev = el(doc, 'span', 'ss-player-radio-chevron');
    chev.innerHTML = SVG_CHEVRON;
    visuals.append(chev);
    links.append(visuals);
    return links;
  }

  let headKey = '';
  function drawPanel(): void {
    const panel = root.querySelector<HTMLElement>('[data-player-radio-panel]');
    const st = radio()?.state();
    if (!panel) return;
    if (!st?.station) {
      panel.replaceChildren();
      headKey = '';
      return;
    }
    const keep = focusKey(panel);
    const station = st.station;
    // four parts: the head (redrawn when the station changes), the body, the
    // controls (kept, so the volume can be dragged while a scan polls) and the links
    const part = (name: string) => {
      let node = panel.querySelector<HTMLElement>(`:scope > [data-radio-sheet="${name}"]`);
      if (!node) {
        node = name === 'controls' ? controlsNode() : el(doc, 'div', `ss-player-radio-${name}`);
        node.dataset.radioSheet = name;
      }
      return node;
    };
    const head = part('headbox');
    const body = part('body');
    const controls = part('controls');
    const links = part('linkbox');
    if (panel.children.length !== 4 || panel.children[2] !== controls) {
      panel.replaceChildren(head, body, controls, links);
      headKey = '';
    }
    const key = [station.id, station.name, station.logo_url, sheetStationLine(st)].join('|');
    if (key !== headKey) {
      head.replaceChildren(headNode(st));
      headKey = key;
    }
    const stop = controls.querySelector<HTMLElement>('[data-player-radio-stop]');
    stop?.setAttribute('aria-label', `Stop ${station.name}`);

    const panelView = scanPanel(
      st.scan,
      st.scanError,
      st.scanStarting,
      st.nowPlaying?.scan?.services ?? [],
    );
    if (autoConfirm && autoConfirm.stationId !== station.id) autoConfirm = null;
    const on =
      autoSet?.stationId === station.id
        ? autoSet.on
        : Boolean(stationInfo?.data?.station.auto_add ?? station.auto_add);
    const auto = autoConfirm ? confirmCard(station.name, autoConfirm) : autoRow(station.name, on);
    body.replaceChildren(nowRow(st), addNode(st, panelView), scanNode(st, panelView), auto);
    links.replaceChildren(linksNode(st));
    restoreFocus(panel, keep);
    // the tray's auto-add row follows the same state (9c's confirm swaps in there too)
    drawTrayAuto(st);
  }

  // ── the meter ──────────────────────────────────────────────────────────
  // its bars are counted from its width, kept by a ResizeObserver, so it
  // fills the room it has in the bar and the deck (Ross, 2026-10-23)
  const meterWidths = new WeakMap<Element, number>();
  const resize =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          for (const e of entries) meterWidths.set(e.target, e.contentRect.width);
          // still (reduced motion): draw once at the new width
          if (!meterFrame) drawMeter();
        })
      : null;
  for (const meter of root.querySelectorAll('[data-player-meter]')) resize?.observe(meter);

  // ── the bar's room (148) ───────────────────────────────────────────────
  // Scan now keeps its word only while the track block can still have 240px
  // with the meter at its least; measured, not by breakpoint
  function fitScan(): void {
    for (const slot of root.querySelectorAll<HTMLElement>(
      '.ss-player-bar [data-player-action-slot]',
    )) {
      const centre = slot.parentElement;
      if (!centre || slot.hidden) continue;
      const view = doc.defaultView;
      const width = (n: Element) => n.getBoundingClientRect().width;
      const shown = (n: Element) => view?.getComputedStyle(n).display !== 'none';
      const gap = (n: Element) => parseFloat(view?.getComputedStyle(n).columnGap || '') || 0;
      const meter = centre.querySelector<HTMLElement>('[data-player-meter]');
      const kids = [...centre.children].filter(shown);
      let fixed = Math.max(0, kids.length - 1) * gap(centre);
      for (const k of kids) if (k !== meter && k !== slot) fixed += width(k);
      const inSlot = [...slot.children].filter(shown);
      fixed += Math.max(0, inSlot.length - 1) * gap(slot);
      for (const k of inSlot)
        if (
          !k.classList.contains('ss-player-radio-now') &&
          !k.classList.contains('ss-player-radio-scan')
        )
          fixed += width(k);
      const meterMin = meter ? parseFloat(view?.getComputedStyle(meter).minWidth || '') || 0 : 0;
      const compact = scanIconOnly(width(centre), fixed, meterMin);
      if ((slot.dataset.scanCompact === 'true') !== compact) {
        if (compact) slot.dataset.scanCompact = 'true';
        else delete slot.dataset.scanCompact;
      }
    }
  }
  const roomWatch =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitScan()) : null;
  for (const centre of root.querySelectorAll('.ss-player-bar .ss-player-centre'))
    roomWatch?.observe(centre);

  function ensureBars(meter: HTMLElement, n: number, width: number): HTMLElement[] {
    if (meter.childElementCount !== n) {
      meter.replaceChildren(...Array.from({ length: n }, () => el(doc, 'span')));
    }
    const bw = meterBarWidth(width, n);
    const value = bw ? `${bw}px` : '';
    if (meter.style.getPropertyValue('--meter-bar') !== value) {
      if (value) meter.style.setProperty('--meter-bar', value);
      else meter.style.removeProperty('--meter-bar');
    }
    return [...meter.children] as HTMLElement[];
  }

  // its own tap off the player's analyser (128 bins; the player's has 32), so a
  // wide meter has a bin for each bar; spread logarithmically, as heard
  let tap: AnalyserNode | null = null;
  let tapSource: AnalyserNode | null = null;
  const bins = new Uint8Array(128);
  function meterTap(): AnalyserNode | null {
    const shared = analyser();
    if (!shared) return null;
    if (tap && tapSource === shared) return tap;
    try {
      const node = shared.context.createAnalyser();
      node.fftSize = 256;
      node.smoothingTimeConstant = 0.75;
      shared.connect(node);
      tap = node;
      tapSource = shared;
      return tap;
    } catch {
      return shared;
    }
  }
  function drawMeter(): void {
    meterFrame = 0;
    if (!isRadio()) return;
    const node = meterTap();
    let level: Uint8Array | null = null;
    if (node) {
      try {
        node.getByteFrequencyData(bins);
        level = bins.subarray(0, Math.min(bins.length, node.frequencyBinCount));
      } catch {
        level = null;
      }
    }
    for (const meter of root.querySelectorAll<HTMLElement>('[data-player-meter]')) {
      if (meter.hidden) continue;
      const deck = meter.classList.contains('ss-player-meter--deck');
      const width = meterWidths.get(meter) ?? meter.clientWidth;
      // the deck's bars are a little wider: a bar every 8px, the bar's every 6px
      const n = meterBarCount(width, deck ? 8 : 6);
      const bars = ensureBars(meter, n, width);
      // up to about 10 kHz: above it most stations carry little to show
      const top = level ? Math.max(2, Math.floor(level.length * 0.45)) : 2;
      bars.forEach((bar, i) => {
        const v = level ? (level[meterBin(i, n, top)] ?? 0) : 64;
        bar.style.height = `${Math.max(8, Math.round((v / 255) * 100))}%`;
      });
    }
    if (!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      meterFrame = win.requestAnimationFrame(drawMeter);
    }
  }

  // ── the tray (Ross, 2026-10-23) ────────────────────────────────────────
  const storage = (() => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  })();
  let trayTab: 'heard' | 'recent' = 'heard';
  let heard: {
    stationId: string;
    items: HeardItem[] | null;
    failed: boolean;
    loading: boolean;
    at: number;
  } | null = null;
  let heardBusy: number | null = null;
  let heardKey = '';
  let lastHeardId: number | null | undefined;
  let recentKey = '';
  let rememberedId = '';
  let streamsKey = '';
  let trayAutoKey = '';

  const tray = () => root.querySelector<HTMLElement>('[data-player-radio-tray]');
  const inTray = <T extends Element = HTMLElement>(sel: string): T | null =>
    tray()?.querySelector<T>(sel) ?? null;
  const trayOpen = () => doc.documentElement.getAttribute('data-player') === 'tray' && !isPhone();

  function setText(node: Element | null, text: string): void {
    if (node && node.textContent !== text) node.textContent = text;
  }
  function setHidden(node: Element | null, hidden: boolean): void {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  async function loadHeard(stationId: string): Promise<void> {
    if (heard?.loading && heard.stationId === stationId) return;
    const keep = heard?.stationId === stationId ? heard.items : null;
    heard = { stationId, items: keep, failed: false, loading: true, at: Date.now() };
    drawHeard();
    try {
      const q = new URLSearchParams({ station_id: stationId, days: '1' });
      const res = await fetcher(appURL(`/api/radio/heard?${q.toString()}`), {
        credentials: 'same-origin',
      });
      const body = (await res.json()) as HeardResponse;
      if (heard?.stationId !== stationId) return;
      if (!res.ok || !Array.isArray(body.items)) throw new Error(String(res.status));
      heard = { ...heard, items: body.items, loading: false, failed: false };
    } catch {
      if (heard?.stationId === stationId) heard = { ...heard, loading: false, failed: true };
    }
    drawHeard();
  }

  async function wantHeard(item: HeardItem): Promise<void> {
    if (heardBusy !== null) return;
    heardBusy = item.id;
    drawHeard();
    const toast = (win as Window & { showToast?: (m: string, t: string) => void }).showToast;
    try {
      const res = await fetcher(appURL(`/api/radio/heard/${item.id}/want`), {
        method: 'POST',
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        skipped?: boolean;
      };
      if (!res.ok) toast?.(body.message || 'SYNCHRO.S didn’t take it. Try again.', 'error');
      else
        toast?.(
          body.skipped
            ? body.message || `${item.title} is already in your library.`
            : `Added ${item.title} to Wanted.`,
          body.skipped ? 'info' : 'success',
        );
    } catch {
      toast?.('SYNCHRO.S didn’t answer. Try again in a moment.', 'error');
    }
    heardBusy = null;
    void radio()?.refresh();
    if (heard) void loadHeard(heard.stationId);
  }

  function heardRow(item: HeardItem): HTMLElement {
    const view = heardRowView(item);
    const row = el(doc, 'div', 'ss-player-rtray-row-heard');
    row.setAttribute('role', 'listitem');
    const time = el(doc, 'span', 'ss-player-rtray-time', clockAt(item.heard_at));
    const text = el(doc, 'span', 'ss-player-rtray-text');
    text.append(
      el(doc, 'span', 'ss-player-rtray-title', view.title),
      el(doc, 'span', 'ss-player-rtray-meta', view.line),
    );
    row.append(time, text);
    if (view.action) {
      const label = view.action === 'upgrade' ? 'Upgrade' : 'Add';
      const b = el(doc, 'button', 'ss-player-radio-add', heardBusy === item.id ? 'Adding…' : label);
      b.type = 'button';
      b.dataset.playerRtrayWant = String(item.id);
      b.setAttribute(
        'aria-label',
        `${view.action === 'upgrade' ? 'Upgrade' : 'Add'} ${view.title}${item.artist ? ` by ${item.artist}` : ''} ${view.action === 'upgrade' ? 'via' : 'to'} Wanted`,
      );
      if (heardBusy !== null) b.setAttribute('aria-disabled', 'true');
      row.append(b);
    } else if (view.status) {
      const tag = el(doc, 'span', 'ss-player-rtray-status', view.status.label);
      tag.dataset.tone = view.status.tone;
      row.append(tag);
    } else row.append(el(doc, 'span'));
    return row;
  }

  function clockAt(unix: number): string {
    return new Date(unix * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function drawHeard(): void {
    const st = radio()?.state();
    const list = inTray('[data-player-rtray-heard-list]');
    const status = inTray('[data-player-rtray-heard-status]');
    if (!list || !status || !st?.station) return;
    const today =
      heard?.stationId === st.station.id && heard.items ? heardToday(heard.items) : null;
    // 143: the tab counts identified tracks; the rest fold into one line at the end
    const fold = today ? heardFold(today) : null;
    const items = fold ? fold.rows : null;
    setText(inTray('[data-player-rtray-heard-count]'), String(fold?.count ?? 0));
    setAttr(
      inTray('[data-player-rtray-tab="heard"]'),
      'aria-label',
      `Heard today, ${fold?.count ?? 0} identified`,
    );
    const key = JSON.stringify([
      st.station.id,
      heard?.failed,
      heard?.loading && !items,
      heardBusy,
      items?.map((i) => [i.id, i.state, i.below_target]),
      fold?.rest,
    ]);
    if (key === heardKey) return;
    heardKey = key;
    const keep = doc.activeElement as HTMLElement | null;
    const keepId = list.contains(keep) ? keep?.dataset.playerRtrayWant : undefined;
    // the folded line sits after the list, not in it (it isn't a track)
    const rest = inTray('[data-player-rtray-heard-rest]');
    if (!items) {
      setHidden(rest, true);
      list.replaceChildren();
      status.replaceChildren();
      if (heard?.failed) {
        status.append(el(doc, 'span', '', 'Heard today didn’t load. '));
        const retry = el(doc, 'button', 'ss-player-text-btn', 'Try again');
        retry.type = 'button';
        retry.dataset.playerRtrayHeardRetry = '';
        status.append(retry);
      } else status.textContent = 'Loading what was heard today…';
      status.hidden = false;
      return;
    }
    setText(rest, fold?.rest ?? '');
    setHidden(rest, !fold?.rest);
    if (!items.length && !fold?.rest) {
      list.replaceChildren();
      status.textContent = `Nothing heard on ${st.station.name} today yet. Tracks show here as they’re identified while you listen.`;
      status.hidden = false;
      return;
    }
    status.hidden = true;
    list.replaceChildren(...items.map(heardRow));
    if (keepId)
      (
        list.querySelector<HTMLElement>(`[data-player-rtray-want="${keepId}"]`) ??
        inTray<HTMLElement>('[data-player-rtray-tab="heard"]')
      )?.focus();
  }

  function stationRow(s: RecentStation, current: boolean): HTMLElement {
    const row = el(doc, 'div', 'ss-player-rtray-row-station');
    row.setAttribute('role', 'listitem');
    if (current) row.setAttribute('aria-current', 'true');
    const logo = el(doc, 'span', 'ss-player-rtray-stationlogo');
    logo.setAttribute('aria-hidden', 'true');
    fillLogo(logo, s);
    const text = el(doc, 'span', 'ss-player-rtray-text');
    text.append(
      el(doc, 'span', 'ss-player-rtray-title', s.name),
      el(doc, 'span', 'ss-player-rtray-meta', cardSubline(recentAsStation(s))),
    );
    row.append(logo, text);
    if (current) {
      const tag = el(doc, 'span', 'ss-player-tag', 'Playing');
      tag.dataset.tone = 'info';
      row.append(tag);
    } else {
      const play = el(doc, 'button', 'ss-player-btn ss-player-rtray-play');
      play.type = 'button';
      play.dataset.playerRtrayPlay = s.id;
      play.setAttribute('aria-label', `Play ${s.name}`);
      play.innerHTML = SVG_PLAY;
      row.append(play);
    }
    return row;
  }

  function drawRecent(st: RadioSessionState): void {
    const list = inTray('[data-player-rtray-recent-list]');
    const status = inTray('[data-player-rtray-recent-status]');
    if (!list || !status) return;
    const items = readRecentStations(storage);
    const key = JSON.stringify([
      st.station?.id,
      items.map((s) => [s.id, s.name, s.logo_url, s.source, s.added_by]),
    ]);
    if (key === recentKey) return;
    recentKey = key;
    const focused = doc.activeElement as HTMLElement | null;
    const keepId = list.contains(focused) ? focused?.dataset.playerRtrayPlay : undefined;
    if (!items.length) {
      list.replaceChildren();
      status.textContent =
        'Stations you play show here, newest first, on every device you use, so you can go back to one.';
      status.hidden = false;
      return;
    }
    status.hidden = true;
    list.replaceChildren(...items.map((s) => stationRow(s, s.id === st.station?.id)));
    if (keepId) list.querySelector<HTMLElement>(`[data-player-rtray-play="${keepId}"]`)?.focus();
  }

  // ── Stations on the server, per profile (HANDOFF 142, 163) ─────────────
  // this browser's copy is the first paint; the server's list is read when
  // the tray opens (at most once a minute) and after a station is counted,
  // then merged over it and kept as the next first paint
  let recentAt = 0;
  let recentLoading = false;
  let recentTimer: ReturnType<typeof setTimeout> | null = null;
  let recentFor = '';
  const recentSent = new Set<string>();

  async function loadRecent(): Promise<void> {
    if (recentLoading) return;
    recentLoading = true;
    recentAt = Date.now();
    try {
      const res = await fetcher(appURL('/api/radio/recent'), { credentials: 'same-origin' });
      const body = (await res.json().catch(() => ({}))) as { stations?: unknown };
      if (res.ok && Array.isArray(body.stations)) {
        keepRecentStations(
          storage,
          mergeRecent(readRecentStations(storage), serverRecent(body.stations)),
        );
        recentKey = '';
        const st = radio()?.state();
        if (st?.station) drawRecent(st);
      }
    } catch {
      // the browser's own list stays
    } finally {
      recentLoading = false;
    }
  }

  /** After 30 s of play the station counts for this profile, once per session. */
  function scheduleRecent(st: RadioSessionState): void {
    const sid = st.status === 'playing' && st.sessionId ? st.sessionId : '';
    if (sid === recentFor) return;
    if (recentTimer) clearTimeout(recentTimer);
    recentTimer = null;
    recentFor = sid;
    if (!sid || recentSent.has(sid)) return;
    recentTimer = setTimeout(() => {
      recentTimer = null;
      void sendRecent(sid);
    }, RECENT_AFTER_MS);
  }

  async function sendRecent(sid: string): Promise<void> {
    const now = radio()?.state();
    if (now?.sessionId !== sid || now.status !== 'playing') return;
    recentSent.add(sid);
    try {
      const res = await fetcher(appURL('/api/radio/recent'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid }),
      });
      if (res.ok) await loadRecent();
    } catch {
      // counted next time it plays
    }
  }

  function setAttr(node: Element | null, name: string, value: string): void {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function selectTab(tab: 'heard' | 'recent', focus = false): void {
    trayTab = tab;
    for (const b of tray()?.querySelectorAll<HTMLElement>('[data-player-rtray-tab]') ?? []) {
      const on = b.dataset.playerRtrayTab === tab;
      setAttr(b, 'aria-selected', on ? 'true' : 'false');
      setAttr(b, 'tabindex', on ? '0' : '-1');
      if (on && focus) b.focus();
    }
    for (const p of tray()?.querySelectorAll<HTMLElement>('[data-player-rtray-panel]') ?? []) {
      p.classList.toggle('hidden', p.dataset.playerRtrayPanel !== tab);
    }
    // 146: auto-add belongs to what this station played, so it shows on Heard today only
    setHidden(inTray('[data-player-rtray-auto]'), tab !== 'heard');
    drawFoot();
  }

  function drawFoot(): void {
    const foot = inTray('[data-player-rtray-foot]');
    const station = radio()?.state().station;
    if (!foot || !station) return;
    const href: `/${string}` = trayTab === 'heard' ? stationHref(station.id) : '/radio';
    const text =
      trayTab === 'heard'
        ? `All of it on ${stationPossessive(station.name)} page`
        : 'All stations on the Radio page';
    const a = foot.querySelector<HTMLAnchorElement>('a');
    if (a && a.dataset.playerRadioGo === href && a.textContent === text) return;
    const link = el(doc, 'a', '', text) as HTMLAnchorElement;
    link.href = appURL(href);
    link.dataset.playerRadioGo = href;
    foot.replaceChildren(link);
  }

  function drawTrayAuto(st: RadioSessionState): void {
    const box = inTray('[data-player-rtray-auto]');
    const station = st.station;
    if (!box || !station) return;
    const on =
      autoSet?.stationId === station.id
        ? autoSet.on
        : Boolean(stationInfo?.data?.station.auto_add ?? station.auto_add);
    const c = autoConfirm?.stationId === station.id ? autoConfirm : null;
    const key = JSON.stringify([station.id, station.name, on, c]);
    if (key === trayAutoKey) return;
    trayAutoKey = key;
    const keep = focusKey(box);
    box.replaceChildren(c ? confirmCard(station.name, c, 'tray') : autoRow(station.name, on));
    restoreFocus(box, keep);
  }

  function drawTray(st: RadioSessionState): void {
    const box = tray();
    const station = st.station;
    if (!box || !station) return;
    // the record: the logo, Now playing, the readout, Add or the tag
    const logoTile = inTray('.ss-player-rtray-logo');
    if (logoTile) fillLogo(logoTile, station, inTray('[data-player-rtray-letters]'));
    const view = sheetNowPlaying(st);
    const np = scanAnswer(st.scan) ?? st.nowPlaying;
    const named = np?.state === 'identified' && np.track ? np.track : null;
    setText(inTray('[data-player-rtray-label]'), view.label);
    setText(inTray('[data-player-rtray-title]'), view.title);
    const artistLink = inTray<HTMLAnchorElement>('[data-player-rtray-artist]');
    if (artistLink) {
      setHidden(artistLink, !named?.artist);
      if (named?.artist) {
        setText(artistLink, named.artist);
        const q = new URLSearchParams({ q: named.artist, type: 'artists' });
        setAttr(artistLink, 'href', appURL(`/search?${q.toString()}`));
        artistLink.dataset.playerRadioGo = `/search?${q.toString()}`;
        setAttr(artistLink, 'aria-label', `Search for ${named.artist}`);
      }
    }
    setHidden(inTray('[data-player-rtray-artist-plain]'), true);
    setText(
      inTray('[data-player-rtray-line]'),
      named && np
        ? [named.release, agoWords(secondsSince(np, st.skew))].filter(Boolean).join(' · ')
        : view.line,
    );
    setText(inTray('[data-player-rtray-stream]'), streamReadout(st.stream, station, st.mode));
    const out = root.querySelector('[data-player-output-label]')?.textContent || 'This device';
    setText(inTray('[data-player-rtray-path]'), pathLabel(station.name, out));
    const actionBox = inTray('[data-player-rtray-action]');
    if (actionBox) {
      const keep = focusKey(actionBox);
      const services = st.nowPlaying?.scan?.services ?? [];
      const panel = scanPanel(st.scan, st.scanError, st.scanStarting, services);
      let action =
        panel?.state === 'identified' ? scanActionNode(panel, false, st) : actionNode(st, false);
      if (!action) {
        // nothing identified yet: disabled-neutral, its reason as the title (as in the bar)
        const b = el(doc, 'button', 'ss-player-radio-add', 'Add to Wanted');
        b.type = 'button';
        b.dataset.playerRadioAdd = '';
        b.setAttribute('aria-disabled', 'true');
        b.title = 'Nothing identified to add yet.';
        b.setAttribute('aria-label', 'Add to Wanted. Nothing identified to add yet.');
        action = b;
      }
      actionBox.replaceChildren(action);
      restoreFocus(actionBox, keep);
    }

    // the deck: the stream picker, Scan now and its words
    const select = inTray<HTMLSelectElement>('[data-player-rtray-streams]');
    if (select) {
      const streams = station.streams ?? [];
      const key = JSON.stringify([station.id, streams.map((x) => [x.id, x.label])]);
      if (key !== streamsKey) {
        streamsKey = key;
        select.replaceChildren(
          ...streams.map((x) => {
            const o = el(doc, 'option', '', x.label) as HTMLOptionElement;
            o.value = x.id;
            return o;
          }),
        );
      }
      setHidden(select, streams.length < 2);
      const cur = st.stream?.id ?? '';
      if (doc.activeElement !== select && cur && select.value !== cur) select.value = cur;
    }
    const scanBox = inTray('[data-player-rtray-scan]');
    const services = st.nowPlaying?.scan?.services ?? [];
    const panelView = scanPanel(st.scan, st.scanError, st.scanStarting, services);
    if (scanBox) {
      const keep = focusKey(scanBox);
      scanBox.replaceChildren(scanButtonNode(st, false));
      restoreFocus(scanBox, keep);
    }
    const words = inTray('[data-player-rtray-scanwords]');
    if (words) {
      const running = panelView?.state === 'listening' || panelView?.state === 'identifying';
      const parts: HTMLElement[] = [];
      if (running && panelView!.progress != null) {
        const bar = el(doc, 'span', 'ss-player-radio-scan-progress');
        bar.setAttribute('aria-hidden', 'true');
        const fill = el(doc, 'span');
        fill.style.width = `${Math.round(panelView!.progress * 100)}%`;
        bar.append(fill);
        parts.push(bar);
      }
      const said = sheetScanWords(panelView, services);
      if (said) {
        const p = el(doc, 'p', '', said.text);
        if (said.danger) p.dataset.tone = 'danger';
        parts.push(p);
      } else if (!panelView) {
        const sb = scanButton(st);
        const trouble = sb.disabled ? null : scanTrouble(st.nowPlaying?.scan);
        if (trouble) parts.push(el(doc, 'p', '', trouble.sheet));
      }
      words.replaceChildren(...parts);
      setHidden(words, !parts.length);
    }

    // the list
    drawHeard();
    drawRecent(st);
    drawTrayAuto(st);
    drawFoot();
  }

  function drawListened(): void {
    const node = inTray('[data-player-rtray-listened]');
    if (!node || !isRadio()) return;
    const a =
      (
        win as Window & { SoulSyncPlayer?: { audio?: () => HTMLAudioElement | null } }
      ).SoulSyncPlayer?.audio?.() ?? doc.querySelector<HTMLAudioElement>('#audio-player');
    const t = a && Number.isFinite(a.currentTime) ? a.currentTime : 0;
    setText(node, formatClock(t));
  }

  // ── the Visuals overlay's header ───────────────────────────────────────
  function drawVisualsHeader(st: RadioSessionState): void {
    const head = radioVisualsHeader(st);
    if (!head) return;
    setText(doc.getElementById('np-v2-visuals-title'), head.title);
    setText(doc.getElementById('np-v2-visuals-artist'), head.line);
    const art = doc.getElementById('np-v2-visuals-art') as HTMLImageElement | null;
    if (art) {
      const src = head.art
        ? head.art.startsWith('/')
          ? appURL(head.art as `/${string}`)
          : head.art
        : '';
      if (!src || art.dataset.broken === src) {
        art.hidden = true;
        return;
      }
      art.onerror = () => {
        art.dataset.broken = src;
        art.hidden = true;
      };
      if (art.getAttribute('src') !== src) art.setAttribute('src', src);
      art.hidden = false;
    }
  }

  function draw(): void {
    const st = radio()?.state();
    if (!st || !isRadio()) {
      if (meterFrame) win.cancelAnimationFrame(meterFrame);
      meterFrame = 0;
      if (tick) clearInterval(tick);
      tick = null;
      return;
    }
    drawSlot(st);
    drawPanel();
    drawTray(st);
    drawVisualsHeader(st);
    if (st.station && stationInfo?.id !== st.station.id) void loadStation(st.station.id);
    if (st.station && st.status === 'playing' && rememberedId !== st.station.id) {
      rememberedId = st.station.id;
      rememberStation(storage, st.station);
      recentKey = '';
      drawRecent(st);
    }
    scheduleRecent(st);
    if (trayOpen() && !recentLoading && Date.now() - recentAt > 60_000) void loadRecent();
    // Heard today: read when the tray opens or the station changes, and again
    // when the station names a new track (at most every 15 s)
    if (st.station && trayOpen()) {
      const hid = st.nowPlaying?.heard_id ?? null;
      const stale = heard?.stationId !== st.station.id;
      const moved = hid !== lastHeardId && Date.now() - (heard?.at ?? 0) > 15_000;
      if (stale || (moved && !heard?.loading)) {
        lastHeardId = hid;
        void loadHeard(st.station.id);
      }
    }
    if (!meterFrame) meterFrame = win.requestAnimationFrame(drawMeter);
    // "identified 40 s ago" keeps counting between polls
    if (!tick)
      tick = setInterval(() => {
        if (!isRadio()) return;
        const now = radio()!.state();
        drawSlot(now);
        drawTray(now);
      }, 5000);
  }

  // ── events ─────────────────────────────────────────────────────────────
  const onClick = async (event: Event) => {
    if (!isRadio()) return;
    const target = event.target as Element | null;
    // the tray's list (Ross, 2026-10-23)
    const tab = target?.closest<HTMLElement>('[data-player-rtray-tab]');
    if (tab) {
      event.preventDefault();
      selectTab(tab.dataset.playerRtrayTab === 'recent' ? 'recent' : 'heard');
      return;
    }
    const want = target?.closest<HTMLElement>('[data-player-rtray-want]');
    if (want) {
      event.preventDefault();
      if (want.getAttribute('aria-disabled') === 'true') return;
      const item = heard?.items?.find((i) => String(i.id) === want.dataset.playerRtrayWant);
      if (item) await wantHeard(item);
      return;
    }
    if (target?.closest('[data-player-rtray-heard-retry]')) {
      event.preventDefault();
      const st = radio()?.state();
      if (st?.station) void loadHeard(st.station.id);
      return;
    }
    const playBtn = target?.closest<HTMLElement>('[data-player-rtray-play]');
    if (playBtn) {
      event.preventDefault();
      const s = readRecentStations(storage).find((x) => x.id === playBtn.dataset.playerRtrayPlay);
      if (s) await radio()?.play(s.id, { station: recentAsStation(s) });
      return;
    }
    if (target?.closest('[data-player-radio-visuals]')) {
      event.preventDefault();
      // the sheet closes first; the overlay gives the focus back to the mini bar
      root.querySelector<HTMLElement>('[data-player-sheet-close]')?.click();
      (win as Window & { npV2?: { openVisuals?: () => void } }).npV2?.openVisuals?.();
      return;
    }
    const add = target?.closest<HTMLElement>('[data-player-radio-add]');
    if (add) {
      event.preventDefault();
      if (add.getAttribute('aria-disabled') === 'true') return;
      const ok = await radio()?.addToWanted();
      if (ok)
        (win as Window & { showToast?: (m: string, t: string) => void }).showToast?.(
          'Added to Wanted.',
          'success',
        );
      return;
    }
    const scanBtn = target?.closest<HTMLElement>('[data-player-radio-scan]');
    if (scanBtn) {
      event.preventDefault();
      if (scanBtn.getAttribute('aria-disabled') === 'true') return;
      await radio()?.scanNow?.();
      return;
    }
    const scanAdd = target?.closest<HTMLElement>('[data-player-radio-scan-add]');
    if (scanAdd) {
      event.preventDefault();
      if (scanAdd.getAttribute('aria-disabled') === 'true') return;
      const ok = await radio()?.addScanToWanted?.();
      if (ok)
        (win as Window & { showToast?: (m: string, t: string) => void }).showToast?.(
          'Added to Wanted.',
          'success',
        );
      return;
    }
    if (target?.closest('[data-player-radio-close]')) {
      event.preventDefault();
      root.querySelector<HTMLElement>('[data-player-sheet-close]')?.click();
      return;
    }
    if (target?.closest('[data-player-radio-stop]')) {
      event.preventDefault();
      await radio()?.stop();
      return;
    }
    const goto = target?.closest<HTMLElement>('[data-player-radio-go], [data-player-station]');
    if (goto) {
      event.preventDefault();
      const st = radio()?.state();
      const href =
        (goto.dataset.playerRadioGo as `/${string}` | undefined) ??
        (st?.station ? stationHref(st.station.id) : '/radio');
      root.querySelector<HTMLElement>('[data-player-sheet-close]')?.click();
      go(win, href);
      return;
    }
    const confirmBtn = target?.closest<HTMLElement>('[data-player-radio-auto-confirm]');
    if (confirmBtn) {
      event.preventDefault();
      const st = radio()?.state();
      if (!st?.station || !autoConfirm || confirmBtn.getAttribute('aria-disabled') === 'true')
        return;
      const id = st.station.id;
      const name = st.station.name;
      autoConfirm.busy = true;
      autoConfirm.failed = null;
      drawPanel();
      const failed = await setAutoAdd(id, true);
      if (autoConfirm?.stationId !== id) return;
      if (failed) {
        autoConfirm.busy = false;
        autoConfirm.failed = failed;
        drawPanel();
        return;
      }
      autoConfirm = null;
      autoSet = { stationId: id, on: true };
      if (stationInfo) stationInfo.data = null;
      drawPanel();
      focusHere('[data-player-radio-auto]');
      (win as Window & { showToast?: (m: string, t: string) => void }).showToast?.(
        `Auto-add is on for ${name}.`,
        'success',
      );
      void loadStation(id);
      return;
    }
    if (target?.closest('[data-player-radio-auto-cancel]')) {
      event.preventDefault();
      // Not now: the switch row comes back, off
      autoConfirm = null;
      drawPanel();
      focusHere('[data-player-radio-auto]');
      return;
    }
    const sw = target?.closest<HTMLElement>('[data-player-radio-auto]');
    if (sw) {
      event.preventDefault();
      const st = radio()?.state();
      if (!st?.station) return;
      const id = st.station.id;
      if (sw.dataset.playerRadioAuto === 'on') {
        // turning off stays immediate
        const failed = await setAutoAdd(id, false);
        if (failed) {
          (win as Window & { showToast?: (m: string, t: string) => void }).showToast?.(
            failed,
            'error',
          );
          return;
        }
        autoSet = { stationId: id, on: false };
        if (stationInfo) stationInfo.data = null;
        drawPanel();
        void loadStation(id);
      } else {
        // turning it on asks first, with the numbers, in the sheet (9c)
        void openAutoConfirm(id);
      }
    }
  };
  // the tabs: the arrow keys move between Heard today and Recent stations
  const onKey = (event: Event) => {
    const ev = event as KeyboardEvent;
    const tab = (ev.target as Element | null)?.closest?.('[data-player-rtray-tab]');
    if (!tab || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
    ev.preventDefault();
    selectTab(trayTab === 'heard' ? 'recent' : 'heard', true);
  };
  // another of the station's streams: the station restarts on it
  const onChange = (event: Event) => {
    const select = event.target as HTMLSelectElement | null;
    if (!select?.matches?.('[data-player-rtray-streams]')) return;
    const st = radio()?.state();
    if (!st?.station || select.value === st.stream?.id) return;
    void radio()?.play(st.station.id, { streamId: select.value, station: st.station });
  };
  // the sheet's volume goes through the deck's slider, which the player listens to
  const onInput = (event: Event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches?.('[data-player-radio-volume]')) return;
    input.style.setProperty('--vol', `${input.value}%`);
    const deck = root.querySelector<HTMLInputElement>('.ss-player-volume--deck');
    if (!deck || deck === input) return;
    deck.value = input.value;
    deck.dispatchEvent(new Event('input', { bubbles: true }));
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  // the time listened runs with the stream
  const audioEl =
    (
      win as Window & { SoulSyncPlayer?: { audio?: () => HTMLAudioElement | null } }
    ).SoulSyncPlayer?.audio?.() ?? doc.querySelector<HTMLAudioElement>('#audio-player');
  audioEl?.addEventListener('timeupdate', drawListened);
  // the tray opening (html[data-player="tray"]) reads Heard today
  const layout =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (trayOpen()) draw();
        })
      : null;
  layout?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-player'] });
  win.addEventListener(RADIO_EVENT, draw);
  win.addEventListener('ss:player', draw);
  cleanups.push(
    () => root.removeEventListener('click', onClick),
    () => root.removeEventListener('keydown', onKey),
    () => root.removeEventListener('change', onChange),
    () => audioEl?.removeEventListener('timeupdate', drawListened),
    () => layout?.disconnect(),
    () => resize?.disconnect(),
    () => roomWatch?.disconnect(),
    () => root.removeEventListener('input', onInput),
    () => win.removeEventListener(RADIO_EVENT, draw),
    () => win.removeEventListener('ss:player', draw),
  );
  selectTab('heard');
  draw();
  return {
    draw,
    dispose() {
      cleanups.forEach((fn) => fn());
      if (meterFrame) win.cancelAnimationFrame(meterFrame);
      if (tick) clearInterval(tick);
      if (recentTimer) clearTimeout(recentTimer);
    },
  };
}
