/**
 * DJ mode's outputs (3b, 37r; 441, 444): the four cases from the devices,
 * the fallbacks (one output and split cue; the headphones lost: muted, never
 * rerouted; the speakers lost: both decks pause), and the Monitor's routing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutputDevice } from '@/shell/player-output';

import type { DjOutputPrefs, MonitorGraph, OutputState } from './dj-outputs';

import { laneA, laneB, rig, type Rig } from './dj-mix.fixtures';
import {
  cueMixGains,
  cueMixWords,
  decideOutputs,
  headphonesWhy,
  monitorLine,
  monitorShown,
  MonitorRouter,
  NO_SECOND_OUTPUT,
  readOutputPrefs,
} from './dj-outputs';
import { DjOutputs, type OutputsEnv } from './dj-outputs-host';

const BUILT_IN: OutputDevice = { id: 'b1', label: 'Built-in Output' };
const SCARLETT: OutputDevice = { id: 's2', label: 'Scarlett 2i2' };
const HDMI: OutputDevice = { id: 'h3', label: 'HDMI' };
const prefs = (over: Partial<DjOutputPrefs> = {}): DjOutputPrefs => ({
  headphones: null,
  none: false,
  split: false,
  ...over,
});

describe('the case (37r)', () => {
  it('two outputs: the speakers are the player’s own; the headphones the newest other device', () => {
    const s = decideOutputs({
      devices: [BUILT_IN, HDMI, SCARLETT],
      speakersId: 'b1',
      prefs: prefs(),
      canDevice: true,
    });
    expect(s.case).toBe('two');
    expect(s.speakers).toEqual({ id: 'b1', label: 'Built-in Output', connected: true });
    expect(s.headphones).toEqual(SCARLETT);
    expect(monitorLine(s)).toBe('Scarlett 2i2 · speakers on Built-in Output');
    expect(monitorShown(s)).toBe(true);
    expect(headphonesWhy(s)).toBeNull();
  });

  it('the headphones remembered by id, and by name when the id changed', () => {
    const kept = prefs({ headphones: { id: 'old', label: 'HDMI' } });
    expect(
      decideOutputs({
        devices: [BUILT_IN, HDMI, SCARLETT],
        speakersId: '',
        prefs: kept,
        canDevice: true,
      }).headphones,
    ).toEqual(HDMI);
  });

  it('one output: no Monitor block, Headphones say why; split cue only when asked', () => {
    const one = decideOutputs({
      devices: [BUILT_IN],
      speakersId: 'b1',
      prefs: prefs(),
      canDevice: true,
    });
    expect(one.case).toBe('one');
    expect(monitorShown(one)).toBe(false);
    expect(headphonesWhy(one)).toBe('No headphones output · Outputs…');
    const split = decideOutputs({
      devices: [BUILT_IN],
      speakersId: 'b1',
      prefs: prefs({ split: true }),
      canDevice: true,
    });
    expect(monitorShown(split)).toBe(true);
    expect(headphonesWhy(split)).toBeNull();
    expect(monitorLine(split)).toBe(
      'Split cue · the cue left, the speakers right, on Built-in Output',
    );
  });

  it('a browser that can’t send to a second output is the one-output case, and says why', () => {
    const s = decideOutputs({
      devices: [BUILT_IN, SCARLETT],
      speakersId: '',
      prefs: prefs(),
      canDevice: false,
    });
    expect(s.case).toBe('one');
    expect(s.why).toBe(NO_SECOND_OUTPUT);
  });

  it('"None" chosen: one output on purpose', () => {
    expect(
      decideOutputs({
        devices: [BUILT_IN, SCARLETT],
        speakersId: '',
        prefs: prefs({ none: true }),
        canDevice: true,
      }).case,
    ).toBe('one');
  });

  it('the headphones gone: amber, nothing rerouted; the speakers gone: the decks pause', () => {
    const lost = decideOutputs({
      devices: [BUILT_IN],
      speakersId: 'b1',
      prefs: prefs({ headphones: SCARLETT }),
      canDevice: true,
    });
    expect(lost.case).toBe('phonesLost');
    expect(monitorLine(lost)).toBe('Scarlett 2i2 isn’t connected · speakers unchanged');
    const gone = decideOutputs({
      devices: [SCARLETT],
      speakersId: 'b1',
      prefs: prefs({ headphones: SCARLETT }),
      canDevice: true,
    });
    expect(gone.case).toBe('speakersLost');
    // the headphones are never made the speakers
    expect(gone.speakers.connected).toBe(false);
  });

  it('the saved choice reads back, and junk reads as nothing chosen', () => {
    const store = {
      getItem: () =>
        JSON.stringify({ headphones: { id: 's2', label: 'Scarlett 2i2' }, split: true }),
    };
    expect(readOutputPrefs(store)).toEqual({ headphones: SCARLETT, none: false, split: true });
    expect(readOutputPrefs({ getItem: () => '{nope' })).toEqual(prefs());
  });
});

describe('the Monitor (37g)', () => {
  it('Cue mix is constant power, with its words', () => {
    expect(cueMixGains(0)).toEqual({ cue: 1, speakers: 0 });
    expect(cueMixGains(100)).toEqual({ cue: 0, speakers: 1 });
    const half = cueMixGains(50);
    expect(half.cue ** 2 + half.speakers ** 2).toBeCloseTo(1);
    expect(cueMixWords(0, 'B alone')).toBe('Cue only · B alone');
    expect(cueMixWords(50, '')).toBe('Half cue, half speakers');
  });

  it('the headphones lost mute the feed where it is; nothing is connected anew', async () => {
    const made: string[] = [];
    const node = (kind: string) => {
      made.push(kind);
      const n = {
        gain: {
          value: 1,
          target: 1,
          setTargetAtTime(v: number) {
            n.gain.target = v;
          },
        },
        connect: vi.fn((to: unknown) => to),
        disconnect: vi.fn(),
      };
      return n;
    };
    const ctx = {
      currentTime: 0,
      destination: {},
      createGain: () => node('gain'),
    } as unknown as AudioContext;
    const g: MonitorGraph = {
      context: ctx,
      cueBus: node('cueBus') as never,
      out: node('out') as never,
      tap: node('tap') as never,
    };
    const router = new MonitorRouter(g);
    made.length = 0;
    await router.route({ case: 'phonesLost' } as OutputState);
    expect(router.isMuted).toBe(true);
    expect(router.current).toBeNull();
    // no new node, no new path: never rerouted to the speakers
    expect(made).toEqual([]);
    router.dispose();
  });
});

describe('the outputs as the page runs them', () => {
  let r: Rig;
  let devices: MediaDeviceInfo[];
  let change: () => void;
  let said: string[];
  let routed: OutputState[];

  const info = (d: OutputDevice) =>
    ({ deviceId: d.id, label: d.label, kind: 'audiooutput', groupId: d.id }) as MediaDeviceInfo;

  function make(speakersId = 'b1'): DjOutputs {
    const env: OutputsEnv = {
      enumerate: async () => devices,
      onDeviceChange: (fn) => {
        change = fn;
        return () => undefined;
      },
      canDevice: true,
      speakersId: () => speakersId,
      storage: null,
      tap: () => ({}) as AudioNode,
      makeRouter: () => ({
        route: async (s: OutputState) => {
          routed.push(s);
          return true;
        },
        set: () => undefined,
        dispose: () => undefined,
        isMuted: false,
      }),
    };
    return new DjOutputs(env, r.session, (w) => said.push(w));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    r = rig(vi);
    devices = [info(BUILT_IN), info(SCARLETT)];
    said = [];
    routed = [];
    // the engine's graph has the nodes the Monitor taps
    Object.assign(r.engine.graph, { out: {}, cueBus: {} });
  });

  afterEach(() => {
    r.session.dispose();
    vi.useRealTimers();
  });

  async function blending(o: DjOutputs) {
    o.start();
    r.session.setLanes(laneA(), laneB());
    await r.advance(0.01);
    r.session.playB();
    await r.advance(2.5);
  }

  it('two outputs: routed to the headphones once the engine exists', async () => {
    const o = make();
    await blending(o);
    expect(o.snapshot().state.case).toBe('two');
    expect(routed.at(-1)!.headphones).toEqual(SCARLETT);
    o.stop();
  });

  it('the headphones unplugged mid-blend: muted, said once, the speakers and the blend carry on', async () => {
    const o = make();
    await blending(o);
    devices = [info(BUILT_IN)];
    change();
    await r.advance(0.01);
    // found by default, then remembered: missed when it goes
    expect(o.snapshot().state.case).toBe('phonesLost');
    expect(said.filter((w) => w.startsWith('Headphones lost'))).toEqual([
      'Headphones lost; the speakers are unchanged',
    ]);
    expect(r.session.snapshot().phase).toBe('playing');
    expect(r.el.paused).toBe(false);
    expect(r.el.muted).toBe(true); // A still on its deck, in the speakers
    o.stop();
  });

  it('remembered headphones lost: amber, muted, and back when plugged in', async () => {
    const o = make();
    o.setHeadphones(SCARLETT);
    await blending(o);
    devices = [info(BUILT_IN)];
    change();
    await r.advance(0.01);
    expect(o.snapshot().state.case).toBe('phonesLost');
    expect(routed.at(-1)!.case).toBe('phonesLost');
    expect(said).toContain('Headphones lost; the speakers are unchanged');
    expect(r.session.snapshot().phase).toBe('playing');
    devices = [info(BUILT_IN), info({ id: 'new-id', label: 'Scarlett 2i2' })];
    change();
    await r.advance(0.01);
    expect(o.snapshot().state.case).toBe('two');
    expect(said.at(-1)).toBe('Headphones back: Scarlett 2i2');
    o.stop();
  });

  it('the speakers unplugged while A is on its deck: both decks pause where they are', async () => {
    const o = make();
    await blending(o);
    const pause = vi.fn(() => {
      r.el.paused = true;
      r.el.dispatchEvent(new Event('pause'));
    });
    (r.el as unknown as { pause: () => void }).pause = pause;
    devices = [info(SCARLETT)];
    change();
    await r.advance(0.01);
    expect(o.snapshot().state.case).toBe('speakersLost');
    expect(pause).toHaveBeenCalledTimes(1);
    expect(r.engine.suspended).toBe(1);
    expect(said).toContain('Speakers lost: both decks paused where they are');
    // the element is unmuted when the blend ends, never left silent
    r.session.end();
    expect(r.el.muted).toBe(false);
    o.stop();
  });

  it('without the engine nothing is routed; stopping lets the routing go', async () => {
    const o = make();
    o.start();
    await r.advance(0.01);
    expect(routed).toEqual([]);
    o.stop();
  });
});
