/**
 * A lane's waveform, sections strip and beat map (37b), zoomable (3b, 37s)
 * and where cues are placed (439).
 *
 * - **Zoom:** at whole track the playhead moves across a still track; at
 *   64, 16, 4 or 1 bar the waveform and the beat map are drawn for the whole
 *   track on one layer `--zoom-scale` lanes wide and moved so the playhead
 *   stays at the centre (`--played`, written every frame by the lane, is
 *   also how far the layer has moved: no render a frame). The sections strip
 *   stays the whole track, with a white outline for the part on show.
 * - **Cues:** discs in the deck's colour in a band under the bar numbers;
 *   with a cue picked, the pointer over the waveform shows "Cue 4 · bar 80 ·
 *   click to place" on a dashed line, and a click places (or moves) it.
 * - **⌥ scroll** over the waveform zooms.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { DjModeSnapshot, DjModeStore, LaneState } from './dj-mode-store';

import { cueSeconds, placeLabel } from './dj-cues';
import { beatMap, beatMapWords } from './dj-mode.logic';
import styles from './dj-mode.module.css';
import { zoomTicks, zoomTransform, zoomWords } from './dj-zoom';

export function LaneBody({
  deck,
  lane,
  duration,
  store,
  s,
  now,
  window: win,
}: {
  deck: 'a' | 'b';
  lane: LaneState;
  duration: number;
  store: DjModeStore;
  s: DjModeSnapshot;
  /** the lane's playhead (seconds) right now */
  now: () => number;
  /** B's window on its deck (424), drawn at whole track only */
  window?: { start: number; end: number } | null;
}) {
  const wave = useRef<HTMLDivElement>(null);
  const level = s.zoom[deck];
  const zoomed = level !== 'whole';
  const grid = lane.phase === 'ready' && lane.grid ? lane.grid : null;
  const pick = s.pick[deck];
  const scale = zoomTransform(level, now(), grid?.grid ?? null, duration).scale;
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const layout = useMemo(
    () => (grid && duration > 0 ? beatMap(grid, duration) : null),
    [grid, duration],
  );
  const ticks = useMemo(
    () => (grid && duration > 0 ? zoomTicks(grid, duration, level) : []),
    [grid, duration, level],
  );

  // ⌥ scroll zooms (a listener that may prevent the page's scroll)
  useEffect(() => {
    const el = wave.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      store.zoom(deck, e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [store, deck]);

  /** The track second under a pointer's x. */
  const timeAtX = (clientX: number): { x: number; t: number } | null => {
    const r = wave.current?.getBoundingClientRect();
    if (!r || !(r.width > 0) || !(duration > 0)) return null;
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const t = zoomed ? now() + (frac - 0.5) * (duration / scale) : frac * duration;
    return { x: frac, t: Math.max(0, Math.min(duration, t)) };
  };

  const peaks = lane.peaks;
  const bars = useMemo(() => {
    const list = peaks && peaks.length ? peaks : Array.from({ length: 200 }, () => 0.04);
    return list.map((v, i) => {
      const h = Math.max(0.02, Math.min(1, Number(v) || 0)) * 100;
      return <rect key={i} x={i + 0.18} y={(100 - h) / 2} width={0.64} height={h} />;
    });
  }, [peaks]);
  const n = peaks && peaks.length ? peaks.length : 200;

  const span =
    win && duration > 0 && !zoomed
      ? {
          left: Math.max(0, Math.min(1, win.start / duration)),
          right: Math.max(0, Math.min(1, win.end / duration)),
        }
      : null;
  const gridT = grid?.grid ?? null;
  const cues = lane.cues
    .map((c) =>
      c ? { slot: c.slot, x: duration > 0 ? cueSeconds(c, gridT) / duration : 0 } : null,
    )
    .filter((c): c is { slot: number; x: number } => c !== null && c.x >= 0 && c.x <= 1);
  const discs = cues.map((c) => (
    <span
      key={c.slot}
      className={styles.cueDisc}
      data-picked={pick === c.slot ? '' : undefined}
      data-dj-cue-disc={c.slot}
      style={{ left: `${c.x * 100}%` }}
    >
      {c.slot}
    </span>
  ));
  const layer = { '--zoom-scale': String(scale) } as CSSProperties;
  // zoomed, the deck's window gives the detail the 200 peaks can't (37s)
  const detail = zoomed ? s.mix.levels?.[deck === 'a' ? 'A' : 'B'] : null;
  const detailPath = useMemo(() => {
    if (!detail || !(duration > 0)) return null;
    const { offset, step, levels } = detail;
    let top = `M${offset} 50`;
    let bottom = '';
    for (let i = 0; i < levels.length; i += 1) {
      const x = offset + i * step;
      const h = Math.max(0.01, levels[i]!) * 48;
      top += `L${x.toFixed(3)} ${(50 - h).toFixed(2)}`;
      bottom = `L${x.toFixed(3)} ${(50 + h).toFixed(2)}` + bottom;
    }
    return `${top}${bottom}Z`;
  }, [detail, duration]);

  return (
    <div className={styles.body} data-zoomed={zoomed ? '' : undefined} style={layer}>
      <div
        ref={wave}
        className={styles.wave}
        data-empty={peaks ? undefined : ''}
        data-picking={pick !== null ? '' : undefined}
        data-dj-wave={deck}
        aria-hidden="true"
        onPointerMove={(e) => {
          if (pick === null) return;
          setHover(timeAtX(e.clientX));
        }}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          if (pick === null) return;
          const at = timeAtX(e.clientX);
          if (at) store.placeCue(deck, at.t);
        }}
      >
        {span && span.right > span.left ? (
          <span
            className={styles.window}
            data-dj-window=""
            title="The deck’s 3 minutes"
            style={{ left: `${span.left * 100}%`, width: `${(span.right - span.left) * 100}%` }}
          />
        ) : null}
        <div className={styles.zoomLayer}>
          <svg
            className={styles.waveSvg}
            viewBox={`0 0 ${n} 100`}
            preserveAspectRatio="none"
            data-dimmed={detailPath ? '' : undefined}
          >
            {bars}
          </svg>
          {detailPath ? (
            <svg
              className={styles.waveSvg}
              viewBox={`0 0 ${duration} 100`}
              preserveAspectRatio="none"
              data-dj-detail=""
            >
              <path d={detailPath} />
            </svg>
          ) : null}
          <span className={styles.played} />
        </div>
        <span className={styles.playhead} data-dj-playhead="" />
        {pick !== null && hover ? (
          <span className={styles.placeCursor} style={{ left: `${hover.x * 100}%` }}>
            <span className={styles.placeLabel}>{placeLabel(pick, gridT, hover.t)}</span>
          </span>
        ) : null}
      </div>
      {layout && layout.sections.length ? (
        <div className={styles.sections} aria-hidden="true" data-dj-sections="">
          {layout.sections.map((sec, i) => (
            <span
              key={i}
              className={styles.section}
              data-kind={sec.kind}
              style={{ left: `${sec.x0 * 100}%`, width: `${(sec.x1 - sec.x0) * 100}%` }}
            >
              {sec.kind}
            </span>
          ))}
          {zoomed ? <span className={styles.outline} data-dj-outline="" /> : null}
        </div>
      ) : null}
      {grid && layout ? (
        <div
          className={styles.map}
          role="img"
          aria-label={`${beatMapWords(grid)}; ${zoomWords(level)}`}
          data-dj-beat-map=""
          data-cues={cues.length ? '' : undefined}
        >
          <div className={styles.zoomLayer}>
            {layout.mixIn ? (
              <span
                className={styles.region}
                data-region="in"
                style={{
                  left: `${layout.mixIn.x0 * 100}%`,
                  width: `${(layout.mixIn.x1 - layout.mixIn.x0) * 100}%`,
                }}
              />
            ) : null}
            {layout.mixOut ? (
              <span
                className={styles.region}
                data-region="out"
                style={{
                  left: `${layout.mixOut.x0 * 100}%`,
                  width: `${(layout.mixOut.x1 - layout.mixOut.x0) * 100}%`,
                }}
              />
            ) : null}
            {layout.analysedTo !== null ? (
              <span
                className={styles.beyond}
                data-dj-beyond=""
                style={{ left: `${layout.analysedTo * 100}%` }}
              />
            ) : null}
            {ticks.map((t, i) => (
              <span key={i}>
                <span
                  className={styles.tick}
                  data-phrase={t.kind === 'phrase' ? '' : undefined}
                  data-beat={t.kind === 'beat' ? '' : undefined}
                  style={{ left: `${t.x * 100}%` }}
                />
                {t.label !== null ? (
                  <span
                    className={`${styles.num} ${styles.mono}`}
                    style={{ left: `${t.x * 100}%` }}
                  >
                    {t.label}
                  </span>
                ) : null}
              </span>
            ))}
            {discs}
          </div>
        </div>
      ) : cues.length ? (
        // no grid (yet): the cues still have their band (M4)
        <div className={styles.map} data-cues="" data-dj-cue-band="" aria-hidden="true">
          <div className={styles.zoomLayer}>{discs}</div>
        </div>
      ) : null}
    </div>
  );
}
