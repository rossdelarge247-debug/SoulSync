import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RadioSessionApi, RadioSessionState, ScanResult } from '@/features/radio/radio.types';

import { scanAnswer } from '@/features/radio/radio.scan';

import { NowPlayingCard, ScanStrip } from './station-page';

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
  };
  window.SoulSyncRadio = a;
  return a;
}

const SERVICES = {
  scan: { available: true, reason: null, services: ['acoustid', 'audd'] },
} as unknown as RadioSessionState['nowPlaying'];

const FOUND: ScanResult = {
  ...BASE,
  state: 'identified',
  track: { artist: 'Marrow Field', title: 'Glasshouse', release: 'Glasshouse EP' },
  source: 'scan_audd',
  source_label: 'AudD',
  heard_id: 5,
  library: { in_library: false, below_target: null, track_id: null },
  finished_at: Date.now() / 1000 - 20,
  now: Date.now() / 1000,
};

const strip = () => screen.getByTestId('scan-strip');
const control = () => strip().querySelector('button')!;

describe('the station page’s Scan now strip (11b)', () => {
  afterEach(() => {
    window.SoulSyncRadio = undefined;
  });

  it('is disabled with its reason when the station isn’t playing here', () => {
    api();
    render(<ScanStrip session={session({ status: 'idle' })} playingHere={false} />);
    expect(control()).toHaveAttribute('aria-disabled', 'true');
    expect(strip()).toHaveTextContent('Play the station first');
  });

  it('ready: says what it does, in the order it asks', () => {
    const a = api();
    render(<ScanStrip session={session({ nowPlaying: SERVICES })} playingHere />);
    // 15b's ready sentence names the services a press asks, in order
    expect(strip()).toHaveTextContent(
      'Not the track you hear? Scan now listens for 10 seconds and asks AcoustID, then AudD.',
    );
    expect(strip().querySelector('[data-tone="warning"]')).toBeNull();
    expect(control()).toHaveTextContent('Scan now');
    fireEvent.click(control());
    expect(a.scanNow).toHaveBeenCalled();
  });

  it('listening: the progress with the full-width bar, and the selected control', () => {
    api();
    render(<ScanStrip session={session({ scan: BASE })} playingHere />);
    expect(screen.getByRole('status')).toHaveTextContent('Capturing 10 seconds · 5 s left');
    expect(strip().querySelector<HTMLElement>('[aria-hidden="true"] > span')!.style.width).toBe(
      '50%',
    );
    expect(screen.getByRole('button', { name: 'Scan now: listening' })).toHaveAttribute(
      'data-busy',
      'listening',
    );
  });

  it('identifying: who is being asked, a spinner on the control', () => {
    api();
    render(
      <ScanStrip
        session={session({
          scan: {
            ...BASE,
            phase: 'identifying',
            trying: 'audd',
            trying_label: 'AudD',
            asked: ['acoustid', 'audd'],
          },
        })}
        playingHere
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Identifying… · Asking AudD (AcoustID had no match)',
    );
    expect(control()).toHaveAttribute('data-busy', 'identifying');
    expect(control()).toHaveTextContent('Identifying…');
  });

  it('found: only talks about scanning, with "Scan again"; no Done, no second tag', () => {
    api();
    render(<ScanStrip session={session({ scan: FOUND })} playingHere />);
    expect(screen.getByRole('status')).toHaveTextContent(
      /^Scan now found this \d+ s ago\. Scan again if the station has moved on; its own feed replaces the answer when it next names a track\.$/,
    );
    expect(control()).toHaveTextContent('Scan again');
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to Wanted' })).toBeNull();
  });

  it('not found and failed, with who can fix it (a link for admins only)', () => {
    api();
    const failed: ScanResult = {
      ...BASE,
      state: 'failed',
      asked: ['acoustid', 'audd'],
      provider_error: { provider: 'audd', label: 'AudD', kind: 'out_of_credit', message: 'x' },
    };
    const { rerender } = render(
      <ScanStrip
        session={session({ scan: { ...BASE, state: 'not_found', asked: ['acoustid', 'audd'] } })}
        playingHere
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Couldn’t identify this — DJ mixes and talk often can’t be. Asked AcoustID and AudD.',
    );
    expect(control()).toHaveTextContent('Scan again');
    rerender(
      <ScanStrip session={session({ scan: failed, nowPlaying: SERVICES })} playingHere isAdmin />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'Scan didn’t work: AudD has no requests left this month. AcoustID had no match.',
    );
    expect(alert.querySelector('[data-tone="danger"]')).not.toBeNull();
    expect(alert).toHaveTextContent(
      'An admin can check Settings → Radio; until then scans use AcoustID alone.',
    );
    expect(screen.getByRole('button', { name: 'Settings → Radio' })).toBeInTheDocument();
    rerender(<ScanStrip session={session({ scan: failed, nowPlaying: SERVICES })} playingHere />);
    expect(screen.queryByRole('button', { name: 'Settings → Radio' })).toBeNull();
  });

  it('no service: the sentence and a disabled control', () => {
    api();
    render(
      <ScanStrip
        session={session({
          nowPlaying: {
            scan: {
              available: false,
              reason:
                'No identification service is set up for Scan now. An admin can add an AcoustID key, or AudD or ACRCloud, in Settings → Radio.',
              services: [],
            },
          } as unknown as RadioSessionState['nowPlaying'],
        })}
        playingHere
      />,
    );
    expect(strip()).toHaveTextContent('No identification service is set up for Scan now.');
    expect(control()).toHaveAttribute('aria-disabled', 'true');
  });

  it('the per-minute wait: written out, the control disabled', () => {
    const a = api();
    render(
      <ScanStrip
        session={session({
          scan: { ...BASE, state: 'not_found' },
          scanWaitUntil: Date.now() + 39_500,
        })}
        playingHere
      />,
    );
    expect(strip()).toHaveTextContent('Scan now can run again in 40 s (three a minute).');
    expect(control()).toHaveAttribute('aria-disabled', 'true');
    expect(control()).toHaveTextContent('Scan again');
    fireEvent.click(control());
    expect(a.scanNow).not.toHaveBeenCalled();
  });
});

