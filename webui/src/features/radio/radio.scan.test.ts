import { describe, expect, it } from 'vitest';

import type { RadioSessionState, ScanResult } from './radio.types';

import { scanAnswer, scanButton, scanPanel, scanWaitSeconds, serviceList } from './radio.scan';

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

describe('Scan now’s control (11a)', () => {
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

  it('says Listening… then Identifying… while it runs, one at a time', () => {
    expect(scanButton(session({ scanStarting: true }))).toMatchObject({
      label: 'Listening…',
      busy: true,
      disabled: true,
      phase: 'listening',
    });
    expect(scanButton(session({ scan: scan() }))).toMatchObject({ phase: 'listening' });
    expect(
      scanButton(session({ scan: scan({ phase: 'identifying', trying: 'audd' }) })),
    ).toMatchObject({ label: 'Identifying…', phase: 'identifying', busy: true });
  });

  it('reads "Scan again" after a scan, whatever it found', () => {
    expect(scanButton(session()).label).toBe('Scan now');
    expect(scanButton(session({ scan: scan({ state: 'not_found' }) })).label).toBe('Scan again');
    expect(scanButton(session({ scanError: 'Busy.' })).label).toBe('Scan again');
    expect(scanButton(session({ scan: scan({ state: 'not_found' }) })).disabled).toBe(false);
  });

  it('waits out the per-minute limit with the wait written out', () => {
    const now = 1_000_000;
    const st = session({ scan: scan({ state: 'not_found' }), scanWaitUntil: now + 39_200 });
    expect(scanWaitSeconds(st, now)).toBe(40);
    expect(scanButton(st, now)).toMatchObject({
      label: 'Scan again',
      disabled: true,
      reason: 'Scan now can run again in 40 s (three a minute).',
    });
    expect(scanButton(st, now + 40_000).disabled).toBe(false);
  });
});

describe('the scan in the track’s place (11a, 11b)', () => {
  it('capturing: the title says how long, with the progress', () => {
    const p = scanPanel(scan({ seconds_left: 6, progress: 0.4 }))!;
    expect(p).toMatchObject({
      state: 'listening',
      title: 'Capturing 10 seconds · 6 s left',
      progress: 0.4,
      line: '',
    });
    expect(p.strip).toBe('Capturing 10 seconds · 6 s left');
    // starting (before the server answers) looks the same at once
    expect(scanPanel(null, null, true)!.title).toBe('Capturing 10 seconds · 10 s left');
  });

  it('identifying: who is being asked, and who had no match', () => {
    const p = scanPanel(
      scan({
        phase: 'identifying',
        trying: 'audd',
        trying_label: 'AudD',
        asked: ['acoustid', 'audd'],
      }),
    )!;
    expect(p).toMatchObject({
      state: 'identifying',
      title: 'Identifying…',
      line: 'Asking AudD · AcoustID had no match',
      progress: null,
    });
    expect(p.strip).toBe('Identifying… · Asking AudD (AcoustID had no match)');
    expect(
      scanPanel(
        scan({
          phase: 'identifying',
          trying: 'acoustid',
          trying_label: 'AcoustID',
          asked: ['acoustid'],
        }),
      )!.line,
    ).toBe('Asking AcoustID');
  });

  it('found: the track with its source phrase, never a second tag', () => {
    const p = scanPanel(
      scan({
        state: 'identified',
        track: { artist: 'Marrow Field', title: 'Glasshouse', release: 'Glasshouse EP' },
        source: 'scan_audd',
        source_label: 'AudD',
        heard_id: 9,
      }),
    )!;
    expect(p).toMatchObject({
      state: 'identified',
      title: 'Glasshouse',
      line: 'Marrow Field · Glasshouse EP',
      note: 'found by AudD · Scan now',
      action: 'add',
    });
  });

  it('not found: says what was asked', () => {
    const p = scanPanel(scan({ state: 'not_found', asked: ['acoustid', 'audd'] }))!;
    expect(p.title).toBe('Couldn’t identify this');
    expect(p.line).toBe('DJ mixes and talk often can’t be · asked AcoustID and AudD');
    expect(p.strip).toBe(
      'Couldn’t identify this — DJ mixes and talk often can’t be. Asked AcoustID and AudD.',
    );
    expect(p.danger).toBe(false);
  });

  it('failed: names the service and who can fix it, in the danger colour', () => {
    const p = scanPanel(
      scan({
        state: 'failed',
        asked: ['acoustid', 'audd'],
        provider_error: { provider: 'audd', label: 'AudD', kind: 'out_of_credit', message: 'x' },
      }),
      null,
      false,
      ['acoustid', 'audd'],
    )!;
    expect(p).toMatchObject({
      state: 'failed',
      title: 'Scan didn’t work',
      danger: true,
      settingsLink: true,
    });
    expect(p.line).toBe(
      'AudD has no requests left this month · an admin can fix it in Settings → Radio',
    );
    expect(p.strip).toBe(
      'Scan didn’t work: AudD has no requests left this month. AcoustID had no match.',
    );
    expect(p.stripMore).toBe(
      'An admin can check Settings → Radio; until then scans use AcoustID alone.',
    );
    const key = scanPanel(
      scan({
        state: 'failed',
        asked: ['audd'],
        provider_error: { provider: 'audd', label: 'AudD', kind: 'bad_key', message: 'x' },
      }),
    )!;
    expect(key.line).toBe('AudD refused the key · an admin can fix it in Settings → Radio');
    const offline = scanPanel(
      scan({
        state: 'failed',
        asked: ['audd'],
        provider_error: { provider: 'audd', label: 'AudD', kind: 'offline', message: 'x' },
      }),
    )!;
    expect(offline.line).toBe('AudD didn’t answer · try again in a minute');
    expect(offline.settingsLink).toBe(false);
  });

  it('a refusal before it started is Failed with the server’s words', () => {
    const p = scanPanel(null, 'Two scans are already listening on this server.')!;
    expect(p).toMatchObject({ state: 'failed', title: 'Scan didn’t work', danger: true });
  });

  it('nothing to show without a scan', () => {
    expect(scanPanel(null)).toBeNull();
  });

  it('the answer reads as Now playing, with the scan’s source', () => {
    expect(scanAnswer(scan())).toBeNull();
    const np = scanAnswer(
      scan({
        state: 'identified',
        track: { artist: 'Marrow Field', title: 'Glasshouse', release: null },
        source: 'scan_audd',
        finished_at: 100,
        heard_id: 9,
      }),
    )!;
    expect(np).toMatchObject({
      state: 'identified',
      source: 'scan_audd',
      identified_at: 100,
      heard_id: 9,
    });
  });

  it('lists services the way the sentences say them', () => {
    expect(serviceList(['acoustid'])).toBe('AcoustID');
    expect(serviceList(['acoustid', 'audd', 'acrcloud'])).toBe('AcoustID, AudD and ACRCloud');
  });
});
