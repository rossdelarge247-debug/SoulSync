import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RadioSessionApi, RadioSessionState, ScanResult } from '@/features/radio/radio.types';

import { ScanStrip } from './station-page';

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
    scan: null,
    scanError: null,
    scanStarting: false,
    ...over,
  };
}

const BASE: ScanResult = {
  scan_id: 'sc1',
  station_id: 'nts-1',
  state: 'listening',
  phase: 'capturing',
  trying: null,
  trying_label: null,
  progress: 0.5,
  capture_seconds: 10,
  seconds_left: 5,
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
};

function api(): RadioSessionApi {
  const a: RadioSessionApi = {
    state: () => session(),
    play: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    addToWanted: vi.fn(),
    refresh: vi.fn(),
    scanNow: vi.fn(async () => undefined),
    addScanToWanted: vi.fn(async () => true),
    dismissScan: vi.fn(),
  };
  window.SoulSyncRadio = a;
  return a;
}

describe('the station page’s Scan now strip', () => {
  afterEach(() => {
    window.SoulSyncRadio = undefined;
  });

  it('is disabled with its reason when the station isn’t playing here', () => {
    api();
    render(<ScanStrip session={session({ status: 'idle' })} playingHere={false} />);
    const button = screen.getByRole('button', { name: /Scan now/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('scan-strip')).toHaveTextContent('Play the station first');
  });

  it('starts a scan, then counts down in a live region', () => {
    const a = api();
    const { rerender } = render(<ScanStrip session={session()} playingHere />);
    fireEvent.click(screen.getByRole('button', { name: /Scan now/ }));
    expect(a.scanNow).toHaveBeenCalled();
    rerender(<ScanStrip session={session({ scan: BASE })} playingHere />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Listening…');
    expect(status).toHaveTextContent('Capturing 10 seconds · 5 s left');
    expect(screen.getByRole('button', { name: 'Scan now: listening' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows the track, who found it, Add to Wanted and Done', () => {
    const a = api();
    const found: ScanResult = {
      ...BASE,
      state: 'identified',
      track: { artist: 'Tidewater', title: 'Night Ferry', release: null },
      source: 'scan_audd',
      source_label: 'AudD',
      heard_id: 5,
      library: { in_library: false, below_target: null, track_id: null },
    };
    render(<ScanStrip session={session({ scan: found })} playingHere />);
    expect(screen.getByRole('status')).toHaveTextContent('Night Ferry');
    expect(screen.getByRole('status')).toHaveTextContent('Found by AudD · Scan now');
    fireEvent.click(screen.getByRole('button', { name: 'Add to Wanted' }));
    expect(a.addScanToWanted).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(a.dismissScan).toHaveBeenCalled();
  });

  it('In your library instead of Add; Not found and Failed in words', () => {
    api();
    const { rerender } = render(
      <ScanStrip
        session={session({
          scan: {
            ...BASE,
            state: 'identified',
            track: { artist: 'A', title: 'B', release: null },
            source_label: 'AcoustID',
            heard_id: 1,
            library: { in_library: true, below_target: false, track_id: '3' },
          },
        })}
        playingHere
      />,
    );
    expect(screen.queryByRole('button', { name: 'Add to Wanted' })).toBeNull();
    expect(screen.getByText('In your library')).toBeInTheDocument();
    rerender(
      <ScanStrip
        session={session({
          scan: {
            ...BASE,
            state: 'not_found',
            reason: 'Couldn’t identify this — DJ mixes and talk often can’t be.',
          },
        })}
        playingHere
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('DJ mixes and talk often can’t be.');
    rerender(
      <ScanStrip
        session={session({ scanError: 'Two scans are already listening on this server.' })}
        playingHere
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t scan');
  });
});
