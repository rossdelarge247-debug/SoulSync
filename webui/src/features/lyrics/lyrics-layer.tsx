/**
 * The lyrics layer (27a–27g) and the phone's record (27e).
 *
 * In the Visuals overlay: the current line large in the middle with the line
 * before fading above and the next waiting below, over a soft oval scrim
 * where the words are (62% black at its centre to 30% at its edge), over
 * MilkDrop, Classic or the SYNCHRO.S visuals; over the artwork (the still
 * stage) the art is blurred 40px and darkened 55%; "Lyrics only" is a
 * #0c0c0c ground with the artwork's colour as a faint wash. The pill above
 * the transport (Lyrics only · A− A+ · Earlier / offset / Later · source)
 * comes and goes with the overlay's chrome.
 *
 * On a phone in portrait the lyrics take the artwork's place in the
 * expanded player (27e): four lines and the source line; text size and the
 * nudge are in the record's "…".
 *
 * Time: the player's position, less the browser's output delay (the audio
 * graph's base and output latency) so words land with the sound, plus the
 * nudge. One animation frame loop while the layer shows; the sweep is
 * written straight to the word spans (`--f`), not through React.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { LyricsSnapshot, LyricsStore } from './lyrics-store';
import type { LyricLine } from './lyrics.logic';

import {
  clock,
  lineAt,
  offsetSpoken,
  offsetWords,
  plainProgress,
  sideSize,
  SIZES,
  wordFills,
} from './lyrics.logic';
import styles from './lyrics.module.css';

interface PlayerHooks {
  audio?: () => HTMLMediaElement | null;
  outputTargets?: () => { context?: AudioContext | null };
  seek?: (seconds: number) => void;
}

function player(): PlayerHooks | undefined {
  return (window as Window & { SoulSyncPlayer?: PlayerHooks }).SoulSyncPlayer;
}

/** The browser's output delay, in seconds (0 when it can't be read). */
export function outputDelay(ctx: AudioContext | null | undefined): number {
  if (!ctx) return 0;
  const out = Number((ctx as AudioContext & { outputLatency?: number }).outputLatency) || 0;
  const base = Number(ctx.baseLatency) || 0;
  const d = out + base;
  return Number.isFinite(d) && d > 0 && d < 1 ? d : 0;
}

/** Where the words are: the position, less the output delay, plus the nudge. */
export function lyricTime(offset: number): { t: number; duration: number } {
  const p = player();
  const el = p?.audio?.() ?? null;
  if (!el) return { t: 0, duration: 0 };
  let ctx: AudioContext | null = null;
  try {
    ctx = p?.outputTargets?.()?.context ?? null;
  } catch {
    ctx = null;
  }
  return { t: el.currentTime - outputDelay(ctx) + offset, duration: el.duration || 0 };
}

export function useLyrics(store: LyricsStore): LyricsSnapshot {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

export function reducedMotion(): boolean {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
  } catch {
    // no matchMedia
  }
  const v2 = (window as Window & { npV2?: { getReduceMotion?: () => boolean } }).npV2;
  return Boolean(v2?.getReduceMotion?.());
}

