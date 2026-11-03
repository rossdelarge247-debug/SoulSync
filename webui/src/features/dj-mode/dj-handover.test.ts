/**
 * DJ mode step 4 (Brief F: 37i, 37j; 413, 414, 422–424, 431): Hand over and
 * every end or change under a blend, on the fake engine and element.
 *
 * - Hand over: the fader to B and B to its own speed over a bar, then the
 *   player takes B where deck B is (B's row after the playing one, Up next
 *   after it as it was), deck B fades out; never silent, the speed unbroken.
 * - Undo for 10 s: A back from its silent deck, B's row out again.
 * - A running out mid-blend is a Hand over; Next or another track cuts B back
 *   over a bar; a seek is the hard stop; a pause pauses both; the context
 *   stopping isn't followed by a seek (L-new-2), nor A moving on (L-new-3).
 * - Up next run out: Play B starts B on its own; Hand over then carries on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HandoffLike } from './dj-mix-session';

import { UNDO_MS } from './dj-mix-session';
import { laneA, laneB, rig, type Rig } from './dj-mix.fixtures';

interface Row {
  id: string;
  title: string;
  file_path?: string;
}

const NIGHT_FERRY: Row = { id: '2', title: 'Night Ferry', file_path: '/m/2.flac' };
const STATIC_BLOOM: Row = { id: '5', title: 'Static Bloom', file_path: '/m/5.flac' };
const HARBOUR = { id: '8', title: 'Harbour Lights', file_path: '/m/8.flac' };

let r: Rig;
let q: {
  queue: Row[];
  index: number;
  plays: { index: number; handoff: HandoffLike | null; joinedAt: number | null }[];
  removed: number[];
  result: 'played' | 'failed' | 'busy';
  loadMs: number;
  next: ReturnType<typeof vi.fn<() => void>>;
};

/** The session's deps with a fake player: its queue, its load with a handoff (media-player.js `playQueueItem`), Next, move. */
function handRigDeps(): Partial<import('./dj-mix-session').SessionDeps> {
  q = {
    queue: [NIGHT_FERRY, STATIC_BLOOM],
    index: 0,
    plays: [],
    removed: [],
    result: 'played',
    loadMs: 200,
    next: vi.fn<() => void>(),
  };
  return {
    player: {
      audio: () => r.el as never,
      state: () => ({ ...r.player, index: q.index, queue: q.queue }),
      seek: () => undefined,
      next: () => q.next(),
      insertNext: (t) => {
        const at = q.index + 1;
        q.queue.splice(at, 0, { ...(t as unknown as Row) });
        return at;
      },
      moveNext: (index) => {
        const [row] = q.queue.splice(index, 1);
        q.queue.splice(q.index + 1, 0, row!);
        return q.index + 1;
      },
      move: (from, to) => {
        const [row] = q.queue.splice(from, 1);
        q.queue.splice(to, 0, row!);
      },
      playIndex: async (index, options) => {
        const handoff = options.handoff ?? null;
        const play = { index, handoff, joinedAt: null as number | null };
        q.plays.push(play);
        if (q.result === 'busy') return { status: 'busy' };
        // the player's load: pause, empty, then the new source loads
        r.el.pause();
        r.el.dispatchEvent(new Event('emptied'));
        r.el.dispatchEvent(new Event('loadstart'));
        await new Promise((res) => setTimeout(res, q.loadMs));
        if (q.result !== 'played') return { status: q.result };
        q.index = index;
        if (handoff) {
          const at = handoff.currentTime + 0.15;
          play.joinedAt = at;
          r.el.currentTime = at;
        }
        r.el.paused = false;
        r.el.ended = false;
        handoff?.pause();
        return { status: 'played' };
      },
      remove: (index) => {
        q.removed.push(index);
        q.queue.splice(index, 1);
      },
    },
  };
}

/** A session on that player. */
function handRig(): Rig {
  return rig(vi, handRigDeps());
}

