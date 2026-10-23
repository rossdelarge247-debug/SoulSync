/**
 * The Visuals overlay's brain (boards 10a–10f): which family is on the
 * stage, MilkDrop's list and the playing preset, Classic's drawing loop,
 * auto-cycle, Quality and the frame-rate guard, the credit, and the states
 * (loading, won't load, no WebGL 2, still for Reduce motion, the radio
 * stream the browser can't hear). React reads it through `subscribe` /
 * `snapshot`; the legacy engine (static/media-player-v2.js) keeps painting
 * the SYNCHRO.S visuals and asks this for the overlay's keys and header.
 *
 * The overlay tells the legacy engine who paints through
 * `data-visuals-engine` on `#np-modal-overlay`: `synchros` (its canvas),
 * `milkdrop` or `classic` (this one's canvases) or `still`.
 */

import type { MilkdropEngine } from './milkdrop-engine';
import type { FetchLike, FetchedPreset } from './visuals-api';
import type { AudioTap } from './visuals-audio';
import type {
  Autocycle,
  ClassicMode,
  Family,
  Moved,
  NpV2,
  PresetAuthor,
  PresetEntry,
  Quality,
  ScopeDraw,
  ShowFilter,
  SynchrosTheme,
} from './visuals.types';

import {
  barBins,
  barLevels,
  barsRect,
  drawBars,
  drawScope,
  newBarsState,
  scopePoints,
  scopeRect,
  stepBars,
} from './classic';
import {
  fetchFavourites,
  fetchIndex,
  fetchPreset,
  forgetPreset,
  setFavourite,
} from './visuals-api';
import { createAudioTap, TAP_FFT } from './visuals-audio';
import {
  AUTOCYCLE_KEY,
  loadAutocycle,
  loadFailed,
  loadPrefs,
  playAnyway,
  saveFailed,
  savePrefs,
  setPlayAnyway,
} from './visuals-storage';
import {
  autocycleSeconds,
  CREDIT_MS,
  creditLine,
  filterPresets,
  FrameRateGuard,
  HINT_TIMES,
  lowerQuality,
  normaliseAutocycle,
  pushRecent,
  qualityPixelRatio,
  randomKey,
  stepKey,
  stillReason,
} from './visuals.logic';
import { FAMILY_NAMES, QUALITY_NAMES } from './visuals.types';

export const PANEL_WIDTH = 520;
export const PANEL_INSET = 16;
export const PREVIEW_DELAY_MS = 400;
export const PREVIEW_BACK_MS = 1000;
/** how long the analyser has to read silence on a direct station before the card shows */
export const SILENT_DIRECT_MS = 3000;
/** the preset MilkDrop starts on, the first time (Butterchurn's own example) */
export const FIRST_PRESET = 'Flexi, martin + geiss - dedicated to the sherwin maxawow';

export type IndexStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface Credit {
  id: number;
  name: string;
  line: string;
  until: number;
  hints: boolean;
  loading: boolean;
  /** the frame-rate guard's note, with "Put it back" */
  guard: { from: Quality; to: Quality } | null;
}

export interface VisualsSnapshot {
  open: boolean;
  panelOpen: boolean;
  family: Family;
  engine: 'synchros' | 'milkdrop' | 'classic' | 'still';
  webgl2: boolean;
  still: 'system' | 'setting' | null;
  phone: boolean;
  radioDirect: { station: string } | null;
  index: {
    status: IndexStatus;
    presets: PresetEntry[];
    authors: PresetAuthor[];
    error: string | null;
  };
  favourites: ReadonlySet<string>;
  recent: string[];
  query: string;
  show: ShowFilter;
  author: string;
  list: PresetEntry[];
  presetKey: string | null;
  loadingKey: string | null;
  previewKey: string | null;
  failed: ReadonlySet<string>;
  failure: { key: string; name: string; backName: string | null } | null;
  engineError: string | null;
  quality: Quality;
  blend: boolean;
  autocycle: Autocycle;
  classicMode: ClassicMode;
  classicPeaks: boolean;
  scopeDraw: ScopeDraw;
  themes: SynchrosTheme[];
  theme: string;
  credit: Credit | null;
  /** the header's ‹ name › and "by author · family" */
  header: { name: string; meta: string };
}

export interface ControllerDeps {
  win: Window;
  fetch?: FetchLike;
  tap?: AudioTap;
  loadEngine?: () => Promise<{
    createMilkdropEngine: (
      canvas: HTMLCanvasElement,
      size: { width: number; height: number; pixelRatio: number },
    ) => MilkdropEngine;
  }>;
  loadConverter?: () => Promise<{
    convertMilk: (text: string) => Promise<Record<string, unknown>>;
  }>;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  cancelRaf?: (id: number) => void;
  webgl2?: () => boolean;
}

