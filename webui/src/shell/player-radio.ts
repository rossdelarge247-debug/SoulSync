/**
 * The player's radio mode (build e; boards 4a, 4b, 4i, 4j), on the seam the
 * player left for it (player-state.ts sourceView('radio'): a Live tag for the
 * times, a level meter for the waveform, one action slot).
 *
 * - The bar: the identified track with "identified 40 s ago" and ONE action,
 *   the primary Add to Wanted or the In your library tag; then Station and
 *   Stop on the right (index.html; static/player.css hides Up next, Expand
 *   and Pause for radio).
 * - The phone's mini bar: Add (or the tag) and Stop; it opens the sheet with
 *   the station's card, Add, the auto-add switch, volume and Stop, and a link
 *   to today's Heard list (4j). Switching auto-add on swaps the switch row
 *   for the confirm with the three numbers, in the sheet (9c); off is at once.
 * - The level meter, drawn from the player's analyser while radio plays.
 * - Scan now (11a, HANDOFF 58): the quiet 132px control after the one
 *   action (icon-only under 1180px), and full width in the sheet. While it
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
 * Every word from a station or a track goes in with textContent.
 */

import type {
  AutoAddNumbers,
  RadioSessionApi,
  RadioSessionState,
  StationResponse,
} from '@/features/radio/radio.types';

import {
  agoWords,
  nowLines,
  playerAction,
  secondsSince,
  sourceWords,
} from '@/features/radio/radio.format';
import { scanAnswer, scanButton, scanPanel, type ScanPanel } from '@/features/radio/radio.scan';
import { RADIO_EVENT } from '@/features/radio/radio.types';
import { appURL } from '@/platform/url-base';

