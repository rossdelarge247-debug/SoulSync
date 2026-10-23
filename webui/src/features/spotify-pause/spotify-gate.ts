/**
 * The hook for "something a person asked for needs Spotify right now" (board
 * 12b): before a Spotify call a person started, ask `spotifyGate(what)`.
 *
 * - Spotify isn't paused (or is only easing back in, which a person's own
 *   request may go through): resolves `true` at once and nothing shows.
 * - Spotify is paused: the "Spotify is paused" dialog opens with `what` as
 *   its description. "Wait for it" resolves `true` once the pause ends (the
 *   caller then carries on by itself); an admin's "Try again now" clears the
 *   pause and resolves `true`; closing it resolves `false` (nothing happens).
 *
 * The dialog is opened by whichever opener is registered: a React tree
 * renders its own (useSpotifyGate, so it nests inside an open dialog), and
 * the page-wide host (spotify-paused-host.tsx) registers
 * `window.ssOpenSpotifyPaused` for everything else, including the classic
 * scripts through `window.ssSpotifyGate`. No React here: the shell bundle
 * may import this (src/shell/no-react.test.ts).
 */

import { appURL } from '@/platform/url-base';

import { spotifyPauseView, type SpotifyPauseStatus } from './spotify-pause';

export type SpotifyGateAnswer = 'wait' | 'cleared' | 'closed';

export interface SpotifyGateRequest {
  /** What waits, in a sentence: "Mirroring “Sunday Mornings” needs Spotify’s playlist, so it waits." */
  description: string;
  /** The Spotify slice the dialog counts down from. */
  status: SpotifyPauseStatus;
}

export type SpotifyGateOpener = (request: SpotifyGateRequest) => Promise<SpotifyGateAnswer>;

declare global {
  interface Window {
    ssOpenSpotifyPaused?: SpotifyGateOpener;
    ssSpotifyGate?: (description: string) => Promise<boolean>;
  }
}

/** The `ss:service-status` push that carries `/status` (src/shell). */
const STATUS_EVENT = 'ss:service-status';

export interface SpotifyGateDeps {
  fetchImpl?: typeof fetch;
  win?: Window;
  /** Opens the dialog; defaults to the page-wide host's. */
  open?: SpotifyGateOpener;
}

/** The `spotify` slice of `/status`, or null when it can't be read. */
export async function readSpotifyStatus(
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<SpotifyPauseStatus | null> {
  try {
    const res = await fetchImpl(appURL('/status'));
    if (!res.ok) return null;
    const body = (await res.json()) as { spotify?: SpotifyPauseStatus } | null;
    return body?.spotify ?? null;
  } catch {
    return null;
  }
}

function paused(status: SpotifyPauseStatus | null | undefined): boolean {
  return spotifyPauseView(status)?.kind === 'paused';
}

/**
 * Resolves once Spotify isn't paused any more: on the status push, or by
 * asking `/status` when the countdown says it should be over (and every 30
 * seconds at most, in case the pause was cleared or replaced).
 */
export function untilSpotifyFree(
  status: SpotifyPauseStatus | null,
  deps: Pick<SpotifyGateDeps, 'fetchImpl' | 'win'> = {},
): Promise<void> {
  const win = deps.win ?? window;
  if (!paused(status)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      win.removeEventListener(STATUS_EVENT, onFrame);
      resolve();
    };
    const delayFor = (s: SpotifyPauseStatus | null) => {
      const view = spotifyPauseView(s);
      if (!view) return 5_000;
      return Math.min(30_000, Math.max(2_000, view.remainingSeconds * 1000 + 500));
    };
    const poll = async () => {
      if (done) return;
      const fresh = await readSpotifyStatus(deps.fetchImpl);
      if (done) return;
      if (fresh && !paused(fresh)) {
        finish();
        return;
      }
      timer = setTimeout(() => void poll(), delayFor(fresh));
    };
    function onFrame(event: Event) {
      const frame = (event as CustomEvent<{ spotify?: SpotifyPauseStatus } | null>).detail;
      if (frame && 'spotify' in frame && !paused(frame.spotify)) finish();
    }
    win.addEventListener(STATUS_EVENT, onFrame);
    timer = setTimeout(() => void poll(), delayFor(status));
  });
}

/**
 * Ask before a Spotify call a person started. `true`: go ahead (now, or once
 * the pause is over); `false`: they closed the dialog, so don't.
 */
export async function spotifyGate(
  description: string,
  deps: SpotifyGateDeps = {},
): Promise<boolean> {
  const win = deps.win ?? window;
  const status = await readSpotifyStatus(deps.fetchImpl);
  if (!status || !paused(status)) return true;
  const open = deps.open ?? win.ssOpenSpotifyPaused;
  // no dialog on this page: the request goes as it always did
  if (!open) return true;
  const answer = await open({ description, status });
  if (answer === 'closed') return false;
  if (answer === 'wait') await untilSpotifyFree(status, deps);
  return true;
}
