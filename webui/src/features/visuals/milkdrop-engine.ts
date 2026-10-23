/**
 * MilkDrop through Butterchurn (MIT, WebGL 2). Loaded with `import()` only
 * when the MilkDrop family is first opened, so the page doesn't carry it.
 *
 * The engine gets no AudioContext: the overlay reads the player's analyser
 * itself (visuals-audio.ts) and hands Butterchurn each frame's samples, so
 * Butterchurn never touches the audio graph and there's one place that knows
 * whether the sound can be heard.
 */

import type { ButterchurnVisualizer } from 'butterchurn';

import butterchurnModule from 'butterchurn';

export interface MilkdropEngine {
  load(preset: Record<string, unknown>, blendSeconds: number): void;
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  frame(time: Uint8Array): void;
}

function factory() {
  const mod = butterchurnModule as unknown as {
    createVisualizer?: unknown;
    default?: { createVisualizer?: unknown; default?: unknown };
  };
  if (typeof mod.createVisualizer === 'function') return mod;
  if (mod.default && typeof mod.default.createVisualizer === 'function') return mod.default;
  const inner = mod.default?.default as { createVisualizer?: unknown } | undefined;
  if (inner && typeof inner.createVisualizer === 'function') return inner;
  throw new Error('Butterchurn didn’t load');
}

export function createMilkdropEngine(
  canvas: HTMLCanvasElement,
  size: { width: number; height: number; pixelRatio: number },
): MilkdropEngine {
  const B = factory() as {
    createVisualizer: (
      ctx: AudioContext | null,
      canvas: HTMLCanvasElement,
      opts: { width: number; height: number; pixelRatio: number },
    ) => ButterchurnVisualizer;
  };
  // Butterchurn draws its last pass at its own width × height on the canvas,
  // so it's given the drawing buffer's size (CSS size × pixel ratio, which is
  // where Quality scales it) and a pixel ratio of 1; CSS stretches it back.
  const px = (n: number, pr: number) => Math.max(2, Math.round(n * pr));
  canvas.width = px(size.width, size.pixelRatio);
  canvas.height = px(size.height, size.pixelRatio);
  const viz = B.createVisualizer(null, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: 1,
  });
  return {
    load(preset, blendSeconds) {
      viz.loadPreset(preset, blendSeconds);
    },
    resize(width, height, pixelRatio) {
      const w = px(width, pixelRatio);
      const h = px(height, pixelRatio);
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      viz.setRendererSize(w, h, { pixelRatio: 1 });
    },
    frame(time) {
      viz.render({
        audioLevels: { timeByteArray: time, timeByteArrayL: time, timeByteArrayR: time },
      });
    },
  };
}
