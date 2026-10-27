import { describe, expect, it } from 'vitest';

import { CUE_KEY, CUE_WHY_NOT, CueRouter, cueSupport, readCuePrefs, saveCuePrefs } from './outputs';

/** Nodes that remember their connections. */
class Node {
  out = new Set<Node>();
  inputs: [Node, number][] = [];
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  constructor(readonly name: string) {}
  connect(to: Node, _o = 0, input = 0): Node {
    this.out.add(to);
    to.inputs.push([this, input]);
    return to;
  }
  disconnect(to?: Node) {
    if (to) {
      if (!this.out.has(to)) throw new Error('not connected');
      this.out.delete(to);
    } else this.out.clear();
  }
}

class FakeCtx {
  destination = new Node('destination');
  currentTime = 0;
  made: Node[] = [];
  private make(name: string) {
    const n = new Node(name) as Node & Record<string, unknown>;
    this.made.push(n);
    return n;
  }
  createGain() {
    return Object.assign(this.make('gain'), { gain: param() });
  }
  createChannelMerger() {
    return this.make('merger');
  }
  createStereoPanner() {
    return Object.assign(this.make('panner'), { pan: param() });
  }
  createMediaStreamDestination() {
    return Object.assign(this.make('stream'), { stream: { id: 'cue' } });
  }
  createOscillator() {
    return Object.assign(this.make('osc'), { frequency: param(), start() {}, stop() {} });
  }
}

function param() {
  return { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} };
}

function router() {
  const ctx = new FakeCtx();
  const mix = new Node('mix');
  const analyser = new Node('analyser');
  const cueBus = new Node('cue');
  mix.connect(analyser);
  analyser.connect(ctx.destination);
  const sinks: string[] = [];
  const el = {
    srcObject: null as unknown,
    setSinkId: async (id: string) => {
      sinks.push(id);
    },
    play: async () => {},
    pause() {},
  };
  const r = new CueRouter({
    context: ctx as unknown as AudioContext,
    mix: mix as unknown as AudioNode,
    mixTarget: analyser as unknown as AudioNode,
    cueBus: cueBus as unknown as AudioNode,
    makeElement: () => el as never,
  });
  return { ctx, mix, analyser, cueBus, r, el, sinks };
}

describe('headphones (23b)', () => {
  it('says why a second output is impossible, not just hides it', () => {
    const md = { enumerateDevices: async () => [] };
    expect(
      cueSupport({
        mediaPrototype: { setSinkId() {} },
        hasStreamDestination: true,
        mediaDevices: md,
      }),
    ).toEqual({
      device: true,
      why: null,
    });
    expect(
      cueSupport({ mediaPrototype: {}, hasStreamDestination: true, mediaDevices: md }),
    ).toEqual({
      device: false,
      why: CUE_WHY_NOT,
    });
  });

  it('keeps the choice per browser, and splits where a second output can’t work', () => {
    const store = new Map<string, string>();
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readCuePrefs(s, true)).toEqual({ mode: 'device', deviceId: '' });
    expect(readCuePrefs(s, false)).toEqual({ mode: 'split', deviceId: '' });
    saveCuePrefs(s, { mode: 'device', deviceId: 'phones' });
    expect(JSON.parse(store.get(CUE_KEY)!)).toEqual({ mode: 'device', deviceId: 'phones' });
    expect(readCuePrefs(s, true)).toEqual({ mode: 'device', deviceId: 'phones' });
    expect(readCuePrefs(s, false).mode).toBe('split');
    store.set(CUE_KEY, '{bad');
    expect(readCuePrefs(s, true).mode).toBe('device');
  });

  it('splits one output: the mix (after the visualisers’ analyser) left, the cue right, and back', async () => {
    const { ctx, mix, analyser, cueBus, r } = router();
    await r.apply({ mode: 'split', deviceId: '' });
    expect(r.current).toBe('split');
    expect(analyser.out.has(ctx.destination)).toBe(false);
    expect(mix.out.has(analyser)).toBe(true); // the visualisers still hear the mix
    const merger = ctx.made.find((n) => n.name === 'merger')!;
    const [left, right] = [...merger.inputs].sort((a, b) => a[1] - b[1]);
    expect(left[1]).toBe(0);
    expect(right[1]).toBe(1);
    expect([...analyser.out][0].channelCount).toBe(1); // summed to mono
    expect([...cueBus.out][0].out.has(merger)).toBe(true);
    expect(merger.out.has(ctx.destination)).toBe(true);
    r.dispose();
    expect(analyser.out.has(ctx.destination)).toBe(true);
    expect(r.current).toBeNull();
  });

  it('sends the cue to another output by its device', async () => {
    const { r, el, sinks, cueBus } = router();
    expect(await r.apply({ mode: 'device', deviceId: 'airpods' })).toBe(true);
    expect(sinks).toEqual(['airpods']);
    expect(el.srcObject).toEqual({ id: 'cue' });
    expect(cueBus.out.size).toBe(1);
    r.dispose();
    expect(el.srcObject).toBeNull();
  });

  it('tests one ear at a time', async () => {
    const { ctx, r } = router();
    await r.apply({ mode: 'split', deviceId: '' });
    r.test('right');
    const merger = ctx.made.find((n) => n.name === 'merger')!;
    expect(merger.inputs.at(-1)?.[1]).toBe(1);
    r.test('left');
    expect(merger.inputs.at(-1)?.[1]).toBe(0);
  });
});