type Listener = () => void;

export function engineModeFor(s: VisualsSnapshot): VisualsSnapshot['engine'] {
  if (s.still) return 'still';
  if (s.family === 'milkdrop' && s.webgl2 && !s.engineError) return 'milkdrop';
  if (s.family === 'classic') return 'classic';
  return 'synchros';
}

function hasWebgl2(win: Window): boolean {
  try {
    const c = win.document.createElement('canvas');
    return Boolean(c.getContext('webgl2'));
  } catch {
    return false;
  }
}

export class VisualsController {
  private s: VisualsSnapshot;
  private listeners = new Set<Listener>();
  private readonly win: Window;
  private readonly f: FetchLike | undefined;
  private readonly tap: AudioTap;
  private readonly now: () => number;
  private readonly raf: (cb: (t: number) => void) => number;
  private readonly cancelRaf: (id: number) => void;
  private readonly deps: ControllerDeps;

  private overlay: HTMLElement | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private canvas2d: HTMLCanvasElement | null = null;
  private engine: MilkdropEngine | null = null;
  private enginePromise: Promise<MilkdropEngine | null> | null = null;
  private loopId = 0;
  private lastFrame = 0;
  private readonly guard = new FrameRateGuard();
  private guardFrom: Quality | null = null;
  private readonly timeBuf = new Uint8Array(TAP_FFT);
  private readonly freqBuf = new Uint8Array(TAP_FFT / 2);
  private readonly bars = newBarsState();
  private bins: [number, number][] | null = null;
  private binsRate = 0;
  private lastChange = 0;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private creditTimer: ReturnType<typeof setTimeout> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewFrom: string | null = null;
  private silentSince: number | null = null;
  private radioTimer: ReturnType<typeof setInterval> | null = null;
  private creditId = 0;
  private hintsShown: number;
  private loadGen = 0;
  private engineKey: string | null = null;
  private engineHasPreset = false;
  private reduceQuery: MediaQueryList | null = null;
  private phoneQuery: MediaQueryList | null = null;
  private cleanups: (() => void)[] = [];

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.win = deps.win;
    this.f = deps.fetch;
    this.tap = deps.tap ?? createAudioTap(deps.win);
    this.now = deps.now ?? (() => Date.now());
    this.raf = deps.raf ?? ((cb) => this.win.requestAnimationFrame(cb));
    this.cancelRaf = deps.cancelRaf ?? ((id) => this.win.cancelAnimationFrame(id));
    const prefs = loadPrefs();
    this.hintsShown = prefs.hints;
    try {
      this.reduceQuery = this.win.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
      this.phoneQuery = this.win.matchMedia?.('(max-width: 768px)') ?? null;
    } catch {
      this.reduceQuery = null;
    }
    const webgl2 = deps.webgl2 ? deps.webgl2() : hasWebgl2(this.win);
    this.s = {
      open: false,
      panelOpen: false,
      family: prefs.family,
      engine: 'synchros',
      webgl2,
      still: null,
      phone: Boolean(this.phoneQuery?.matches),
      radioDirect: null,
      index: { status: 'idle', presets: [], authors: [], error: null },
      favourites: new Set(),
      recent: prefs.recent,
      query: '',
      show: 'all',
      author: '',
      list: [],
      presetKey: prefs.preset,
      loadingKey: null,
      previewKey: null,
      failed: new Set(loadFailed()),
      failure: null,
      engineError: null,
      quality: prefs.quality,
      blend: prefs.blend,
      autocycle: normaliseAutocycle(loadAutocycle()),
      classicMode: prefs.classicMode,
      classicPeaks: prefs.classicPeaks,
      scopeDraw: prefs.scopeDraw,
      themes: [],
      theme: 'aurora',
      credit: null,
      header: { name: '', meta: '' },
    };
    this.s.header = this.headerFor(this.s);
    this.s.engine = engineModeFor(this.s);
  }

  // ── store ──────────────────────────────────────────────────────────────────

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): VisualsSnapshot => this.s;

  private set(patch: Partial<VisualsSnapshot>): void {
    const next = { ...this.s, ...patch };
    if (
      'index' in patch ||
      'query' in patch ||
      'show' in patch ||
      'author' in patch ||
      'favourites' in patch ||
      'recent' in patch
    ) {
      next.list = filterPresets(next.index.presets, {
        query: next.query,
        show: next.show,
        author: next.author,
        favourites: next.favourites,
        recent: next.recent,
      });
    }
    next.header = this.headerFor(next);
    next.engine = engineModeFor(next);
    this.s = next;
    this.syncEngineAttr();
    for (const fn of this.listeners) fn();
    this.win.dispatchEvent(new CustomEvent('ss:visuals'));
  }

  private npv2(): NpV2 | undefined {
    return (this.win as Window & { npV2?: NpV2 }).npV2;
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  attach(nodes: {
    overlay: HTMLElement;
    gl: HTMLCanvasElement;
    canvas2d: HTMLCanvasElement;
  }): void {
    this.overlay = nodes.overlay;
    this.glCanvas = nodes.gl;
    this.canvas2d = nodes.canvas2d;
    const onPlayer = (e: Event) => {
      const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
      if (reason === 'track') this.onTrackChange();
    };
    this.win.addEventListener('ss:player', onPlayer);
    this.cleanups.push(() => this.win.removeEventListener('ss:player', onPlayer));
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTOCYCLE_KEY) this.set({ autocycle: normaliseAutocycle(e.newValue) });
    };
    this.win.addEventListener('storage', onStorage);
    this.cleanups.push(() => this.win.removeEventListener('storage', onStorage));
    const onVisibility = () => {
      this.guard.pause();
    };
    this.win.document.addEventListener('visibilitychange', onVisibility);
    this.cleanups.push(() =>
      this.win.document.removeEventListener('visibilitychange', onVisibility),
    );
    const onResize = () => this.resize();
    this.win.addEventListener('resize', onResize);
    this.cleanups.push(() => this.win.removeEventListener('resize', onResize));
    const onPhone = () => this.set({ phone: Boolean(this.phoneQuery?.matches) });
    this.phoneQuery?.addEventListener?.('change', onPhone);
    this.cleanups.push(() => this.phoneQuery?.removeEventListener?.('change', onPhone));
    this.syncEngineAttr();
  }

  dispose(): void {
    this.stopLoop();
    for (const c of this.cleanups.splice(0)) c();
    if (this.cycleTimer) clearInterval(this.cycleTimer);
    if (this.radioTimer) clearInterval(this.radioTimer);
  }

  /** The overlay opened or closed (the host watches its class). */
  setOpen(open: boolean): void {
    if (open === this.s.open) return;
    if (!open) {
      this.stopLoop();
      if (this.cycleTimer) clearInterval(this.cycleTimer);
      if (this.radioTimer) clearInterval(this.radioTimer);
      this.cycleTimer = null;
      this.radioTimer = null;
      this.clearPreview();
      this.set({ open: false, panelOpen: false, credit: null, radioDirect: null });
      return;
    }
    const v2 = this.npv2();
    const settingReduce = Boolean(v2?.getReduceMotion?.());
    const still = stillReason({
      systemReduce: Boolean(this.reduceQuery?.matches),
      settingReduce,
      playAnyway: playAnyway(),
    });
    this.set({
      open: true,
      still,
      themes: v2?.themeList?.() ?? this.s.themes,
      theme: v2?.getTheme?.() ?? this.s.theme,
      autocycle: normaliseAutocycle(loadAutocycle()),
      phone: Boolean(this.phoneQuery?.matches),
    });
    this.lastChange = this.now();
    this.cycleTimer = setInterval(() => this.cycleTick(), 1000);
    this.radioTimer = setInterval(() => this.radioTick(), 1000);
    this.silentSince = null;
    if (this.s.family === 'milkdrop') void this.ensureIndex();
    this.startEngine();
    this.showCredit('opened');
  }

  // ── the panel ──────────────────────────────────────────────────────────────

  togglePanel(open?: boolean): void {
    const want = open ?? !this.s.panelOpen;
    if (want === this.s.panelOpen) return;
    if (!want) this.clearPreview(true);
    // focus inside the panel goes back to the header's Visuals button
    const doc = this.win.document;
    const returnFocus =
      !want && Boolean(doc.getElementById('ss-visuals-panel')?.contains(doc.activeElement));
    this.set({ panelOpen: want, credit: want ? null : this.s.credit });
    if (returnFocus) doc.getElementById('np-v2-visuals-panel-btn')?.focus();
    if (want && this.s.family === 'milkdrop') void this.ensureIndex();
    this.resize();
    this.npv2()?.wakeVisuals?.();
  }

  setFamily(family: Family, moved: Moved = 'picked'): void {
    if (family === this.s.family) return;
    this.clearPreview(true);
    savePrefs({ family });
    this.set({ family, failure: null });
    if (family === 'milkdrop') void this.ensureIndex();
    this.startEngine();
    this.lastChange = this.now();
    this.showCredit(moved);
  }

  // ── MilkDrop's list ────────────────────────────────────────────────────────

  async ensureIndex(): Promise<void> {
    if (this.s.index.status === 'loading' || this.s.index.status === 'ready') return;
    this.set({ index: { ...this.s.index, status: 'loading', error: null } });
    const [index, favourites] = await Promise.all([
      fetchIndex(this.f).catch((e: Error) => e),
      fetchFavourites(this.f),
    ]);
    if (index instanceof Error) {
      this.set({ index: { status: 'error', presets: [], authors: [], error: index.message } });
      return;
    }
    this.set({
      index: { status: 'ready', presets: index.presets, authors: index.authors, error: null },
      favourites: new Set(favourites),
    });
    this.ensureMilkdropPreset();
  }

  /** MilkDrop on the stage with nothing loaded yet: the last one, else the first. */
  private ensureMilkdropPreset(): void {
    if (this.s.family !== 'milkdrop' || !this.s.open || this.s.still || !this.s.webgl2) return;
    if (this.s.index.status !== 'ready' || this.engineHasPreset || this.s.loadingKey) return;
    const known = this.entry(this.s.presetKey);
    const first =
      known ??
      this.s.index.presets.find((p) => p.full_name === FIRST_PRESET) ??
      this.s.index.presets[0] ??
      null;
    if (first) void this.loadPreset(first.key, 'opened', { keep: true });
  }

  /** After the own-presets folder changes: ask for the list again. */
  reloadIndex(): void {
    this.set({ index: { status: 'idle', presets: [], authors: [], error: null } });
    void this.ensureIndex();
  }

  setQuery(query: string): void {
    this.set({ query: query.slice(0, 200) });
  }

  setShow(show: ShowFilter): void {
    this.set({ show });
  }

  setAuthor(author: string): void {
    this.set({ author });
  }

  entry(key: string | null): PresetEntry | null {
    if (!key) return null;
    return this.s.index.presets.find((p) => p.key === key) ?? null;
  }

  /** Where a preset sits in the A–Z list (1-based), for the credit's "n of N". */
  private position(key: string | null): number {
    if (!key) return 0;
    return this.s.index.presets.findIndex((p) => p.key === key) + 1;
  }

  // ── picking, stepping, previewing ──────────────────────────────────────────

  pick(key: string, moved: Moved = 'picked'): void {
    this.clearPreview();
    void this.loadPreset(key, moved, { keep: true });
  }

  /** V / Shift+V / the header's ‹ ›: the family's next or previous. */
  step(dir: 1 | -1, moved: Moved = dir === 1 ? 'next' : 'previous'): void {
    if (this.s.family === 'synchros') {
      const ids = this.s.themes.length ? this.s.themes.map((t) => t.id) : [];
      if (!ids.length) {
        if (dir === 1) this.npv2()?.cycleTheme?.();
        else this.npv2()?.prevTheme?.();
        return;
      }
      const at = Math.max(0, ids.indexOf(this.s.theme));
      this.pickTheme(ids[(at + dir + ids.length) % ids.length]!, moved);
      return;
    }
    if (this.s.family === 'classic') {
      this.setClassicMode(this.s.classicMode === 'bars' ? 'scope' : 'bars', moved);
      return;
    }
    if (!this.s.webgl2) return;
    const list = this.cycleList();
    const key = stepKey(list, this.s.presetKey, dir, this.s.failed);
    if (key) this.pick(key, moved);
  }

  random(): void {
    if (this.s.family === 'synchros') {
      const ids = this.s.themes
        .map((t) => t.id)
        .filter((id) => id !== 'none' && id !== this.s.theme);
      if (ids.length) this.pickTheme(ids[Math.floor(Math.random() * ids.length)]!, 'random');
      return;
    }
    if (this.s.family === 'classic') {
      this.step(1, 'random');
      return;
    }
    if (!this.s.webgl2) return;
    const key = randomKey(this.cycleList(), this.s.presetKey, this.s.failed);
    if (key) this.pick(key, 'random');
  }

  /** The list V and auto-cycle walk: what the browser shows, else everything. */
  private cycleList(): PresetEntry[] {
    const list = this.s.list;
    if (list.length && (!this.s.presetKey || list.some((p) => p.key === this.s.presetKey)))
      return list;
    return this.s.index.presets;
  }

  /** A row hovered or focused: after 400 ms the stage previews it. */
  hoverRow(key: string): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (key === this.s.presetKey && !this.s.previewKey) return;
      if (this.previewFrom === null) this.previewFrom = this.s.presetKey;
      this.set({ previewKey: key === this.previewFrom ? null : key });
      void this.loadPreset(key, 'picked', { keep: false });
    }, PREVIEW_DELAY_MS);
  }

  /** Left the row: after a second the stage goes back to what was playing. */
  leaveRow(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.clearPreview(true);
    }, PREVIEW_BACK_MS);
  }

  private clearPreview(restore = false): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    const from = this.previewFrom;
    const was = this.s.previewKey;
    this.previewFrom = null;
    if (was) this.set({ previewKey: null });
    if (restore && was && from && from !== this.engineKey)
      void this.loadPreset(from, 'back', { keep: false, quiet: true });
  }

  /**
   * Fetch (kept after the first time), convert your own, then hand it to
   * Butterchurn. The last preset keeps running while this one loads; one
   * that fails puts the last one back and is skipped by auto-cycle.
   */
  async loadPreset(
    key: string,
    moved: Moved,
    opts: { keep: boolean; quiet?: boolean },
  ): Promise<boolean> {
    const entry = this.entry(key);
    if (!entry) return false;
    const gen = ++this.loadGen;
    const backKey = this.s.presetKey;
    if (opts.keep) this.set({ loadingKey: key, failure: null });
    if (opts.keep && !opts.quiet) this.showCredit(moved, { loading: true, key });
    let preset: Record<string, unknown>;
    try {
      const fetched: FetchedPreset = await fetchPreset(key, this.f);
      if (fetched.format === 'milk') {
        const conv = await (this.deps.loadConverter ?? (() => import('./milk-convert')))();
        preset = await conv.convertMilk(fetched.text);
      } else {
        preset = fetched.preset;
      }
      const engine = await this.ensureEngine();
      if (gen !== this.loadGen) return false;
      if (!engine) throw new Error('no engine');
      engine.load(preset, this.s.blend ? 2 : 0);
    } catch {
      if (gen !== this.loadGen) return false;
      forgetPreset(key);
      const failed = new Set(this.s.failed);
      failed.add(key);
      saveFailed([...failed]);
      const back = this.entry(backKey);
      this.set({
        failed,
        loadingKey: null,
        previewKey: opts.keep ? this.s.previewKey : null,
        failure: opts.keep
          ? { key, name: entry.name, backName: back?.name ?? null }
          : this.s.failure,
        credit: opts.keep ? null : this.s.credit,
      });
      return false;
    }
    if (gen !== this.loadGen) return false;
    this.engineKey = key;
    this.engineHasPreset = true;
    if (opts.keep) {
      const failed = new Set(this.s.failed);
      const wasFailed = failed.delete(key);
      if (wasFailed) saveFailed([...failed]);
      const recent = pushRecent(this.s.recent, key);
      savePrefs({ preset: key, recent });
      this.guard.reset();
      this.guardFrom = null;
      this.lastChange = this.now();
      this.set({ presetKey: key, loadingKey: null, recent, failed, failure: null });
      if (!opts.quiet) this.showCredit(moved);
    }
    return true;
  }

  retryFailure(): void {
    const f = this.s.failure;
    if (!f) return;
    forgetPreset(f.key);
    this.pick(f.key, 'retry');
  }

  nextAfterFailure(): void {
    const f = this.s.failure;
    this.set({ failure: null });
    const key = stepKey(this.cycleList(), f?.key ?? this.s.presetKey, 1, this.s.failed);
    if (key) this.pick(key, 'next');
  }

  dismissFailure(): void {
    this.set({ failure: null });
  }

  // ── favourites ─────────────────────────────────────────────────────────────

  async toggleFavourite(key?: string): Promise<void> {
    const k = key ?? (this.s.family === 'milkdrop' ? this.s.presetKey : null);
    if (!k) return;
    const on = !this.s.favourites.has(k);
    const optimistic = new Set(this.s.favourites);
    if (on) optimistic.add(k);
    else optimistic.delete(k);
    this.set({ favourites: optimistic });
    try {
      await setFavourite(k, on, this.f);
    } catch {
      const back = new Set(this.s.favourites);
      if (on) back.delete(k);
      else back.add(k);
      this.set({ favourites: back });
    }
  }

  // ── SYNCHRO.S and Classic ──────────────────────────────────────────────────

  pickTheme(id: string, moved: Moved = 'picked'): void {
    this.npv2()?.setTheme?.(id, { silent: true });
    this.lastChange = this.now();
    this.set({ theme: this.npv2()?.getTheme?.() ?? id });
    if (this.s.family !== 'synchros') this.setFamily('synchros', moved);
    else this.showCredit(moved);
  }

  /** The legacy engine changed the theme by itself (its own auto-cycle). */
  themeChanged(id: string): void {
    if (id !== this.s.theme) this.set({ theme: id });
  }

  setClassicMode(mode: ClassicMode, moved: Moved = 'picked'): void {
    savePrefs({ classicMode: mode });
    this.set({ classicMode: mode });
    if (this.s.family !== 'classic') this.setFamily('classic', moved);
    else this.showCredit(moved);
  }

  setClassicPeaks(on: boolean): void {
    savePrefs({ classicPeaks: on });
    this.set({ classicPeaks: on });
  }

  setScopeDraw(draw: ScopeDraw): void {
    savePrefs({ scopeDraw: draw });
    this.set({ scopeDraw: draw });
  }

  // ── the foot ───────────────────────────────────────────────────────────────

  setAutocycle(v: Autocycle): void {
    const value = normaliseAutocycle(v);
    const v2 = this.npv2();
    if (v2?.setVizAutocycle) v2.setVizAutocycle(value);
    else {
      try {
        this.win.localStorage.setItem(AUTOCYCLE_KEY, value);
      } catch {
        // best effort
      }
    }
    this.lastChange = this.now();
    this.set({ autocycle: value });
  }

  setBlend(on: boolean): void {
    savePrefs({ blend: on });
    this.set({ blend: on });
  }

  setQuality(q: Quality): void {
    savePrefs({ quality: q });
    this.guardFrom = null;
    // a person's choice: the guard leaves this preset alone
    this.guard.disarm();
    this.set({ quality: q, credit: this.s.credit?.guard ? null : this.s.credit });
    this.resize();
  }

  /** "Put it back" after the frame-rate guard dropped Quality. */
  restoreQuality(): void {
    const from = this.guardFrom;
    if (!from) return;
    this.setQuality(from);
  }

  // ── the states ─────────────────────────────────────────────────────────────

  playVisualsThisTime(): void {
    setPlayAnyway(true);
    this.set({ still: null });
    this.startEngine();
  }

  /** The radio card's "Play through SYNCHRO.S": restart the station through the relay. */
  async playThroughSynchros(): Promise<void> {
    const radio = (
      this.win as Window & {
        SoulSyncRadio?: {
          state(): { station: { id: string } | null; stream?: { id?: string } | null };
          play(id: string, o?: Record<string, unknown>): Promise<void>;
        };
      }
    ).SoulSyncRadio;
    const st = radio?.state();
    if (!radio || !st?.station) return;
    this.set({ radioDirect: null });
    this.silentSince = null;
    await radio.play(st.station.id, {
      streamId: st.stream?.id,
      station: st.station,
      forceRelay: true,
    });
  }

  private radioTick(): void {
    if (!this.s.open) return;
    const radio = (
      this.win as Window & {
        SoulSyncRadio?: {
          state(): { status: string; mode: string | null; station: { name: string } | null };
        };
      }
    ).SoulSyncRadio;
    const st = radio?.state();
    const direct = st && st.status === 'playing' && st.mode === 'direct' && st.station;
    if (!direct) {
      this.silentSince = null;
      if (this.s.radioDirect) this.set({ radioDirect: null });
      return;
    }
    if (!this.tap.silent()) {
      this.silentSince = null;
      if (this.s.radioDirect) this.set({ radioDirect: null });
      return;
    }
    const t = this.now();
    if (this.silentSince === null) this.silentSince = t;
    if (t - this.silentSince >= SILENT_DIRECT_MS && !this.s.radioDirect)
      this.set({ radioDirect: { station: st!.station!.name } });
  }

  // ── auto-cycle ─────────────────────────────────────────────────────────────

  private cycleTick(): void {
    if (!this.s.open || this.s.still) return;
    const every = autocycleSeconds(this.s.autocycle);
    if (!every || this.s.family !== 'milkdrop') return;
    if (this.s.loadingKey || this.s.previewKey) return;
    if (this.now() - this.lastChange >= every * 1000) {
      this.lastChange = this.now();
      const key = stepKey(this.cycleList(), this.s.presetKey, 1, this.s.failed);
      if (key) this.pick(key, 'every');
    }
  }

  private onTrackChange(): void {
    if (!this.s.open || this.s.still || this.s.autocycle !== 'track') return;
    if (this.s.family === 'milkdrop') {
      const key = stepKey(this.cycleList(), this.s.presetKey, 1, this.s.failed);
      if (key) this.pick(key, 'track');
    } else if (this.s.family === 'synchros') {
      // the legacy engine cycles its own on track change; this only credits it
      setTimeout(() => {
        const id = this.npv2()?.getTheme?.();
        if (id) this.set({ theme: id });
        this.showCredit('track');
      }, 200);
    }
  }

  // ── keys (10a; question 83) ────────────────────────────────────────────────

  key(action: 'next' | 'previous' | 'random' | 'favourite'): void {
    this.npv2()?.wakeVisuals?.();
    if (action === 'next') this.step(1);
    else if (action === 'previous') this.step(-1);
    else if (action === 'random') this.random();
    else if (action === 'favourite' && this.s.family === 'milkdrop') void this.toggleFavourite();
  }

  // ── the credit (10c) ───────────────────────────────────────────────────────

  private showCredit(moved: Moved, opts: { loading?: boolean; key?: string } = {}): void {
    if (!this.s.open) return;
    const s = this.s;
    let name = '';
    let author: string | null = null;
    let position = 0;
    let total = 0;
    if (s.family === 'milkdrop') {
      const e = this.entry(opts.key ?? s.presetKey);
      if (!e) return;
      name = e.name;
      author = e.author;
      position = this.position(e.key);
      total = s.index.presets.length;
    } else if (s.family === 'synchros') {
      const t = s.themes.find((x) => x.id === s.theme);
      name = t?.name ?? s.theme;
      position =
        Math.max(
          0,
          s.themes.findIndex((x) => x.id === s.theme),
        ) + 1;
      total = s.themes.length;
    } else {
      name = s.classicMode === 'bars' ? 'Bars' : 'Scope';
      position = s.classicMode === 'bars' ? 1 : 2;
      total = 2;
    }
    const loading = Boolean(opts.loading);
    const line = loading
      ? `${author ? `by ${author}` : 'author unknown'} · fetched once, then kept`
      : creditLine({ author, family: s.family, position, total, moved, autocycle: s.autocycle });
    const hints = !loading && this.hintsShown < HINT_TIMES && moved !== 'opened';
    if (hints) {
      this.hintsShown += 1;
      savePrefs({ hints: this.hintsShown });
    }
    const credit: Credit = {
      id: ++this.creditId,
      name: loading ? `Loading ${name}…` : name,
      line,
      until: this.now() + CREDIT_MS,
      hints,
      loading,
      guard: null,
    };
    if (this.creditTimer) clearTimeout(this.creditTimer);
    this.creditTimer = setTimeout(() => {
      // the card stays in the tree; the stylesheet hides it with the chrome
      if (this.s.credit?.id === credit.id) this.set({ credit: { ...credit, until: 0 } });
    }, CREDIT_MS);
    this.set({ credit: s.panelOpen ? null : credit });
  }

  private headerFor(s: VisualsSnapshot): { name: string; meta: string } {
    if (s.family === 'milkdrop') {
      const e = s.index.presets.find((p) => p.key === s.presetKey);
      if (!e) return { name: 'MilkDrop', meta: s.webgl2 ? 'Loading presets…' : 'Needs WebGL 2' };
      return { name: e.name, meta: `${e.author ? `by ${e.author}` : 'author unknown'} · MilkDrop` };
    }
    if (s.family === 'classic')
      return {
        name: s.classicMode === 'bars' ? 'Bars' : 'Scope',
        meta: 'Classic · drawn by SYNCHRO.S',
      };
    const t = s.themes.find((x) => x.id === s.theme);
    return { name: t?.name ?? 'Visuals', meta: `${FAMILY_NAMES.synchros} · drawn by SYNCHRO.S` };
  }

  // ── the stage ──────────────────────────────────────────────────────────────

  private engineMode(): VisualsSnapshot['engine'] {
    return engineModeFor(this.s);
  }

  private syncEngineAttr(): void {
    const mode = this.s.engine;
    if (this.overlay && this.overlay.dataset.visualsEngine !== mode) {
      this.overlay.dataset.visualsEngine = mode;
    }
  }

  private startEngine(): void {
    this.syncEngineAttr();
    const mode = this.engineMode();
    if (!this.s.open || (mode !== 'milkdrop' && mode !== 'classic')) {
      this.stopLoop();
      return;
    }
    this.resize();
    if (mode === 'milkdrop') {
      void this.ensureEngine();
      this.ensureMilkdropPreset();
    }
    if (!this.loopId) {
      this.lastFrame = 0;
      this.loopId = this.raf(this.frame);
    }
  }

  private stopLoop(): void {
    if (this.loopId) this.cancelRaf(this.loopId);
    this.loopId = 0;
    this.guard.pause();
  }

  private stageSize(): { width: number; height: number } {
    const el = this.overlay;
    const w = el?.clientWidth || this.win.innerWidth || 1440;
    const h = el?.clientHeight || this.win.innerHeight || 900;
    return { width: w, height: h };
  }

  private pixelRatio(): number {
    return qualityPixelRatio(this.s.quality, this.win.devicePixelRatio || 1);
  }

  private async ensureEngine(): Promise<MilkdropEngine | null> {
    if (this.engine) return this.engine;
    if (!this.s.webgl2 || !this.glCanvas) return null;
    if (!this.enginePromise) {
      const canvas = this.glCanvas;
      this.enginePromise = (this.deps.loadEngine ?? (() => import('./milkdrop-engine')))()
        .then((mod) => {
          const size = this.stageSize();
          this.engine = mod.createMilkdropEngine(canvas, {
            ...size,
            pixelRatio: this.pixelRatio(),
          });
          return this.engine;
        })
        .catch(() => {
          this.enginePromise = null;
          this.set({ engineError: 'MilkDrop didn’t start in this browser.' });
          return null;
        });
    }
    return this.enginePromise;
  }

  resize(): void {
    const { width, height } = this.stageSize();
    const pr = this.pixelRatio();
    try {
      this.engine?.resize(width, height, pr);
    } catch {
      // the next frame tries again
    }
    const c = this.canvas2d;
    if (c) {
      const dpr = Math.min(2, this.win.devicePixelRatio || 1);
      const w = Math.max(2, Math.round(width * dpr));
      const h = Math.max(2, Math.round(height * dpr));
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
    }
  }

  private frame = (t: number): void => {
    this.loopId = 0;
    const mode = this.engineMode();
    if (!this.s.open || (mode !== 'milkdrop' && mode !== 'classic')) return;
    this.loopId = this.raf(this.frame);
    if (this.win.document.hidden) return;
    const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = t;
    if (mode === 'milkdrop') {
      if (!this.engine || !this.engineHasPreset) return;
      this.tap.time(this.timeBuf);
      try {
        this.engine.frame(this.timeBuf);
      } catch {
        return;
      }
      if (this.guard.frame(t)) this.guardDrop();
      return;
    }
    this.drawClassic(dt);
  };

  private guardDrop(): void {
    const from = this.s.quality;
    const to = lowerQuality(from);
    if (!to) return;
    this.guardFrom = from;
    savePrefs({ quality: to });
    this.set({ quality: to });
    this.resize();
    const credit: Credit = {
      id: ++this.creditId,
      name: `Quality dropped to ${QUALITY_NAMES[to]}`,
      line: 'The picture was stuttering. This preset plays smoother this way.',
      until: this.now() + CREDIT_MS * 2,
      hints: false,
      loading: false,
      guard: { from, to },
    };
    if (this.creditTimer) clearTimeout(this.creditTimer);
    this.creditTimer = setTimeout(() => {
      if (this.s.credit?.id === credit.id) this.set({ credit: { ...credit, until: 0 } });
    }, CREDIT_MS * 2);
    this.set({ credit: this.s.panelOpen ? null : credit });
  }

  private drawClassic(dt: number): void {
    const c = this.canvas2d;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const { width, height } = this.stageSize();
    const scale = c.width / Math.max(1, width);
    const panel = this.s.panelOpen && !this.s.phone ? PANEL_WIDTH + PANEL_INSET * 2 : 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (this.s.classicMode === 'bars') {
      const rate = this.tap.sampleRate();
      if (!this.bins || this.binsRate !== rate) {
        this.bins = barBins(TAP_FFT / 2, rate);
        this.binsRate = rate;
      }
      this.tap.freq(this.freqBuf);
      stepBars(this.bars, barLevels(this.freqBuf, this.bins), dt);
      drawBars(ctx, this.bars, barsRect(width, height, panel), {
        peaks: this.s.classicPeaks,
        scale: 1,
      });
    } else {
      this.tap.time(this.timeBuf);
      const r = scopeRect(width, height, panel);
      drawScope(
        ctx,
        scopePoints(this.timeBuf, Math.max(64, Math.round(r.w / 3))),
        r,
        this.s.scopeDraw,
      );
    }
  }

  // ── for the tests and the screenshots ──────────────────────────────────────

  /** @internal */
  debugState(): { guardArmed: boolean; engineKey: string | null; hintsShown: number } {
    return { guardArmed: this.guard.armed, engineKey: this.engineKey, hintsShown: this.hintsShown };
  }

  /** @internal feed the guard a frame (tests) */
  debugGuardFrame(t: number): void {
    if (this.guard.frame(t)) this.guardDrop();
  }
}
