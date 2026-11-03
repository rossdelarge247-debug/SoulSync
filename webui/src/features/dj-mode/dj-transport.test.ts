/** A deck's Play/Pause and CUE as a Pioneer CDJ's (step 4b). */
import { describe, expect, it } from 'vitest';

import { DeckTransport, type DeckPort } from './dj-transport';

function deck(at = 10, cue = 10) {
  const log: string[] = [];
  const d = {
    playing: false,
    pos: at,
    cuePoint: cue,
    log,
  };
  const port: DeckPort = {
    playing: () => d.playing,
    position: () => d.pos,
    cue: () => d.cuePoint,
    setCue: (s) => {
      d.cuePoint = s;
      log.push(`cue ${s}`);
    },
    play: () => {
      d.playing = true;
      log.push('play');
    },
    pause: () => {
      d.playing = false;
      log.push('pause');
    },
    seek: (s) => {
      d.pos = s;
      log.push(`seek ${s}`);
    },
  };
  return { d, port };
}

describe('CUE', () => {
  it('stopped away from the cue point: the cue point moves there and the deck to it, still stopped', () => {
    const t = new DeckTransport();
    const { d, port } = deck(42, 10);
    expect(t.cueDown(port)).toBe('set');
    expect(d.cuePoint).toBe(42);
    expect(d.playing).toBe(false);
    expect(t.cueUp(port)).toBe(false);
    // the deck goes to the cue point as set (review M-4)
    expect(d.log).toEqual(['cue 42', 'seek 42']);
    expect(d.pos).toBe(42);
  });

  it('held at the cue point: plays from it; let go, back to it and stopped', () => {
    const t = new DeckTransport();
    const { d, port } = deck(10, 10);
    expect(t.cueDown(port)).toBe('held');
    expect(d.playing).toBe(true);
    d.pos = 13;
    expect(t.cueUp(port)).toBe(true);
    expect(d.playing).toBe(false);
    expect(d.pos).toBe(10);
    expect(d.log).toEqual(['seek 10', 'play', 'pause', 'seek 10']);
  });

  it('Play while CUE is held: it plays on after CUE is let go', () => {
    const t = new DeckTransport();
    const { d, port } = deck(10, 10);
    t.cueDown(port);
    expect(t.playPress(port)).toBe('latched');
    expect(t.cueUp(port)).toBe(false);
    expect(d.playing).toBe(true);
  });

  it('playing: back to the cue point, stopped', () => {
    const t = new DeckTransport();
    const { d, port } = deck(55, 10);
    d.playing = true;
    expect(t.cueDown(port)).toBe('back');
    expect(d.playing).toBe(false);
    expect(d.pos).toBe(10);
    // pause first, so the stopped deck lands on the cue point
    expect(d.log).toEqual(['pause', 'seek 10']);
  });

  it('a second press while held does nothing; reset lets go', () => {
    const t = new DeckTransport();
    const { port } = deck(10, 10);
    t.cueDown(port);
    expect(t.cueDown(port)).toBeNull();
    t.reset();
    expect(t.held).toBe(false);
  });
});

describe('Play/Pause', () => {
  it('plays or pauses where it is', () => {
    const t = new DeckTransport();
    const { d, port } = deck(30, 10);
    expect(t.playPress(port)).toBe('play');
    expect(d.playing).toBe(true);
    expect(t.playPress(port)).toBe('pause');
    expect(d.playing).toBe(false);
    expect(d.pos).toBe(30);
  });
});
