/**
 * The Spotify pause as a live React view. Its own module so that
 * spotify-pause.ts stays free of React: the shell bundle (vite.shell.config.ts,
 * an IIFE built without React's production define) imports spotify-pause.ts,
 * and React's CommonJS entry reads `process.env.NODE_ENV`, which a browser
 * doesn't have, so importing React there stops the whole shell at load.
 */

import { useEffect, useState } from 'react';

import { spotifyPauseView, type SpotifyPauseStatus, type SpotifyPauseView } from './spotify-pause';

/** The live view: re-reads the clock every second while Spotify is paused. */
export function useSpotifyPause(
  status: SpotifyPauseStatus | null | undefined,
): SpotifyPauseView | null {
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = Date.now();
    setReceivedAt(t);
    setNow(t);
  }, [status]);
  const view = spotifyPauseView(status, Math.max(0, now - receivedAt) / 1000);
  const ticking = view !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  return view;
}
