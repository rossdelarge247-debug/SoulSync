/**
 * What a person sees while Spotify is paused for rate limiting, in plain
 * words, counting down live.
 *
 * The server (core/spotify_client.py) pauses every Spotify call after a 429:
 * for exactly as long as Spotify's Retry-After when it sends one
 * (`rate_limit.source === 'spotify'`), or for SYNCHRO.S's own estimate when
 * it doesn't (`'estimate'`: 10 minutes first, longer on repeats). After the
 * pause, background jobs wait out `post_ban_cooldown` seconds and then ease
 * back in slowly. CONTRACTS.md, "Spotify pause".
 *
 * Pure apart from `clearSpotifyPause`
 * (the admins' "Try again now").
 */

import { appURL } from '@/platform/url-base';

export interface SpotifyRateLimit {
  active?: boolean;
  remaining_seconds?: number;
  retry_after?: number;
  endpoint?: string | null;
  /** 'spotify' = Spotify's own Retry-After; 'estimate' = SYNCHRO.S's guess. */
  source?: string | null;
  /** What was happening, in words that follow "after": "checking an artist's albums". */
  trigger?: string | null;
  feature?: string | null;
  expires_at?: number;
}

export interface SpotifyPauseStatus {
  rate_limited?: boolean;
  rate_limit?: SpotifyRateLimit | null;
  post_ban_cooldown?: number | null;
}

export interface SpotifyPauseView {
  /** 'paused': no Spotify calls at all. 'easing': back, background jobs still waiting. */
  kind: 'paused' | 'easing';
  /** The time came from Spotify (its Retry-After) rather than our estimate. */
  fromSpotify: boolean;
  remainingSeconds: number;
  /** The time left alone: "12 min". */
  timeLeft: string;
  /** For a status pill or dot title: "Spotify paused · 12 min". */
  short: string;
  /** The headline: "Spotify asked us to wait 12 min (after checking an artist's albums)". */
  sentence: string;
  /** What it means for the person. */
  detail: string;
}

/** Shown beside "Try again now". */
export const TRY_AGAIN_NOTE =
  'Clears SYNCHRO.S’s pause. If Spotify is still limiting, the pause comes back.';

/** "45 s", "3 min 20 s", "12 min", "2 h 5 min". Rounds up: never says 0 while waiting. */
export function formatWait(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.ceil(seconds ?? 0));
  if (s < 60) return `${s} s`;
  if (s < 600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
  }
  const totalMinutes = Math.ceil(s / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * The view for a Spotify status slice, `elapsedSeconds` after it arrived
 * (so a page can count down between pushes). Null when Spotify isn't paused.
 */
export function spotifyPauseView(
  status: SpotifyPauseStatus | null | undefined,
  elapsedSeconds = 0,
): SpotifyPauseView | null {
  const rl = status?.rate_limit;
  if (status?.rate_limited && rl) {
    const remaining = Math.max(0, (rl.remaining_seconds ?? 0) - elapsedSeconds);
    if (remaining > 0) {
      const t = formatWait(remaining);
      const after = rl.trigger ? ` (after ${rl.trigger})` : '';
      const fromSpotify = rl.source === 'spotify';
      return {
        kind: 'paused',
        fromSpotify,
        remainingSeconds: remaining,
        timeLeft: t,
        short: `Spotify paused · ${t}`,
        sentence: fromSpotify
          ? `Spotify asked us to wait ${t}${after}`
          : `Paused Spotify for ${t} to be safe${after}`,
        detail: fromSpotify
          ? 'That time came from Spotify. Until then, Spotify features use your other sources.'
          : 'Spotify didn’t say how long to wait, so this is SYNCHRO.S’s estimate. It gets longer if Spotify keeps saying no. Until then, Spotify features use your other sources.',
      };
    }
  }
  const cooldown = Math.max(0, (status?.post_ban_cooldown ?? 0) - elapsedSeconds);
  if (cooldown > 0) {
    const t = formatWait(cooldown);
    return {
      kind: 'easing',
      fromSpotify: false,
      remainingSeconds: cooldown,
      timeLeft: t,
      short: `Spotify easing back in · ${t}`,
      sentence: `Spotify is back. Background jobs wait ${t} more`,
      detail:
        'What you do uses Spotify again now. Enrichment, scans and auto-sync wait, then start slowly so the pause doesn’t come back.',
    };
  }
  return null;
}

/** Whether this profile may use "Try again now" (the server checks too). */
export function canClearSpotifyPause(): boolean {
  const ctx = window.SoulSyncWebShellBridge?.getCurrentProfileContext?.() ?? null;
  return ctx ? !!ctx.isAdmin || ctx.profileId === 1 : false;
}

/** "Try again now": clears the local pause. Resolves to an error message, or null. */
export async function clearSpotifyPause(): Promise<string | null> {
  try {
    const res = await fetch(appURL('/api/spotify/rate-limit/clear'), { method: 'POST' });
    if (res.ok) return null;
    if (res.status === 403) return 'Only an admin can do that.';
    return 'SYNCHRO.S couldn’t clear the pause. Try again in a moment.';
  } catch {
    return 'SYNCHRO.S didn’t answer. Try again in a moment.';
  }
}