beforeEach(() => {
  vi.useFakeTimers();
  r = handRig();
});

afterEach(() => {
  r.session.dispose();
  vi.useRealTimers();
});

async function blending(): Promise<void> {
  r.session.setLanes(laneA(), laneB({ queue: HARBOUR }));
  await r.advance(0.01);
  expect(r.session.snapshot().phase).toBe('ready');
  r.session.playB();
  await r.advance(3);
  expect(r.session.snapshot().phase).toBe('playing');
}

/** Something is heard: the element (unmuted, playing, with volume) or a deck through the master. */
function heard(): boolean {
  const el = r.el;
  if (!el.paused && !el.muted && el.volume > 0) return true;
  const t = r.engine.port.time;
  const master = r.engine.master.browser.valueAt(t);
  const a = r.engine.value('A.xf') > 0.01 && (r.engine.port.stops.A ?? Infinity) / 48000 > t;
  const b = r.engine.value('B.xf') > 0.01 && (r.engine.port.stops.B ?? Infinity) / 48000 > t;
  return master > 0.01 && (a || b);
}

describe('Hand over (414, 37i)', () => {
  it('waits until B plays, and says why', async () => {
    r.session.setLanes(laneA(), laneB({ queue: HARBOUR }));
    await r.advance(0.01);
    expect(r.session.handOverWhy()).toBe('Hand over once Harbour Lights is playing (Play B)');
    expect(r.session.handOver()).toBe(false);
    expect(r.said.at(-1)).toBe('Hand over once Harbour Lights is playing (Play B)');
    // B's player record not there yet (a Browse row): a moment
    r.session.setLanes(laneA(), laneB());
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    expect(r.session.handOverWhy()).toBe('Getting Harbour Lights ready for the player: a moment');
  });

  it('the fader to B and B to its own speed over a bar, then the player takes B where deck B is', async () => {
    await blending();
    const t = r.engine.port.time + 0.03;
    expect(r.session.handOver()).toBe(true);
    expect(r.session.snapshot().phase).toBe('handing');
    expect(r.session.blending).toBe(true);
    // one bar of A (2 s): A out, B in, B from Sync's 0.96 to 1.0 with no jump
    expect(r.engine.value('A.xf', t + 2)).toBeCloseTo(0, 5);
    expect(r.engine.value('B.xf', t + 2)).toBeCloseTo(1, 5);
    expect(r.engine.port.rate('B', t + 0.01)).toBeCloseTo(0.96, 2);
    expect(r.engine.port.rate('B', t + 2.01)).toBeCloseTo(1, 4);
    // never silent, all the way through the bar
    for (let i = 0; i < 8; i++) {
      await r.advance(0.25);
      expect(heard()).toBe(true);
    }
    await r.advance(0.06);
    // the bar's over: B's row straight after the playing one, Up next after it as it was
    expect(q.queue.map((row) => row.id)).toEqual(['2', '8', '5']);
    expect(q.plays).toHaveLength(1);
    expect(q.plays[0]!.index).toBe(1);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    // while the player loads B, deck B is still what's heard
    expect(heard()).toBe(true);
    const posB = r.engine.position('B')!;
    expect(q.plays[0]!.handoff!.currentTime).toBeCloseTo(posB, 6);
    await r.advance(0.25);
    // joined where deck B was (read as late as possible: after the 200 ms load), the deck faded out after
    expect(q.plays[0]!.joinedAt).toBeCloseTo(posB + 0.2 + 0.15, 1);
    expect(r.el.muted).toBe(false);
    expect(r.el.paused).toBe(false);
    expect(r.el.playbackRate).toBe(1);
    expect(r.engine.value('B.xf', r.engine.port.time + 0.1)).toBeCloseTo(0, 5);
    expect(r.engine.port.stops.B / 48000).toBeLessThan(r.engine.port.time + 0.2);
    expect(heard()).toBe(true);
    expect(r.session.snapshot()).toMatchObject({
      phase: 'idle',
      handed: { title: 'Harbour Lights', from: 'Night Ferry', ended: false, undo: true },
    });
    expect(r.said.at(-1)).toBe('Handed over to Harbour Lights');
  });

  it('the speed stays the player’s own: a moved A Tempo goes back, the element at 1×', async () => {
    await blending();
    r.session.setDeck('A', 'tempo', 4);
    expect(r.el.playbackRate).toBeCloseTo(1.04);
    r.session.handOver();
    await r.advance(2.6);
    expect(r.el.playbackRate).toBe(1);
    expect(r.session.snapshot().values.A.tempo).toBe(0);
  });

  it('the lanes following the player (A becomes B, B empties) leave the hand-over alone', async () => {
    await blending();
    r.session.handOver();
    await r.advance(1);
    r.session.setLanes(laneA({ id: '8', title: 'Harbour Lights' }), null);
    await r.advance(1.6);
    expect(q.plays).toHaveLength(1);
    expect(r.session.snapshot().handed?.title).toBe('Harbour Lights');
  });

  it('a load that doesn’t play (H-2): B plays on, on its own, the queue as it was; nothing goes quiet', async () => {
    await blending();
    q.result = 'failed';
    r.session.handOver();
    await r.advance(2.5);
    expect(r.session.snapshot()).toMatchObject({ phase: 'playing', solo: true, aOnDeck: false });
    expect(r.engine.port.stops.B).toBe(Infinity);
    expect(heard()).toBe(true);
    expect(q.queue.map((row) => row.id)).toEqual(['2', '5']);
    expect(r.said.at(-1)).toBe(
      'Couldn’t hand over to Harbour Lights: it plays on here · Hand over again or Back',
    );
    expect(r.session.snapshot().handed).toBeNull();
    // the player plays something again: B goes out over a bar under it
    r.el.paused = false;
    r.el.dispatchEvent(new Event('play'));
    expect(r.session.snapshot().solo).toBe(false);
    await r.advance(1);
    expect(heard()).toBe(true);
  });

  it('A’s end handed over and the player busy (H-2): B plays on and the player advances', async () => {
    r.session.setLanes(laneA(), laneB({ queue: HARBOUR }));
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    q.result = 'busy' as never;
    r.el.ended = true;
    r.el.dispatchEvent(new Event('ended'));
    await r.advance(0.6);
    expect(r.session.snapshot().solo).toBe(true);
    expect(q.next).toHaveBeenCalledTimes(1);
    expect(heard()).toBe(true);
  });

  it('a handoff read after it’s used or given up is NaN, so a skip never joins deck B (M-4)', async () => {
    await blending();
    q.result = 'failed';
    r.session.handOver();
    await r.advance(2.5);
    expect(Number.isNaN(q.plays[0]!.handoff!.currentTime)).toBe(true);
  });
});

