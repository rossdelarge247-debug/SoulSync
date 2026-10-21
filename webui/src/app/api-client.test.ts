import type { ResponsePromise } from 'ky';

import { HTTPError } from 'ky';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw';

import { apiClient, readJson } from './api-client';

function createHttpError(body: unknown, status = 400) {
  const response = new Response(JSON.stringify(body), {
    status,
    statusText: 'Bad Request',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  const request = new Request('https://example.com/api/test');
  const error = new HTTPError(response, request, {} as any);
  error.data = body;
  return error;
}

describe('readJson', () => {
  it('returns parsed JSON', async () => {
    const json = vi.fn().mockResolvedValue({ ok: true });
    const promise = { json } as unknown as ResponsePromise<{ ok: boolean }>;

    await expect(readJson(promise)).resolves.toEqual({ ok: true });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it('keeps HTTPError instances intact and uses the payload message', async () => {
    const error = createHttpError({ error: 'Nope' }, 403);
    const json = vi.fn().mockRejectedValue(error);
    const promise = { json } as unknown as ResponsePromise<unknown>;
    const result = readJson(promise);

    await expect(result).rejects.toBe(error);
    await expect(result).rejects.toHaveProperty('message', 'Nope');
  });

  it('surfaces the standard public-API error.message envelope', async () => {
    const error = createHttpError(
      {
        success: false,
        data: null,
        error: { code: 'CONFLICT', message: 'Wishlist processing is already running.' },
      },
      409,
    );
    const json = vi.fn().mockRejectedValue(error);
    const promise = { json } as unknown as ResponsePromise<unknown>;
    const result = readJson(promise);

    await expect(result).rejects.toBe(error);
    await expect(result).rejects.toHaveProperty(
      'message',
      'Wishlist processing is already running.',
    );
  });

  it('falls back to the HTTPError message when the payload is unhelpful', async () => {
    const error = createHttpError({ detail: 'missing error field' }, 404);
    const json = vi.fn().mockRejectedValue(error);
    const promise = { json } as unknown as ResponsePromise<unknown>;
    const result = readJson(promise);

    await expect(result).rejects.toBe(error);
    await expect(result).rejects.toHaveProperty('message', error.message);
  });
});

describe('a turned-off module (409 module_disabled)', () => {
  const body = {
    success: false,
    error: 'module_disabled',
    module: 'podcasts',
    message: 'Podcasts is turned off. An admin can turn it back on in Settings.',
  };
  const seen = vi.fn();
  const onDisabled = (event: Event) => seen((event as CustomEvent).detail);

  afterEach(() => {
    window.removeEventListener('soulsync:module-disabled', onDisabled);
    seen.mockReset();
  });

  it('reads the sentence, not the code', async () => {
    const error = createHttpError(body, 409);
    const json = vi.fn().mockRejectedValue(error);
    const result = readJson({ json } as unknown as ResponsePromise<unknown>);
    await expect(result).rejects.toHaveProperty('message', body.message);
  });

  it('is announced on window so the page and the sidebar can follow', async () => {
    window.addEventListener('soulsync:module-disabled', onDisabled);
    server.use(http.get('/api/podcasts/featured', () => HttpResponse.json(body, { status: 409 })));
    await expect(readJson(apiClient.get('podcasts/featured'))).rejects.toHaveProperty(
      'message',
      body.message,
    );
    await vi.waitFor(() =>
      expect(seen).toHaveBeenCalledWith({ module: 'podcasts', message: body.message }),
    );
  });

  it('any other 409 stays quiet', async () => {
    window.addEventListener('soulsync:module-disabled', onDisabled);
    server.use(
      http.post('/api/wishlist/process', () =>
        HttpResponse.json({ success: false, error: 'Already running' }, { status: 409 }),
      ),
    );
    await expect(readJson(apiClient.post('wishlist/process'))).rejects.toHaveProperty(
      'message',
      'Already running',
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).not.toHaveBeenCalled();
  });
});
