/**
 * The player's chrome (board 6a; docs/design/DESIGN-SYSTEM.md, "Player bar
 * and tray"): the 72px bar pinned along the bottom of the window, the 360px
 * tray it expands into, and on phones the 64px mini bar and its sheet.
 *
 * The markup is static in webui/index.html (#media-player) and the look is
 * static/player.css. Playback, the queue, crossfade, scrobbling and the Media
 * Session stay in static/media-player.js; the visuals, EQ, speed, A-B loop,
 * lyrics, details and the settings panel stay in static/media-player-v2.js.
 * This module draws from their state (window.SoulSyncPlayer.state(), redrawn
 * on every 'ss:player' event and on the audio element's own events) and acts
 * through window.SoulSyncPlayer. It owns:
 *
 * - collapsed / expanded, remembered per browser (localStorage, like the
 *   compact rail), as html[data-player="bar"|"tray"]; absent while nothing
 *   plays. Every toggle carries aria-expanded on the tray; Escape collapses;
 * - the waveform (GET /api/library/tracks/<id>/peaks) as a slider, the
 *   readout and the record (GET /api/library/tracks/<id>/details), Recent
 *   (GET /api/player/recent);
 * - the source kind seam: library, stream, podcast / audiobook (−15 s / +30 s,
 *   the speed button, chapter ticks) and radio (a Live tag, a level meter,
 *   one action slot; build e fills it). Radio expands like music: the tray's
 *   radio columns are player-radio.ts's (Ross, 2026-10-23);
 * - the record's "…" menu, the speed and output pickers;
 * - the phone sheet (html[data-player-sheet]).
 */

import { logoText } from '@/features/radio/radio.format';

import {
  applyOutput,
  browserEnv,
  listOutputs,
  outputSupport,
  readSavedOutput,
  saveOutput,
  worthOffering,
  type OutputDevice,
  type OutputSupport,
} from './player-output';
import { bootQueueQuality } from './player-queue-quality';
import { radioMiniLines } from './player-radio';
import {
  albumLine,
  barCount,
  chapterTicks,
  formatClock,
  formatFromPath,
  formatReadout,
  formatRemaining,
  formatSpeed,
  formatSpeedValue,
  fractionAt,
  parseChapters,
  pathLabel,
  peaksRetryDelay,
  positionText,
  queueFoot,
  readTrayState,
  seekStep,
  shortFormat,
  sleepButtonLabel,
  sleepButtonText,
  sleepChoiceLabel,
  sleepStepsFor,
  sourceLabel,
  sourceView,
  spokenRecentMeta,
  timeAgo,
  upNextCount,
  volumeDb,
  waveformBars,
  writeTrayState,
  type AudioDetails,
  type Chapter,
  type SourceKind,
  type TrayState,
} from './player-state';

// ── the engine's shape (static/media-player.js) ────────────────────────────

export interface PlayerTrack {
  id?: string | number | null;
  title?: string;
  artist?: string;
  album?: string;
  artist_id?: string | number | null;
  album_id?: string | number | null;
  image_url?: string | null;
  filename?: string;
  file_path?: string;
  is_library?: boolean;
  is_preview?: boolean;
  username?: string;
  kind?: SourceKind;
  media_id?: string;
  duration?: number | null;
  chapters?: Chapter[] | null;
  chapters_url?: string | null;
  bitrate?: number | null;
  download_pending?: boolean;
}

export interface PlayerSnapshot {
  track: PlayerTrack | null;
  kind: SourceKind | null;
  playing: boolean;
  buffering: boolean;
  loading: { active: boolean; text: string; progress: number };
  queue: PlayerTrack[];
  index: number;
  canPrevious: boolean;
  canNext: boolean;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  radio: boolean;
  autoDownload: boolean;
  crossfade: boolean;
  /** How long a crossfade lasts, in seconds (Player settings). */
  crossfadeSeconds?: number;
  context: string;
  volume: number;
  muted: boolean;
  sleep: number | 'track';
  sleepEndsAt: number;
  sleepSteps: (number | 'track')[];
  lyrics: { synced: boolean; lines: number; loading: boolean; status: string };
  reportable: boolean;
  playlistTrack: Record<string, string> | null;
}

export interface PlayerEngine {
  state(): PlayerSnapshot;
  audio(): HTMLAudioElement | null;
  outputTargets(): { elements: HTMLMediaElement[]; context: AudioContext | null };
  analyser(): AnalyserNode | null;
  toggle(): void;
  stop(): Promise<void> | void;
  next(): void;
  previous(): void;
  seek(seconds: number): void;
  skip(seconds: number): void;
  setVolume(percent: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  playIndex(index: number): Promise<unknown>;
  setCrossfade(on: boolean): void;
  setSleep(value: number | 'track'): void;
  playNext(track: Record<string, unknown>): void;
  /** a podcast episode or an audiobook (static/media-player.js npPlayMedia) */
  playMedia?(item: Record<string, unknown>): Promise<unknown>;
  setExpanded(open: boolean): void;
}

interface TheaterApi {
  selectTab?: (name: string) => void;
  setSpeed?: (v: number) => void;
  getSpeed?: () => number;
  speedPresets?: () => number[];
  openVisuals?: () => void;
  /** The equalizer: on or off, and the preset's name. */
  getEq?: () => { on: boolean; preset: string };
  closeVisuals?: () => void;
  visualsOpen?: () => boolean;
  updateWakeLock?: () => void;
}

interface RecentItem {
  /** music, podcast or audiobook (HANDOFF 46: Recent shows every kind) */
  kind?: 'music' | 'podcast' | 'audiobook';
  /** podcasts and audiobooks: the item, its show or author, its address */
  media_id?: string;
  subtitle?: string | null;
  src?: string | null;
  position_s?: number | null;
  finished?: boolean;
  track_id?: string | null;
  title?: string;
  artist?: string;
  album?: string;
  played_at?: string;
  file_path?: string | null;
  artist_id?: string | null;
  album_id?: string | null;
  bitrate?: number | null;
  duration_s?: number | null;
  format?: string | null;
  image_url?: string | null;
}

interface DetailsBody extends AudioDetails {
  album?: string | null;
  year?: number | null;
  track_number?: number | null;
  album_track_count?: number | null;
  artist?: string | null;
  artist_id?: string | null;
  album_id?: string | null;
  image_url?: string | null;
  quality?: { at_target: boolean; target_name?: string | null } | null;
}

declare global {
  interface Window {
    SoulSyncPlayer?: PlayerEngine;
    SoulSyncPlayerChrome?: PlayerChrome;
    npV2?: TheaterApi;
    buildArtistDetailPath?: (
      id: unknown,
      source?: string | null,
      name?: string | null,
      album?: unknown,
    ) => string;
  }
}

export interface PlayerChrome {
  expand(): void;
  collapse(): void;
  toggle(): void;
  isExpanded(): boolean;
  openSheet(): void;
  closeSheet(): void;
  destroy(): void;
}

export const PHONE_QUERY = '(max-width: 768px)';

const FOCUSABLE =
  'button:not([disabled]):not([hidden]), a[href]:not([hidden]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function stripId(value: string | undefined | null): string {
  const s = String(value ?? '');
  const i = s.indexOf('||');
  return i >= 0 ? s.slice(i + 2) : s;
}

function trackKey(t: PlayerTrack | null): string {
  if (!t) return '';
  return String(t.id ?? t.media_id ?? `${t.title ?? ''}|${t.filename ?? ''}`);
}

