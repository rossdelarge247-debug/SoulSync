/**
 * The page-wide "Spotify is paused" dialog (board 12b), for a Spotify call a
 * person started anywhere outside a React tree that renders its own
 * (useSpotifyGate). Registers `window.ssOpenSpotifyPaused` (what
 * `spotifyGate` opens) and `window.ssSpotifyGate` for the classic scripts.
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { SpotifyGateAnswer, SpotifyGateRequest } from './spotify-gate';

import { spotifyGate } from './spotify-gate';
import { SpotifyPausedDialog } from './spotify-paused-dialog';

interface Pending {
  id: number;
  request: SpotifyGateRequest;
  resolve: (answer: SpotifyGateAnswer) => void;
}

let seq = 0;
let show: ((p: Pending) => void) | null = null;

/** Open the dialog; resolves with what the person chose. */
export function openSpotifyPaused(request: SpotifyGateRequest): Promise<SpotifyGateAnswer> {
  return new Promise((resolve) => {
    seq += 1;
    if (show) show({ id: seq, request, resolve });
    else resolve('wait');
  });
}

export function SpotifyPausedHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    show = (p) =>
      setPending((current) => {
        // one at a time: a newer ask replaces an older one, which waits too
        current?.resolve('wait');
        return p;
      });
    return () => {
      show = null;
    };
  }, []);
  if (!pending) return null;
  return (
    <SpotifyPausedDialog
      key={pending.id}
      open
      status={pending.request.status}
      description={pending.request.description}
      onAnswer={(answer) => {
        setPending(null);
        pending.resolve(answer);
      }}
    />
  );
}

const HOST_ID = 'spotify-paused-root';

export function mountSpotifyPausedHost(): void {
  if (typeof document === 'undefined' || document.getElementById(HOST_ID)) return;
  const el = document.createElement('div');
  el.id = HOST_ID;
  document.body.appendChild(el);
  createRoot(el).render(<SpotifyPausedHost />);
  window.ssOpenSpotifyPaused = openSpotifyPaused;
  window.ssSpotifyGate = (description: string) => spotifyGate(description);
}
