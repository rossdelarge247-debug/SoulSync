import type { ResponsePromise } from 'ky';

import ky, { HTTPError } from 'ky';

import { MODULE_DISABLED_EVENT, moduleDisabledPayload } from '@/features/modules/modules.helpers';
import { appURL } from '@/platform/url-base';

const apiBaseUrl =
  typeof globalThis.location === 'object'
    ? new URL(appURL('/api/'), globalThis.location.origin).toString()
    : 'http://localhost/api/';
const shellBaseUrl =
  typeof globalThis.location === 'object'
    ? new URL(appURL('/'), globalThis.location.origin).toString()
    : 'http://localhost/';

/**
 * A turned-off module answers 409 module_disabled on every route
 * (core/modules.py). Say so on window, so the page can show its "turned off"
 * message instead of an empty or generic error state, and the shell can hide
 * the module's sidebar entries. Only watches: the response goes on unchanged.
 */
export function announceModuleDisabled({ response }: { response: Response }): void {
  if (response.status !== 409) return;
  void response
    .clone()
    .json()
    .then((body: unknown) => {
      const payload = moduleDisabledPayload(body);
      if (payload)
        window.dispatchEvent(new CustomEvent(MODULE_DISABLED_EVENT, { detail: payload }));
    })
    .catch(() => {
      /* not JSON: not ours */
    });
}

export const apiClient = ky.create({
  baseUrl: apiBaseUrl,
  retry: 0,
  hooks: { afterResponse: [announceModuleDisabled] },
});

export const shellClient = ky.create({
  baseUrl: shellBaseUrl,
  retry: 0,
});

export async function readJson<T>(promise: ResponsePromise<T>): Promise<T> {
  try {
    return await promise.json<T>();
  } catch (error) {
    if (error instanceof HTTPError) {
      error.message = getHttpErrorMessage(error.data, error.message);
    }

    throw error;
  }
}

type JsonErrorPayload = {
  error?: unknown;
  message?: unknown;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function getHttpErrorMessage(data: unknown, fallback: string): string {
  const direct = nonEmptyString(data);
  if (direct) return direct;
  if (!data || typeof data !== 'object') return fallback;

  const payload = data as JsonErrorPayload;
  // module_disabled is a code; its message is the sentence to show
  const disabled = moduleDisabledPayload(data);
  if (disabled?.message) return disabled.message;
  const error = nonEmptyString(payload.error);
  if (error) return error;
  if (payload.error && typeof payload.error === 'object') {
    const nested = nonEmptyString((payload.error as { message?: unknown }).message);
    if (nested) return nested;
  }
  const message = nonEmptyString(payload.message);
  if (message) return message;

  return fallback;
}
