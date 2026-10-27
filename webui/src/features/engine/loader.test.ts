import { describe, expect, it } from 'vitest';

import { BUSY_BUDGET_MS, FETCH_TIMEOUT_MS, busyDelayMs, fetchWindow, inLine } from './loader';

const SR = 48000;

/** A WAV-ish answer; the fake context "decodes" it to a short stereo buffer. */
function okResponse(start: number): Response {
  return new Response(new Uint8Array(64), {
    status: 200,
    headers: { 'Content-Type': 'audio/wav', 'X-Window-Start': start.toFixed(6) },
  });
}

function busy(after = '1'): Response {
  return new Response(JSON.stringify({ error: 'busy' }), {
    status: 429,
    headers: { 'Retry-After': after },
  });
}

const ctx = {
  sampleRate: SR,
  async decodeAudioData() {
    const data = new Float32Array(SR / 10);
    return { numberOfChannels: 2, sampleRate: SR, length: data.length, getChannelData: () => data };
  },
} as unknown as BaseAudioContext;

/** The server's rule (core/dj/window.py): one decode a profile, the next is 429 with Retry-After. */
function serverWithCapOne(decodeMs: number, clock: { t: number }) {
  let busyUntil = 0;
  let inFlight = 0;
  let peak = 0;
  let refused = 0;
  const fetchImpl = (async (url: string) => {
    if (clock.t < busyUntil || inFlight > 0) {
      refused++;
      return busy();
    }
    inFlight++;
    peak = Math.max(peak, inFlight);
    busyUntil = clock.t + decodeMs;
    await new Promise((r) => setTimeout(r, 5));
    clock.t += decodeMs;
    inFlight--;
    return okResponse(Number(new URL(url, 'http://x').searchParams.get('start')));
  }) as typeof fetch;
  return { fetchImpl, stats: () => ({ peak, refused }) };
}

describe('loading windows (re-review N2)', () => {
  it('loads both decks with the server at one decode a profile: one after the other, nothing refused', async () => {
    const clock = { t: 0 };
    const server = serverWithCapOne(1700, clock);
    const opts = {
      fetchImpl: server.fetchImpl,
      now: () => clock.t,
      sleep: async (ms: number) => void (clock.t += ms),
    };
    const [a, b] = await Promise.all([
      fetchWindow(ctx, '1', 150, 90, opts),
      fetchWindow(ctx, '2', 0.2, 100, opts),
    ]);
    expect(a.offset).toBe(150);
    expect(b.offset).toBe(0.2);
    expect(server.stats()).toEqual({ peak: 1, refused: 0 });
  });

  it('waits out another tab’s decode, as long as Retry-After says, then loads', async () => {
    const clock = { t: 0 };
    const answers = [busy('1'), busy('1'), okResponse(10)];
    const waited: number[] = [];
    const deck = await fetchWindow(ctx, '1', 10, 30, {
      fetchImpl: (async () => answers.shift()!) as typeof fetch,
      now: () => clock.t,
      sleep: async (ms) => {
        waited.push(ms);
        clock.t += ms;
      },
    });
    expect(deck.offset).toBe(10);
    expect(waited).toEqual([1000, 1000]);
  });

  it('gives up with words after about ten seconds of busy', async () => {
    const clock = { t: 0 };
    let asked = 0;
    await expect(
      fetchWindow(ctx, '1', 10, 30, {
        fetchImpl: (async () => {
          asked++;
          return busy('2');
        }) as typeof fetch,
        now: () => clock.t,
        sleep: async (ms) => void (clock.t += ms),
      }),
    ).rejects.toThrow(/busy loading other tracks/);
    expect(clock.t).toBeLessThanOrEqual(BUSY_BUDGET_MS);
    expect(asked).toBeGreaterThan(3);
  });

  it('backs off without a Retry-After, and never waits less than the server asked', () => {
    const none = { headers: new Headers() };
    expect([0, 1, 2, 3, 5].map((n) => busyDelayMs(none, n))).toEqual([250, 500, 1000, 2000, 4000]);
    expect(busyDelayMs({ headers: new Headers({ 'Retry-After': '3' }) }, 0)).toBe(3000);
    expect(busyDelayMs({ headers: new Headers({ 'Retry-After': 'soon' }) }, 1)).toBe(500);
  });

  it('runs one job at a time in the tab, and a failed one doesn’t stop the next', async () => {
    const order: string[] = [];
    const job =
      (name: string, fail = false) =>
      async () => {
        order.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      };
    const results = await Promise.allSettled([
      inLine(job('a', true)),
      inLine(job('b')),
      inLine(job('c')),
    ]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
  });

  it('gives a hung request up after its deadline, so the tab’s line moves on (stage B review)', async () => {
    expect(FETCH_TIMEOUT_MS).toBe(90_000);
    const signals: (AbortSignal | undefined)[] = [];
    // a server that never answers: only the signal ends the request
    const hung = ((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as typeof fetch;
    const started = Date.now();
    await expect(fetchWindow(ctx, '1', 10, 30, { fetchImpl: hung, timeoutMs: 40 })).rejects.toThrow(
      /took too long/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    // the next window in the line isn't held behind it
    const next = await fetchWindow(ctx, '2', 5, 30, {
      fetchImpl: (async () => okResponse(5)) as typeof fetch,
    });
    expect(next.offset).toBe(5);
  });

  it('passes a deadline with every request by default', async () => {
    let seen: AbortSignal | null | undefined;
    await fetchWindow(ctx, '1', 1, 30, {
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        seen = init?.signal;
        return okResponse(1);
      }) as typeof fetch,
    });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });
});