describe('Undo (414: 10 s; 431)', () => {
  it('A back from its silent deck where it would be now, B’s row out again', async () => {
    await blending();
    r.session.handOver();
    await r.advance(2.4);
    // deck A went on, silent, at the player's own speed
    const t = r.engine.port.time;
    expect(r.engine.value('A.xf', t)).toBeCloseTo(0, 5);
    expect(r.engine.port.stops.A).toBe(Infinity);
    await r.advance(3);
    const posA = r.engine.position('A')!;
    const undone = r.session.undoHandOver();
    // heard again over 80 ms while the player loads A
    expect(r.engine.value('A.xf', r.engine.port.time + 0.1)).toBeCloseTo(1, 5);
    await r.advance(0.3);
    expect(await undone).toBe(true);
    const play = q.plays.at(-1)!;
    expect(play.index).toBe(0);
    expect(play.joinedAt).toBeCloseTo(posA + 0.2 + 0.15, 1);
    expect(q.removed).toEqual([1]);
    expect(q.queue.map((row) => row.id)).toEqual(['2', '5']);
    expect(r.session.snapshot().handed).toBeNull();
    expect(r.engine.port.stops.A / 48000).toBeLessThan(r.engine.port.time + 0.2);
    expect(heard()).toBe(true);
  });

  it('after 10 s it’s gone: A’s deck stops, the notice goes, the decks let go', async () => {
    await blending();
    r.session.handOver();
    await r.advance(2.5);
    r.session.setLanes(laneA({ id: '8', title: 'Harbour Lights' }), null);
    await r.advance(UNDO_MS / 1000 + 0.5);
    expect(r.session.snapshot().handed).toBeNull();
    expect(r.engine.port.stops.A).toBeLessThan(Infinity);
    expect(await r.session.undoHandOver()).toBe(false);
    expect(r.engine.disposed).toBe(1);
  });

  it('a new B loaded drops the Undo at once', async () => {
    await blending();
    r.session.handOver();
    await r.advance(2.5);
    r.session.setLanes(laneA({ id: '8', title: 'Harbour Lights' }), null);
    r.session.setLanes(
      laneA({ id: '8', title: 'Harbour Lights' }),
      laneB({ id: '9', title: 'Copper Sky' }),
    );
    expect(r.session.snapshot().handed).toBeNull();
    expect(await r.session.undoHandOver()).toBe(false);
  });
});

