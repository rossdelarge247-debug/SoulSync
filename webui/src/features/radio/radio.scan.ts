/**
 * Scan now's words, worked out with no DOM: the button (enabled, or disabled
 * with its reason) and the result in its four states (Listening…, the track
 * it found, Not found, Failed). Shared by the player's radio mode, the phone
 * sheet and the station page's Now playing card.
 */

import type { RadioSessionState, ScanResult } from './radio.types';

export const SCAN_LABEL = 'Scan now';

export interface ScanButton {
  label: string;
  disabled: boolean;
  /** Why it's disabled, in words; null when it can be pressed. */
  reason: string | null;
  busy: boolean;
}

export function scanButton(st: RadioSessionState | null): ScanButton {
  if (!st?.station || st.status !== 'playing' || !st.sessionId) {
    return {
      label: SCAN_LABEL,
      disabled: true,
      reason: 'Play the station first: Scan now listens to what’s playing.',
      busy: false,
    };
  }
  if (st.scanStarting || st.scan?.state === 'listening') {
    return { label: 'Listening…', disabled: true, reason: 'A scan is listening', busy: true };
  }
  const avail = st.nowPlaying?.scan;
  if (avail && !avail.available) {
    return {
      label: SCAN_LABEL,
      disabled: true,
      reason: avail.reason || 'Scan now isn’t available',
      busy: false,
    };
  }
  return { label: SCAN_LABEL, disabled: false, reason: null, busy: false };
}

export type ScanAction = 'add' | 'adding_disabled' | 'in_library' | 'below_target' | 'on_wanted';

export interface ScanPanel {
  state: ScanResult['state'];
  title: string;
  line: string;
  /** "Found by AudD · Scan now", or the provider note under a Not found. */
  note: string;
  tone: 'info' | 'success' | 'neutral' | 'danger';
  /** 0–1 while listening. */
  progress: number | null;
  action: ScanAction | null;
  /** What a screen reader hears when the state changes. */
  announce: string;
}

/** The scan's answer, or the refusal before it started; null when there's nothing to show. */
export function scanPanel(
  scan: ScanResult | null | undefined,
  error?: string | null,
  starting?: boolean,
): ScanPanel | null {
  if (error) {
    return {
      state: 'failed',
      title: 'Couldn’t scan',
      line: error,
      note: '',
      tone: 'danger',
      progress: null,
      action: null,
      announce: `Couldn’t scan. ${error}`,
    };
  }
  if (starting && !scan) {
    return {
      state: 'listening',
      title: 'Listening…',
      line: 'Starting the scan',
      note: '',
      tone: 'info',
      progress: 0,
      action: null,
      announce: 'Listening to the station for about ten seconds.',
    };
  }
  if (!scan) return null;
  if (scan.state === 'listening') {
    const identifying = scan.phase === 'identifying';
    return {
      state: 'listening',
      title: identifying ? 'Identifying…' : 'Listening…',
      line: identifying
        ? `Asking ${scan.trying_label ?? 'the identification services'}`
        : `Capturing ${scan.capture_seconds} seconds · ${Math.max(0, scan.seconds_left)} s left`,
      note: '',
      tone: 'info',
      progress: identifying ? 1 : Math.max(0, Math.min(1, scan.progress)),
      action: null,
      announce: identifying
        ? 'Identifying what was captured.'
        : 'Listening to the station for about ten seconds.',
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
    const note = `Found by ${scan.source_label ?? 'Scan now'} · Scan now`;
    return {
      state: 'identified',
      title: scan.track.title,
      line: [scan.track.artist, scan.track.release].filter(Boolean).join(' · '),
      note,
      tone: 'success',
      progress: null,
      action,
      announce: `Identified: ${scan.track.title} by ${scan.track.artist}. Found by ${scan.source_label ?? 'Scan now'}.`,
    };
  }
  if (scan.state === 'not_found') {
    const line = scan.reason || 'Couldn’t identify this — DJ mixes and talk often can’t be.';
    return {
      state: 'not_found',
      title: 'Not found',
      line,
      note: scan.provider_error ? scan.provider_error.message : '',
      tone: 'neutral',
      progress: null,
      action: null,
      announce: line,
    };
  }
  const line = scan.reason || 'The scan didn’t finish. Try again.';
  return {
    state: 'failed',
    title: 'Couldn’t scan',
    line,
    note: '',
    tone: 'danger',
    progress: null,
    action: null,
    announce: `Couldn’t scan. ${line}`,
  };
}
