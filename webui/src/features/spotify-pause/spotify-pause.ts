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
  /** The time left alone, in whole minutes past a minute: "12 min". */
  timeLeft: string;
  /** The time left to the second, for the dialog's tile: "11 min 42 s". */
  timeLeftExact: string;
  /** For a status pill or dot title: "Spotify paused · 12 min". */
  short: string;
  /** The headline: "Spotify asked us to wait 12 min (after checking an artist's albums)".
   *  An hour or more also says when: "Spotify asked us to wait 15 h, until 21:40 (after …)". */
  sentence: string;
  /** When it's over, on the local clock: "21:40", "tomorrow 09:12" (null while easing). */
  backAt: string | null;
  /** What it means for the person. */
  detail: string;

  // ── the boards (Spotify pause 12a–12d) ──────────────────────────────────
  /** The Notice's title, the one fact: "Spotify asked us to wait 11 min". */
  title: string;
  /** Warning while paused, info while easing back in; never danger. */
  tone: 'warning' | 'info';
  /** The Connections card's header tag: "Paused by Spotify · 11 min". */
  tag: string;
  /** The Spotify tile's own tag in the Connections grid, shorter (15a): "Paused · 11 min", "Easing back in". */
  tileTag: string;
  /** Home's sentence for an admin at full width (names the trigger, whose number, what works). */
  body: string;
  /** The same on a phone (12d), shorter. */
  bodyNarrow: string;
  /** A member's sentence: no button, "An admin can try again sooner." at the end. */
  bodyMember: string;
  /** Beside Try again now on Home and in the dialog; null while easing (no button). */
  tryAgainNote: string | null;
  /** The Connections card's warning box. */
  cardSentence: string;
  /** Under the card's Try again now; null while easing. */
  cardNote: string | null;
  /** The dialog's "Whose number" tile: "Spotify’s" or "SYNCHRO.S’s guess". */
  whose: string;
  /** The dialog's "Set off by" tile: "Checking an artist's albums, for the watchlist scan". */
  setOffBy: string;
  /** The dialog's sentence under the tiles. */
  dialogSentence: string;
}

/** Shown beside "Try again now". */
export const TRY_AGAIN_NOTE =
  'Clears SYNCHRO.S’s pause. If Spotify is still limiting, the pause comes back.';

/** On an estimate a repeat doubles the pause, so the note says so. */
export const TRY_AGAIN_NOTE_ESTIMATE =
  'Clears SYNCHRO.S’s pause. If Spotify is still limiting, the pause comes back, longer.';

/** A member's line in place of the button (12a). */
export const MEMBER_TRY_AGAIN = 'An admin can try again sooner.';

/** The estimate's longest step (core/spotify_client.py): it doesn't double past this. */
const LONGEST_ESTIMATE_SECONDS = 4 * 3600;

const STILL_WORKS = 'Searches and downloads carry on; only what asks Spotify waits.';
const STILL_WORKS_LONG =
  'Searches and downloads carry on; only what asks Spotify (playlists, new releases, the watchlist scan) waits.';

/**
 * "45 s", "12 min", "1 h 20 min" (the boards' times). Past a minute it
 * counts whole minutes, rounding up, so a running pause never says 0.
 */