describe('A runs out mid-blend (37j): a Hand over', () => {
  it('a bar before A’s end the fader goes to B and the player takes it; no Undo (A is over)', async () => {
    r.session.setLanes(laneA({ duration: 130 }), laneB({ queue: HARBOUR }));
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    expect(r.session.ownsAdvance()).toBe(true);
    // A from 124 s: 6 s to its end; the watch hands over a bar and a margin before
    await r.advance(3.5);
    expect(r.session.snapshot().phase).toBe('handing');
    await r.advance(3);
    expect(q.plays).toHaveLength(1);
    expect(r.session.snapshot().handed).toMatchObject({ ended: true, undo: false });
    expect(r.said.at(-1)).toBe('Night Ferry ended · handed over to Harbour Lights');
    expect(heard()).toBe(true);
  });

  it('the element’s end itself (a late timer): the Hand over at once', async () => {
    await blending();
    r.el.ended = true;
    r.el.dispatchEvent(new Event('ended'));
    expect(r.session.snapshot().phase).toBe('handing');
    await r.advance(0.6);
    expect(q.plays).toHaveLength(1);
    expect(q.next).not.toHaveBeenCalled();
  });

  it('B not in yet (starting): the blend stops and the player advances as it always does', async () => {
    r.session.setLanes(laneA(), laneB({ queue: HARBOUR }));
    await r.advance(0.01);
    r.session.playB();
    expect(r.session.ownsAdvance()).toBe(false);
    r.el.ended = true;
    r.el.dispatchEvent(new Event('ended'));
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.el.muted).toBe(false);
  });
});

describe('the player obeys (37j): Next or another track under a blend', () => {
  it('A’s deck stops at once, B is cut back over a bar, the element unmuted; B cued again for the new A', async () => {
    await blending();
    r.session.setCentre('xf', 60);
    await r.advance(0.05);
    r.el.pause();
    r.el.dispatchEvent(new Event('emptied'));
    const t = r.engine.port.time;
    // not taken for the listener's Pause: the context runs
    await r.advance(0.1);
    expect(r.engine.suspended).toBe(0);
    expect(r.engine.value('A.xf', t + 0.05)).toBeCloseTo(0, 5);
    expect(r.engine.port.stops.A / 48000).toBeLessThan(t + 0.1);
    // B out over a bar
    expect(r.engine.value('B.xf', t + 1)).toBeGreaterThan(0.2);
    expect(r.engine.value('B.xf', t + 2.01)).toBeCloseTo(0, 5);
    expect(r.el.muted).toBe(false);
    expect(r.el.volume).toBeCloseTo(0.7);
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.said).toContain('Harbour Lights cut back over a bar');
    // the new A arrives with the same B: cued again (Sync replans)
    r.el.paused = false;
    r.session.setLanes(laneA({ id: '5', title: 'Static Bloom' }), laneB({ queue: HARBOUR }));
    await r.advance(0.5);
    expect(r.session.snapshot().phase).toBe('ready');
    expect(r.session.snapshot().values.xf).toBe(0);
  });

  it('the lanes saying A moved on first (L-new-3): the same cut back, the element not sought', async () => {
    await blending();
    const seeks = vi.fn();
    r.el.addEventListener('seeking', seeks);
    r.session.setDeck('A', 'tempo', 5);
    await r.advance(4);
    r.session.setLanes(laneA({ id: '5', title: 'Static Bloom' }), laneB({ queue: HARBOUR }));
    expect(seeks).not.toHaveBeenCalled();
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.said).toContain('Harbour Lights cut back over a bar');
  });
});

