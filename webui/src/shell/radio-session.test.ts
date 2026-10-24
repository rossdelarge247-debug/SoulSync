import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RadioSessionState } from '@/features/radio/radio.types';

import { createRadioSession } from './radio-session';

const STATION = {
  id: 'somafm-dronezone',
  name: 'SomaFM · Drone Zone',
  logo_url: '',
  quality: { codec: 'MP3', bitrate_kbps: 256, lossless: false, label: 'MP3 256 kbps' },
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(results: string[] = ['played']) {
  const calls: { url: string; body: unknown }[] = [];
  const plays: Record<string, unknown>[] = [];
  let mode = 'direct';
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith('/api/radio/play')) {
      mode = body?.force_relay ? 'relay' : 'direct';
      return reply({
        success: true,
        mode,
        session_id: mode === 'relay' ? 's-relay' : 's-direct',
        play_url:
          mode === 'relay'
            ? '/api/radio/relay/s-relay'
            : 'https://ice1.somafm.com/dronezone-256-mp3',
        station: STATION,
        stream: {
          id: 'mp3-256',
          label: 'MP3 256 kbps (best offered)',
          codec: 'MP3',
          bitrate_kbps: 256,
          lossless: false,
        },
      });
    }
    if (url.includes('/api/radio/now-playing')) {
      return reply({
        success: true,
        state: 'identified',
        now: Date.now() / 1000,
        identified_at: Date.now() / 1000,
        track: { artist: 'A', title: 'B', release: null, art_url: null },
        heard_id: 4,
        on_wanted: false,
        library: { in_library: false, below_target: null, track_id: null },
      });
    }
    if (url.includes('/want')) return reply({ success: true, message: 'Added' });
    return reply({ success: true });
  });
  const queue = [...results];
  const engine = {
    playRadio: vi.fn(async (item: Record<string, unknown>) => {
      plays.push(item);
      return { status: queue.shift() ?? 'played' };
    }),
    updateRadio: vi.fn(),
    stop: vi.fn(),
    state: () => ({ track: { kind: 'radio' }, playing: true }),
  };
  const session = createRadioSession({
    fetch: fetchImpl as unknown as typeof fetch,
    engine: () => engine,
    win: window,
  });
  return { session, calls, plays, engine, fetchImpl };
}

describe('the radio session', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('plays a direct stream with CORS, then polls what is on', async () => {
    const { session, plays, calls } = setup();
    const events: RadioSessionState[] = [];
    window.addEventListener('ss:radio', (e) => events.push((e as CustomEvent).detail));
    await session.play('somafm-dronezone');
    expect(plays[0]).toMatchObject({
      crossOrigin: true,
      quiet: true,
      src: 'https://ice1.somafm.com/dronezone-256-mp3',
    });
    expect(session.state().status).toBe('playing');
    await vi.waitFor(() => expect(session.state().nowPlaying?.track?.title).toBe('B'));
    expect(calls.some((c) => c.url.includes('session_id=s-direct'))).toBe(true);
    expect(events.at(-1)?.status).toBe('playing');
    session.dispose();
  });

  it('falls back to the relay when the browser cannot play the direct stream', async () => {
    const { session, plays, calls } = setup(['failed', 'played']);
    await session.play('somafm-dronezone');
    expect(plays).toHaveLength(2);
    expect(plays[1]).toMatchObject({ crossOrigin: false, src: '/api/radio/relay/s-relay' });
    expect(calls.find((c) => c.url.endsWith('/api/radio/stop'))?.body).toEqual({
      session_id: 's-direct',
    });
    expect(calls.filter((c) => c.url.endsWith('/api/radio/play'))[1]?.body).toMatchObject({
      force_relay: true,
    });
    expect(session.state().mode).toBe('relay');
    session.dispose();
  });

  it('says busy when two stations already play through the server', async () => {
    const fetchImpl = vi.fn(async () =>
      reply({ success: false, error: 'busy', message: 'Two stations are already playing.' }, 409),
    );
    const session = createRadioSession({
      fetch: fetchImpl as unknown as typeof fetch,
      engine: () => undefined,
      win: window,
    });
    await session.play('kexp');
    expect(session.state()).toMatchObject({ status: 'error', error: { code: 'busy' } });
    session.dispose();
  });

  it('stops: tells the server and stops the player', async () => {
    const { session, calls, engine } = setup();
    await session.play('somafm-dronezone');
    await session.stop();
    expect(session.state().status).toBe('idle');
    expect(calls.at(-1)).toMatchObject({ body: { session_id: 's-direct' } });
    expect(engine.stop).toHaveBeenCalled();
    session.dispose();
  });

  it('stops the player before the server answers, so a hung server can’t keep it playing', async () => {
    const { session, engine, fetchImpl } = setup();
    await session.play('somafm-dronezone');
    const orig = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      (input instanceof Request ? input.url : input.toString()).endsWith('/api/radio/stop')
        ? new Promise<Response>(() => {})
        : orig(input, init),
    );
    void session.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.stop).toHaveBeenCalled();
    expect(session.state().status).toBe('idle');
    session.dispose();
  });

  it('adds the identified track to Wanted through its Heard row', async () => {
    const { session, calls } = setup();
    await session.play('somafm-dronezone');
    await vi.waitFor(() => expect(session.state().nowPlaying?.heard_id).toBe(4));
    expect(await session.addToWanted()).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/api/radio/heard/4/want'))).toBe(true);
    session.dispose();
  });
});
