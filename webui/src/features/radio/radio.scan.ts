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

import type {
  NowPlaying,
  RadioSessionState,
  ScanAvailability,
  ScanResult,
  ScanService,
} from './radio.types';

import { agoWords, nowLines, secondsSince, sourcePhrase } from './radio.format';

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

/**
 * The phone sheet's Now playing row (11d, 11e; HANDOFF 82): the label says
 * who named it ("Now playing · found by AudD", "Now playing · from the
 * station"), then the title and the line ("Marrow Field · Glasshouse EP ·
 * Scan now · 20 s ago"). A scan's answer is what Now playing shows while it
 * lasts.
 */
export function sheetNowPlaying(st: Pick<RadioSessionState, 'nowPlaying' | 'scan' | 'skew'>): {
  label: string;
  title: string;
  line: string;
  art: string | null;
  identified: boolean;
} {
  const answer = scanAnswer(st.scan);
  const np = answer ?? st.nowPlaying;
  if (np?.state === 'identified' && np.track) {
    const scanned = Boolean(np.source && np.source.startsWith('scan_'));
    const by = scanned
      ? `found by ${st.scan?.source_label ?? 'Scan now'}`
      : sourcePhrase(np.source);
    return {
      label: ['Now playing', by].filter(Boolean).join(' · '),
      title: np.track.title,
      line: [
        np.track.artist,
        np.track.release,
        scanned ? 'Scan now' : '',
        agoWords(secondsSince(np, st.skew)),
      ]
        .filter(Boolean)
        .join(' · '),
      art: np.track.art_url ?? null,
      identified: true,
    };
  }
  const lines = nowLines(np, st.skew);
  return {
    label: 'Now playing',
    title: lines.title,
    line: np?.reason || lines.line,
    art: null,
    identified: false,
  };
}

/**
 * The words under the sheet's Scan now (11d): while capturing, the seconds
 * and who will be asked ("Capturing 10 seconds · 6 s left · then AcoustID,
 * then AudD"); while identifying, who's being asked; not found and failed in
 * one line (failed in the danger colour); nothing once it found the track,
 * since the answer is Now playing.
 */
export function sheetScanWords(
  panel: ScanPanel | null,
  services: readonly ScanService[] = [],
): { text: string; danger: boolean } | null {
  if (!panel || panel.state === 'identified') return null;
  if (panel.state === 'listening') {
    const then = services.length
      ? ` · then ${services.map((s) => SERVICE_LABELS[s] ?? s).join(', then ')}`
      : '';
    return { text: `${panel.title}${then}`, danger: false };
  }
  if (panel.state === 'identifying') return { text: panel.line, danger: false };
  return { text: [panel.title, panel.line].filter(Boolean).join(' · '), danger: panel.danger };
}

/** "asks AcoustID, then AudD": the services a press asks, in order (15b). */
export function askWords(services: readonly ScanService[]): string {
  return services.length
    ? services.map((s) => SERVICE_LABELS[s] ?? s).join(', then ')
    : 'the identification services';
}

/** What each service calls its key. */
const KEY_WORDS: Record<ScanService, string> = {
  acoustid: 'its key',
  audd: 'its token',
  acrcloud: 'its keys',
};

export interface ScanTrouble {
  /** The station strip's line, said for everyone with the warning dot (15b). */
  strip: string;
  /** The phone sheet's one line under Scan now. */
  sheet: string;
  /** "Settings → Radio" is in the strip's line (a link for admins). */
  settingsLink: boolean;
}

/**
 * A service that's refused or out of requests, said for everyone where they
 * press Scan now (HANDOFF 87, board 15b): "AudD has no requests left this
 * month, so Scan now asks AcoustID alone, which knows fewer tracks. An admin
 * can add requests in Settings → Radio." null when every service set up is
 * fine (or the server didn't say).
 */
export function scanTrouble(avail: ScanAvailability | null | undefined): ScanTrouble | null {
  const states = avail?.states;
  if (!avail || !states) return null;
  const bad = (s: ScanService) => states[s] === 'refused' || states[s] === 'no_requests_left';
  const order: ScanService[] = ['acoustid', 'audd', 'acrcloud'];
  const troubled = order.filter(bad);
  if (!troubled.length) return null;
  const left = avail.services.filter((s) => !bad(s));
  const what = (s: ScanService) =>
    states[s] === 'refused'
      ? `${SERVICE_LABELS[s]} refused ${KEY_WORDS[s]}`
      : `${SERVICE_LABELS[s]} has no requests left this month`;
  const said = troubled.map(what);
  const head =
    said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
  const then = !left.length
    ? 'so Scan now has nothing left to ask'
    : left.length === 1
      ? `so Scan now asks ${SERVICE_LABELS[left[0]]} alone${left[0] === 'acoustid' ? ', which knows fewer tracks' : ''}`
      : `so Scan now asks ${askWords(left)} instead`;
  const onlyCredit = troubled.every((s) => states[s] === 'no_requests_left');
  const who =
    troubled.length > 1
      ? 'An admin can fix them in Settings → Radio.'
      : onlyCredit
        ? 'An admin can add requests in Settings → Radio.'
        : 'An admin can fix it in Settings → Radio.';
  const sheetHead = troubled.length === 1 ? said[0] : `${serviceList(troubled)} can’t be asked`;
  const sheetTail = !left.length
    ? 'nothing else to ask'
    : `${left.map((s) => SERVICE_LABELS[s]).join(' and ')} only`;
  return {
    strip: `${head}, ${then}. ${who}`,
    sheet: `${sheetHead}; ${sheetTail}.`,
    settingsLink: true,
  };
}

/**
 * Automatic AudD's state where it fits (the station strip, under the ready
 * sentence): its daily limit used up, said for everyone. A refused token or
 * no requests left is already the service's own line.
 */
export function autoAuddNote(avail: ScanAvailability | null | undefined): string | null {
  const auto = avail?.audd_auto;
  if (!auto?.on || auto.stopped !== 'cap_reached') return null;
  return 'AudD’s daily limit for listening automatically is used up, so tracks the station doesn’t name wait for Scan now until midnight.';
}

/** Our own logo route only (the server fetches and caches the station's logo). */
export function ownLogo(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^\/api\/radio\/stations\/[A-Za-z0-9-]+\/logo(\?|$)/.test(url)
    ? url
    : null;
}

/**
 * The Visuals overlay's header while a station plays: the identified track
 * over "artist · station" (a scan's answer while it lasts), or the station
 * over "Live · Listening…" while nothing is named. The art is the track's
 * own (https only, as on the station page), else the station's logo.
 */
export function radioVisualsHeader(
  st: Pick<RadioSessionState, 'station' | 'nowPlaying' | 'scan' | 'skew'>,
): { title: string; line: string; art: string | null } | null {
  const station = st.station;
  if (!station) return null;
  const np = scanAnswer(st.scan) ?? st.nowPlaying;
  const logo = ownLogo(station.logo_url);
  if (np?.state === 'identified' && np.track) {
    const art = np.track.art_url?.startsWith('https://') ? np.track.art_url : logo;
    return {
      title: np.track.title,
      line: [np.track.artist, station.name].filter(Boolean).join(' · '),
      art,
    };
  }
  return {
    title: station.name,
    line: ['Live', nowLines(np, st.skew).title].join(' · '),
    art: logo,
  };
}
