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
 * `milkdrop`, `classic` or `data` (this one's canvases; Data draws on
 * Classic's), `still`, or `lyrics` while Lyrics only turns the visual off
 * (27a; src/features/lyrics).
 */

import { lyricsStore } from '@/features/lyrics/lyrics-store';

import type { DataColour, DataInfo, DataNumbers, DataRow } from './data-viz';
import type { MilkdropEngine } from './milkdrop-engine';
import type { FetchLike, FetchedPreset } from './visuals-api';
import type { AudioTap } from './visuals-audio';
import type {
  Autocycle,
  ClassicMode,
  Family,
  Moved,
  NpV2,
  OwnFolderState,
  PresetAuthor,
  PresetEntry,
  PresetSet,
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
import { infoKey, loadDataInfo } from './data-source';
import {
  allZero,
  counterWords,
  countFullScale,
  DataTexture,
  drawDataMode,
  EMPTY_INFO,
  PHOSPHOR,
  readout,
  shownDepth,
  sliceWords,
  toInt,
  volumeGain,
  WHITE,
} from './data-viz';
import {
  fetchFavourites,
  fetchIndex,
  fetchPreset,
  forgetPreset,
  setFavourite,
} from './visuals-api';
import { createAudioTap, DATA_FFT, TAP_FFT } from './visuals-audio';
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
  withKept,
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

/** Data's settings (30a's pill, 30d's switches, 30h's colour), kept per browser. */
export interface DataPrefs {
  numbers: DataNumbers;
  bits: boolean;
  texture: boolean;
  colour: DataColour;
  underBars: boolean;
  underScope: boolean;
}

/** How often the texture moves on (it's texture, not for reading: 30a note 2). */
export const TEXTURE_MS = 100;
/** Reduced motion: one still block a second (30g). */
export const SNAPSHOT_MS = 1000;

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
  engine: 'synchros' | 'milkdrop' | 'classic' | 'data' | 'still' | 'lyrics';
  /** Lyrics only (27a): the lyrics layer turned the visual off */
  lyricsOnly: boolean;
  data: DataPrefs;
  /** Data's readout lines 1 and 2 as words, for a screen reader (the canvas is hidden) */
  dataSummary: string;
  webgl2: boolean;
  still: 'system' | 'setting' | null;
  phone: boolean;
  radioDirect: { station: string } | null;
  index: {
    status: IndexStatus;
    presets: PresetEntry[];
    authors: PresetAuthor[];
    error: string | null;
    /** favourites and Recent's presets the curated set leaves out (101) */
    kept?: PresetEntry[];
    /** which set the list is */
    set?: PresetSet;
    /** the bundled presets outside the curated packs */
    uncurated?: number;
    /** the admin's own-presets folder, for Show → Yours (18a, 18b) */
    own?: OwnFolderState;
  };
  /** "Every preset": list the uncurated presets too (101); per browser */
  everyPreset: boolean;
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
  if (s.lyricsOnly) return 'lyrics';
  // Data under reduced motion is a still block a second (30g), not the still stage
  if (s.family === 'data') return 'data';
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
  // Data (30a–30i)
  private readonly dataL = new Float32Array(DATA_FFT);
  private readonly dataR = new Float32Array(DATA_FFT);
  private dataRows: DataRow[] = [];
  private fullScale = 0;
  private info: DataInfo = EMPTY_INFO;
  private infoFor: string | null = null;
  private texture: DataTexture | null = null;
  private layerTexture: DataTexture | null = null;
  private textureAt = 0;
  private textureStill = false;
  private snapshotAt = 0;
  private fps = 60;
  private infoCheckedAt = 0;
  /** the element's volume undone (volumeGain) */
  private gain = 1;
  private lastSize: { width: number; height: number } | null = null;
  private accentRgb = '';
  private accentAt = 0;
  /** @internal the last frame's cost, for the screenshots' measurement */
  lastDataMs = 0;

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
      everyPreset: prefs.everyPreset,
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
      lyricsOnly: lyricsStore(this.win).snapshot().onlyActive,
      data: {
        numbers: prefs.dataNumbers,
        bits: prefs.dataBits,
        texture: prefs.dataTexture,
        colour: prefs.dataColour,
        underBars: prefs.dataUnderBars,
        underScope: prefs.dataUnderScope,
      },
      dataSummary: '',
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
        kept: next.index.kept,
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
      if (reason === 'track') {
        this.resetData();
        this.onTrackChange();
      }
    };
    // Lyrics only (27a) turns the stage off; turned back, the visual returns
    const lyrics = lyricsStore(this.win);
    this.cleanups.push(
      lyrics.subscribe(() => {
        const only = lyrics.snapshot().onlyActive;
        if (only === this.s.lyricsOnly) return;
        this.set({ lyricsOnly: only });
        this.startEngine();
      }),
    );
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
      this.set({
        open: false,
        panelOpen: false,
        credit: null,
        radioDirect: null,
      });
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
    const set: PresetSet = this.s.everyPreset ? 'all' : 'curated';
    const [index, favourites] = await Promise.all([
      fetchIndex({ set, keep: this.s.recent }, this.f).catch((e: Error) => e),
      fetchFavourites(this.f),
    ]);
    if (index instanceof Error) {
      this.set({
        index: {
          status: 'error',
          presets: [],
          authors: [],
          error: index.message,
        },
      });
      return;
    }
    // "Every preset" changed while this list was on its way: ask again
    if ((index.set ?? set) !== (this.s.everyPreset ? 'all' : 'curated')) {
      this.set({
        index: { status: 'idle', presets: [], authors: [], error: null },
      });
      void this.ensureIndex();
      return;
    }
    const own = index.own;
    this.set({
      index: {
        status: 'ready',
        presets: index.presets,
        authors: index.authors,
        error: null,
        kept: index.kept ?? [],
        set: index.set ?? set,
        uncurated: index.uncurated ?? 0,
        own,
      },
      favourites: new Set(favourites),
      // Yours goes when the folder does
      show: this.s.show === 'yours' && !own?.configured ? 'all' : this.s.show,
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
    this.set({
      index: { status: 'idle', presets: [], authors: [], error: null },
    });
    void this.ensureIndex();
  }

  /** "Every preset" in the panel's foot (101): the other presets join the list. */
  setEveryPreset(on: boolean): void {
    if (on === this.s.everyPreset) return;
    savePrefs({ everyPreset: on });
    const wasLoading = this.s.index.status === 'loading';
    this.set({ everyPreset: on });
    // a list on its way is checked against the switch when it lands
    if (!wasLoading) this.reloadIndex();
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
    return (
      this.s.index.presets.find((p) => p.key === key) ??
      this.s.index.kept?.find((p) => p.key === key) ??
      null
    );
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
    // Classic and Data are one ring for V (30a note 1): Bars, Scope, Data
    if (this.s.family === 'classic' || this.s.family === 'data') {
      const ring = ['bars', 'scope', 'data'] as const;
      const at = this.s.family === 'data' ? 2 : this.s.classicMode === 'bars' ? 0 : 1;
      const to = ring[(at + dir + ring.length) % ring.length]!;
      if (to === 'data') this.setFamily('data', moved);
      else this.setClassicMode(to, moved);
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
    if (this.s.family === 'classic' || this.s.family === 'data') {
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
      this.set({
        presetKey: key,
        loadingKey: null,
        recent,
        failed,
        failure: null,
      });
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

  // ── Data (30a–30i) ─────────────────────────────────────────────────────────

  setData(patch: Partial<DataPrefs>): void {
    const data = { ...this.s.data, ...patch };
    savePrefs({
      dataNumbers: data.numbers,
      dataBits: data.bits,
      dataTexture: data.texture,
      dataColour: data.colour,
      dataUnderBars: data.underBars,
      dataUnderScope: data.underScope,
    });
    if (patch.colour) this.textureStill = false;
    this.set({ data });
  }

  /** A new track: its own readout, count and texture. */
  private resetData(): void {
    this.dataRows = [];
    this.fullScale = 0;
    this.infoFor = null;
    this.textureStill = false;
  }

  /** Which track the readout is for, looked at twice a second (not every frame). */
  private ensureInfo(): void {
    const now = this.now();
    if (this.infoFor !== null && now - this.infoCheckedAt < 500) return;
    this.infoCheckedAt = now;
    const key = infoKey(this.win);
    if (key === this.infoFor) return;
    this.infoFor = key;
    this.info = EMPTY_INFO;
    void loadDataInfo(this.win, this.f).then((info) => {
      if (this.infoFor !== key) return;
      this.info = info;
      const r = readout(info, this.tap.sampleRate(), { fullScale: 0, silent: false });
      this.set({ dataSummary: `${r.line1}. ${r.line2}.` });
    });
  }

  private dataRgb(): string {
    const c = this.s.data.colour;
    if (c === 'phosphor') return PHOSPHOR;
    if (c === 'white') return WHITE;
    // the accent, read from the page's style every 2 s, not every frame
    const now = this.now();
    if (this.accentRgb && now - this.accentAt < 2000) return this.accentRgb;
    this.accentAt = now;
    this.accentRgb = this.readAccent();
    return this.accentRgb;
  }

  private readAccent(): string {
    try {
      const v = this.win
        .getComputedStyle(this.win.document.documentElement)
        .getPropertyValue('--ss-accent-light-rgb')
        .trim();
      if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(v)) return v;
    } catch {
      // the default below
    }
    return '194, 169, 250';
  }

  private makeCanvas = (w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null => {
    try {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      const c = this.win.document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    } catch {
      return null;
    }
  };

  private playerState(): { playing: boolean; time: number; gain: number; muted: boolean } {
    const p = (
      this.win as Window & {
        SoulSyncPlayer?: {
          state?: () => { playing?: boolean };
          audio?: () => HTMLMediaElement | null;
        };
      }
    ).SoulSyncPlayer;
    try {
      // the element itself: state() builds the whole player snapshot, too much for every frame
      const el = p?.audio?.() ?? null;
      if (el) {
        const muted = el.muted || el.volume <= 0.001;
        return {
          playing: !el.paused,
          time: el.currentTime,
          gain: volumeGain(el.volume, el.muted),
          muted,
        };
      }
      return { playing: Boolean(p?.state?.()?.playing), time: 0, gain: 1, muted: false };
    } catch {
      return { playing: false, time: 0, gain: 1, muted: false };
    }
  }

  /** The texture's next line: values from across the newest block. */
  private textureLine(columns: number, depth: 16 | 24, from: Float32Array, shift = 0): number[] {
    const out: number[] = [];
    const step = Math.max(1, Math.floor(from.length / Math.max(1, columns)));
    for (let i = 0; i < columns; i += 1)
      out.push(toInt((from[(i * step + shift * 13) % from.length] ?? 0) * this.gain, depth));
    return out;
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
    this.set({
      quality: q,
      credit: this.s.credit?.guard ? null : this.s.credit,
    });
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
          state(): {
            station: { id: string } | null;
            stream?: { id?: string } | null;
          };
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
          state(): {
            status: string;
            mode: string | null;
            station: { name: string } | null;
          };
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
    } else if (s.family === 'data') {
      name = 'Data';
    } else {
      name = s.classicMode === 'bars' ? 'Bars' : 'Scope';
      position = s.classicMode === 'bars' ? 1 : 2;
      total = 2;
    }
    const loading = Boolean(opts.loading);
    const line = loading
      ? `${author ? `by ${author}` : 'author unknown'} · fetched once, then kept`
      : creditLine({
          author,
          family: s.family,
          position,
          total,
          moved,
          autocycle: s.autocycle,
        });
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
    // Lyrics only (27a): no visual plays, so the header says so
    if (s.lyricsOnly) return { name: 'Lyrics only', meta: 'The visual is off' };
    if (s.family === 'milkdrop') {
      const e = withKept(s.index.presets, s.index.kept).find((p) => p.key === s.presetKey);
      if (!e)
        return {
          name: 'MilkDrop',
          meta: s.webgl2 ? 'Loading presets…' : 'Needs WebGL 2',
        };
      return {
        name: e.name,
        meta: `${e.author ? `by ${e.author}` : 'author unknown'} · MilkDrop`,
      };
    }
    if (s.family === 'classic')
      return {
        name: s.classicMode === 'bars' ? 'Bars' : 'Scope',
        meta: 'Classic · drawn by SYNCHRO.S',
      };
    // 30a's header: "Data · SYNCHRO.S · the decoded audio"
    if (s.family === 'data') return { name: 'Data', meta: 'SYNCHRO.S · the decoded audio' };
    const t = s.themes.find((x) => x.id === s.theme);
    return {
      name: t?.name ?? 'Visuals',
      meta: `${FAMILY_NAMES.synchros} · drawn by SYNCHRO.S`,
    };
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
    if (!this.s.open || (mode !== 'milkdrop' && mode !== 'classic' && mode !== 'data')) {
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

  /**
   * The stage's size for a frame: kept from the last resize (the window's,
   * the panel's, opening), since reading the overlay's size every frame
   * forced the page's layout each time (Data's measurement, 30 October).
   */
  private frameSize(): { width: number; height: number } {
    return (this.lastSize ??= this.stageSize());
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
    const { width, height } = (this.lastSize = this.stageSize());
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
    if (!this.s.open || (mode !== 'milkdrop' && mode !== 'classic' && mode !== 'data')) return;
    this.loopId = this.raf(this.frame);
    // a hidden tab draws nothing (the browser slows the frames too); the
    // counter is worked out from the play position, so it's right on return (257)
    if (this.win.document.hidden) return;
    const raw = this.lastFrame ? (t - this.lastFrame) / 1000 : 1 / 60;
    const dt = Math.min(0.1, raw);
    this.lastFrame = t;
    if (raw > 0 && raw < 0.5) this.fps = this.fps * 0.95 + (1 / raw) * 0.05;
    if (mode === 'data') {
      this.drawData(raw, t);
      return;
    }
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
    const { width, height } = this.frameSize();
    const scale = c.width / Math.max(1, width);
    const panel = this.s.panelOpen && !this.s.phone ? PANEL_WIDTH + PANEL_INSET * 2 : 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const under = this.s.classicMode === 'bars' ? this.s.data.underBars : this.s.data.underScope;
    if (under) this.drawDataLayer(ctx, width, height);
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

  /**
   * "Data underneath" (30d): texture only, 20% of the visual's colour, edge
   * to edge, under the spectrum or the scope; no readout, no labels.
   */
  private drawDataLayer(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const tex = (this.layerTexture ??= new DataTexture(this.makeCanvas));
    const rgb = this.dataRgb();
    const depth = shownDepth(this.info);
    this.ensureInfo();
    const fresh = tex.ensure(width, height, rgb, 0.2);
    const now = this.now();
    if (fresh || now - this.textureAt >= TEXTURE_MS) {
      this.textureAt = now;
      const got = this.tap.floats?.(this.dataL, this.dataR) ?? false;
      if (fresh) tex.fill((i) => this.textureLine(tex.columns, depth, this.dataL, i), depth);
      else if (got) tex.push(this.textureLine(tex.columns, depth, this.dataL), depth);
    }
    tex.draw(ctx, 0, 0);
  }

  /** Data as its own visual (30a–30c, 30f, 30g). */
  private drawData(raw: number, t: number): void {
    const c = this.canvas2d;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const snapshot = Boolean(this.s.still);
    // reduced motion: one still block a second, no scrolling (30g)
    if (snapshot && this.snapshotAt && t - this.snapshotAt < SNAPSHOT_MS) return;
    this.snapshotAt = t;
    const started = typeof performance !== 'undefined' ? performance.now() : 0;
    const { width, height } = this.frameSize();
    const scale = c.width / Math.max(1, width);
    const panel = this.s.panelOpen && !this.s.phone ? PANEL_WIDTH + PANEL_INSET * 2 : 0;
    const phone = this.s.phone;
    // a phone on its side (30c): full screen, one readout line, the chrome over it on a tap
    const short = width > height && height <= 500;
    const top = short ? 0 : phone ? 56 : 64;
    const bottom = short ? 0 : phone ? 64 : 72 + 64;
    const stage = { x: 0, y: top, w: width - panel, h: height - top - bottom };

    this.ensureInfo();
    const info = this.info;
    const depth = shownDepth(info);
    const mono = info.channels === 1;
    const rate = this.tap.sampleRate();
    const { playing, time, gain, muted } = this.playerState();
    this.gain = gain;
    const got = playing ? (this.tap.floats?.(this.dataL, this.dataR) ?? false) : false;
    if (got) {
      // the full-scale count: only the samples new since the last frame (256)
      const fresh = Math.min(DATA_FFT, Math.round(Math.min(raw, 0.5) * rate));
      this.fullScale += countFullScale(this.dataL, fresh, depth, gain);
      if (!mono) this.fullScale += countFullScale(this.dataR, fresh, depth, gain);
      const last = DATA_FFT - 1;
      if (snapshot) {
        // one block of consecutive samples, all at full strength
        const n = 24;
        this.dataRows = [];
        for (let i = DATA_FFT - n; i < DATA_FFT; i += 1)
          this.dataRows.push({
            l: toInt(this.dataL[i]! * gain, depth),
            r: mono ? null : toInt(this.dataR[i]! * gain, depth),
          });
      } else {
        this.dataRows.push({
          l: toInt(this.dataL[last]! * gain, depth),
          r: mono ? null : toInt(this.dataR[last]! * gain, depth),
        });
        if (this.dataRows.length > 32) this.dataRows.splice(0, this.dataRows.length - 32);
      }
    }

    const rgb = this.dataRgb();
    let tex: DataTexture | null = null;
    if (this.s.data.texture) {
      tex = this.texture ??= new DataTexture(this.makeCanvas);
      const fresh = tex.ensure(Math.ceil(stage.w), Math.ceil(stage.h), rgb, 0.14, true);
      const now = this.now();
      if (fresh || (snapshot && !this.textureStill)) {
        // a new size, or reduced motion's texture: drawn once per track
        tex.fill((i) => this.textureLine(tex!.columns, depth, this.dataL, i), depth);
        this.textureStill = true;
      } else if (!snapshot && got && now - this.textureAt >= TEXTURE_MS) {
        this.textureAt = now;
        tex.push(this.textureLine(tex.columns, depth, this.dataL), depth);
      }
    }

    const fileRate = info.fileRate || rate;
    let samples = time * fileRate;
    if (snapshot) samples = Math.floor(samples / fileRate) * fileRate;
    const stream = Boolean(info.station);
    // Drawn into an offscreen buffer, then copied: on a canvas in the page each
    // change of font made the browser recompute the page's styles first,
    // which cost more than the whole drawing (the measurement, 30 October).
    const fb = this.frameBuffer(c.width, c.height);
    const dc = (fb?.getContext('2d') as CanvasRenderingContext2D | null) ?? ctx;
    dc.setTransform(1, 0, 0, 1, 0, 0);
    dc.clearRect(0, 0, c.width, c.height);
    dc.setTransform(scale, 0, 0, scale, 0, 0);
    drawDataMode(
      dc,
      stage,
      this.dataRows,
      {
        numbers: this.s.data.numbers,
        bits: this.s.data.bits,
        texture: this.s.data.texture,
        rgb,
        depth,
        mono,
        snapshot,
        phone,
        short,
        readout: readout(info, rate, {
          fullScale: this.fullScale,
          silent: allZero(this.dataRows),
        }),
        counter: counterWords(samples, info.channels, stream),
        tag: !playing
          ? 'Paused'
          : muted
            ? 'Muted: no samples reach the analyser'
            : snapshot
              ? 'Snapshot · every 1 s'
              : null,
        slice: snapshot ? null : sliceWords(rate, this.fps),
      },
      tex,
    );
    if (dc !== ctx && fb) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(fb as CanvasImageSource, 0, 0);
    }
    if (started) this.lastDataMs = performance.now() - started;
  }

  private fb: OffscreenCanvas | null = null;

  private frameBuffer(w: number, h: number): OffscreenCanvas | null {
    if (typeof OffscreenCanvas === 'undefined') return null;
    try {
      if (!this.fb || this.fb.width !== w || this.fb.height !== h)
        this.fb = new OffscreenCanvas(w, h);
      return this.fb;
    } catch {
      return null;
    }
  }

  // ── for the tests and the screenshots ──────────────────────────────────────

  /** @internal */
  debugState(): {
    guardArmed: boolean;
    engineKey: string | null;
    hintsShown: number;
  } {
    return {
      guardArmed: this.guard.armed,
      engineKey: this.engineKey,
      hintsShown: this.hintsShown,
    };
  }

  /** @internal feed the guard a frame (tests) */
  debugGuardFrame(t: number): void {
    if (this.guard.frame(t)) this.guardDrop();
  }
}
