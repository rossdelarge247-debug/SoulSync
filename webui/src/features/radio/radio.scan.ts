/**
 * Scan now's words, worked out with no DOM (boards 11a, 11b; HANDOFF 58):
 * the one control ("Scan now" before, "Scan again" after, "Listening…" /
 * "Identifying…" while it runs, disabled with its reason), and the scan in
 * the track's place: capturing with its progress, identifying with the
 * service being asked, the answer with its source phrase, not found, failed.
 * Shared by the player's bar, the phone sheet and the station page's strip.
 *
 * There's no Done: an answer lives as long as a track the station named,
 * until the station names the next one, the next scan, or Stop
 * (src/shell/radio-session.ts).
 */

import type { NowPlaying, RadioSessionState, ScanResult, ScanService } from './radio.types';

export const SCAN_LABEL = 'Scan now';
export const SCAN_AGAIN = 'Scan again';

/** The server's limit (core/internet_radio/scan.py PER_PROFILE_PER_MINUTE). */
const PER_MINUTE_WORDS = 'three a minute';

export const SERVICE_LABELS: Record<ScanService, string> = {
  acoustid: 'AcoustID',
  audd: 'AudD',
  acrcloud: 'ACRCloud',
};

/** "AcoustID", "AcoustID and AudD", "AcoustID, AudD and ACRCloud". */
export function serviceList(services: readonly ScanService[], joiner = 'and'): string {
  const names = services.map((s) => SERVICE_LABELS[s] ?? s);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`;
}

export interface ScanButton {
  label: string;
  disabled: boolean;
  /** Why it's disabled, in words; null when it can be pressed. */
  reason: string | null;
  busy: boolean;
  /** While it runs: a pulsing icon for listening, a spinner for identifying. */
  phase: 'listening' | 'identifying' | null;
}

/** Seconds until the per-minute limit lets another scan start; 0 when it can. */
export function scanWaitSeconds(
  st: Pick<RadioSessionState, 'scanWaitUntil'> | null,
  nowMs = Date.now(),
): number {
  const until = st?.scanWaitUntil;
  return until ? Math.max(0, Math.ceil((until - nowMs) / 1000)) : 0;
}

/** "Scan now can run again in 40 s (three a minute)." */
export function scanWaitWords(seconds: number): string {
  return `Scan now can run again in ${seconds} s (${PER_MINUTE_WORDS}).`;
}

export function scanButton(st: RadioSessionState | null, nowMs = Date.now()): ScanButton {
  if (!st?.station || st.status !== 'playing' || !st.sessionId) {
    return {
      label: SCAN_LABEL,
      disabled: true,
      reason: 'Play the station first: Scan now listens to what’s playing.',
      busy: false,
      phase: null,
    };
  }
  if (st.scanStarting || st.scan?.state === 'listening') {
    const identifying = !st.scanStarting && st.scan?.phase === 'identifying';
    return {
      label: identifying ? 'Identifying…' : 'Listening…',
      disabled: true,
      reason: 'A scan is running; one at a time.',
      busy: true,
      phase: identifying ? 'identifying' : 'listening',
    };
  }
  const label = st.scan || st.scanError ? SCAN_AGAIN : SCAN_LABEL;
  const avail = st.nowPlaying?.scan;
  if (avail && !avail.available) {
    return {
      label,
      disabled: true,
      reason: avail.reason || 'Scan now isn’t available',
      busy: false,
      phase: null,
    };
  }
  const wait = scanWaitSeconds(st, nowMs);
  if (wait > 0) {
    return { label, disabled: true, reason: scanWaitWords(wait), busy: false, phase: null };
  }
  return { label, disabled: false, reason: null, busy: false, phase: null };
}

export type ScanAction = 'add' | 'adding_disabled' | 'in_library' | 'below_target' | 'on_wanted';

export interface ScanPanel {
  state: 'listening' | 'identifying' | 'identified' | 'not_found' | 'failed';
  /** The track block's title: "Capturing 10 seconds · 6 s left", "Identifying…", the track. */
  title: string;
  /** The track block's meta line ('' while capturing: the bar is drawn there). */
  line: string;
  /** Failed puts its line in the danger colour. */
  danger: boolean;
  /** "found by AudD · Scan now" for an answer; '' otherwise. */
  note: string;
  /** 0–1 while capturing; null otherwise. */
  progress: number | null;
  action: ScanAction | null;
  /** What a screen reader hears when the state changes. */
  announce: string;
  /** The station page's strip (11b): the line, and a second one for Failed. */
  strip: string;
  stripMore: string | null;
  /** The second line points at Settings → Radio (a link for admins). */
  settingsLink: boolean;
}

interface Failure {
  /** "AudD refused the key" */
  what: string;
  /** For the bar: "an admin can fix it in Settings → Radio", "try again in a minute". */
  who: string;
  /** An admin can fix it in Settings → Radio. */
  admin: boolean;
}

function failure(label: string, kind: string): Failure {
  switch (kind) {
    case 'bad_key':
      return {
        what: `${label} refused the key`,
        who: 'an admin can fix it in Settings → Radio',
        admin: true,
      };
    case 'out_of_credit':
      return {
        what: `${label} has no requests left this month`,
        who: 'an admin can fix it in Settings → Radio',
        admin: true,
      };
    case 'rate_limited':
      return {
        what: `${label} is getting too many requests`,
        who: 'try again in a minute',
        admin: false,
      };
    case 'offline':
      return { what: `${label} didn’t answer`, who: 'try again in a minute', admin: false };
    case 'bad_audio':
      return { what: `${label} couldn’t read the clip`, who: 'try again', admin: false };
    default:
      return {
        what: `${label} answered with an error`,
        who: 'try again in a minute',
        admin: false,
      };
  }
}

function sentenceCase(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** The services asked before the one being asked now (they had no match). */
function askedBefore(scan: ScanResult): ScanService[] {
  return (scan.asked ?? []).filter((s) => s !== scan.trying);
}

/**
 * The scan in the track's place, or the refusal before it started; null when
 * there's nothing to show. `services` are the ones a scan asks, in order
 * (now playing's `scan.services`), for Failed's "until then scans use …".
 */
export function scanPanel(
  scan: ScanResult | null | undefined,
  error?: string | null,
  starting?: boolean,
  services: readonly ScanService[] = [],
): ScanPanel | null {
  if (starting) {
    const title = 'Capturing 10 seconds · 10 s left';
    return {
      state: 'listening',
      title,
      line: '',
      danger: false,
      note: '',
      progress: 0,
      action: null,
      announce: 'Listening to the station for about ten seconds.',
      strip: title,
      stripMore: null,
      settingsLink: false,
    };
  }
  if (error) {
    return {
      state: 'failed',
      title: 'Scan didn’t work',
      line: error,
      danger: true,
      note: '',
      progress: null,
      action: null,
      announce: `Scan didn’t work. ${error}`,
      strip: `Scan didn’t work. ${error}`,
      stripMore: null,
      settingsLink: false,
    };
  }
  if (!scan) return null;
  if (scan.state === 'listening') {
    if (scan.phase === 'identifying') {
      const before = askedBefore(scan);
      const asking = scan.trying_label ?? 'the identification services';
      const noMatch = before.length ? `${serviceList(before)} had no match` : '';
      return {
        state: 'identifying',
        title: 'Identifying…',
        line: [`Asking ${asking}`, noMatch].filter(Boolean).join(' · '),
        danger: false,
        note: '',
        progress: null,
        action: null,
        announce: 'Identifying what was captured.',
        strip: `Identifying… · Asking ${asking}${noMatch ? ` (${noMatch})` : ''}`,
        stripMore: null,
        settingsLink: false,
      };
    }
    const title = `Capturing ${scan.capture_seconds} seconds · ${Math.max(0, scan.seconds_left)} s left`;
    return {
      state: 'listening',
      title,
      line: '',
      danger: false,
      note: '',
      progress: Math.max(0, Math.min(1, scan.progress)),
      action: null,
      announce: 'Listening to the station for about ten seconds.',
      strip: title,
      stripMore: null,
      settingsLink: false,
    };
  }
  if (scan.state === 'identified' && scan.track) {
    const lib = scan.library;
    const action: ScanAction =
      lib?.in_library && lib.below_target
        ? 'below_target'
        : lib?.in_library
          ? 'in_library'
          : scan.on_wanted
            ? 'on_wanted'
            : scan.heard_id
              ? 'add'
              : 'adding_disabled';
    const by = scan.source_label ?? 'Scan now';
    return {
      state: 'identified',
      title: scan.track.title,
      line: [scan.track.artist, scan.track.release].filter(Boolean).join(' · '),
      danger: false,
      note: `found by ${by} · Scan now`,
      progress: null,
      action,
      announce: `Identified: ${scan.track.title} by ${scan.track.artist}. Found by ${by}.`,
      strip:
        'Scan now found this. Scan again if the station has moved on; its own feed replaces the answer when it next names a track.',
      stripMore: null,
      settingsLink: false,
    };
  }
  const asked = serviceList(scan.asked ?? []);
  if (scan.state === 'not_found') {
    const perr = scan.provider_error;
    const also = perr ? ` ${sentenceCase(failure(perr.label, perr.kind).what)}.` : '';
    return {
      state: 'not_found',
      title: 'Couldn’t identify this',
      line: ['DJ mixes and talk often can’t be', asked ? `asked ${asked}` : '']
        .filter(Boolean)
        .join(' · '),
      danger: false,
      note: '',
      progress: null,
      action: null,
      announce: 'Couldn’t identify this. DJ mixes and talk often can’t be.',
      strip: `Couldn’t identify this — DJ mixes and talk often can’t be.${asked ? ` Asked ${asked}.` : ''}${also}`,
      stripMore: null,
      settingsLink: false,
    };
  }
  const perr = scan.provider_error;
  if (perr) {
    const f = failure(perr.label, perr.kind);
    const others = (scan.asked ?? []).filter((s) => s !== perr.provider);
    const left = services.filter((s) => s !== perr.provider);
    return {
      state: 'failed',
      title: 'Scan didn’t work',
      line: `${f.what} · ${f.who}`,
      danger: true,
      note: '',
      progress: null,
      action: null,
      announce: `Scan didn’t work. ${sentenceCase(f.what)}.`,
      strip: `Scan didn’t work: ${f.what}.${others.length ? ` ${serviceList(others)} had no match.` : ''}`,
      stripMore: f.admin
        ? `An admin can check Settings → Radio${left.length ? `; until then scans use ${serviceList(left)} alone` : ''}.`
        : `${sentenceCase(f.who)}.`,
      settingsLink: f.admin,
    };
  }
  const line = scan.reason || 'The scan didn’t finish. Try again.';
  return {
    state: 'failed',
    title: 'Scan didn’t work',
    line,
    danger: true,
    note: '',
    progress: null,
    action: null,
    announce: `Scan didn’t work. ${line}`,
    strip: `Scan didn’t work. ${line}`,
    stripMore: null,
    settingsLink: false,
  };
}

/**
 * A scan's answer as Now playing, so the bar and the station page's card
 * show it like a name the station gave (its source phrase says who found it).
 */
export function scanAnswer(scan: ScanResult | null | undefined): NowPlaying | null {
  if (scan?.state !== 'identified' || !scan.track) return null;
  return {
    station_id: scan.station_id,
    state: 'identified',
    track: { ...scan.track, art_url: null },
    source: scan.source,
    identified_at: scan.finished_at ?? scan.now,
    started_at: scan.started_at,
    reason: null,
    library: scan.library,
    on_wanted: scan.on_wanted,
    previous_title: null,
    now: scan.now,
    playing: true,
    heard_id: scan.heard_id,
  };
}