describe('the context stopping under the decks (L-new-2)', () => {
  it('the hard stop, and the element isn’t sought to A’s frozen place', async () => {
    await blending();
    const seeks = vi.fn();
    r.el.addEventListener('seeking', seeks);
    r.session.setDeck('A', 'tempo', 5);
    await r.advance(4);
    r.engine.interrupt('interrupted');
    expect(seeks).not.toHaveBeenCalled();
    expect(r.session.snapshot().aOnDeck).toBe(false);
    expect(r.el.muted).toBe(false);
    expect(r.said.at(-1)).toMatch(/^The decks stopped \(interrupted\)/);
  });
});

describe('Up next ran out (37j): B on its own, then Hand over', () => {
  async function aFinished(): Promise<void> {
    r.session.setLanes(laneA(), laneB({ queue: HARBOUR }));
    await r.advance(0.01);
    r.el.ended = true;
    r.el.paused = true;
  }

  it('Play B starts B at its cue now, the fader at B; the player stays stopped', async () => {
    await aFinished();
    expect(r.session.playB()).toBe(true);
    const t = r.engine.port.time;
    expect(r.session.snapshot()).toMatchObject({ phase: 'playing', solo: true, aOnDeck: false });
    expect(r.session.snapshot().values.xf).toBe(100);
    expect(r.engine.value('B.xf', t + 0.2)).toBeCloseTo(1, 5);
    expect(r.engine.master.browser.valueAt(t + 0.3)).toBeCloseTo(0.7);
    expect(r.engine.position('B', t + 0.62)).toBeCloseTo(1.0, 2);
    expect(r.said.at(-1)).toBe(
      'Harbour Lights playing on its own: Hand over makes it the player’s track',
    );
  });

  it('Hand over then makes it the player’s track so Up next can carry on after it; no Undo', async () => {
    await aFinished();
    r.session.playB();
    await r.advance(2);
    r.session.handOver();
    await r.advance(2.6);
    expect(q.plays).toHaveLength(1);
    expect(q.queue.map((row) => row.id)).toEqual(['2', '8', '5']);
    expect(r.session.snapshot()).toMatchObject({ solo: false, handed: { undo: false } });
    expect(heard()).toBe(true);
  });

  it('the player playing again (Play, another track): B goes out over a bar', async () => {
    await aFinished();
    r.session.playB();
    await r.advance(1);
    r.el.ended = false;
    r.el.paused = false;
    r.el.dispatchEvent(new Event('play'));
    const t = r.engine.port.time;
    expect(r.session.snapshot()).toMatchObject({ phase: 'idle', solo: false });
    expect(r.engine.master.browser.valueAt(t + 1)).toBeGreaterThan(0.1);
    expect(r.engine.master.browser.valueAt(t + 2.1)).toBeCloseTo(0, 5);
    expect(r.said.at(-1)).toBe('Harbour Lights out: the player plays again');
  });

  it('Pause B and Play B on its own: stopped where it is, carried on from there', async () => {
    await aFinished();
    r.session.playB();
    await r.advance(2);
    expect(r.session.pauseB()).toBe(true);
    const at = r.session.positionB()!;
    expect(r.session.snapshot().phase).toBe('paused');
    expect(r.engine.master.browser.valueAt(r.engine.port.time + 0.05)).toBe(0);
    await r.advance(1);
    expect(r.session.playB()).toBe(true);
    const t = r.engine.port.time;
    expect(r.session.snapshot()).toMatchObject({ phase: 'playing', solo: true });
    expect(r.engine.position('B', t + 0.62)).toBeCloseTo(at + 0.5, 2);
    expect(r.engine.master.browser.valueAt(t + 0.3)).toBeCloseTo(0.7);
  });

  it('Back: B out over a bar, then DJ mode’s done', async () => {
    await aFinished();
    r.session.playB();
    await r.advance(1);
    const done = vi.fn();
    r.session.backOverBar(done);
    await r.advance(2.2);
    expect(done).toHaveBeenCalledTimes(1);
    expect(r.session.snapshot().phase).toBe('idle');
  });
});

