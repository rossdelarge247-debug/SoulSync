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
 *   to today's Heard list (4j).
 * - The level meter, drawn from the player's analyser while radio plays.
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
import { RADIO_EVENT } from '@/features/radio/radio.types';
import { appURL } from '@/platform/url-base';

const SVG_STOP =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const SVG_NOTE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
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

  function drawSlot(st: RadioSessionState): void {
    for (const slot of root.querySelectorAll<HTMLElement>('[data-player-action-slot]')) {
      slot.replaceChildren();
      if (!st.station) continue;
      const lines = nowLines(st.nowPlaying, st.skew);
      const now = el(doc, 'span', 'ss-player-radio-now');
      now.append(
        el(doc, 'span', 'ss-player-title', lines.title),
        el(doc, 'span', 'ss-player-meta', lines.line),
      );
      slot.append(now);
      const action = actionNode(st, false);
      if (action) slot.append(action);
      slot.hidden = false;
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
      drawPanel();
    } catch {
      // the sheet shows what it has
    }
  }

  function drawPanel(): void {
    const panel = root.querySelector<HTMLElement>('[data-player-radio-panel]');
    const st = radio()?.state();
    if (!panel) return;
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
        sourceWords(np.source, station.name).replace('Identified from ', 'From '),
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

    const auto = el(doc, 'div', 'ss-player-radio-auto');
    const on = Boolean(stationInfo?.data?.station.auto_add ?? station.auto_add);
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
      el(doc, 'span', 'ss-player-radio-auto-title', `Auto-add what ${station.name} plays`),
      el(doc, 'span', 'ss-player-meta', 'To Wanted, skipping what you have. Asks first.'),
    );
    sw.setAttribute('aria-label', `Auto-add what ${station.name} plays`);
    auto.append(sw, autoText);

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

    panel.append(head, art, card, actions, auto, controls, heard);
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
    const sw = target?.closest<HTMLElement>('[data-player-radio-auto]');
    if (sw) {
      event.preventDefault();
      const st = radio()?.state();
      if (!st?.station) return;
      if (sw.dataset.playerRadioAuto === 'on') {
        await fetcher(appURL(`/api/radio/stations/${encodeURIComponent(st.station.id)}/auto-add`), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });
        if (stationInfo) stationInfo.data = null;
        void loadStation(st.station.id);
      } else {
        // turning it on asks first, with the numbers (4d), on the station's page
        root.querySelector<HTMLElement>('[data-player-sheet-close]')?.click();
        go(win, `${stationHref(st.station.id)}?confirm=auto-add` as `/${string}`);
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