const SVG_STOP =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const SVG_NOTE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const SVG_SCAN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></svg>';
const SPINNER = '<span class="ss-player-radio-spinner" aria-hidden="true"></span>';
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

  /** The auto-add switch row (4j). */
  function autoRow(stationName: string, on: boolean): HTMLElement {
    const auto = el(doc, 'div', 'ss-player-radio-auto');
    const sw = el(doc, 'button', 'ss-player-radio-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.dataset.playerRadioAuto = on ? 'on' : 'off';
    sw.append(
      el(doc, 'span', 'ss-player-radio-switch-track'),
      el(doc, 'span', 'ss-player-radio-switch-text', on ? 'On' : 'Off'),
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
  function confirmCard(stationName: string, c: NonNullable<typeof autoConfirm>): HTMLElement {
    const n = c.numbers;
    const card = el(doc, 'div', 'ss-player-radio-confirm');
    card.setAttribute('role', 'group');
    const titleId = 'ss-player-radio-confirm-title';
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
    root.querySelector<HTMLElement>('[data-player-radio-auto-cancel]')?.focus();
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
    root.querySelector<HTMLElement>('[data-player-radio-auto-confirm]')?.focus();
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

  function drawPanel(): void {
    const panel = root.querySelector<HTMLElement>('[data-player-radio-panel]');
    const st = radio()?.state();
    if (!panel) return;
    const keep = focusKey(panel);
    panel.replaceChildren();
    if (!st?.station) return;
    const station = st.station;
    const np = st.nowPlaying;
    const lines = nowLines(np, st.skew);

    const head = el(doc, 'div', 'ss-player-radio-head');
    const name = el(doc, 'span', 'ss-player-radio-name', station.name);
    const live = el(doc, 'span', 'ss-player-live-tag');
    live.append(el(doc, 'span', 'ss-player-live-dot'), doc.createTextNode('Live'));
    const page = el(doc, 'a', 'ss-player-link', 'Station page') as HTMLAnchorElement;
    page.href = appURL(stationHref(station.id));
    page.dataset.playerRadioGo = stationHref(station.id);
    head.append(name, live, page);

    const art = el(doc, 'span', 'ss-player-radio-art');
    if (np?.track?.art_url) {
      const img = el(doc, 'img');
      img.alt = '';
      img.src = np.track.art_url;
      img.onerror = () => img.remove();
      art.append(img);
    } else {
      art.innerHTML = SVG_NOTE;
    }

    const label = el(doc, 'p', 'ss-player-label', 'Now playing');
    const title = el(doc, 'p', 'ss-player-radio-title', lines.title);
    const card = el(doc, 'div', 'ss-player-radio-card');
    card.append(label, title);
    if (np?.state === 'identified' && np.track) {
      card.append(
        el(
          doc,
          'p',
          'ss-player-radio-line',
          [np.track.artist, np.track.release].filter(Boolean).join(' · '),
        ),
      );
      const src = [
        sourceWords(np.source),
        agoWords(secondsSince(np, st.skew)),
        st.stream?.label.replace(' (best offered)', ''),
      ]
        .filter(Boolean)
        .join(' · ');
      card.append(el(doc, 'p', 'ss-player-radio-source', src));
    } else {
      card.append(el(doc, 'p', 'ss-player-radio-source', np?.reason || lines.line));
    }
    // a live region: "Listening…" and the name that follows are announced
    card.setAttribute('aria-live', 'polite');

    const actions = el(doc, 'div', 'ss-player-radio-actions');
    const kind = playerAction(np);
    if (kind === 'add' || kind === 'adding_disabled') {
      const b = el(doc, 'button', 'ss-player-radio-add ss-player-radio-add--wide', 'Add to Wanted');
      b.type = 'button';
      b.dataset.playerRadioAdd = '';
      if (kind === 'adding_disabled' || st.adding) b.setAttribute('aria-disabled', 'true');
      actions.append(b);
    } else if (kind === 'in_library') {
      const tag = el(doc, 'span', 'ss-player-tag ss-player-radio-tag', 'In your library');
      tag.dataset.tone = 'success';
      actions.append(tag);
    } else if (kind === 'on_wanted') {
      const tag = el(doc, 'span', 'ss-player-tag ss-player-radio-tag', 'On Wanted');
      tag.dataset.tone = 'info';
      actions.append(tag);
    } else {
      const b = el(doc, 'button', 'ss-player-radio-add ss-player-radio-add--wide', 'Add to Wanted');
      b.type = 'button';
      b.setAttribute('aria-disabled', 'true');
      b.title = 'Once it’s identified';
      actions.append(b);
    }

    const scan = el(doc, 'div', 'ss-player-radio-scanbox');
    const panelView = scanPanel(
      st.scan,
      st.scanError,
      st.scanStarting,
      st.nowPlaying?.scan?.services ?? [],
    );
    if (panelView) {
      const result = el(doc, 'div', 'ss-player-radio-scanresult');
      result.dataset.state = panelView.state;
      result.append(
        el(doc, 'p', 'ss-player-label', 'Scan now'),
        el(doc, 'p', 'ss-player-radio-scan-title', panelView.title),
      );
      if (panelView.line) result.append(el(doc, 'p', 'ss-player-radio-line', panelView.line));
      if (panelView.note) result.append(el(doc, 'p', 'ss-player-radio-source', panelView.note));
      if (panelView.progress != null) {
        const bar = el(doc, 'span', 'ss-player-radio-scan-progress');
        const fill = el(doc, 'span');
        fill.style.width = `${Math.round(panelView.progress * 100)}%`;
        bar.append(fill);
        bar.setAttribute('aria-hidden', 'true');
        result.append(bar);
      }
      // no Done (HANDOFF 58): the answer stays until the station names the next track
      const act = panelView.state === 'identified' ? scanActionNode(panelView, false, st) : null;
      if (act) {
        const row = el(doc, 'div', 'ss-player-radio-scan-row');
        row.append(act);
        result.append(row);
      }
      scan.append(result);
    }
    scan.append(scanButtonNode(st, true));
    const scanReason = scanButton(st);
    if (!panelView && scanReason.disabled && scanReason.reason) {
      scan.append(el(doc, 'p', 'ss-player-radio-source', scanReason.reason));
    }

    if (autoConfirm && autoConfirm.stationId !== station.id) autoConfirm = null;
    const on =
      autoSet?.stationId === station.id
        ? autoSet.on
        : Boolean(stationInfo?.data?.station.auto_add ?? station.auto_add);
    const auto = autoConfirm ? confirmCard(station.name, autoConfirm) : autoRow(station.name, on);

    const heard = el(doc, 'a', 'ss-player-radio-heard') as HTMLAnchorElement;
    const count = stationInfo?.data?.heard_today.identified;
    heard.href = appURL(`${stationHref(station.id)}#heard`);
    heard.dataset.playerRadioGo = `${stationHref(station.id)}#heard`;
    heard.append(
      el(doc, 'span', '', `Heard on ${station.name} today${count != null ? ` · ${count}` : ''}`),
    );
    const chev = el(doc, 'span', 'ss-player-radio-chevron');
    chev.innerHTML = SVG_CHEVRON;
    heard.append(chev);

    const stop = el(
      doc,
      'button',
      'ss-player-btn ss-player-radio-stop ss-player-radio-stop--sheet',
    );
    stop.type = 'button';
    stop.dataset.playerRadioStop = '';
    stop.setAttribute('aria-label', `Stop ${station.name}`);
    stop.innerHTML = SVG_STOP;
    const controls = el(doc, 'div', 'ss-player-radio-controls');
    controls.append(stop);

    panel.append(head, art, card, actions, scan, auto, controls, heard);
    restoreFocus(panel, keep);
  }

  // ── the meter ──────────────────────────────────────────────────────────
  function ensureBars(meter: HTMLElement, n: number): HTMLElement[] {
    if (meter.childElementCount !== n) {
      meter.replaceChildren(...Array.from({ length: n }, () => el(doc, 'span')));
    }
    return [...meter.children] as HTMLElement[];
  }

  const bins = new Uint8Array(64);
  function drawMeter(): void {
    meterFrame = 0;
    if (!isRadio()) return;
    const node = analyser();
    let level: number[] | null = null;
    if (node) {
      try {
        node.getByteFrequencyData(bins);
        level = Array.from(bins.slice(0, Math.min(bins.length, node.frequencyBinCount)));
      } catch {
        level = null;
      }
    }
    for (const meter of root.querySelectorAll<HTMLElement>('[data-player-meter]')) {
      if (meter.hidden) continue;
      const n = meter.classList.contains('ss-player-meter--deck') ? 48 : 24;
      const bars = ensureBars(meter, n);
      bars.forEach((bar, i) => {
        const v = level ? (level[Math.floor((i / n) * Math.max(1, level.length - 8))] ?? 0) : 64;
        bar.style.height = `${Math.max(8, Math.round((v / 255) * 100))}%`;
      });
    }
    if (!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      meterFrame = win.requestAnimationFrame(drawMeter);
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
    if (st.station && stationInfo?.id !== st.station.id) void loadStation(st.station.id);
    if (!meterFrame) meterFrame = win.requestAnimationFrame(drawMeter);
    // "identified 40 s ago" keeps counting between polls
    if (!tick) tick = setInterval(() => isRadio() && drawSlot(radio()!.state()), 5000);
  }

  // ── events ─────────────────────────────────────────────────────────────
  const onClick = async (event: Event) => {
    if (!isRadio()) return;
    const target = event.target as Element | null;
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
      root.querySelector<HTMLElement>('[data-player-radio-auto]')?.focus();
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
      root.querySelector<HTMLElement>('[data-player-radio-auto]')?.focus();
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
  // the bar's left button opens the station's page on a desktop (the tray
  // isn't drawn for radio); on a phone it opens the sheet as always
  const onToggle = (event: Event) => {
    if (!isRadio() || win.matchMedia?.('(max-width: 768px)').matches) return;
    const target = event.target as Element | null;
    if (!target?.closest('.ss-player-bar [data-player-toggle]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const st = radio()?.state();
    if (st?.station) go(win, stationHref(st.station.id));
  };
  root.addEventListener('click', onClick);
  root.addEventListener('click', onToggle, true);
  win.addEventListener(RADIO_EVENT, draw);
  win.addEventListener('ss:player', draw);
  cleanups.push(
    () => root.removeEventListener('click', onClick),
    () => root.removeEventListener('click', onToggle, true),
    () => win.removeEventListener(RADIO_EVENT, draw),
    () => win.removeEventListener('ss:player', draw),
  );
  draw();
  return {
    draw,
    dispose() {
      cleanups.forEach((fn) => fn());
      if (meterFrame) win.cancelAnimationFrame(meterFrame);
      if (tick) clearInterval(tick);
    },
  };
}
