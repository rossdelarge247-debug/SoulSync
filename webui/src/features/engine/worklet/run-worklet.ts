/**
 * Runs the deck processor (deck-processor.js, the very file the browser
 * loads) in-process, block by block, for the tests and the CPU figures: a
 * fake AudioWorkletGlobalScope (sampleRate, currentFrame, registerProcessor
 * and a port), no Web Audio needed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

export const WORKLET_PATH = path.resolve(import.meta.dirname, 'deck-processor.js');

export interface FakeScope {
  sampleRate: number;
  currentFrame: number;
  posted: unknown[];
}

interface Processor {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

export class WorkletRunner {
  readonly scope: FakeScope;
  readonly processor: Processor;
  readonly block = 128;

  constructor(sampleRate = 48000) {
    const posted: unknown[] = [];
    class Port {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      postMessage(m: unknown) {
        posted.push(m);
      }
    }
    class AudioWorkletProcessor {
      port = new Port();
    }
    let registered: (new () => Processor) | null = null;
    const scope = {
      sampleRate,
      currentFrame: 0,
      posted,
      AudioWorkletProcessor,
      registerProcessor: (_name: string, cls: new () => Processor) => {
        registered = cls;
      },
    };
    const source = readFileSync(WORKLET_PATH, 'utf8');
    // the file is a script on its global scope: run it with ours as the global
    runInNewContext(source, scope, { filename: WORKLET_PATH });
    if (!registered) throw new Error('the processor did not register');
    this.scope = scope;
    this.processor = new (registered as new () => Processor)();
  }

  send(msg: unknown): void {
    this.processor.port.onmessage?.({ data: msg });
  }

  /** Render `frames` (rounded up to whole blocks): [deck][channel] arrays. */
  render(frames: number): Float32Array[][] {
    const blocks = Math.ceil(frames / this.block);
    const out = [0, 1].map(() => [
      new Float32Array(blocks * this.block),
      new Float32Array(blocks * this.block),
    ]);
    for (let b = 0; b < blocks; b++) {
      const outputs = [0, 1].map(() => [
        new Float32Array(this.block),
        new Float32Array(this.block),
      ]);
      this.processor.process([], outputs);
      for (let d = 0; d < 2; d++) {
        out[d][0].set(outputs[d][0], b * this.block);
        out[d][1].set(outputs[d][1], b * this.block);
      }
      this.scope.currentFrame += this.block;
    }
    return out;
  }

  /** Time `blocks` calls of process() (milliseconds), for the CPU figures. */
  time(blocks: number): number {
    const outputs = [0, 1].map(() => [new Float32Array(this.block), new Float32Array(this.block)]);
    const t0 = performance.now();
    for (let b = 0; b < blocks; b++) {
      for (const o of outputs) {
        o[0].fill(0);
        o[1].fill(0);
      }
      this.processor.process([], outputs);
      this.scope.currentFrame += this.block;
    }
    return performance.now() - t0;
  }
}

/** A deck's load message for mono or stereo samples. */
export function loadMessage(
  deck: number,
  left: Float32Array,
  right: Float32Array,
  rate: number,
  offset = 0,
) {
  const n = left.length;
  const mono4 = new Float32Array(Math.floor(n / 4));
  for (let i = 0; i < mono4.length; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += left[i * 4 + k] + right[i * 4 + k];
    mono4[i] = s / 8;
  }
  return { type: 'load', deck, channels: [left, right], mono4, rate, offset };
}
