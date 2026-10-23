/** The Alerts band's pure core — fires exactly when the retired Services
 *  card's indicators left 'connected', via the same -dash.services views. */

import { describe, expect, it } from 'vitest';

import type { ServiceStatusPayload } from './-dash.api';

import { serviceAlerts } from './-dash.alerts';

const HEALTHY = {
  metadata_source: { source: 'spotify', connected: true },
  spotify: { authenticated: true },
  media_server: { connected: true },
  soulseek: { connected: true },
} as unknown as ServiceStatusPayload;

describe('serviceAlerts', () => {
  it('is silent before the first payload and while healthy', () => {
    expect(serviceAlerts(null)).toEqual([]);
    expect(serviceAlerts(HEALTHY)).toEqual([]);
  });

  it('fires one row per disconnected core service', () => {
    const alerts = serviceAlerts({
      ...HEALTHY,
      media_server: { connected: false },
      soulseek: { connected: false },
    } as unknown as ServiceStatusPayload);
    expect(alerts.map((a) => a.key)).toEqual(['server', 'download']);
    expect(alerts[0].detail).toBe('Disconnected');
    expect(alerts.every((a) => a.severity === 'warn')).toBe(true);
  });

  it('a chosen server that was never set up is no library chosen, not disconnected', () => {
    const alerts = serviceAlerts({
      ...HEALTHY,
      media_server: { connected: false, type: 'plex', configured: false },
    } as unknown as ServiceStatusPayload);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: 'server',
      severity: 'warn',
      line: 'No library chosen',
      advice:
        'Downloads won’t show in your library until you choose where it lives. Go to Settings → ' +
        'Connections → Server Connections and choose Standalone, or connect Plex, Jellyfin or Navidrome.',
    });
    expect(alerts[0].detail).not.toBe('Disconnected');
  });

  it('a set-up server that is down, or an older payload, still says disconnected', () => {
    for (const media_server of [{ connected: false, configured: true }, { connected: false }]) {
      const alerts = serviceAlerts({ ...HEALTHY, media_server } as unknown as ServiceStatusPayload);
      expect(alerts.map((a) => [a.label, a.detail, a.line])).toEqual([
        ['Media Server', 'Disconnected', undefined],
      ]);
    }
  });

  it('a rate-limited Spotify is attention-worthy too, with the countdown', () => {
    const alerts = serviceAlerts({
      ...HEALTHY,
      spotify: {
        authenticated: true,
        rate_limited: true,
        rate_limit: { remaining_seconds: 120 },
      },
    } as unknown as ServiceStatusPayload);
    expect(alerts.map((a) => a.key)).toEqual(['metadata']);
    expect(alerts[0].detail).toBe('Spotify paused · 2 min');
    // the headline says why and whose number it is
    expect(alerts[0].line).toBe('Paused Spotify for 2 min to be safe');
    expect(alerts[0].advice).toContain('SYNCHRO.S’s estimate');
  });

  it('a Spotify pause counts down from when the payload arrived', () => {
    const payload = {
      ...HEALTHY,
      spotify: {
        authenticated: true,
        rate_limited: true,
        rate_limit: {
          remaining_seconds: 720,
          source: 'spotify',
          trigger: "checking an artist's albums",
        },
      },
    } as unknown as ServiceStatusPayload;
    expect(serviceAlerts(payload)[0].line).toBe(
      "Spotify asked us to wait 12 min (after checking an artist's albums)",
    );
    expect(serviceAlerts(payload, 125)[0].line).toBe(
      "Spotify asked us to wait 9 min 55 s (after checking an artist's albums)",
    );
    expect(serviceAlerts(payload, 125)[0].advice).toContain('That time came from Spotify');
  });

  it('a payload with no metadata source at all alerts as disconnected', () => {
    const alerts = serviceAlerts({
      ...HEALTHY,
      metadata_source: {},
      spotify: {},
    } as unknown as ServiceStatusPayload);
    expect(alerts.map((a) => a.key)).toEqual(['metadata']);
    expect(alerts[0].detail).toBe('Disconnected');
  });
});
