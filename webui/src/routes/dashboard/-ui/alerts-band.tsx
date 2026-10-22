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

  useServiceStatusEvent(useCallback((p) => setPayload(p), []));
  useEffect(() => {
    let cancelled = false;
    void fetchServiceStatus().then((p) => {
      if (!cancelled && p) setPayload(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const alerts = serviceAlerts(payload);
  if (alerts.length === 0) return null;

  return (
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
  );
}
