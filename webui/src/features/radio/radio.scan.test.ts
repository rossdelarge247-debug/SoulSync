import { describe, expect, it } from 'vitest';

import type { RadioSessionState, ScanResult } from './radio.types';

import { scanButton, scanPanel } from './radio.scan';

function scan(over: Partial<ScanResult> = {}): ScanResult {
  return {
    scan_id: 'sc1',
    station_id: 'nts-1',
    state: 'listening',
    phase: 'capturing',
    trying: null,
    trying_label: null,
    progress: 0.3,
    capture_seconds: 10,
    seconds_left: 7,
    track: null,
    source: null,
    source_label: null,
    heard_id: null,
    library: null,
    on_wanted: false,
    reason: null,
    provider_error: null,
    asked: [],
    started_at: 1,
    finished_at: null,
    now: 2,
    ...over,
  };
}

function session(over: Partial<RadioSessionState> = {}): RadioSessionState {
  return {
    status: 'playing',
    station: { id: 'nts-1', name: 'NTS 1' } as RadioSessionState['station'],
    sessionId: 's1',
    mode: 'relay',
    stream: null,
    nowPlaying: null,
    error: null,
    skew: 0,
    adding: false,
    ...over,
  };
}

describe('Scan now’s button', () => {
  it('is disabled with a reason when nothing is playing', () => {
    expect(scanButton(null)).toMatchObject({ disabled: true, label: 'Scan now' });
    expect(scanButton(session({ status: 'starting' })).reason).toMatch(/Play the station first/);
  });

  it('is disabled with the server’s reason when no service is set up', () => {
    const st = session({
      nowPlaying: {
        scan: { available: false, reason: 'No identification service is set up.', services: [] },
      } as unknown as RadioSessionState['nowPlaying'],
    });
    expect(scanButton(st)).toMatchObject({
      disabled: true,
      reason: 'No identification service is set up.',
    });
  });

  it('says Listening… while a scan runs, and can be pressed otherwise', () => {
    expect(scanButton(session({ scan: scan() }))).toMatchObject({
      busy: true,
      disabled: true,
      label: 'Listening…',
    });
    expect(scanButton(session())).toMatchObject({ disabled: false, reason: null });
  });
});

describe('Scan now’s result', () => {
  it('counts down while capturing, then says who it is asking', () => {
    expect(scanPanel(scan())).toMatchObject({
      title: 'Listening…',
      line: 'Capturing 10 seconds · 7 s left',
      progress: 0.3,
    });
    expect(scanPanel(scan({ phase: 'identifying', trying_label: 'AudD' }))).toMatchObject({
      title: 'Identifying…',
      line: 'Asking AudD',
    });
  });

  it('names the track, the service that found it and the one action', () => {
    const found = scan({
      state: 'identified',
      track: { artist: 'Tidewater', title: 'Night Ferry', release: 'Dub' },
      source: 'scan_audd',
      source_label: 'AudD',
      heard_id: 4,
      library: { in_library: false, below_target: null, track_id: null },
    });
    expect(scanPanel(found)).toMatchObject({
      title: 'Night Ferry',
      line: 'Tidewater · Dub',
      note: 'Found by AudD · Scan now',
      action: 'add',
    });
    expect(
      scanPanel({ ...found, library: { in_library: true, below_target: false, track_id: '1' } })
        ?.action,
    ).toBe('in_library');
    expect(
      scanPanel({ ...found, library: { in_library: true, below_target: true, track_id: '1' } })
        ?.action,
    ).toBe('below_target');
    expect(scanPanel({ ...found, on_wanted: true })?.action).toBe('on_wanted');
    expect(scanPanel({ ...found, heard_id: null })?.action).toBe('adding_disabled');
  });

  it('is calm when nothing matched and plain when it failed', () => {
    expect(scanPanel(scan({ state: 'not_found', reason: null }))).toMatchObject({
      title: 'Not found',
      line: 'Couldn’t identify this — DJ mixes and talk often can’t be.',
      tone: 'neutral',
    });
    expect(
      scanPanel(
        scan({
          state: 'failed',
          reason: 'AudD refused the key. An admin can check it in Settings → Radio.',
        }),
      ),
    ).toMatchObject({ title: 'Couldn’t scan', tone: 'danger' });
    expect(scanPanel(null, 'That’s 3 scans in a minute. Try again in 20 s.')?.line).toMatch(
      /3 scans in a minute/,
    );
    expect(scanPanel(null)).toBeNull();
  });
});
