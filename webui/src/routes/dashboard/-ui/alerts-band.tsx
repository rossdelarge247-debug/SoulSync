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
 * Data: the same /status payload + ss:service-status push the sidebar dots
 * use; health semantics come from -dash.services' differentially-tested card
 * views via -dash.alerts.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/form';
import { Notice } from '@/components/primitives';
import {
  canClearSpotifyPause,
  clearSpotifyPause,
  TRY_AGAIN_NOTE,
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
  const [retryState, setRetryState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [retryError, setRetryError] = useState<string | null>(null);

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

  const alerts = serviceAlerts(payload, Math.max(0, now - receivedAt) / 1000);
  const pause = alerts.find((a) => a.spotifyPause)?.spotifyPause ?? null;
  const ticking = pause !== null;
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  if (alerts.length === 0) return null;

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
    const fresh = await fetchServiceStatus();
    if (fresh) accept(fresh);
  };
  const showTryAgain = pause !== null && canClearSpotifyPause();

  return (
    <Notice
      className="dash-alerts"
      data-card="alerts"
      // a live countdown in an alert region would be read out every second
      role={pause ? 'note' : 'alert'}
      tone={alerts.some((a) => a.severity === 'error') ? 'danger' : 'warning'}
      title={title(alerts)}
      actions={
        <>
          {showTryAgain && (
            <Button size="lg" disabled={retryState === 'busy'} onClick={() => void tryAgain()}>
              Try again now
            </Button>
          )}
          <Button size="lg" onClick={() => void window.navigateToPage?.('settings')}>
            Open Settings
          </Button>
        </>
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
      {showTryAgain && (
        <p className="dash-alert-note" aria-live="polite">
          {retryError ??
            (retryState === 'done' ? 'Pause cleared. Trying Spotify again.' : TRY_AGAIN_NOTE)}
        </p>
      )}
    </Notice>
  );
}