/** The words of a line, each a span the sweep fills. */
function Words({
  line,
  wordRefs,
}: {
  line: LyricLine;
  wordRefs?: React.MutableRefObject<(HTMLSpanElement | null)[]>;
}) {
  if (!line.text) return <span className={styles.gap}>♪</span>;
  return (
    <>
      {line.words.map((w, i) => (
        <span
          // eslint-disable-next-line react/no-array-index-key -- words repeat in a line
          key={i}
          className={styles.word}
          ref={(el) => {
            if (wordRefs) wordRefs.current[i] = el;
          }}
        >
          {w.text}
          {i < line.words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  );
}

function seekTo(line: LyricLine, offset: number): void {
  const p = player();
  // a hair after the line's start, so it's the line that plays
  p?.seek?.(Math.max(0, line.time - offset + 0.05));
}

/**
 * The timed lines: before, now (swept), next, and on the phone one more.
 * Each line is a button that seeks to it; hovering shows its time at its end.
 */
export function TimedLines({
  s,
  active,
  variant,
}: {
  s: LyricsSnapshot;
  active: boolean;
  variant: 'stage' | 'record';
}) {
  const lines = s.doc?.lines ?? [];
  const [idx, setIdx] = useState(-1);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const offsetRef = useRef(s.offset);
  offsetRef.current = s.offset;
  const still = reducedMotion();
  const real = lines[idx]?.real ?? lines.some((l) => l.real);

  useEffect(() => {
    if (!active || !lines.length) return;
    let raf = 0;
    let shown = -2;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const { t } = lyricTime(offsetRef.current);
      const i = lineAt(lines, t);
      if (i !== shown) {
        shown = i;
        setIdx(i);
      }
      const line = lines[i];
      if (!line) return;
      const fills = still ? line.words.map(() => 1) : wordFills(line, t);
      fills.forEach((f, w) => {
        const el = wordRefs.current[w];
        if (!el) return;
        // the estimate's 24px feather sits across the edge, so 0 is fully dark
        const at = line.real ? `${f * 100}%` : `calc(${f * 100}% + ${(f * 2 - 1) * 12}px)`;
        if (el.style.getPropertyValue('--f') !== at) el.style.setProperty('--f', at);
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, lines, still]);

  const cur = lines[idx];
  const prev = idx > 0 ? lines[idx - 1] : undefined;
  const next = lines[idx + 1];
  const after = variant === 'record' ? lines[idx + 2] : undefined;
  wordRefs.current = [];

  const lineButton = (line: LyricLine | undefined, role: 'prev' | 'next' | 'after') =>
    line ? (
      <button
        type="button"
        className={`${styles.line} ${styles[role]}`}
        onClick={() => seekTo(line, s.offset)}
        aria-label={`${line.text || 'Instrumental break'}, at ${clock(line.time)}. Play from here`}
      >
        <span className={styles.lineText}>{line.text || '♪'}</span>
        <span className={styles.lineTime} aria-hidden="true">
          {clock(line.time)}
        </span>
      </button>
    ) : (
      <span className={`${styles.line} ${styles[role]} ${styles.empty}`} aria-hidden="true" />
    );

  return (
    <div
      className={styles.lines}
      data-variant={variant}
      data-sweep={real ? 'real' : 'estimate'}
      data-still={still ? 'true' : undefined}
      style={
        {
          '--ly-size': `${s.size}px`,
          '--ly-side': `${sideSize(s.size)}px`,
        } as React.CSSProperties
      }
    >
      {lineButton(prev, 'prev')}
      {cur ? (
        <button
          type="button"
          className={`${styles.line} ${styles.current}`}
          onClick={() => seekTo(cur, s.offset)}
          aria-label={`${cur.text || 'Instrumental break'}, at ${clock(cur.time)}. Play from here`}
        >
          {/* keyed by the line, so each new line fades in; the button keeps focus */}
          <span key={idx} className={styles.lineText}>
            <Words line={cur} wordRefs={wordRefs} />
          </span>
          <span className={styles.lineTime} aria-hidden="true">
            {clock(cur.time)}
          </span>
        </button>
      ) : (
        <span className={`${styles.line} ${styles.current} ${styles.waiting}`} aria-hidden="true">
          ♪
        </span>
      )}
      {lineButton(next, 'next')}
      {variant === 'record' ? lineButton(after, 'after') : null}
      {/* the line, not the sweep, as a polite update when it changes (27a) */}
      <p className={styles.srOnly} aria-live="polite">
        {cur?.text ?? ''}
      </p>
    </div>
  );
}

/** Plain lyrics (27g): all lines alike, a slow scroll paced by the track. */
export function PlainLines({ s, active }: { s: LyricsSnapshot; active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const still = reducedMotion();
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = -1;
    let lastAt = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !box.current || !list.current) return;
      // reduced motion: no scroll, the block moves on every 5 s
      if (still && now - lastAt < 5000 && last >= 0) return;
      lastAt = now;
      const { t, duration } = lyricTime(0);
      const room = Math.max(0, list.current.scrollHeight - box.current.clientHeight);
      const y = Math.round(plainProgress(t, duration) * room);
      if (y !== last) {
        last = y;
        list.current.style.transform = `translateY(${-y}px)`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, still, s.doc]);
  return (
    <div className={styles.plainBox} ref={box}>
      <div className={styles.plainList} ref={list}>
        {(s.doc?.plain ?? []).map((l, i) =>
          // eslint-disable-next-line react/no-array-index-key -- lines repeat
          l ? <p key={i}>{l}</p> : <p key={i} className={styles.plainGap} aria-hidden="true" />,
        )}
      </div>
    </div>
  );
}

/** Loading, None found and Instrumental (27g), quiet in the layer's place. */
function StateNote({ s }: { s: LyricsSnapshot }) {
  if (s.state === 'loading')
    return (
      <div className={styles.note} role="status">
        <p className={styles.noteMain}>Finding the words…</p>
        <p className={styles.noteSub}>Looking in LRCLIB and beside the track</p>
      </div>
    );
  if (s.state === 'none' && s.quiet)
    return (
      <div className={styles.note} role="status">
        <p className={styles.noteMain}>No lyrics found{s.title ? ` for ${s.title}` : ''}</p>
        <p className={styles.noteSub}>Looked in LRCLIB and beside the track</p>
      </div>
    );
  if (s.state === 'instrumental' && s.quiet)
    return (
      <div className={styles.note} role="status">
        <p className={styles.noteMain}>Instrumental</p>
        <p className={styles.noteSub}>LRCLIB marks it as instrumental</p>
      </div>
    );
  return null;
}

/** The pill above the transport (27a). */
export function LyricsPill({ s, store }: { s: LyricsSnapshot; store: LyricsStore }) {
  const smallest = s.size === SIZES[0];
  const largest = s.size === SIZES[SIZES.length - 1];
  return (
    <div className={styles.pill} role="group" aria-label="Lyrics" data-lyrics-pill>
      <button
        type="button"
        className={styles.pillBtn}
        aria-pressed={s.only}
        onClick={() => store.setOnly(!s.only)}
      >
        Lyrics only
      </button>
      <span className={styles.pillRule} aria-hidden="true" />
      <button
        type="button"
        className={styles.pillBtn}
        aria-label="Smaller lyrics"
        aria-disabled={smallest || undefined}
        onClick={() => !smallest && store.stepSize(-1)}
      >
        A−
      </button>
      <button
        type="button"
        className={`${styles.pillBtn} ${styles.pillBig}`}
        aria-label="Larger lyrics"
        aria-disabled={largest || undefined}
        onClick={() => !largest && store.stepSize(1)}
      >
        A+
      </button>
      {s.state === 'synced' ? (
        <>
          <span className={styles.pillRule} aria-hidden="true" />
          <button
            type="button"
            className={styles.pillBtn}
            aria-label="Lyrics earlier by 0.1 seconds"
            onClick={() => store.nudge(1)}
          >
            Earlier
          </button>
          <button
            type="button"
            className={styles.pillOffset}
            aria-label={`Lyrics ${offsetSpoken(s.offset)} for this track. Put back on time`}
            title="Put back on time"
            onClick={() => store.resetOffset()}
          >
            {offsetWords(s.offset)}
          </button>
          <button
            type="button"
            className={styles.pillBtn}
            aria-label="Lyrics later by 0.1 seconds"
            onClick={() => store.nudge(-1)}
          >
            Later
          </button>
        </>
      ) : null}
      {s.source ? (
        <>
          <span className={styles.pillRule} aria-hidden="true" />
          <span className={styles.pillSource}>{s.source}</span>
        </>
      ) : null}
    </div>
  );
}

/** The layer in the Visuals overlay. */
export function LyricsLayer({
  store,
  open,
  engine,
}: {
  store: LyricsStore;
  open: boolean;
  /** the overlay's data-visuals-engine: the artwork treatment is for 'still' */
  engine: string;
}) {
  const s = useLyrics(store);
  const art = useArt(open && s.showing && (engine === 'still' || s.onlyActive));
  const quietShown = open && s.showing && s.quiet;
  useEffect(() => {
    if (quietShown) store.seen();
  }, [quietShown, store]);
  if (!open || !s.showing) return null;
  const words = s.state === 'synced' || s.state === 'plain';
  const ground = s.onlyActive ? 'only' : engine === 'still' ? 'art' : 'visual';
  return (
    <div className={styles.layer} data-ground={ground} data-state={s.state} data-lyrics-layer>
      {ground === 'only' ? <div className={styles.wash} aria-hidden="true" /> : null}
      {ground === 'art' && art ? (
        <div
          className={styles.artBlur}
          aria-hidden="true"
          style={{ backgroundImage: `url("${art.replace(/"/g, '%22')}")` }}
        />
      ) : null}
      {/* the visual plays clear until there are words to show (27g) */}
      {words && ground === 'visual' ? <div className={styles.scrim} aria-hidden="true" /> : null}
      <div className={styles.stage}>
        {s.state === 'synced' ? <TimedLines s={s} active={open} variant="stage" /> : null}
        {s.state === 'plain' ? <PlainLines s={s} active={open} /> : null}
        <StateNote s={s} />
      </div>
      {words ? <LyricsPill s={s} store={store} /> : null}
    </div>
  );
}

function useArt(on: boolean): string | null {
  const [art, setArt] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    const read = () => {
      try {
        const st = (
          window as Window & {
            SoulSyncPlayer?: { state?: () => { track?: { image_url?: string | null } | null } };
          }
        ).SoulSyncPlayer?.state?.();
        setArt(st?.track?.image_url || null);
      } catch {
        setArt(null);
      }
    };
    read();
    window.addEventListener('ss:player', read);
    return () => window.removeEventListener('ss:player', read);
  }, [on]);
  return on ? art : null;
}

/** The phone's record (27e): the lyrics in the artwork's place. */
export function LyricsRecord({ store, active }: { store: LyricsStore; active: boolean }) {
  const s = useLyrics(store);
  const words = s.state === 'synced' || s.state === 'plain';
  const show = s.on && s.available;
  const quietShown = active && show && s.quiet;
  useEffect(() => {
    if (quietShown) store.seen();
  }, [quietShown, store]);
  const content = useMemo(() => {
    if (!show) return null;
    if (s.state === 'synced') return <TimedLines s={s} active={active} variant="record" />;
    if (s.state === 'plain') return <PlainLines s={s} active={active} />;
    if (s.state === 'loading') return <p className={styles.recordNote}>Finding the words…</p>;
    if (s.state === 'instrumental') return <p className={styles.recordNote}>Instrumental</p>;
    return <p className={styles.recordNote}>No lyrics found{s.title ? ` for ${s.title}` : ''}</p>;
  }, [show, s, active]);
  if (!show) return null;
  return (
    <div className={styles.record} data-state={s.state}>
      {content}
      {words && s.source ? <p className={styles.recordSource}>{s.source}</p> : null}
    </div>
  );
}