describe('review round 1 (step 4)', () => {
  it('H-1: A’s echo and headphones send go to 0 with Hand over; the silent deck A isn’t heard anywhere', async () => {
    await blending();
    r.session.setCentre('echoSend', 60);
    r.session.setPhones('A', true);
    await r.advance(0.05);
    expect(r.engine.value('A.echoSend')).toBeCloseTo(0.6, 3);
    const t = r.engine.port.time + 0.03;
    r.session.handOver();
    // out over the bar with the fader
    expect(r.engine.value('A.echoSend', t + 2)).toBeCloseTo(0, 5);
    await r.advance(2.6);
    // deck A runs on for the Undo: no fader, no echo, no headphones
    expect(r.engine.port.stops.A).toBe(Infinity);
    for (const dt of [0, 1, 5]) {
      expect(r.engine.value('A.xf', r.engine.port.time + dt)).toBeCloseTo(0, 5);
      expect(r.engine.value('A.echoSend', r.engine.port.time + dt)).toBeCloseTo(0, 5);
    }
    expect(r.engine.cueSends.A.gain.value).toBe(0);
    // the next blend has A's headphones as the person set them
    expect(r.session.snapshot().decks.A.phones).toBe(true);
  });

  it('M-1: a pause during the bar stops the Hand over, paused; Play carries on with B at the fader; no stuck state', async () => {
    await blending();
    r.session.handOver();
    await r.advance(0.5);
    r.el.pause();
    await r.advance(0.1);
    expect(r.session.snapshot().phase).toBe('playing');
    expect(r.engine.suspended).toBe(1);
    expect(r.said.at(-1)).toBe('Paused: Hand over stopped · H hands over to Harbour Lights again');
    // the bar's timer never fires the switch
    await r.advance(3);
    expect(q.plays).toHaveLength(0);
    r.el.paused = false;
    r.el.dispatchEvent(new Event('play'));
    await r.advance(0.05);
    expect(r.engine.resumed).toBe(1);
    expect(r.engine.paused.at(-1)).toBe(false);
    // and Hand over again works
    expect(r.session.handOver()).toBe(true);
    await r.advance(2.6);
    expect(q.plays).toHaveLength(1);
    expect(heard()).toBe(true);
  });

  it('M-1: a pause in the last moment before the switch (not settled yet) stops it too', async () => {
    await blending();
    r.session.handOver();
    await r.advance(1.99);
    r.el.pause();
    await r.advance(0.1);
    expect(q.plays).toHaveLength(0);
    expect(r.session.snapshot().phase).toBe('playing');
    expect(r.engine.suspended).toBe(1);
  });

  it('M-2: a row before A taken out in the 10 s: Undo finds A by itself, not its old place', async () => {
    q.queue.unshift({ id: '0', title: 'Earlier' });
    q.index = 1;
    await blending();
    r.session.handOver();
    await r.advance(2.6);
    expect(q.queue.map((row) => row.id)).toEqual(['0', '2', '8', '5']);
    // the earlier row goes: A's old index (1) now points at B
    q.queue.shift();
    q.index -= 1;
    expect(await Promise.all([r.session.undoHandOver(), r.advance(0.3)]).then(([ok]) => ok)).toBe(
      true,
    );
    expect(q.plays.at(-1)!.index).toBe(0);
    expect(q.queue.map((row) => row.id)).toEqual(['2', '5']);
  });

  it('M-2: A’s row gone altogether: no Undo, said so; B plays on', async () => {
    await blending();
    r.session.handOver();
    await r.advance(2.6);
    q.queue.splice(0, 1);
    q.index = 0;
    expect(await r.session.undoHandOver()).toBe(false);
    expect(r.said.at(-1)).toBe('Can’t undo: Night Ferry isn’t in the queue any more');
    expect(q.plays).toHaveLength(1);
    expect(r.el.paused).toBe(false);
  });

  it('M-3: an Undo the player can’t do leaves B’s row and B playing', async () => {
    await blending();
    r.session.handOver();
    await r.advance(2.6);
    q.result = 'busy';
    const undone = r.session.undoHandOver();
    await r.advance(0.3);
    expect(await undone).toBe(false);
    expect(q.queue.map((row) => row.id)).toEqual(['2', '8', '5']);
    expect(q.removed).toEqual([]);
    expect(r.said.at(-1)).toBe('Couldn’t put Night Ferry back: the player carries on');
  });

  it('L-1: DJ mode let go during the load: auto-mix isn’t left held', async () => {
    const autoHold = vi.fn();
    r.session.dispose();
    r = rig(vi, { ...handRigDeps(), autoHold });
    r.session.setLanes(laneA(), laneB({ queue: HARBOUR }));
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    r.session.handOver();
    await r.advance(2.05);
    r.session.end();
    await r.advance(0.3);
    expect(autoHold.mock.calls.at(-1)).toEqual([false]);
  });

  it('L-3: the player moving on from B in the 10 s drops the Undo', async () => {
    await blending();
    r.session.handOver();
    await r.advance(2.6);
    r.session.setLanes(laneA({ id: '8', title: 'Harbour Lights' }), null);
    expect(r.session.snapshot().handed?.undo).toBe(true);
    r.session.setLanes(laneA({ id: '5', title: 'Static Bloom' }), null);
    expect(r.session.snapshot().handed).toBeNull();
    expect(await r.session.undoHandOver()).toBe(false);
  });

  it('L-4: end() takes the notice with it', async () => {
    await blending();
    r.session.handOver();
    await r.advance(2.6);
    expect(r.session.snapshot().handed).not.toBeNull();
    r.session.end();
    expect(r.session.snapshot().handed).toBeNull();
  });

  it('L-5: B’s file missing: Hand over says so, not "a moment"', async () => {
    r.session.setLanes(
      laneA(),
      laneB({
        queueWhy: 'Harbour Lights’s file isn’t on this computer: it can’t go to the player',
      }),
    );
    await r.advance(0.01);
    r.session.playB();
    await r.advance(3);
    expect(r.session.handOverWhy()).toBe(
      'Harbour Lights’s file isn’t on this computer: it can’t go to the player',
    );
  });

  it('L-6: B already further on in Up next: that row is moved next, not doubled; Undo puts it back', async () => {
    q.queue = [NIGHT_FERRY, STATIC_BLOOM, { ...HARBOUR }];
    await blending();
    r.session.handOver();
    await r.advance(2.6);
    expect(q.queue.map((row) => row.id)).toEqual(['2', '8', '5']);
    const undone = r.session.undoHandOver();
    await r.advance(0.3);
    expect(await undone).toBe(true);
    expect(q.queue.map((row) => row.id)).toEqual(['2', '5', '8']);
  });
});
