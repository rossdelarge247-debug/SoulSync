import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRadioSession } from './radio-session';

const STATION = {
  id: 'nts-1',
  name: 'NTS 1',
  logo_url: '',
  quality: { codec: 'AAC', bitrate_kbps: 256, lossless: false, label: 'AAC 256 kbps' },
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(scanReplies: { status?: number; body: Record<string, unknown> }[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const queue = [...scanReplies];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/api/radio/play')) {
      return reply({
        success: true,
        mode: 'relay',
        session_id: 's-relay',
        play_url: '/api/radio/relay/s-relay',
        station: STATION,
        stream: {
          id: 'a',
          label: 'AAC 256 kbps',
          codec: 'AAC',
          bitrate_kbps: 256,
          lossless: false,
        },
      });
    }
    if (url.includes('/api/radio/now-playing')) {
      return reply({ success: true, state: 'listening', now: Date.now() / 1000 });
    }
    if (url.includes('/api/radio/scan')) {
      const next = queue.shift() ?? { body: { success: true, state: 'not_found' } };
      return reply(next.body, next.status ?? 200);
    }
    if (url.includes('/want')) return reply({ success: true });
    return reply({ success: true });
  });
  const engine = {
    playRadio: vi.fn(async () => ({ status: 'played' })),
    updateRadio: vi.fn(),
    stop: vi.fn(),
    state: () => ({ track: { kind: 'radio' }, playing: true }),
  };
  const session = createRadioSession({
    fetch: fetchImpl as unknown as typeof fetch,
    engine: () => engine,
    win: window,
  });
  return { session, calls };
}

const LISTENING = {
  success: true,
  scan_id: 'sc1',
  state: 'listening',
  phase: 'capturing',
  seconds_left: 9,
};
const FOUND = {
  success: true,
  scan_id: 'sc1',
  state: 'identified',
  track: { artist: 'Tidewater', title: 'Night Ferry', release: null },
  source: 'scan_audd',
  source_label: 'AudD',
  heard_id: 12,
  library: { in_library: false, below_target: null, track_id: null },
  on_wanted: false,
};

describe('Scan now in the radio session', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('starts a scan for the session, polls each second, then keeps the answer', async () => {
    const { session, calls } = setup([
      { body: LISTENING },
      { body: { ...LISTENING, seconds_left: 3 } },
      { body: FOUND },
    ]);
    await session.play('nts-1');
    await session.scanNow!();
    const start = calls.find((c) => c.url.endsWith('/api/radio/scan'))!;
    expect(start.method).toBe('POST');
    expect(start.body).toEqual({ session_id: 's-relay' });
    expect(session.state().scan?.state).toBe('listening');
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.state().scan?.seconds_left).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.state().scan?.state).toBe('identified');
    expect(calls.filter((c) => c.url.includes('/api/radio/scan/sc1'))).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.filter((c) => c.url.includes('/api/radio/scan/sc1'))).toHaveLength(2); // stopped polling
  });

  it('says why when a scan is refused', async () => {
    const { session } = setup([
      {
        status: 429,
        body: {
          success: false,
          error: 'rate_limited',
          message: 'That’s 3 scans in a minute. Try again in 20 s.',
        },
      },
    ]);
    await session.play('nts-1');
    await session.scanNow!();
    expect(session.state().scan).toBeNull();
    expect(session.state().scanError).toMatch(/3 scans in a minute/);
  });

  it('adds what it found to Wanted through its Heard row, and Done clears it', async () => {
    const { session, calls } = setup([{ body: FOUND }]);
    await session.play('nts-1');
    await session.scanNow!();
    expect(await session.addScanToWanted!()).toBe(true);
    expect(
      calls.some((c) => c.url.endsWith('/api/radio/heard/12/want') && c.method === 'POST'),
    ).toBe(true);
    expect(session.state().scan?.on_wanted).toBe(true);
    session.dismissScan!();
    expect(session.state().scan).toBeNull();
  });

  it('does nothing without a station, and Stop ends the scan', async () => {
    const { session, calls } = setup([{ body: LISTENING }, { body: LISTENING }]);
    await session.scanNow!();
    expect(calls.some((c) => c.url.includes('/api/radio/scan'))).toBe(false);
    await session.play('nts-1');
    await session.scanNow!();
    await session.stop();
    expect(session.state().scan).toBeNull();
    const polls = calls.filter((c) => c.url.includes('/api/radio/scan/sc1')).length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.filter((c) => c.url.includes('/api/radio/scan/sc1')).length).toBe(polls);
  });
});
