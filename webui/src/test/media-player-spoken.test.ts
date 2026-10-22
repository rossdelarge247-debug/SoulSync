import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { extractFunction } from './vanilla-extract';

// HANDOFF 46: the player keeps where each profile got to in an episode or an
// audiobook, and logs its plays, apart from music's history and scrobbling.
// Runs the real functions from static/media-player.js.
const source = readFileSync(resolve(process.cwd(), 'static/media-player.js'), 'utf8');
const NAMES = [
  'npTrackKind',
  'npIsSpokenWord',
  'npSpokenKey',
  'npSpokenDuration',
  'npSpokenRead',
  'npSpokenSend',
  'npSpokenTick',
  'npSpokenOnPause',
  'npSpokenOnEnded',
  'npSpokenLeave',
  'npSpokenLogPlay',
  'npFormatResume',
  'npSpokenResumeAt',
  'npMaybeLogPlay',
];
const functions = NAMES.map((name) => extractFunction(name, source)).join('\n');

const EPISODE = {
  title: 'Episode 12',
  artist: 'Quiet Rooms',
  kind: 'podcast',
  media_id: 'guid-12',
  media_src: 'https://cdn.example/ep12.mp3',
  image_url: 'https://cdn.example/art.jpg',
  duration: 1800,
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function harness(lookup: Record<string, unknown> = {}) {
  const audio = {
    currentTime: 0,
    duration: 1800,
    currentSrc: 'https://cdn.example/ep12.mp3',
    paused: false,
    ended: false,
  };
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({
      url,
      method: init?.method || 'GET',
      body: init?.body ? JSON.parse(init.body) : {},
    });
    if (url === '/api/player/progress/lookup') {
      return { ok: true, json: async () => ({ success: true, items: lookup }) };
    }
    return { ok: true, json: async () => ({ success: true }) };
  });
  const toasts: string[] = [];
  const api = new Function(
    'audioPlayer',
    'fetch',
    'showToast',
    `
    let currentTrack = null;
    let npPlayLogged = false, npPlayId = null, npPlayGeneration = 0;
    const NP_SPOKEN_SAVE_EVERY_MS = 15000;
    let npSpokenSnap = null, npSpokenLastSave = 0, npSpokenPlayLogged = false;
    ${functions}
    return {
      set(track) { npSpokenLeave(track); currentTrack = track; },
      tick: () => npSpokenTick(),
      musicTick: () => npMaybeLogPlay(),
      pause: () => npSpokenOnPause(),
      ended: () => npSpokenOnEnded(),
      resumeAt: (t) => npSpokenResumeAt(t),
      snap: () => npSpokenSnap,
      resetClock: () => { npSpokenLastSave = 0; },
    };
  `,
  )(audio, fetch, (msg: string) => toasts.push(msg)) as {
    set(track: Record<string, unknown> | null): void;
    tick(): void;
    musicTick(): void;
    pause(): void;
    ended(): void;
    resumeAt(track: Record<string, unknown>): Promise<number>;
    snap(): Record<string, unknown> | null;
    resetClock(): void;
  };
  return { api, audio, calls, toasts };
}

const progressCalls = (calls: Call[]) => calls.filter((c) => c.url === '/api/player/progress');

describe('podcast and audiobook progress', () => {
  it('logs one play after ten seconds and saves the place as it plays', () => {
    const h = harness();
    h.api.set(EPISODE);
    h.audio.currentTime = 4;
    h.api.tick();
    expect(h.calls.filter((c) => c.url === '/api/player/plays')).toHaveLength(0);
    h.audio.currentTime = 12;
    h.api.tick();
    h.api.tick();
    const plays = h.calls.filter((c) => c.url === '/api/player/plays');
    expect(plays).toHaveLength(1);
    expect(plays[0].body).toEqual({
      kind: 'podcast',
      media_id: 'guid-12',
      title: 'Episode 12',
      subtitle: 'Quiet Rooms',
      art_url: 'https://cdn.example/art.jpg',
      src: 'https://cdn.example/ep12.mp3',
      duration_s: 1800,
    });
    // saved on the first tick, then at most every 15 s
    const saves = progressCalls(h.calls);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      method: 'PUT',
      body: { kind: 'podcast', media_id: 'guid-12', position_s: 4, duration_s: 1800, ended: false },
    });
  });

  it('never sends an episode to music’s play log (which feeds scrobbling)', () => {
    const h = harness();
    h.api.set(EPISODE);
    h.audio.currentTime = 300;
    h.api.musicTick();
    expect(h.calls.some((c) => c.url === '/api/library/log-play')).toBe(false);
  });

  it('pausing keeps the place; the end marks it finished', () => {
    const h = harness();
    h.api.set(EPISODE);
    h.audio.currentTime = 600;
    h.api.pause();
    expect(progressCalls(h.calls).at(-1)?.body).toMatchObject({ position_s: 600, ended: false });
    h.audio.ended = true;
    h.api.ended();
    expect(progressCalls(h.calls).at(-1)?.body).toMatchObject({ position_s: 1800, ended: true });
  });

  it('another item taking over keeps where the last one got to, even after the load reset it', () => {
    const h = harness();
    h.api.set(EPISODE);
    h.audio.currentTime = 754.32;
    h.api.tick();
    h.api.resetClock();
    // the load of what comes next empties src and resets the position to 0
    h.audio.currentTime = 0;
    h.audio.currentSrc = '';
    h.api.tick();
    expect(h.api.snap()).toMatchObject({ position: 754.32 });
    h.api.set({ ...EPISODE, media_id: 'guid-13', title: 'Episode 13' });
    const last = progressCalls(h.calls).at(-1)!;
    expect(last.body).toMatchObject({ media_id: 'guid-12', position_s: 754.3 });
    expect(h.api.snap()).toBeNull();
  });

  it('starts where this profile left it, and says so', async () => {
    const h = harness({ 'guid-12': { resume_at: 754.3, duration_s: 1800 } });
    expect(await h.api.resumeAt(EPISODE)).toBe(754.3);
    expect(h.calls[0]).toMatchObject({
      url: '/api/player/progress/lookup',
      method: 'POST',
      body: { kind: 'podcast', ids: ['guid-12'] },
    });
    expect(h.toasts).toEqual(['Picking up where you left off, at 12:34']);
  });

  it('a finished or new item starts from the top; music never asks', async () => {
    const h = harness({ 'guid-12': { resume_at: 0, finished: true } });
    expect(await h.api.resumeAt(EPISODE)).toBe(0);
    expect(h.toasts).toEqual([]);
    expect(await h.api.resumeAt({ title: 'Song', is_library: true })).toBe(0);
    expect(h.calls).toHaveLength(1);
  });
});