export function formatWait(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.ceil(seconds ?? 0));
  if (s < 60) return `${s} s`;
  const totalMinutes = Math.ceil(s / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** To the second under an hour, for the dialog's Time left: "11 min 42 s". */
export function formatWaitExact(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.ceil(seconds ?? 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
  }
  return formatWait(s);
}

/** A length in words, for a sentence: "10 minutes", "1 hour 20 minutes". */
export function lengthWords(seconds: number | null | undefined): string {
  const totalMinutes = Math.max(1, Math.round((seconds ?? 0) / 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const mins = `${m} minute${m === 1 ? '' : 's'}`;
  if (!h) return mins;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m ? `${hours} ${mins}` : hours;
}

/** "21:40", or "tomorrow 09:12", or "Thu 09:12": when a wait that ends at
 *  `endMs` is over, on the local clock (24-hour, as the server says it). */
export function formatBackAt(endMs: number, nowMs: number): string {
  const end = new Date(endMs);
  const now = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(end) - day(now)) / 86_400_000);
  if (days <= 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  return `${end.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
}

function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "checking an artist's albums for the watchlist scan" + its feature →
 *  "Checking an artist's albums, for the watchlist scan". */
function setOffBy(rl: SpotifyRateLimit): string {
  const trigger = rl.trigger?.trim();
  if (!trigger) return 'A Spotify request';
  const feature = rl.feature?.trim();
  if (feature && trigger.endsWith(` for ${feature}`)) {
    return `${capitalise(trigger.slice(0, -` for ${feature}`.length))}, for ${feature}`;
  }
  return capitalise(trigger);
}

/** From an hour on, a countdown alone is hard to plan around, so the
 *  sentences also say when it's over. */
const SAY_WHEN_FROM_SECONDS = 3600;

/**
 * The view for a Spotify status slice, `elapsedSeconds` after it arrived
 * (so a page can count down between pushes). Null when Spotify isn't paused.
 * `nowMs` is the clock (for "until 21:40").
 */
export function spotifyPauseView(
  status: SpotifyPauseStatus | null | undefined,
  elapsedSeconds = 0,
  nowMs: number = Date.now(),
): SpotifyPauseView | null {
  const rl = status?.rate_limit;
  if (status?.rate_limited && rl) {
    const remaining = Math.max(0, (rl.remaining_seconds ?? 0) - elapsedSeconds);
    if (remaining > 0) {
      const backAt = formatBackAt(nowMs + remaining * 1000, nowMs);
      const t =
        remaining >= SAY_WHEN_FROM_SECONDS
          ? `${formatWait(remaining)}, until ${backAt}`
          : formatWait(remaining);
      const tShort = formatWait(remaining);
      const trigger = rl.trigger?.trim() || 'a Spotify request';
      const after = rl.trigger ? ` (after ${rl.trigger})` : '';
      const fromSpotify = rl.source === 'spotify';
      const total = rl.retry_after || rl.remaining_seconds || remaining;
      const lead = `After ${trigger}.`;
      const doubles =
        total < LONGEST_ESTIMATE_SECONDS
          ? ', and twice as long if it happens again within the hour'
          : ', the longest it waits';
      const guess = `Spotify said “too many requests” after ${trigger}, but not how long to wait, so this is SYNCHRO.S’s guess: ${lengthWords(total)}${doubles}.`;
      return {
        kind: 'paused',
        fromSpotify,
        remainingSeconds: remaining,
        timeLeft: tShort,
        timeLeftExact: formatWaitExact(remaining),
        backAt,
        short: `Spotify paused · ${tShort}`,
        sentence: fromSpotify
          ? `Spotify asked us to wait ${t}${after}`
          : `Paused Spotify for ${t} to be safe${after}`,
        detail: fromSpotify
          ? 'That time came from Spotify. Until then, Spotify features use your other sources.'
          : 'Spotify didn’t say how long to wait, so this is SYNCHRO.S’s estimate. It gets longer if Spotify keeps saying no. Until then, Spotify features use your other sources.',
        title: fromSpotify ? `Spotify asked us to wait ${t}` : `Paused Spotify for ${t} to be safe`,
        tone: 'warning',
        tag: fromSpotify ? `Paused by Spotify · ${tShort}` : `Paused to be safe · ${tShort}`,
        tileTag: `Paused · ${tShort}`,
        body: fromSpotify
          ? `${lead} That time came from Spotify, so SYNCHRO.S waits exactly that long. ${STILL_WORKS_LONG}`
          : `${guess} ${STILL_WORKS}`,
        bodyNarrow: fromSpotify ? `${lead} ${STILL_WORKS}` : `${guess} ${STILL_WORKS}`,
        bodyMember: fromSpotify
          ? `${lead} ${STILL_WORKS} ${MEMBER_TRY_AGAIN}`
          : `${guess} ${STILL_WORKS} ${MEMBER_TRY_AGAIN}`,
        tryAgainNote: fromSpotify ? TRY_AGAIN_NOTE : TRY_AGAIN_NOTE_ESTIMATE,
        cardSentence: fromSpotify
          ? `Spotify asked us to wait ${t}, after ${trigger}. Background jobs wait it out; your own lookups go first when it ends.`
          : `Paused Spotify for ${t} to be safe, after ${trigger}: Spotify didn’t say how long, so this is SYNCHRO.S’s guess. Background jobs wait it out; your own lookups go first when it ends.`,
        cardNote: fromSpotify
          ? 'If Spotify is still limiting, the pause comes back.'
          : 'If Spotify is still limiting, the pause comes back, longer.',
        whose: fromSpotify ? 'Spotify’s' : 'SYNCHRO.S’s guess',
        setOffBy: setOffBy(rl),
        dialogSentence: fromSpotify
          ? `Spotify said how long to wait (${lengthWords(total)}), and SYNCHRO.S obeys that exactly: waiting is how the limit lifts. Searches and downloads carry on meanwhile.`
          : `Spotify didn’t say how long to wait, so SYNCHRO.S guessed ${lengthWords(total)}${doubles}. Searches and downloads carry on meanwhile.`,
      };
    }
  }
  const cooldown = Math.max(0, (status?.post_ban_cooldown ?? 0) - elapsedSeconds);
  if (cooldown > 0) {
    const t = formatWait(cooldown);
    const body = `Anything you do yourself uses it now. Background jobs wait ${t} more, then SYNCHRO.S spaces its calls out for a quarter of an hour so the backlog trickles in instead of setting off another pause.`;
    return {
      kind: 'easing',
      fromSpotify: false,
      remainingSeconds: cooldown,
      timeLeft: t,
      timeLeftExact: formatWaitExact(cooldown),
      backAt: null,
      short: `Spotify easing back in · ${t}`,
      sentence: `Spotify is back. Background jobs wait ${t} more`,
      detail:
        'What you do uses Spotify again now. Enrichment, scans and auto-sync wait, then start slowly so the pause doesn’t come back.',
      title: 'Spotify is back',
      tone: 'info',
      tag: `Easing back in · ${t}`,
      tileTag: 'Easing back in',
      body,
      bodyNarrow: body,
      bodyMember: body,
      tryAgainNote: null,
      cardSentence: `Spotify is back. Background jobs wait ${t} more, then ease back in slowly; your own lookups use it now.`,
      cardNote: null,
      whose: '',
      setOffBy: '',
      dialogSentence: '',
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