describe('a scan’s answer in the Now playing card (11b)', () => {
  it('reads like the station’s, with the scan’s source phrase', () => {
    const onAdd = vi.fn();
    render(
      <NowPlayingCard
        station={{ id: 'nts-1', name: 'NTS 1' } as RadioSessionState['station'] & object}
        np={scanAnswer(FOUND)}
        skew={0}
        playingHere
        adding={false}
        onAdd={onAdd}
      />,
    );
    expect(screen.getByText('Glasshouse')).toBeInTheDocument();
    // 86: the card's line stops after the time (no "the station's feed says …")
    const line = screen.getByText(/Found by AudD · Scan now · \d+ s ago/);
    expect(line.textContent).toMatch(/^Found by AudD · Scan now · \d+ s ago$/);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Wanted' }));
    expect(onAdd).toHaveBeenCalled();
  });
});

describe('Scan now’s state for everyone (15b, HANDOFF 87)', () => {
  afterEach(() => {
    window.SoulSyncRadio = undefined;
  });
  const np = (scan: Record<string, unknown>) =>
    ({
      scan: { available: true, reason: null, ...scan },
    }) as unknown as RadioSessionState['nowPlaying'];

  it('says a service out of requests for a member, with the warning dot and who can fix it', () => {
    api();
    render(
      <ScanStrip
        session={session({
          nowPlaying: np({
            services: ['acoustid', 'audd'],
            states: { acoustid: 'ready', audd: 'no_requests_left', acrcloud: 'not_set_up' },
            audd_auto: { on: true, stopped: 'out_of_credit' },
          }),
        })}
        playingHere
      />,
    );
    const line = strip().querySelector('[data-tone="warning"]')!;
    expect(line).toHaveTextContent(
      'AudD has no requests left this month, so Scan now asks AcoustID alone, which knows fewer tracks. An admin can add requests in Settings → Radio.',
    );
    expect(line.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    // a member gets the words, not the link
    expect(strip().querySelector('button[type="button"]:not([class*="scanControl"])')).toBeNull();
    expect(strip()).not.toHaveTextContent('Not the track you hear?');
    // still pressable
    expect(control()).not.toHaveAttribute('aria-disabled');
  });

  it('gives admins Settings → Radio as a link for a refused key', () => {
    api();
    const open = vi.fn();
    window.openRadioSettings = open;
    render(
      <ScanStrip
        session={session({
          nowPlaying: np({
            services: ['audd', 'acrcloud'],
            states: { acoustid: 'not_set_up', audd: 'refused', acrcloud: 'ready' },
          }),
        })}
        playingHere
        isAdmin
      />,
    );
    expect(strip()).toHaveTextContent(
      'AudD refused its token, so Scan now asks ACRCloud alone. An admin can fix it in Settings → Radio.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings → Radio' }));
    expect(open).toHaveBeenCalled();
    window.openRadioSettings = undefined;
  });

  it('says automatic AudD’s used-up day under the ready sentence', () => {
    api();
    render(
      <ScanStrip
        session={session({
          nowPlaying: np({
            services: ['acoustid', 'audd'],
            states: { acoustid: 'ready', audd: 'ready', acrcloud: 'not_set_up' },
            audd_auto: { on: true, stopped: 'cap_reached' },
          }),
        })}
        playingHere
      />,
    );
    expect(strip()).toHaveTextContent('asks AcoustID, then AudD.');
    expect(strip()).toHaveTextContent(
      'AudD’s daily limit for listening automatically is used up, so tracks the station doesn’t name wait for Scan now until midnight.',
    );
  });
});