function setText(el: Element | null | undefined, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

function setHidden(el: Element | null | undefined, hidden: boolean): void {
  if (!el) return;
  if (hidden) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

function setAttr(el: Element | null | undefined, name: string, value: string): void {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export interface BootOptions {
  root?: HTMLElement | null;
  engine?: PlayerEngine;
  win?: Window;
  fetchImpl?: typeof fetch;
}

/** Wire the chrome to the markup. Returns null when there's no player. */
export function bootPlayer(options: BootOptions = {}): PlayerChrome | null {
  const view: Window = options.win ?? window;
  const doc = view.document;
  const root = options.root ?? doc.getElementById('media-player');
  const engine = options.engine ?? view.SoulSyncPlayer;
  if (!root || !engine) return null;
  const html = doc.documentElement;
  const fetcher: typeof fetch = options.fetchImpl ?? ((...args) => view.fetch(...args));
  const tray = root.querySelector<HTMLElement>('#ss-player-tray');
  const menu = root.querySelector<HTMLElement>('#ss-player-menu');
  const speedMenu = root.querySelector<HTMLElement>('#ss-player-speed-menu');
  const sleepMenu = root.querySelector<HTMLElement>('#ss-player-sleep-menu');
  const outputMenu = root.querySelector<HTMLElement>('#ss-player-output-menu');
  const scrim = doc.querySelector<HTMLElement>('[data-player-scrim]');
  const overlay = doc.getElementById('np-modal-overlay');
  const live = root.querySelector<HTMLElement>('#ss-player-live');
  const loadingEl = root.querySelector<HTMLElement>('#loading-animation');
  const phone = view.matchMedia ? view.matchMedia(PHONE_QUERY) : null;
  const isPhone = () => Boolean(phone?.matches);
  const all = <T extends Element = HTMLElement>(sel: string) => [
    ...root.querySelectorAll<T>(sel),
    ...((overlay?.querySelectorAll<T>(sel) ?? []) as Iterable<T>),
  ];
  const cleanups: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: EventTarget | null | undefined,
    type: K | string,
    fn: (ev: Event) => void,
    opts?: AddEventListenerOptions,
  ) => {
    if (!el) return;
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };
  const storage = (() => {
    try {
      return view.localStorage;
    } catch {
      return null;
    }
  })();

  let trayState: TrayState = readTrayState(storage);
  let sheetOpen = false;
  let sheetOpener: HTMLElement | null = null;
  let currentKey = '';
  let details: DetailsBody | null = null;
  let peaks: number[] | null = null;
  let peaksTimer = 0;
  let chapters: Chapter[] | null = null;
  let listView = 'queue';
  let recent: RecentItem[] | null = null;
  let recentError = false;
  let recentLoading = false;
  let lastAnnounced = '';
  let lastLoadingText = '';
  let menuOpener: HTMLElement | null = null;
  let outputDevices: OutputDevice[] = [];
  let outputUnnamed = false;
  let outputCurrent = readSavedOutput(storage);
  let outputLabel = 'This device';
  let airplayAvailable = false;
  let airplayWireless = false;
  const support: OutputSupport = outputSupport(browserEnv(view));
  let lastAriaUpdate = 0;
  let snapshot: PlayerSnapshot = engine.state();
  // art that failed to load stays hidden (the fallback shows), however often we redraw
  const brokenArt = new Set<string>();

  // ── expanded or collapsed ────────────────────────────────────────────────
  const hasTrack = () => Boolean(snapshot.track);

  function applyLayout(): void {
    // every kind expands the same way, radio included (its columns are player-radio.ts's)
    if (hasTrack()) setAttr(html, 'data-player', trayState);
    else html.removeAttribute('data-player');
    const expanded = trayState === 'tray' && hasTrack();
    if (tray) {
      // the phone shows the tray only as its sheet
      setHidden(tray, !(sheetOpen || (expanded && !isPhone())));
    }
    for (const t of root!.querySelectorAll('[data-player-toggle], [data-player-upnext]')) {
      setAttr(t, 'aria-expanded', expanded && !isPhone() ? 'true' : 'false');
    }
    for (const t of root!.querySelectorAll('[data-player-sheet-open]')) {
      setAttr(t, 'aria-expanded', sheetOpen ? 'true' : 'false');
    }
    const now = root!.querySelector('.ss-player-now');
    if (now) {
      const t = snapshot.track;
      setAttr(
        now,
        'aria-label',
        t && snapshot.kind === 'radio'
          ? `${stripId(t.title) || 'The station'}, live. Expand the player`
          : t
            ? `${stripId(t.title) || 'Unknown track'} by ${stripId(t.artist) || 'Unknown artist'}. Expand the player`
            : 'Expand the player',
      );
    }
    engine!.setExpanded(expanded);
    view.npV2?.updateWakeLock?.();
  }

  function setTray(state: TrayState, focus = false): void {
    if (state === trayState && !focus) return;
    trayState = state;
    writeTrayState(storage, state);
    closeMenus(false);
    applyLayout();
    if (focus) {
      // the Collapse that shows: the list's, or radio's list's
      const target =
        state === 'tray'
          ? visible(root!.querySelectorAll<HTMLElement>('.ss-player-collapse'))
          : root!.querySelector<HTMLElement>('.ss-player-bar [data-player-toggle].ss-player-ghost');
      target?.focus();
    }
    if (state === 'tray') {
      drawWaves();
      drawTime(true);
    }
  }

  function visible(list: Iterable<HTMLElement>): HTMLElement | null {
    let first: HTMLElement | null = null;
    for (const el of list) {
      first ??= el;
      // jsdom lays nothing out: fall back to the one not inside a hidden column
      if (el.offsetParent !== null || el.getClientRects().length) return el;
      if (!el.closest('[hidden]') && !hiddenColumn(el)) return el;
    }
    return first;
  }

  /** In radio mode the music columns step aside, and the other way round. */
  function hiddenColumn(el: HTMLElement): boolean {
    const radio = snapshot.kind === 'radio';
    const inRadio = Boolean(el.closest('[data-player-radio-tray]'));
    if (radio !== inRadio) return true;
    return false;
  }

  // ── the phone sheet ──────────────────────────────────────────────────────
  function openSheet(opener?: HTMLElement | null): void {
    if (!hasTrack() || sheetOpen) return;
    sheetOpen = true;
    sheetOpener = opener ?? (doc.activeElement as HTMLElement | null);
    html.setAttribute('data-player-sheet', '');
    if (tray) {
      tray.setAttribute('role', 'dialog');
      tray.setAttribute('aria-modal', 'true');
    }
    setHidden(scrim, false);
    applyLayout();
    drawWaves();
    drawTime(true);
    root!.querySelector<HTMLElement>('[data-player-sheet-close]')?.focus();
  }

  function closeSheet(restore = true): void {
    if (!sheetOpen) return;
    sheetOpen = false;
    html.removeAttribute('data-player-sheet');
    if (tray) {
      tray.setAttribute('role', 'region');
      tray.removeAttribute('aria-modal');
    }
    setHidden(scrim, true);
    closeMenus(false);
    applyLayout();
    if (restore && sheetOpener && doc.contains(sheetOpener)) sheetOpener.focus();
    sheetOpener = null;
  }

  // ── menus ────────────────────────────────────────────────────────────────
  function closeMenus(restore = true): void {
    let was = false;
    for (const m of [menu, speedMenu, sleepMenu, outputMenu]) {
      if (m && !m.hidden) {
        m.hidden = true;
        was = true;
      }
    }
    for (const b of root!.querySelectorAll(
      '[data-player-more], [data-player-action="speed"], [data-player-output], [data-player-sleep], [data-player-menu="speed"]',
    )) {
      setAttr(b, 'aria-expanded', 'false');
    }
    for (const c of root!.querySelectorAll<HTMLElement>('.ss-player-choices')) c.hidden = true;
    if (was && restore && menuOpener && doc.contains(menuOpener)) menuOpener.focus();
    if (was) menuOpener = null;
  }

  function placeMenu(m: HTMLElement, anchor: HTMLElement): void {
    m.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth || 300;
    const mh = m.offsetHeight || 200;
    const vw = view.innerWidth;
    const vh = view.innerHeight;
    let left = r.right - mw;
    if (left < 12) left = Math.min(r.left, vw - mw - 12);
    left = Math.max(12, Math.min(left, vw - mw - 12));
    // open upwards from the player; downwards when there's no room above
    let top = r.top - mh - 8;
    if (top < 12) top = Math.min(r.bottom + 8, vh - mh - 12);
    m.style.left = `${Math.round(left)}px`;
    m.style.top = `${Math.round(Math.max(12, top))}px`;
  }

  function openMenu(m: HTMLElement | null, anchor: HTMLElement): void {
    if (!m) return;
    const wasOpen = !m.hidden;
    closeMenus(false);
    if (wasOpen) {
      anchor.focus();
      return;
    }
    menuOpener = anchor;
    setAttr(anchor, 'aria-expanded', 'true');
    drawMenu();
    placeMenu(m, anchor);
    m.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }

  function fillChoices(
    box: HTMLElement,
    choices: { value: string; label: string; checked: boolean }[],
    pick: (value: string) => void,
  ): void {
    box.textContent = '';
    for (const c of choices) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'ss-player-menu-item';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', c.checked ? 'true' : 'false');
      b.dataset.value = c.value;
      b.textContent = c.label;
      b.addEventListener('click', () => pick(c.value));
      box.appendChild(b);
    }
  }

  function speedChoices() {
    const presets = view.npV2?.speedPresets?.() ?? [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const cur = view.npV2?.getSpeed?.() ?? 1;
    return presets.map((p) => ({ value: String(p), label: formatSpeed(p), checked: p === cur }));
  }

  function pickSpeed(value: string): void {
    view.npV2?.setSpeed?.(Number(value));
    closeMenus(true);
    draw();
  }

  // ── output ───────────────────────────────────────────────────────────────
  async function refreshOutputs(): Promise<void> {
    if (support !== 'sink') return;
    try {
      const list = await view.navigator.mediaDevices.enumerateDevices();
      const r = listOutputs(list);
      outputDevices = r.devices;
      outputUnnamed = r.unnamed;
      const cur = outputDevices.find((d) => d.id === outputCurrent);
      if (outputCurrent && !cur) outputCurrent = '';
      outputLabel = cur ? cur.label : 'This device';
    } catch {
      outputDevices = [];
    }
    drawOutput();
  }

  function outputOffered(): boolean {
    // count "This device" as one of the places
    const count = support === 'sink' ? outputDevices.length + 1 : 0;
    return worthOffering(support, count, airplayAvailable);
  }

  async function chooseOutput(id: string): Promise<void> {
    closeMenus(true);
    const ok = await applyOutput(id, engine!.outputTargets());
    if (!ok) {
      view.showToast?.("This browser can't move the player's sound to another output.", 'error');
      return;
    }
    outputCurrent = id;
    saveOutput(storage, id);
    outputLabel = outputDevices.find((d) => d.id === id)?.label ?? 'This device';
    drawOutput();
    draw();
  }

  async function nameOutputs(): Promise<void> {
    closeMenus(true);
    try {
      const stream = await view.navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
    } catch {
      view.showToast?.(
        "The outputs keep their numbers: the browser wasn't allowed to name them.",
        'info',
      );
    }
    await refreshOutputs();
  }

  async function onOutputButton(anchor: HTMLElement): Promise<void> {
    if (support === 'airplay') {
      const a = engine!.audio() as
        | (HTMLAudioElement & { webkitShowPlaybackTargetPicker?: () => void })
        | null;
      a?.webkitShowPlaybackTargetPicker?.();
      return;
    }
    if (support === 'select') {
      try {
        const md = view.navigator.mediaDevices as MediaDevices & {
          selectAudioOutput?: (o?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
        };
        const picked = await md.selectAudioOutput?.({ deviceId: outputCurrent || undefined });
        if (picked) {
          outputDevices = [{ id: picked.deviceId, label: picked.label || 'Chosen output' }];
          await chooseOutput(picked.deviceId);
        }
      } catch {
        /* the person closed the browser's picker */
      }
      return;
    }
    if (!outputMenu) return;
    outputMenu.textContent = '';
    const make = (label: string, id: string) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'ss-player-menu-item';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', id === outputCurrent ? 'true' : 'false');
      b.textContent = label;
      b.addEventListener('click', () => void chooseOutput(id));
      outputMenu.appendChild(b);
    };
    make('This device (the system default)', '');
    for (const d of outputDevices) make(d.label, d.id);
    if (outputUnnamed) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'ss-player-menu-item';
      b.textContent = 'Show the outputs’ names…';
      b.title =
        'Your browser only names outputs once it has been allowed the microphone. SYNCHRO.S records nothing.';
      b.addEventListener('click', () => void nameOutputs());
      outputMenu.appendChild(b);
    }
    openMenu(outputMenu, anchor);
  }

  function drawOutput(): void {
    const offered = outputOffered();
    const label =
      support === 'airplay' ? (airplayWireless ? 'AirPlay' : 'This device') : outputLabel;
    for (const b of root!.querySelectorAll<HTMLElement>('[data-player-output]')) {
      setHidden(b, !offered);
      setAttr(b, 'aria-label', `Output: ${label}`);
    }
    for (const l of root!.querySelectorAll('[data-player-output-label]')) {
      setText(l, support === 'airplay' && airplayWireless ? 'AirPlay' : label);
    }
  }

  // ── the waveform ─────────────────────────────────────────────────────────
  const waves = () => all<HTMLElement>('[data-player-wave]');

  function buildWave(el: HTMLElement): void {
    const width = el.clientWidth || el.getBoundingClientRect().width || 320;
    const count = barCount(width);
    const bars = waveformBars(peaks, count, peaks ? 0.08 : 0.12);
    el.dataset.empty = peaks ? 'false' : 'true';
    el.textContent = '';
    for (const layerClass of [
      'ss-player-wave-layer',
      'ss-player-wave-layer ss-player-wave-layer--played',
    ]) {
      const layer = doc.createElement('div');
      layer.className = layerClass;
      layer.setAttribute('aria-hidden', 'true');
      for (const h of bars) {
        const s = doc.createElement('span');
        s.style.height = `${Math.round(h * 100)}%`;
        layer.appendChild(s);
      }
      el.appendChild(layer);
    }
    const audio = engine!.audio();
    const duration =
      audio && Number.isFinite(audio.duration)
        ? audio.duration
        : Number(snapshot.track?.duration) || 0;
    for (const t of chapterTicks(chapters, duration)) {
      const tick = doc.createElement('span');
      tick.className = 'ss-player-wave-tick';
      tick.style.left = `${t.left}%`;
      if (t.title) tick.title = t.title;
      el.appendChild(tick);
    }
    const tip = doc.createElement('span');
    tip.className = 'ss-player-wave-tip';
    tip.setAttribute('aria-hidden', 'true');
    el.appendChild(tip);
  }

  function drawWaves(): void {
    for (const w of waves()) buildWave(w);
    drawTime(true);
  }

  function duration(): number {
    const a = engine!.audio() ?? doc.querySelector<HTMLAudioElement>('#audio-player');
    if (a && Number.isFinite(a.duration) && a.duration > 0) return a.duration;
    return Number(snapshot.track?.duration) || 0;
  }

  function current(): number {
    const a = engine!.audio() ?? doc.querySelector<HTMLAudioElement>('#audio-player');
    return a && Number.isFinite(a.currentTime) ? a.currentTime : 0;
  }

  function drawTime(forceAria = false): void {
    const d = duration();
    const c = current();
    const pct = d > 0 ? Math.min(100, (c / d) * 100) : 0;
    for (const el of all('[data-player-elapsed]')) setText(el, formatClock(c));
    // a station's time listened is the stream element's own (as the tray's deck)
    const listened = overlay?.querySelector('[data-player-visuals-listened]');
    if (listened && snapshot.kind === 'radio') setText(listened, formatClock(c));
    for (const el of all('[data-player-total]')) setText(el, formatClock(d));
    for (const el of all('[data-player-remaining]')) setText(el, formatRemaining(c, d));
    const now = Date.now();
    for (const w of waves()) {
      w.style.setProperty('--played', `${pct.toFixed(2)}%`);
      // the time isn't announced as it runs: a focused slider only changes
      // its values when someone moves it; unfocused it catches up now and then
      const focused = doc.activeElement === w;
      if (forceAria || (!focused && now - lastAriaUpdate > 5000)) {
        setAttr(w, 'aria-valuemax', String(Math.round(d)));
        setAttr(w, 'aria-valuenow', String(Math.round(c)));
        setAttr(w, 'aria-valuetext', positionText(c, d));
      }
    }
    if (forceAria || now - lastAriaUpdate > 5000) lastAriaUpdate = now;
  }

  function wireWave(w: HTMLElement): void {
    let dragging = false;
    const at = (ev: PointerEvent) => {
      const r = w.getBoundingClientRect();
      return fractionAt(ev.clientX, r.left, r.width);
    };
    const tipAt = (ev: PointerEvent) => {
      const tip = w.querySelector<HTMLElement>('.ss-player-wave-tip');
      const d = duration();
      if (!tip || d <= 0) return;
      const f = at(ev);
      tip.textContent = formatClock(f * d);
      tip.style.left = `${f * 100}%`;
    };
    on(w, 'pointerdown', (e) => {
      const ev = e as PointerEvent;
      if (ev.button !== 0 || duration() <= 0) return;
      dragging = true;
      w.dataset.dragging = 'true';
      try {
        w.setPointerCapture(ev.pointerId);
      } catch {
        /* jsdom */
      }
      w.style.setProperty('--played', `${at(ev) * 100}%`);
      tipAt(ev);
    });
    on(w, 'pointermove', (e) => {
      const ev = e as PointerEvent;
      tipAt(ev);
      if (dragging) w.style.setProperty('--played', `${at(ev) * 100}%`);
    });
    const finish = (e: Event) => {
      if (!dragging) return;
      dragging = false;
      delete w.dataset.dragging;
      const d = duration();
      if (d > 0 && e.type === 'pointerup') engine!.seek(at(e as PointerEvent) * d);
      drawTime(true);
    };
    on(w, 'pointerup', finish);
    on(w, 'pointercancel', finish);
    on(w, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      const next = seekStep(ev.key, current(), duration());
      if (next === null) return;
      ev.preventDefault();
      ev.stopPropagation();
      engine!.seek(next);
      // the moved value is the one thing a screen reader should hear
      const d = duration();
      w.style.setProperty('--played', `${d > 0 ? (next / d) * 100 : 0}%`);
      setAttr(w, 'aria-valuenow', String(Math.round(next)));
      setAttr(w, 'aria-valuetext', positionText(next, d));
    });
  }

  // ── fetching what the server knows ───────────────────────────────────────
  async function loadDetails(key: string, id: string): Promise<void> {
    try {
      const res = await fetcher(`/api/library/tracks/${encodeURIComponent(id)}/details`);
      if (!res.ok) return;
      const body = (await res.json()) as DetailsBody;
      if (key !== currentKey) return;
      details = body;
      draw();
    } catch {
      /* the readout falls back to the file name */
    }
  }

  async function loadPeaks(key: string, id: string, attempt = 0): Promise<void> {
    try {
      const res = await fetcher(`/api/library/tracks/${encodeURIComponent(id)}/peaks`);
      if (key !== currentKey) return;
      if (res.status === 202) {
        const delay = peaksRetryDelay(attempt);
        if (delay !== null) {
          peaksTimer = view.setTimeout(() => void loadPeaks(key, id, attempt + 1), delay);
        }
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { peaks?: number[] | null };
      if (key !== currentKey || !Array.isArray(body.peaks)) return;
      peaks = body.peaks;
      drawWaves();
    } catch {
      /* a flat line is still a working slider */
    }
  }

  async function loadChapters(key: string, url: string): Promise<void> {
    try {
      const res = await fetcher(url);
      if (!res.ok) return;
      const list = parseChapters(await res.json());
      if (key !== currentKey || !list.length) return;
      chapters = list;
      drawWaves();
    } catch {
      /* a feed that doesn't share its chapters: no ticks */
    }
  }

  async function loadRecent(): Promise<void> {
    if (recentLoading) return;
    recentLoading = true;
    recentError = false;
    drawRecent();
    try {
      const res = await fetcher('/api/player/recent?limit=20');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { items?: RecentItem[] };
      recent = Array.isArray(body.items) ? body.items : [];
    } catch {
      recentError = true;
    } finally {
      recentLoading = false;
      drawRecent();
    }
  }

  function onTrackChanged(t: PlayerTrack | null): void {
    view.clearTimeout(peaksTimer);
    details = null;
    peaks = null;
    chapters = t?.chapters && t.chapters.length ? t.chapters : null;
    drawWaves();
    if (!t) return;
    const key = currentKey;
    const kind = snapshot.kind;
    if (kind === 'library' && t.id !== undefined && t.id !== null && t.id !== '') {
      void loadDetails(key, String(t.id));
      void loadPeaks(key, String(t.id));
    }
    if (!chapters && t.chapters_url) void loadChapters(key, t.chapters_url);
    // Recent changes as this one gets played; read it again next time it shows
    if (listView === 'history') view.setTimeout(() => void loadRecent(), 15000);
    else recent = null;
  }

  // ── drawing ──────────────────────────────────────────────────────────────
  function announce(text: string): void {
    if (!live || !text || text === lastAnnounced) return;
    lastAnnounced = text;
    live.textContent = text;
  }

  function drawRecent(): void {
    const panel = root!.querySelector('#np-v2-history-panel');
    if (!panel) return;
    const status = panel.querySelector<HTMLElement>('[data-player-recent-status]');
    const list = panel.querySelector<HTMLElement>('[data-player-recent-list]');
    if (!status || !list) return;
    if (recentLoading && !recent) {
      status.textContent = 'Loading what you played…';
      status.hidden = false;
      list.textContent = '';
      return;
    }
    if (recentError) {
      status.textContent = '';
      const msg = doc.createElement('span');
      msg.textContent = "Couldn't load what you played. ";
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.className = 'ss-player-text-btn';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => void loadRecent());
      status.append(msg, retry);
      status.hidden = false;
      return;
    }
    const items = recent ?? [];
    if (!items.length) {
      status.textContent =
        'Nothing played here yet. What you play in SYNCHRO.S shows here, newest first.';
      status.hidden = false;
      list.textContent = '';
      return;
    }
    status.hidden = true;
    list.textContent = '';
    const now = Date.now();
    for (const item of items) {
      const row = doc.createElement('div');
      row.className = 'ss-player-recent-row';
      row.setAttribute('role', 'listitem');
      const art = doc.createElement('img');
      art.className = 'ss-player-recent-art';
      art.alt = '';
      if (item.image_url) art.src = item.image_url;
      else art.style.visibility = 'hidden';
      art.addEventListener('error', () => (art.style.visibility = 'hidden'));
      const play = doc.createElement('button');
      play.type = 'button';
      play.className = 'ss-player-recent-play';
      if (item.kind === 'podcast' || item.kind === 'audiobook') {
        drawSpokenRecent(item, play);
        const when = doc.createElement('span');
        when.className = 'ss-player-recent-when';
        when.textContent = timeAgo(item.played_at, now);
        row.append(art, play, when);
        list.appendChild(row);
        continue;
      }
      const playable = Boolean(item.file_path);
      play.setAttribute(
        'aria-label',
        playable
          ? `Play ${item.title || 'this track'} by ${item.artist || 'an unknown artist'} now`
          : `${item.title || 'This track'} by ${item.artist || 'an unknown artist'} isn't in your library any more`,
      );
      if (!playable) play.setAttribute('aria-disabled', 'true');
      const title = doc.createElement('span');
      title.className = 'ss-player-recent-title';
      title.textContent = item.title || 'Unknown track';
      const meta = doc.createElement('span');
      meta.className = 'ss-player-recent-meta';
      meta.textContent = [item.artist || 'Unknown artist', item.format].filter(Boolean).join(' · ');
      play.append(title, meta);
      play.addEventListener('click', () => {
        if (!playable) return;
        // play it now; what's queued carries on after it
        engine!.playNext({
          id: item.track_id,
          title: item.title,
          artist: item.artist,
          album: item.album,
          file_path: item.file_path,
          artist_id: item.artist_id,
          album_id: item.album_id,
          image_url: item.image_url,
          bitrate: item.bitrate,
          duration: item.duration_s,
        });
        const st = engine!.state();
        const at = st.index >= 0 ? st.index + 1 : st.queue.length - 1;
        void engine!.playIndex(at);
      });
      const when = doc.createElement('span');
      when.className = 'ss-player-recent-when';
      when.textContent = timeAgo(item.played_at, now);
      row.append(art, play, when);
      list.appendChild(row);
    }
  }

  /** An episode or an audiobook in Recent: "Podcast · Show · 23 min left";
   *  playing it again picks up where you left it. */
  function drawSpokenRecent(item: RecentItem, play: HTMLButtonElement): void {
    const playable = Boolean(item.src && item.media_id && engine?.playMedia);
    const name = item.title || (item.kind === 'podcast' ? 'An episode' : 'An audiobook');
    play.setAttribute(
      'aria-label',
      playable ? `Play ${name} again` : `${name} can't be played from here`,
    );
    if (!playable) play.setAttribute('aria-disabled', 'true');
    const title = doc.createElement('span');
    title.className = 'ss-player-recent-title';
    title.textContent = name;
    const meta = doc.createElement('span');
    meta.className = 'ss-player-recent-meta';
    meta.textContent = spokenRecentMeta(item);
    play.append(title, meta);
    play.addEventListener('click', () => {
      if (!playable) return;
      void engine!.playMedia!({
        kind: item.kind,
        id: item.media_id,
        src: item.src,
        title: item.title,
        subtitle: item.subtitle || '',
        artUrl: item.image_url || null,
        durationHint: item.duration_s ?? null,
      });
    });
  }

  function drawMenu(): void {
    if (!menu) return;
    const st = snapshot;
    const item = (name: string) => menu.querySelector<HTMLElement>(`[data-player-menu="${name}"]`);
    setHidden(item('report'), !st.reportable);
    const spoken = st.kind === 'podcast' || st.kind === 'audiobook';
    const radio = st.kind === 'radio';
    setHidden(item('lyrics'), spoken || radio);
    // a live stream has no speed, loop, crossfade, details or queue: those rows step aside
    setHidden(item('details'), radio);
    for (const row of menu.querySelectorAll('[data-player-menu-music]')) setHidden(row, radio);
    setAttr(menu, 'aria-label', radio ? 'More for this station' : 'More for this track');
    // Visuals with nothing playing: disabled-neutral with its reason (10d)
    const visualsRow = item('visuals');
    if (st.track) visualsRow?.removeAttribute('aria-disabled');
    else setAttr(visualsRow, 'aria-disabled', 'true');
    setHidden(menu.querySelector('[data-player-visuals-state]'), Boolean(st.track));
    setHidden(visualsRow?.querySelector('kbd') ?? null, !st.track);
    setText(
      menu.querySelector('[data-player-lyrics-state]'),
      st.lyrics.loading
        ? 'Looking…'
        : st.lyrics.synced
          ? 'Synced'
          : st.lyrics.status || (st.lyrics.lines ? '' : ''),
    );
    setText(
      menu.querySelector('[data-player-speed-state]'),
      formatSpeedValue(view.npV2?.getSpeed?.() ?? 1),
    );
    // values in meta on the right (9d): Crossfade · 4 s, Equalizer · Flat
    setAttr(item('crossfade'), 'aria-pressed', st.crossfade ? 'true' : 'false');
    setText(
      menu.querySelector('[data-player-crossfade-state]'),
      st.crossfade ? `${st.crossfadeSeconds ?? 6} s` : 'Off',
    );
    const eq = view.npV2?.getEq?.();
    setText(menu.querySelector('[data-player-eq-state]'), eq?.on ? eq.preset || 'On' : 'Off');
    setText(menu.querySelector('[data-player-radio-state]'), st.radio ? 'On' : 'Off');
  }

  /** The record's control row: Add to playlist, Sleep timer (9d). */
  function drawRecordControls(): void {
    const st = snapshot;
    setHidden(
      root!.querySelector('[data-player-record="playlist"]'),
      !st.playlistTrack || typeof view.openAddToPlaylist !== 'function',
    );
    // a station has no end of track (147): that choice doesn't carry over to one
    if (st.kind === 'radio' && st.sleep === 'track') engine!.setSleep(0);
    const now = Date.now();
    const running = st.sleep === 'track' || Boolean(st.sleep);
    for (const b of root!.querySelectorAll<HTMLElement>('[data-player-sleep]')) {
      setAttr(b, 'aria-pressed', running ? 'true' : 'false');
      setAttr(b, 'aria-label', sleepButtonLabel(st.sleep, st.sleepEndsAt, now));
      const left = b.querySelector<HTMLElement>('[data-player-sleep-left]');
      setText(left, sleepButtonText(st.sleep, st.sleepEndsAt, now));
      setHidden(left, !running);
    }
  }

  function fillSleep(box: HTMLElement): void {
    const st = snapshot;
    fillChoices(
      box,
      sleepStepsFor(st.kind, st.sleepSteps).map((v) => ({
        value: String(v),
        label: sleepChoiceLabel(v),
        checked: v === st.sleep,
      })),
      (value) => {
        engine!.setSleep(value === 'track' ? 'track' : Number(value));
        closeMenus(true);
        draw();
      },
    );
  }

  function readout(st: PlayerSnapshot): { format: string; short: string | null; source: string } {
    const t = st.track;
    const kind = st.kind ?? 'library';
    if (details && kind === 'library') {
      return {
        format: formatReadout(details),
        short: shortFormat(details),
        source: details.path_label || 'Library',
      };
    }
    const path =
      t?.filename || t?.file_path || (t as { media_src?: string } | null)?.media_src || '';
    const fmt = formatFromPath(path);
    const brt = t?.bitrate ? `${t.bitrate} kbps` : '';
    return {
      format: fmt ? [fmt, brt].filter(Boolean).join(' · ') : kind === 'library' ? '—' : 'Stream',
      short: fmt,
      source: sourceLabel(kind, t),
    };
  }

  function draw(): void {
    snapshot = engine!.state();
    const st = snapshot;
    const t = st.track;
    const key = trackKey(t);
    if (key !== currentKey) {
      currentKey = key;
      onTrackChanged(t);
      if (t)
        announce(
          `Now playing: ${stripId(t.title) || 'Unknown track'} by ${stripId(t.artist) || 'Unknown artist'}`,
        );
    }
    if (!t && sheetOpen) closeSheet(false);
    applyLayout();
    if (!t) {
      // an open menu says Visuals needs something playing (10d)
      if (menu && !menu.hidden) drawMenu();
      return;
    }

    const kind = (st.kind ?? 'library') as SourceKind;
    const sv = sourceView(kind);
    root!.dataset.source = kind;
    root!.dataset.playing = st.playing ? 'true' : 'false';
    const busy = st.buffering || st.loading.active;
    root!.dataset.busy = busy ? 'true' : 'false';
    if (overlay) overlay.dataset.playing = st.playing ? 'true' : 'false';

    const title = stripId(t.title) || 'Unknown track';
    const artist = stripId(t.artist) || (kind === 'library' ? 'Unknown artist' : '');
    const ro = readout(st);
    const preview = t.is_preview ? '30-second preview' : '';
    const loadingWords = st.loading.active ? st.loading.text : '';
    const meta =
      loadingWords && !/^\d+%$/.test(loadingWords)
        ? loadingWords
        : kind === 'radio'
          ? artist
          : [
              artist,
              ro.short && kind !== 'podcast' && kind !== 'audiobook'
                ? ro.short
                : sv.speedButton
                  ? kind
                  : '',
              preview,
            ]
              .filter(Boolean)
              .join(' · ');
    if (loadingWords && loadingWords !== lastLoadingText && !/^\d+%$/.test(loadingWords)) {
      lastLoadingText = loadingWords;
      announce(loadingWords);
    } else if (!loadingWords) lastLoadingText = '';

    for (const el of root!.querySelectorAll('[data-player-title]')) setText(el, title);
    for (const el of root!.querySelectorAll('[data-player-meta]')) setText(el, meta);
    const radioLines =
      kind === 'radio' ? radioMiniLines(view.SoulSyncRadio?.state() ?? null) : null;
    setText(
      root!.querySelector('[data-player-mini-title]'),
      radioLines ? radioLines.title : artist ? `${title} · ${artist}` : title,
    );
    setText(
      root!.querySelector('[data-player-mini-meta]'),
      loadingWords && !/^\d+%$/.test(loadingWords)
        ? loadingWords
        : radioLines
          ? radioLines.meta
          : [ro.source, kind === 'library' || kind === 'stream' ? ro.short : '', preview]
              .filter(Boolean)
              .join(' · '),
    );
    for (const img of root!.querySelectorAll<HTMLImageElement>('[data-player-art]')) {
      const src = t.image_url || details?.image_url || '';
      img.onerror = () => {
        if (src) brokenArt.add(src);
        img.hidden = true;
      };
      if (src && !brokenArt.has(src)) {
        if (img.getAttribute('src') !== src) img.src = src;
        img.hidden = false;
      } else {
        // no art, or art that didn't load: the fallback, never the broken-image glyph
        img.hidden = true;
        img.removeAttribute('src');
      }
    }
    // radio: the station's letters under (or instead of) its logo, as on its card
    const radioStation = kind === 'radio' ? (view.SoulSyncRadio?.state().station ?? null) : null;
    for (const letters of root!.querySelectorAll<HTMLElement>('[data-player-art-letters]')) {
      setText(letters, radioStation ? logoText(radioStation.name, radioStation.logo_text) : '');
      setHidden(letters, !radioStation);
    }

    // the record
    setText(root!.querySelector('[data-player-record-title]'), title);
    const artistLink = root!.querySelector<HTMLAnchorElement>('[data-player-artist]');
    const artistPlain = root!.querySelector<HTMLElement>('[data-player-artist-plain]');
    const artistId = details?.artist_id ?? t.artist_id;
    const linkable =
      Boolean(artistId) && typeof view.buildArtistDetailPath === 'function' && kind === 'library';
    if (artistLink) {
      setHidden(artistLink, !linkable);
      if (linkable) {
        setText(artistLink, artist);
        const href = view.buildArtistDetailPath!(artistId, 'library');
        setAttr(artistLink, 'href', href);
      }
    }
    if (artistPlain) {
      setHidden(artistPlain, linkable || !artist);
      setText(artistPlain, artist);
    }
    const line = details
      ? albumLine(details)
      : kind === 'library' || kind === 'stream'
        ? stripId(t.album) && t.album !== 'Unknown Album'
          ? stripId(t.album)
          : ''
        : kind === 'podcast'
          ? 'Podcast episode'
          : kind === 'audiobook'
            ? 'Audiobook sample'
            : st.context || '';
    setText(root!.querySelector('[data-player-album-line]'), line);
    setText(root!.querySelector('[data-player-format]'), ro.format);
    const outLabel = support === 'airplay' && airplayWireless ? 'AirPlay' : outputLabel;
    setText(root!.querySelector('[data-player-path]'), pathLabel(ro.source, outLabel));
    const tag = root!.querySelector<HTMLElement>('[data-player-quality]');
    if (tag) {
      if (t.is_preview) {
        tag.dataset.tone = 'warning';
        setText(tag, '30-second preview');
        tag.hidden = false;
      } else if (t.download_pending) {
        tag.dataset.tone = 'info';
        setText(tag, 'Downloading');
        tag.hidden = false;
      } else if (details?.quality) {
        tag.dataset.tone = details.quality.at_target ? 'success' : 'warning';
        setText(tag, details.quality.at_target ? 'At your target' : 'Below your target');
        tag.hidden = false;
      } else {
        tag.hidden = true;
      }
    }
    const albumLink = root!.querySelector<HTMLAnchorElement>('[data-player-album]');
    const albumId = details?.album_id ?? t.album_id;
    const albumOk = linkable && Boolean(albumId);
    if (albumLink) {
      setHidden(albumLink, !albumOk);
      if (albumOk)
        setAttr(albumLink, 'href', view.buildArtistDetailPath!(artistId, 'library', null, albumId));
    }
    for (const more of root!.querySelectorAll('[data-player-more]'))
      setAttr(more, 'aria-label', `More for ${title}`);
    root!.dataset.listView = listView;
    for (const b of root!.querySelectorAll('[data-player-view-close]'))
      setText(b, kind === 'radio' ? 'Back to the station' : 'Back to Up next');

    // the transport, by source kind
    const spoken = Boolean(sv.skip);
    for (const b of all('[data-player-action="previous"]')) {
      setHidden(b, spoken || kind === 'radio');
      (b as HTMLButtonElement).disabled = !st.canPrevious && !(current() > 3);
    }
    for (const b of all('[data-player-action="next"]')) {
      setHidden(b, spoken || kind === 'radio');
      (b as HTMLButtonElement).disabled = !st.canNext;
    }
    for (const b of all('[data-player-action="back"], [data-player-action="forward"]'))
      setHidden(b, !spoken);
    for (const b of all('[data-player-action="speed"]')) {
      setHidden(b, !sv.speedButton);
      const sp = formatSpeed(view.npV2?.getSpeed?.() ?? 1);
      setText(b, sp);
      setAttr(b, 'aria-label', `Speed, ${sp}`);
    }
    for (const b of all('[data-player-action="shuffle"]')) {
      setHidden(b, spoken || !sv.queueModes);
      setAttr(b, 'aria-pressed', st.shuffle ? 'true' : 'false');
    }
    for (const b of all('[data-player-action="repeat"]')) {
      setHidden(b, !sv.queueModes);
      setAttr(b, 'aria-pressed', st.repeat !== 'off' ? 'true' : 'false');
      (b as HTMLElement).dataset.repeat = st.repeat;
      setAttr(
        b,
        'aria-label',
        st.repeat === 'one'
          ? 'Repeat: this track'
          : st.repeat === 'all'
            ? 'Repeat: the queue'
            : 'Repeat: off',
      );
    }
    for (const b of all('[data-player-action="toggle"]')) {
      setAttr(b, 'aria-label', busy ? 'Loading' : st.playing ? 'Pause' : 'Play');
    }
    // 145: the Visuals overlay's transport while a station plays: Live and the
    // time listened in the waveform's place, Stop instead of Pause
    if (overlay) {
      const radioNow = kind === 'radio';
      setHidden(overlay.querySelector('[data-player-visuals-live]'), !radioNow);
      setHidden(overlay.querySelector('.ss-visuals-progress'), radioNow);
      setHidden(
        overlay.querySelector('.ss-visuals-buttons [data-player-action="toggle"]'),
        radioNow,
      );
      setHidden(overlay.querySelector('[data-player-action="radio-stop"]'), !radioNow);
    }
    const mini = root!.querySelector<HTMLButtonElement>('[data-player-action="mini"]');
    if (mini) {
      setHidden(mini.querySelector('[data-mini-icon="next"]'), spoken);
      setHidden(mini.querySelector('[data-mini-icon="forward"]'), !spoken);
      setAttr(mini, 'aria-label', spoken ? 'Forward 30 seconds' : 'Next');
      mini.disabled = !spoken && !st.canNext;
      setHidden(mini, kind === 'radio');
    }
    // radio's seam
    for (const el of all('[data-player-live]')) setHidden(el, sv.times);
    for (const el of all('[data-player-elapsed], [data-player-total], [data-player-remaining]'))
      setHidden(el, !sv.times);
    for (const el of waves()) setHidden(el, sv.progress !== 'waveform');
    for (const el of all('[data-player-meter]')) setHidden(el, sv.progress !== 'meter');
    for (const el of all('[data-player-action-slot]'))
      setHidden(el, !sv.actionSlot || !el.childElementCount);

    // volume
    for (const b of all('[data-player-action="mute"]')) {
      setAttr(b, 'aria-pressed', st.muted ? 'true' : 'false');
      setAttr(b, 'aria-label', st.muted ? 'Unmute' : 'Mute');
    }
    const vol = st.muted ? 0 : st.volume;
    for (const input of all<HTMLInputElement>('[data-player-volume]')) {
      if (doc.activeElement !== input && input.value !== String(vol)) input.value = String(vol);
      input.style.setProperty('--vol', `${vol}%`);
      setAttr(input, 'aria-valuetext', st.muted ? 'Muted' : `${vol}%, ${volumeDb(vol)}`);
    }
    for (const el of root!.querySelectorAll('[data-player-db]'))
      setText(el, volumeDb(st.volume, st.muted));

    // the list
    const n = upNextCount({ length: st.queue.length, index: st.index });
    for (const el of root!.querySelectorAll('[data-player-upnext-count]')) setText(el, String(n));
    setAttr(
      root!.querySelector('[data-player-upnext]'),
      'aria-label',
      `Up next, ${n} track${n === 1 ? '' : 's'}`,
    );
    const foot = root!.querySelector<HTMLElement>('[data-player-queue-foot]');
    if (foot) {
      const list = root!.querySelector<HTMLElement>('#np-queue-list');
      const showAll = Boolean(list?.classList.contains('show-all'));
      foot.textContent = '';
      if (st.queue.length) {
        foot.append(
          doc.createTextNode(
            `${queueFoot({ length: st.queue.length, index: st.index, radio: st.radio, repeat: st.repeat, context: st.context })} · `,
          ),
        );
        const toggle = doc.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ss-player-text-btn';
        toggle.textContent = showAll ? 'Show up next only' : 'Show all';
        toggle.setAttribute('aria-pressed', showAll ? 'true' : 'false');
        toggle.addEventListener('click', () => {
          list?.classList.toggle('show-all');
          draw();
          root!.querySelector<HTMLElement>('[data-player-queue-foot] button')?.focus();
        });
        foot.appendChild(toggle);
      }
      foot.hidden = !st.queue.length;
    }
    root!.querySelector('#np-queue-list')?.classList.toggle('nothing-up-next', n === 0);
    const empty = root!.querySelector<HTMLElement>('#np-queue-empty');
    if (empty && st.queue.length && n === 0) {
      const list = root!.querySelector<HTMLElement>('#np-queue-list');
      if (!list?.classList.contains('show-all')) {
        empty.classList.remove('hidden');
        setText(
          empty,
          'Nothing after this track. Play an album or a playlist, or choose Add to queue on any track.',
        );
      }
    } else if (empty && st.queue.length) {
      empty.classList.add('hidden');
    }
    setHidden(root!.querySelector('[data-player-clear]'), listView !== 'queue' || !st.queue.length);

    drawOutput();
    drawRecordControls();
    if (menu && !menu.hidden) drawMenu();
    drawTime();
  }

  // ── events ───────────────────────────────────────────────────────────────
  on(view, 'ss:player', () => draw());
  // HANDOFF 44: queued rows below the quality target, judged as they come into view
  const queueList = root.querySelector<HTMLElement>('#np-queue-list');
  if (queueList) {
    const quality = bootQueueQuality({
      list: queueList,
      queue: () => snapshot.queue,
      fetcher,
      win: view,
    });
    on(view, 'ss:player', (e) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
      if (reason === 'queue') quality.refresh();
    });
    quality.refresh();
    cleanups.push(() => quality.dispose());
  }
  on(view, 'ss:player-view', (e) => {
    const name = (e as CustomEvent<{ view?: string }>).detail?.view ?? 'queue';
    listView = name;
    if (name === 'history') {
      if (!recent || recentError) void loadRecent();
      else drawRecent();
    }
    draw();
  });
  // the engine binds its element once the page has booted (init.js); the
  // element itself is in the markup from the start
  const audio = engine.audio() ?? doc.querySelector<HTMLAudioElement>('#audio-player');
  for (const type of ['timeupdate', 'seeked']) on(audio, type, () => drawTime());
  for (const type of ['durationchange', 'loadedmetadata', 'emptied']) {
    on(audio, type, () => {
      drawWaves();
      draw();
    });
  }
  for (const type of ['play', 'pause', 'ratechange', 'volumechange']) on(audio, type, () => draw());
  if (loadingEl && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => draw());
    mo.observe(loadingEl, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      characterData: true,
      subtree: true,
    });
    cleanups.push(() => mo.disconnect());
  }
  let resizeFrame = 0;
  on(view, 'resize', () => {
    view.cancelAnimationFrame(resizeFrame);
    resizeFrame = view.requestAnimationFrame(() => {
      if (!isPhone() && sheetOpen) closeSheet(false);
      applyLayout();
      drawWaves();
    });
  });

  // toggles
  for (const t of root.querySelectorAll<HTMLElement>('[data-player-toggle]')) {
    on(t, 'click', () => {
      if (isPhone()) {
        openSheet(t);
        return;
      }
      setTray(trayState === 'tray' ? 'bar' : 'tray', true);
    });
  }
  on(root.querySelector('[data-player-upnext]'), 'click', () => {
    view.npV2?.selectTab?.('queue');
    setTray('tray', true);
  });
  for (const t of root.querySelectorAll<HTMLElement>('[data-player-sheet-open]'))
    on(t, 'click', () => openSheet(t));
  on(root.querySelector('[data-player-sheet-close]'), 'click', () => closeSheet(true));
  on(scrim, 'click', () => closeSheet(true));

  // transport (the visuals overlay carries its own copy)
  for (const b of all<HTMLButtonElement>('[data-player-action]')) {
    on(b, 'click', () => {
      switch (b.dataset.playerAction) {
        case 'toggle':
          engine.toggle();
          break;
        case 'previous':
          engine.previous();
          break;
        case 'next':
          engine.next();
          break;
        case 'back':
          engine.skip(-15);
          break;
        case 'forward':
          engine.skip(30);
          break;
        case 'mini':
          if (sourceView(snapshot.kind).skip) engine.skip(30);
          else engine.next();
          break;
        case 'shuffle':
          engine.toggleShuffle();
          break;
        case 'repeat':
          engine.cycleRepeat();
          break;
        case 'radio-stop':
          void view.SoulSyncRadio?.stop();
          break;
        case 'mute':
          engine.toggleMute();
          break;
        case 'speed':
          if (speedMenu) {
            fillChoices(speedMenu, speedChoices(), pickSpeed);
            openMenu(speedMenu, b);
          }
          break;
      }
    });
  }
  // the visuals' transport carries a volume too (10a)
  for (const input of all<HTMLInputElement>('[data-player-volume]')) {
    on(input, 'input', () => engine.setVolume(Number(input.value)));
  }
  for (const w of waves()) wireWave(w);

  // the record's control row: Add to playlist, Sleep timer, "…" (9d)
  const openPlaylist = (anchor: HTMLElement | null) => {
    if (!snapshot.playlistTrack || !anchor) return;
    const open = view.openAddToPlaylist as unknown as
      | ((t: Record<string, string>, a: HTMLElement) => void)
      | undefined;
    open?.(snapshot.playlistTrack, anchor);
  };
  on(root.querySelector('[data-player-record="playlist"]'), 'click', (e) => {
    closeMenus(false);
    openPlaylist(e.currentTarget as HTMLElement);
  });
  // the record's moon, and radio's (147): the same timer and choices, less
  // "End of track" and the hours for a station
  for (const b of root.querySelectorAll<HTMLElement>('[data-player-sleep]'))
    on(b, 'click', (e) => {
      if (!sleepMenu) return;
      fillSleep(sleepMenu);
      openMenu(sleepMenu, e.currentTarget as HTMLElement);
      sleepMenu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    });
  const sleepTick = view.setInterval(() => drawRecordControls(), 15000);
  cleanups.push(() => view.clearInterval(sleepTick));
  for (const more of root.querySelectorAll<HTMLElement>('[data-player-more]'))
    on(more, 'click', (e) => openMenu(menu, e.currentTarget as HTMLElement));
  if (menu) {
    on(menu, 'click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-player-menu]');
      if (!target) {
        // the legacy switches (EQ, A–B, radio, auto-download, clear played,
        // shortcuts) run their own handlers; the menu just follows them
        const legacy = (e.target as HTMLElement).closest('button');
        if (legacy && legacy.id === 'np-v2-shorts-btn') closeMenus(false);
        view.setTimeout(drawMenu, 0);
        return;
      }
      const anchor =
        menuOpener ?? visible(root!.querySelectorAll<HTMLElement>('[data-player-more]'));
      switch (target.dataset.playerMenu) {
        case 'report': {
          closeMenus(true);
          const t = snapshot.track;
          const report = (
            view as unknown as {
              showReportIssueModal?: (
                k: string,
                id: unknown,
                title: string,
                artist: string,
                album: string,
              ) => void;
            }
          ).showReportIssueModal;
          if (t && snapshot.reportable)
            report?.('track', t.id, t.title || 'Track', t.artist || '', t.album || '');
          break;
        }
        case 'lyrics':
        case 'details':
        case 'settings':
          closeMenus(false);
          view.npV2?.selectTab?.(target.dataset.playerMenu);
          if (isPhone()) openSheet();
          else setTray('tray');
          root!
            .querySelector<HTMLElement>(
              `#${target.dataset.playerMenu === 'lyrics' ? 'np-lyrics-panel' : target.dataset.playerMenu === 'details' ? 'np-v2-details-panel' : 'np-v2-settings-panel'} [data-player-view-close]`,
            )
            ?.focus();
          break;
        case 'speed': {
          const box = menu.querySelector<HTMLElement>('#ss-player-speed-list');
          if (!box) break;
          const open = box.hidden;
          box.hidden = !open;
          target.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (open) {
            fillChoices(box, speedChoices(), pickSpeed);
            box.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
          }
          if (anchor) placeMenu(menu, anchor);
          break;
        }
        case 'crossfade':
          engine.setCrossfade(!snapshot.crossfade);
          break;
        case 'visuals':
          if (!snapshot.track) break;
          closeMenus(false);
          view.npV2?.openVisuals?.();
          break;
        case 'stop':
          closeMenus(false);
          void engine.stop();
          break;
      }
    });
  }

  // views back to Up next
  for (const b of root.querySelectorAll('[data-player-view-close]')) {
    on(b, 'click', () => {
      view.npV2?.selectTab?.('queue');
      root!
        .querySelector<HTMLElement>(
          snapshot.kind === 'radio'
            ? '[data-player-rtray-tab][aria-selected="true"]'
            : '#ss-player-tab-queue',
        )
        ?.focus();
    });
  }
  // tabs: the arrow keys move between Up next and Recent
  const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"][data-npv2-tab]')];
  for (const tab of tabs) {
    on(tab, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const i = tabs.indexOf(tab);
      const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next?.click();
      next?.focus();
    });
  }

  // output devices
  for (const b of root.querySelectorAll<HTMLElement>('[data-player-output]')) {
    on(b, 'click', () => void onOutputButton(b));
  }
  if (support === 'sink') {
    void refreshOutputs().then(() => {
      if (outputCurrent) void applyOutput(outputCurrent, engine.outputTargets());
    });
    const md = view.navigator.mediaDevices as MediaDevices | undefined;
    on(md, 'devicechange', () => void refreshOutputs());
    // the audio graph is built on the first play; the chosen output follows it
    on(audio, 'playing', () => {
      if (outputCurrent) void applyOutput(outputCurrent, engine.outputTargets());
    });
  }
  if (support === 'airplay' && audio) {
    on(audio, 'webkitplaybacktargetavailabilitychanged', (e) => {
      airplayAvailable = (e as Event & { availability?: string }).availability === 'available';
      drawOutput();
    });
    on(audio, 'webkitcurrentplaybacktargetiswirelesschanged', () => {
      airplayWireless = Boolean(
        (audio as HTMLAudioElement & { webkitCurrentPlaybackTargetIsWireless?: boolean })
          .webkitCurrentPlaybackTargetIsWireless,
      );
      draw();
    });
  }

  // Escape: a menu first, then the sheet, then the tray. The visuals and
  // the shortcuts list take it before this (media-player-v2.js, capture).
  on(doc, 'keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.defaultPrevented) return;
    if (ev.key === 'Escape') {
      if ([menu, speedMenu, sleepMenu, outputMenu].some((m) => m && !m.hidden)) {
        ev.preventDefault();
        closeMenus(true);
        return;
      }
      if (sheetOpen) {
        ev.preventDefault();
        closeSheet(true);
        return;
      }
      if (trayState === 'tray' && hasTrack() && !isPhone()) {
        const tag = (doc.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (doc.querySelector('[role="dialog"][data-open], .modal-overlay:not(.hidden)')) return;
        ev.preventDefault();
        const inside = root!.contains(doc.activeElement);
        setTray('bar', inside);
      }
      return;
    }
    // the phone sheet keeps focus inside while it's open
    if (ev.key === 'Tab' && sheetOpen && tray) {
      const items = [...tray.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === doc.activeElement,
      );
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (ev.shiftKey && doc.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && doc.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  });
  // a click outside closes a menu
  on(doc, 'pointerdown', (e) => {
    const target = e.target as Node;
    for (const m of [menu, speedMenu, sleepMenu, outputMenu]) {
      if (m && !m.hidden && !m.contains(target)) {
        const opener = menuOpener;
        if (opener && opener.contains(target)) return;
        closeMenus(false);
      }
    }
  });
  if (phone) {
    const onChange = () => {
      if (!isPhone() && sheetOpen) closeSheet(false);
      applyLayout();
      drawWaves();
    };
    phone.addEventListener?.('change', onChange);
    cleanups.push(() => phone.removeEventListener?.('change', onChange));
  }

  const chrome: PlayerChrome = {
    expand: () => (isPhone() ? openSheet() : setTray('tray')),
    collapse: () => (isPhone() ? closeSheet(true) : setTray('bar')),
    toggle: () =>
      isPhone()
        ? sheetOpen
          ? closeSheet(true)
          : openSheet()
        : setTray(trayState === 'tray' ? 'bar' : 'tray'),
    isExpanded: () => (isPhone() ? sheetOpen : trayState === 'tray'),
    openSheet: () => openSheet(),
    closeSheet: () => closeSheet(true),
    destroy: () => {
      view.clearTimeout(peaksTimer);
      for (const c of cleanups.splice(0)) c();
      html.removeAttribute('data-player');
      html.removeAttribute('data-player-sheet');
      if (view.SoulSyncPlayerChrome === chrome) delete view.SoulSyncPlayerChrome;
    },
  };
  view.SoulSyncPlayerChrome = chrome;
  draw();
  drawWaves();
  return chrome;
}
