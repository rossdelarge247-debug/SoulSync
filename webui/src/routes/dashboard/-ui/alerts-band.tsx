/**
 * The Alerts band (data-card="alerts") — Home's exception surface. Renders
 * NOTHING while every core connection is healthy; when one isn't, a Notice
 * appears under the Home header with one line per problem and a jump to
 * Settings. It is the one place on the page that shouts when something needs
 * a human, so it sits above the targets rather than with the rest of the old
 * dashboard: a download source that's down is why a target can't search.
 *
 * The look is the design system's failure pattern (a Notice in the colour of
 * the problem: danger when a connection is in error, warning otherwise).
 *
 * A Spotify pause is its own Notice (board 12a, "Spotify pause"): the title
 * is the one fact and counts down, the sentence names the trigger, whose
 * number the time is and what still works; admins get Try again now with its
 * note, members "An admin can try again sooner." Warning while paused, info
 * while easing back in. It isn't a live region (it ticks); a change of state
 * is announced once.
 *
 * Data: the same /status payload + ss:service-status push the sidebar dots
 * use; health semantics come from -dash.services' differentially-tested card
 * views via -dash.alerts.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/form';
import { Notice } from '@/components/primitives';
import { DriveAwayNotice, awayRole } from '@/features/drives/drive-away-notice';
import { useDriveStatus } from '@/features/drives/drive-status';
import { MoveReminder } from '@/features/drives/move-reminder';
import {
  canClearSpotifyPause,
  clearSpotifyPause,
  MEMBER_TRY_AGAIN,
  type SpotifyPauseView,
} from '@/features/spotify-pause/spotify-pause';

import type { ServiceStatusPayload } from '../-dash.api';

import { serviceAlerts, type DashAlert } from '../-dash.alerts';
import { fetchServiceStatus } from '../-dash.api';
import { useServiceStatusEvent } from '../-dash.events';

/** "Media Server" → "Media server": the labels are the old cards' titles. */
function sentenceCase(label: string): string {
  const [first, ...rest] = label.split(' ');
  if (rest.length === 0) return label;
  return [
    first,
    ...rest.map((word) => (word === word.toUpperCase() ? word : word.toLowerCase())),
  ].join(' ');
}

function line(alert: DashAlert): string {
  return alert.line ?? `${sentenceCase(alert.label)}: ${alert.detail}`;
}

function title(alerts: DashAlert[]): string {
  if (alerts.length === 1) return line(alerts[0]);
  return 'Some of SYNCHRO.S’s connections need a look';
}

export function AlertsBand() {
  const [payload, setPayload] = useState<ServiceStatusPayload | null>(null);
  // when the payload arrived, and the clock, so a Spotify pause counts down
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const accept = useCallback((p: ServiceStatusPayload) => {
    const t = Date.now();
    setPayload(p);
    setReceivedAt(t);
    setNow(t);
  }, []);

  useServiceStatusEvent(accept);
  useEffect(() => {
    let cancelled = false;
    void fetchServiceStatus().then((p) => {
      if (!cancelled && p) accept(p);
    });
    return () => {
      cancelled = true;
    };
  }, [accept]);

  const all = serviceAlerts(payload, Math.max(0, now - receivedAt) / 1000);
  const pause = all.find((a) => a.spotifyPause)?.spotifyPause ?? null;
  const alerts = all.filter((a) => !a.spotifyPause);
  const ticking = pause !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  // "Your library's drive isn't connected" (14t) and the move's 7-day reminder (14i)
  const drive = useDriveStatus();
  const driveAway = awayRole(drive.status, 'home') !== null;
  const reminder = drive.status?.reminder ?? null;

  if (all.length === 0 && !driveAway && !reminder) return null;

  return (
    <>
      {driveAway && drive.status ? (
        <DriveAwayNotice
          status={drive.status}
          where="home"
          checking={drive.checking}
          onCheckAgain={() => void drive.checkNow()}
        />
      ) : null}
      {reminder && !driveAway ? <MoveReminder reminder={reminder} /> : null}
      {pause ? (
        <SpotifyPauseNotice
          pause={pause}
          onCleared={async () => {
            const fresh = await fetchServiceStatus();
            if (fresh) accept(fresh);
          }}
        />
      ) : null}
      {alerts.length > 0 ? (
        <Notice
          className="dash-alerts"
          data-card="alerts"
          role="alert"
          tone={alerts.some((a) => a.severity === 'error') ? 'danger' : 'warning'}
          title={title(alerts)}
          actions={
            <Button size="lg" onClick={() => void window.navigateToPage?.('settings')}>
              Open Settings
            </Button>
          }
        >
          {alerts.length === 1 ? (
            <p className="dash-alert-text">
              {alerts[0].advice ??
                'Anything that needs it waits until it’s back. Check the connection in Settings.'}
            </p>
          ) : (
            <ul className="dash-alert-list">
              {alerts.map((a) => (
                <li key={a.key} className={`dash-alert dash-alert--${a.severity}`}>
                  {line(a)}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      ) : null}
    </>
  );
}

/** The Spotify pause on Home (12a, and 12d on a phone). */
export function SpotifyPauseNotice({
  pause,
  onCleared,
}: {
  pause: SpotifyPauseView;
  onCleared?: () => void | Promise<void>;
}) {
  const [retryState, setRetryState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [retryError, setRetryError] = useState<string | null>(null);
  const admin = canClearSpotifyPause();
  const showTryAgain = pause.kind === 'paused' && admin;

  // the state, not the ticking time, is what a screen reader hears, once
  const stateWords =
    pause.kind === 'easing'
      ? 'Spotify is back. Background jobs ease back in.'
      : pause.fromSpotify
        ? 'Spotify asked SYNCHRO.S to wait.'
        : 'SYNCHRO.S paused Spotify to be safe.';
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setAnnounced(stateWords), 100);
    return () => window.clearTimeout(id);
  }, [stateWords]);

  const tryAgain = async () => {
    setRetryState('busy');
    setRetryError(null);
    const error = await clearSpotifyPause();
    if (error) {
      setRetryError(error);
      setRetryState('idle');
      return;
    }
    setRetryState('done');
    await onCleared?.();
  };

  return (
    <Notice
      className="dash-spotify-pause"
      data-card="alerts"
      data-pause={pause.kind === 'easing' ? 'easing' : pause.fromSpotify ? 'spotify' : 'estimate'}
      layout="stacked"
      // a live countdown in an alert region would be read out every second
      role="note"
      tone={pause.tone}
      title={<span className="dash-spotify-pause-title">{pause.title}</span>}
      actions={
        showTryAgain ? (
          <>
            <Button
              size="lg"
              disabled={retryState === 'busy'}
              focusableWhenDisabled
              onClick={() => void tryAgain()}
            >
              Try again now
            </Button>
            <span className="dash-alert-note" aria-live="polite">
              {retryError ??
                (retryState === 'done'
                  ? 'Pause cleared. Trying Spotify again.'
                  : pause.tryAgainNote)}
            </span>
          </>
        ) : undefined
      }
    >
      {admin && pause.kind === 'paused' ? (
        pause.body === pause.bodyNarrow ? (
          <p>{pause.body}</p>
        ) : (
          <>
            <p className="dash-spotify-pause-wide">{pause.body}</p>
            <p className="dash-spotify-pause-narrow">{pause.bodyNarrow}</p>
          </>
        )
      ) : (
        <p data-member={pause.kind === 'paused' ? MEMBER_TRY_AGAIN : undefined}>
          {pause.bodyMember}
        </p>
      )}
      <span className="dash-sr" aria-live="polite">
        {announced}
      </span>
    </Notice>
  );
}
