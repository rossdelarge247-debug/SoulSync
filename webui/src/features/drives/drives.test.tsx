import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DriveStatus, Move, MovePayload } from './drives.api';

import {
  CheckAgainAnswer,
  HelperSteps,
  cleanWindowsFolder,
  linesSnippet,
  windowsComposeLines,
  windowsFolder,
  windowsRestartCommand,
  WindowsSteps,
} from './docker-step';
import { awayRole, DriveAwayNotice } from './drive-away-notice';
import { resetDriveStatus } from './drive-status';
import { durationWords, lastSeenLine, seenWords, sizeOf, sizeWords } from './drives.format';
import { ChangeFolderDialog, FoldersCard, mountFoldersCard, musicBytesOn } from './folders-card';
import { draftView, MoveFlow, useMoveFlow } from './move-flow';
import { CopyStep, DoneStep, FailureView, failureTitle, SwitchStep } from './move-run';
import { CheckStep, destinations, driveFor } from './move-steps';

const GB = 1e9;

function status(patch: Partial<DriveStatus> = {}): DriveStatus {
  const folder = (role: 'library' | 'downloads' | 'staging', connected = true) => ({
    role,
    label: role[0].toUpperCase() + role.slice(1),
    connected,
    last_seen: Math.floor(new Date(2026, 9, 23, 9, 12).getTime() / 1000),
    drive: 'Music HD',
  });
  return {
    success: true,
    checked_at: 0,
    interval: 30,
    library_away: true,
    away: ['library'],
    folders: {
      library: folder('library', false),
      downloads: folder('downloads'),
      staging: folder('staging'),
    },
    can_check: true,
    boot_id: 'b',
    ...patch,
  };
}

const PLAN = {
  order: ['staging', 'downloads', 'library'] as Move['folders'][number]['role'][],
  dests: { library: '/Volumes/Music HD/SYNCHRO.S/Library' },
  sources: { library: '/app/Transfer' },
  total_bytes: 93.2 * GB,
  total_files: 3671,
  estimate_seconds: 4800,
  checksum_seconds: 2400,
  target_label: 'Music HD',
  source_label: 'Macintosh HD',
  automations: ['Tidy new albums', 'Apply quality upgrades', 'Weekly duplicate clean-up'],
  speed: 31e6,
  library_paths: 3627,
};

function move(patch: Partial<Move> = {}): Move {
  return {
    id: 1,
    status: 'draft',
    created_at: 0,
    updated_at: 0,
    started_at: null,
    switched_at: null,
    finished_at: null,
    promise: { tone: 'success', words: 'Nothing has changed yet' },
    choice: {
      roles: { library: true, downloads: true, staging: true },
      target: '/Volumes/Music HD/SYNCHRO.S',
      separate: false,
      per_role: {},
      exfat: null,
      checksum: false,
    },
    checks: null,
    plan: null,
    failure: null,
    result: {},
    has_slskd_session: false,
    folders: [],
    progress: { copied_bytes: 0, total_bytes: 0, eta_seconds: null },
    ...patch,
  };
}

function runProps(m: Move) {
  const payload: MovePayload = { success: true, move: m, boot_id: 'b', running: true };
  return {
    payload,
    move: m,
    busy: false,
    error: null,
    act: vi.fn(async () => true),
    close: vi.fn(),
    done: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  resetDriveStatus();
  useMoveFlow.setState({ open: false, view: null });
  vi.unstubAllGlobals();
});

describe('words', () => {
  it('says sizes as the Finder does and shares the unit', () => {
    expect(sizeWords(93.2 * GB)).toBe('93.2 GB');
    expect(sizeWords(600e6)).toBe('600 MB');
    expect(sizeWords(3.6e12)).toBe('3.6 TB');
    expect(sizeOf(41.2 * GB, 93.2 * GB)).toBe('41.2 of 93.2 GB');
    expect(sizeOf(500e6, 93.2 * GB)).toBe('500 MB of 93.2 GB');
  });

  it('says durations', () => {
    expect(durationWords(4800)).toBe('1 h 20 min');
    expect(durationWords(46 * 60)).toBe('46 min');
    expect(durationWords(10)).toBe('less than a minute');
  });

  it('says when the drive was last seen, on the browser’s clock when asked', () => {
    const now = new Date(2026, 9, 23, 15, 0);
    const seen = Math.floor(new Date(2026, 9, 23, 9, 12).getTime() / 1000);
    expect(seenWords(seen, now)).toBe('today at 09:12');
    expect(lastSeenLine(seen, 30, { now })).toBe('Last seen today at 09:12 · looks every 30 s');
    expect(lastSeenLine(seen, 30, { now, short: true })).toBe('Last seen 09:12 · looks every 30 s');
    expect(seenWords(seen - 86400, now)).toBe('yesterday at 09:12');
  });
});

describe('“Your library’s drive isn’t connected” (14k, 14t)', () => {
  it('is a warning with Check again for admins', () => {
    const onCheck = vi.fn();
    render(<DriveAwayNotice status={status()} onCheckAgain={onCheck} />);
    expect(screen.getByText('Your library’s drive isn’t connected')).toBeInTheDocument();
    expect(document.querySelector('[data-drive-away="library"]')).toHaveAttribute(
      'data-tone',
      'warning',
    );
    expect(screen.getAllByText(/SYNCHRO.S can’t see Music HD/)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/looks every 30 s/)[0]).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onCheck).toHaveBeenCalled();
  });

  it('gives members the same words without Check again', () => {
    render(<DriveAwayNotice status={status({ can_check: false })} onCheckAgain={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(screen.getAllByText(/Last seen/)[0]).toBeInTheDocument();
  });

  it('names the downloads drive on Home only, and nothing when every drive is here', () => {
    const dl = status({ library_away: false, away: ['downloads'] });
    expect(awayRole(dl, 'page')).toBeNull();
    expect(awayRole(dl, 'home')).toBe('downloads');
    render(<DriveAwayNotice status={dl} where="home" />);
    expect(screen.getByText('Your downloads drive isn’t connected')).toBeInTheDocument();
    cleanup();
    const { container } = render(
      <DriveAwayNotice status={status({ library_away: false, away: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the flow’s pieces', () => {
  it('spells out the three paths under one parent folder', () => {
    expect(destinations(move().choice)).toEqual({
      library: '/Volumes/Music HD/SYNCHRO.S/Library',
      downloads: '/Volumes/Music HD/SYNCHRO.S/Downloads',
      staging: '/Volumes/Music HD/SYNCHRO.S/Staging',
    });
    const separate = {
      ...move().choice,
      separate: true,
      roles: { library: true, downloads: false, staging: true },
      per_role: { library: '/Volumes/A/Lib/', staging: '/Volumes/B/St' },
    };
    expect(destinations(separate)).toEqual({ library: '/Volumes/A/Lib', staging: '/Volumes/B/St' });
    const drives = [
      {
        name: 'Music HD',
        path: '/Volumes/Music HD',
        total: 1,
        free: 1,
        format: null,
        backup: false,
        read_only: false,
        offered: true,
      },
    ];
    expect(driveFor('/Volumes/Music HD/SYNCHRO.S', drives)?.name).toBe('Music HD');
    expect(driveFor('/Volumes/Music HDX', drives)).toBeNull();
  });

  it('opens the draft where the server says it is', () => {
    expect(draftView(move(), null)).toBe('choose');
    expect(
      draftView(
        move({
          checks: {
            rows: [],
            at: 0,
            speed: null,
            format: null,
            need: 0,
            ok: true,
            summary: '',
            dests: {},
          },
        }),
        null,
      ),
    ).toBe('check');
    expect(draftView(move({ plan: PLAN }), null)).toBe('plan');
    expect(draftView(move({ plan: PLAN }), 'docker')).toBe('docker');
    expect(draftView(move(), 'plan')).toBe('choose');
  });

  it('shows the lines the helper adds', () => {
    const lines = linesSnippet('mac', ['/Volumes:/Volumes'], './slskd:/slskd-config');
    expect(lines.filter((l) => l.added).map((l) => l.text)).toEqual([
      '+     - /Volumes:/Volumes',
      '+     - ./slskd:/slskd-config',
      '+     - /Volumes:/Volumes',
      '+     - /Volumes:/Volumes',
    ]);
  });

  it('says slskd’s config line as its own step in “What it does, in order” (121)', () => {
    render(<HelperSteps slskdLine="./slskd:/slskd-config" />);
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toHaveLength(5);
    expect(steps[3]).toBe(
      'Gives SYNCHRO.S slskd’s own settings folder (./slskd:/slskd-config), so it can change what slskd shares when your music moves.',
    );
    expect(steps[4]).toMatch(/^Restarts them/);
  });

  it('answers Check again four ways (14d)', () => {
    const props = {
      now: 24000,
      roots: '/Volumes',
      onBack: vi.fn(),
      onCheck: vi.fn(),
      onCopyHelp: vi.fn(),
      copiedHelp: false,
    };
    const { rerender } = render(
      <CheckAgainAnswer state={{ kind: 'restarting', since: 0 }} {...props} />,
    );
    expect(screen.getByText('This page reconnects by itself · 24 s so far')).toBeInTheDocument();
    rerender(<CheckAgainAnswer state={{ kind: 'worked', drive: 'Music HD' }} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to choosing' }));
    expect(props.onBack).toHaveBeenCalled();
    rerender(<CheckAgainAnswer state={{ kind: 'still' }} {...props} />);
    expect(
      screen.getByText('SYNCHRO.S restarted, but still can’t see /Volumes'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy what to send for help' })).toBeInTheDocument();
    rerender(<CheckAgainAnswer state={{ kind: 'not_yet' }} {...props} />);
    expect(
      screen.getByText('SYNCHRO.S hasn’t restarted since you opened this step'),
    ).toBeInTheDocument();
  });
});

describe('the running flow', () => {
  const folders = [
    {
      role: 'staging' as const,
      label: 'Staging',
      files: 12,
      bytes: 0.6 * GB,
      copied_files: 12,
      copied_bytes: 0.6 * GB,
      verified: 0,
    },
    {
      role: 'library' as const,
      label: 'Library',
      files: 3627,
      bytes: 88.4 * GB,
      copied_files: 1602,
      copied_bytes: 36.4 * GB,
      verified: 0,
    },
  ];

  it('copying shows the bar, the line, each folder and what’s paused (14g)', () => {
    const m = move({
      status: 'copying',
      plan: PLAN,
      folders,
      promise: { tone: 'info', words: 'Copying · your music is still on Macintosh HD' },
      progress: {
        phase: 'copying',
        role: 'library',
        current: 'Saltmarsh / Lantern / 04 Static Bloom.flac',
        copied_bytes: 41.2 * GB,
        total_bytes: 93.2 * GB,
        speed: 31e6,
        eta_seconds: 46 * 60,
      },
    });
    render(<CopyStep {...runProps(m)} />);
    expect(screen.getByText('41.2 of 93.2 GB · about 46 min left · 31 MB/s')).toBeInTheDocument();
    expect(
      screen.getAllByText('Copying · your music is still on Macintosh HD').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByText('Copied')).toBeInTheDocument();
    expect(screen.getAllByText(/Saltmarsh \/ Lantern/)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/3 automations/)[0]).toBeInTheDocument();
  });

  it('Stop and undo asks in place first', () => {
    const props = runProps(
      move({
        status: 'copying',
        plan: PLAN,
        folders,
        progress: { copied_bytes: 41.2 * GB, total_bytes: 93.2 * GB, eta_seconds: null },
      }),
    );
    render(<CopyStep {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop and undo' }));
    expect(
      screen.getByText('Stop and delete the half-made copy? 41.2 GB copied so far.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep copying' }));
    expect(props.act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and undo' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop and undo' }).at(-1) as HTMLElement);
    expect(props.act).toHaveBeenCalled();
  });

  it('checking then switching is one numbered list (14h)', () => {
    render(
      <SwitchStep
        {...runProps(
          move({
            status: 'verifying',
            plan: PLAN,
            folders,
            progress: {
              phase: 'verifying',
              checked: 3102,
              total: 3671,
              different: 0,
              copied_bytes: 93.2 * GB,
              total_bytes: 93.2 * GB,
              eta_seconds: null,
            },
          }),
        )}
      />,
    );
    expect(screen.getByText('Checking every file, then switching over')).toBeInTheDocument();
    expect(screen.getByText(/3,102 of 3,671 match/)).toBeInTheDocument();
    expect(screen.getByText('Switch SYNCHRO.S to Music HD')).toBeInTheDocument();
    expect(screen.getByText('Available until the switch starts.')).toBeInTheDocument();
  });

  it('every failure says the music is untouched (14j)', () => {
    const m = move({
      status: 'failed',
      plan: PLAN,
      promise: { tone: 'success', words: 'Nothing switched · your music is on Macintosh HD' },
      failure: {
        kind: 'drive_away',
        words: 'Music HD disconnected at 14:32, after 41.2 GB of 93.2 GB.',
        at: 0,
        matching_files: 1646,
      },
    });
    render(<FailureView {...runProps(m)} />);
    expect(screen.getByText('The copy stopped: Music HD went away')).toBeInTheDocument();
    expect(screen.getByText('Your music is untouched on Macintosh HD')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'Plug it in and carry on' }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/keeps the 1,646 files that match/)).toBeInTheDocument();
    for (const kind of ['full', 'mismatch', 'unreadable', 'refused', 'stuck', 'restart'] as const) {
      expect(failureTitle({ kind, words: '', at: 0, count: 12 }, 'Music HD')).toBeTruthy();
    }
    expect(failureTitle({ kind: 'mismatch', words: '', at: 0, count: 12 }, 'X')).toBe(
      '12 files didn’t match',
    );
  });

  it('done lists the checks and offers removal and switching back (14i)', async () => {
    const m = move({
      status: 'switched',
      plan: PLAN,
      promise: { tone: 'success', words: 'Switched to Music HD · the old copies are kept' },
      result: {
        checks: [
          {
            key: 'library',
            ok: true,
            title: 'Library: 3,627 of 3,627 files found',
            detail: '/Volumes/Music HD/SYNCHRO.S/Library',
            mono: true,
          },
        ],
      },
    });
    const props = runProps(m);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              plan_id: 'p1',
              total: 3671,
              total_bytes: 93.2 * GB,
              sample: [{ path: '/app/Transfer/a.flac', size: 10, action: 'delete', reason: 'x' }],
              truncated: true,
              created_at: 0,
              expires_at: 0,
            }),
            { status: 200 },
          ),
      ),
    );
    render(<DoneStep {...props} />);
    expect(screen.getByText('Your music now lives on Music HD')).toBeInTheDocument();
    expect(screen.getByText('Library: 3,627 of 3,627 files found')).toBeInTheDocument();
    expect(screen.getByText('The old copies are still on Macintosh HD')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Switch back/ }));
    expect(
      screen.getByText(/Anything added or changed on Music HD since is copied back first/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Music HD' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the old copies…' }));
    await screen.findByText('Permanently delete the old copies?');
    await screen.findByText('For good');
    const confirm = screen.getByRole('button', { name: 'Delete 3,671 files' });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByLabelText('I checked the list'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete 3,671 files' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
  });
});

describe('when the switch goes wrong, or goes back', () => {
  it('a switch that didn’t finish never offers to delete the copy', () => {
    const m = move({
      status: 'failed',
      plan: PLAN,
      promise: { tone: 'danger', words: 'The switch didn’t finish · nothing was deleted' },
      failure: {
        kind: 'stuck',
        words:
          'Plex didn’t answer. SYNCHRO.S couldn’t switch its folder settings back, so they may point at Music HD. Nothing has been deleted. Try the switch again.',
        at: 0,
      },
    });
    render(<FailureView {...runProps(m)} />);
    expect(screen.getByText('The switch didn’t finish')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete the half-made copy' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Try the switch again' }).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(/is untouched on/)).toBeNull();
  });

  it('a refused switch says what happened in its own words', () => {
    const m = move({
      status: 'failed',
      plan: PLAN,
      failure: {
        kind: 'refused',
        words:
          'Plex didn’t add the folder. So SYNCHRO.S switched back; the copy on Music HD is kept. Check slskd.yml by hand: SYNCHRO.S couldn’t put it back.',
        at: 0,
      },
    });
    render(<FailureView {...runProps(m)} />);
    expect(screen.getByText(/Check slskd\.yml by hand/)).toBeInTheDocument();
  });

  it('switching back asks for slskd’s sign-in when Downloads moved', async () => {
    const m = move({
      status: 'switched',
      plan: {
        ...PLAN,
        dests: { ...PLAN.dests, downloads: '/Volumes/Music HD/SYNCHRO.S/Downloads' },
        sources: { ...PLAN.sources, downloads: '/app/downloads' },
      },
      result: { checks: [], slskd: { changed: ['shares', 'downloads'] } },
    });
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, init });
        return new Response(
          JSON.stringify({ success: true, move: m, boot_id: 'b', running: false }),
        );
      }),
    );
    const props = {
      ...runProps(m),
      act: async (fn: () => Promise<MovePayload>) => {
        await fn();
        return true;
      },
    };
    render(<DoneStep {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Switch back/ }));
    const go = screen.getByRole('button', { name: 'Switch back' });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('slskd user name'), { target: { value: 'ross' } });
    fireEvent.change(screen.getByLabelText('slskd password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch back' }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].url).toMatch(/\/api\/drives\/move\/1\/switch-back$/);
    expect(JSON.parse(sent[0].init?.body as string)).toEqual({ username: 'ross', password: 'pw' });
  });

  it('every change goes to the server as JSON', async () => {
    const sent: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(init ?? {});
        return new Response(JSON.stringify({ success: true }));
      }),
    );
    const { drivesApi } = await import('./drives.api');
    await drivesApi.stop(1);
    await drivesApi.move();
    expect(sent[0].method).toBe('POST');
    expect((sent[0].headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(sent[0].body).toBe('{}');
    expect(sent[1].body).toBeUndefined();
  });
});

describe('the flow host', () => {
  it('opens on a new draft and leaves without changing anything', async () => {
    const overview = {
      folders: [
        {
          role: 'library',
          label: 'Library',
          path: '/app/Transfer',
          drive: 'Macintosh HD',
          holds: 'Your music. Library and Plex read it; slskd shares it.',
          files: 3627,
          bytes: 88.4 * GB,
          albums: 494,
        },
        {
          role: 'downloads',
          label: 'Downloads',
          path: '/app/downloads',
          drive: 'Macintosh HD',
          holds: '',
          files: 32,
          bytes: 4.2 * GB,
        },
        {
          role: 'staging',
          label: 'Staging',
          path: '/app/Staging',
          drive: 'Macintosh HD',
          holds: '',
          files: 12,
          bytes: 0.6 * GB,
        },
      ],
      drives: [
        {
          name: 'Music HD',
          path: '/Volumes/Music HD',
          total: 4e12,
          free: 3.6e12,
          format: 'exFAT',
          backup: false,
          read_only: false,
          offered: true,
        },
        {
          name: 'Time Machine',
          path: '/Volumes/Time Machine',
          total: 2e12,
          free: 1e12,
          format: null,
          backup: true,
          read_only: false,
          offered: false,
        },
      ],
      home_label: 'Macintosh HD',
      home_free: 41 * GB,
      platform: 'mac',
      visible: true,
      roots: ['/Volumes'],
    };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/api/drives/move') && (init?.method ?? 'GET') === 'GET') {
          return new Response(
            JSON.stringify({ success: true, move: null, overview, boot_id: 'b', running: false }),
          );
        }
        return new Response(
          JSON.stringify({ success: true, move: move(), overview, boot_id: 'b', running: false }),
        );
      }),
    );
    render(<MoveFlow />);
    act(() => useMoveFlow.getState().begin());
    await screen.findByText('What moves, and where to');
    expect(
      screen.getByText(/3,627 files in 494 albums · read by Library and Plex, shared by slskd/),
    ).toBeInTheDocument();
    expect(screen.getByText(/used for backups, not offered/)).toBeInTheDocument();
    expect(screen.getAllByText('/Volumes/Music HD/SYNCHRO.S/Library')[0]).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Music HD' })).toBeInTheDocument();
    expect(document.body).toHaveAttribute('data-drive-move-open');
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(calls).toContain('POST /api/drives/move/1/leave'));
    expect(useMoveFlow.getState().open).toBe(false);
  });

  it('reads the move again while the checks run on the server', async () => {
    let reads = 0;
    const running = move({
      checks: {
        rows: [],
        at: 0,
        speed: null,
        format: null,
        need: 0,
        ok: false,
        summary: 'Looking at the drive…',
        dests: {},
        running: true,
      },
    });
    const done = move({
      checks: {
        rows: [{ key: 'space', title: 'Enough space', tone: 'success', tag: 'Fine', detail: 'ok' }],
        at: 0,
        speed: null,
        format: null,
        need: 0,
        ok: true,
        summary: 'Every check passed.',
        dests: {},
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (url.endsWith('/api/drives/move') && method === 'GET') {
          reads += 1;
          const m = reads === 1 ? running : done;
          return new Response(
            JSON.stringify({ success: true, move: m, boot_id: 'b', running: false }),
          );
        }
        return new Response(
          JSON.stringify({ success: true, move: running, boot_id: 'b', running: false }),
        );
      }),
    );
    render(<MoveFlow />);
    act(() => useMoveFlow.getState().begin('check'));
    await screen.findByText('Looking at the drive…');
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    await screen.findByText('Every check passed.', undefined, { timeout: 4000 });
    expect(reads).toBeGreaterThan(1);
  });
});

describe('the Folders card (14a)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the three folders and the drive line with Getting full', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              platform: 'mac',
              move: null,
              folders: [
                {
                  role: 'library',
                  label: 'Library',
                  path: '/app/Transfer',
                  drive: 'Macintosh HD',
                  holds: 'Your music. Library and Plex read it; slskd shares it.',
                  files: 3627,
                  bytes: 88.4 * GB,
                },
                {
                  role: 'downloads',
                  label: 'Downloads',
                  path: '/app/downloads',
                  drive: 'Macintosh HD',
                  holds: 'Files arriving from Soulseek, before they’re checked.',
                  files: 32,
                  bytes: 4.2 * GB,
                },
                {
                  role: 'staging',
                  label: 'Staging',
                  path: '/app/Staging',
                  drive: 'Macintosh HD',
                  holds: 'Albums waiting to be imported.',
                  files: null,
                  bytes: null,
                },
              ],
              drive: {
                label: 'Macintosh HD',
                free: 41 * GB,
                total: 494 * GB,
                percent: 91.7,
                tone: 'warning',
              },
            }),
          ),
      ),
    );
    render(<FoldersCard />);
    await screen.findByText('/app/Transfer');
    expect(screen.getByText('88.4 GB')).toBeInTheDocument();
    expect(screen.getByText('Measuring…')).toBeInTheDocument();
    expect(screen.getByText('41.0 GB free of 494 GB')).toBeInTheDocument();
    expect(screen.getByText('Getting full')).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '91.7');
    expect(screen.getByRole('button', { name: /Move to another drive…/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Change…' })).toHaveLength(3);
    // 124: no fill rate, and no music line while Staging is still being measured
    expect(screen.queryByText(/Your music folders take/)).toBeNull();
    expect(screen.queryByText(/At this month’s rate/)).toBeNull();
  });

  it('says how much of the drive the music takes (124), counting a nested folder once', () => {
    const row = (
      role: 'library' | 'downloads' | 'staging',
      path: string,
      bytes: number | null,
    ) => ({
      role,
      label: role,
      path,
      drive: 'Macintosh HD',
      holds: '',
      files: 1,
      bytes,
    });
    const drive = {
      label: 'Macintosh HD',
      free: 41 * GB,
      total: 494 * GB,
      percent: 91.7,
      tone: null,
    };
    expect(
      musicBytesOn({
        drive,
        folders: [
          row('library', '/app/Transfer', 88.4 * GB),
          row('downloads', '/app/downloads', 4.2 * GB),
          row('staging', '/app/Staging', 0.6 * GB),
        ],
      }),
    ).toBeCloseTo(93.2 * GB);
    expect(
      musicBytesOn({
        drive,
        folders: [
          row('library', '/app/Transfer', 88.4 * GB),
          row('downloads', '/app/Transfer/downloads', 4.2 * GB),
          row('staging', '/app/Staging', 0.6 * GB),
        ],
      }),
    ).toBeCloseTo(89 * GB);
    expect(
      musicBytesOn({
        drive,
        folders: [{ ...row('library', '/app/Transfer', 1), drive: 'Music HD' }],
      }),
    ).toBeNull();
    expect(sizeWords(93.2 * GB)).toBe('93.2 GB');
  });

  it('Change… writes the Settings page’s field and says it moves nothing', () => {
    document.body.innerHTML =
      '<div class="form-group"><input id="transfer-path" value="/app/Transfer"></div>';
    const input = document.getElementById('transfer-path') as HTMLInputElement;
    const heard = vi.fn();
    input.addEventListener('input', heard);
    const onSaved = vi.fn();
    render(
      <ChangeFolderDialog
        row={{
          role: 'library',
          label: 'Library',
          path: '/app/Transfer',
          drive: 'Macintosh HD',
          holds: '',
          files: 1,
          bytes: 1,
        }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByText(/This doesn’t move anything/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('The folder SYNCHRO.S reads, as it sees it'), {
      target: { value: '/music' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(input.value).toBe('/music');
    expect(heard).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('mounts in place of the three legacy path fields', () => {
    document.body.innerHTML = `
      <div id="folders-music-panel"><div class="stg-media-context"></div>
        <div class="form-group"><input id="download-path"></div>
        <div class="form-group"><input id="transfer-path"></div>
        <div class="form-group"><input id="staging-path"></div>
        <div class="form-group"><input id="music-videos-path"></div>
      </div>`;
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 403 })),
    );
    expect(mountFoldersCard()).toBe(true);
    expect(document.querySelector('[data-folders-card-host]')).not.toBeNull();
    for (const id of ['download-path', 'transfer-path', 'staging-path']) {
      expect(
        ((document.getElementById(id) as HTMLElement).closest('.form-group') as HTMLElement).hidden,
      ).toBe(true);
    }
    expect(
      (
        (document.getElementById('music-videos-path') as HTMLElement).closest(
          '.form-group',
        ) as HTMLElement
      ).hidden,
    ).toBe(false);
    expect(mountFoldersCard()).toBe(false);
  });
});

describe('Check’s slskd row (19a)', () => {
  const SLSKD_ROW = {
    key: 'slskd',
    title: 'slskd downloads to the new place',
    tone: 'warning' as const,
    tag: 'Needs your choice',
    needs_choice: true,
    sign_in: true,
    slskd_choice: 'move' as const,
    signed_in: false,
    home_label: 'Macintosh HD',
    target_label: 'Music HD',
    detail:
      'To download into Music HD, slskd has to restart, and it only lets a signed-in admin do that. SYNCHRO.S signs in once, keeps only what slskd hands back, and forgets it when the move is done.',
  };
  const checked = (rows: object[], ok = false) =>
    move({
      checks: {
        rows: [
          {
            key: 'space',
            title: 'Room for everything',
            tone: 'success',
            tag: 'Fine',
            detail: '93.2 GB to copy · 1.71 TB free on Music HD',
          },
          ...(rows as Move['checks'] extends infer C
            ? C extends { rows: infer R }
              ? R
              : never
            : never),
        ],
        at: 0,
        speed: null,
        format: null,
        need: 0,
        ok,
        summary: 'One check passed and one needs your say.',
        dests: {},
      },
    });

  function renderCheck(m: Move, respond: (url: string, init?: RequestInit) => Response) {
    const sent: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('/api/drives/move/'))
          sent.push({
            url,
            method: init?.method ?? 'GET',
            body: init?.body ? JSON.parse(init.body as string) : null,
          });
        // only the move's routes answer here (a card from another test may still ask)
        if (!url.startsWith('/api/drives/move/'))
          return new Response(JSON.stringify({ success: false }), { status: 404 });
        return respond(url, init);
      }),
    );
    const errors: string[] = [];
    const act = async (fn: () => Promise<MovePayload>) => {
      try {
        await fn();
        return true;
      } catch (e) {
        errors.push((e as Error).message);
        return false;
      }
    };
    const payload: MovePayload = { success: true, move: m, boot_id: 'b', running: false };
    render(
      <CheckStep
        payload={payload}
        move={m}
        busy={false}
        error={null}
        act={act}
        go={vi.fn()}
        leave={vi.fn()}
      />,
    );
    return { sent, errors };
  }

  const ok = (m: Move) =>
    new Response(JSON.stringify({ success: true, move: m, boot_id: 'b', running: false }));

  it('asks for the choice: the sign-in inside "Move Downloads too", the default', () => {
    const m = checked([SLSKD_ROW]);
    renderCheck(m, () => ok(m));
    expect(screen.getByText('Needs your choice')).toBeInTheDocument();
    expect(screen.getByText(SLSKD_ROW.detail)).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(radios[0]).toHaveTextContent('Move Downloads too: sign in to slskd');
    expect(radios[0]).toHaveTextContent(
      'What you chose. slskd’s own user name and password, as on its web page.',
    );
    expect(radios[1]).toHaveTextContent('Leave Downloads on Macintosh HD');
    expect(radios[1]).toHaveTextContent(
      'No sign-in. slskd keeps downloading there; imports then copy across to Music HD instead of moving, a little slower. You can move Downloads later.',
    );
    expect(screen.getByLabelText('User name')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'See the plan' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      screen.getByText('Sign in to slskd, or leave Downloads where it is, to see the plan.'),
    ).toBeInTheDocument();
  });

  it('signs in once; a refused sign-in is said under Password, not at the top', async () => {
    const m = checked([SLSKD_ROW]);
    let accept = false;
    const { sent, errors } = renderCheck(m, (url) =>
      url.endsWith('/slskd-session') && !accept
        ? new Response(
            JSON.stringify({
              success: false,
              error: 'slskd didn’t accept that user name and password.',
              code: 'slskd_refused',
            }),
            { status: 400 },
          )
        : ok(m),
    );
    fireEvent.change(screen.getByLabelText('User name'), { target: { value: 'slskd' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    expect(screen.getByText('Then this row reads “Signed in as slskd”.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to slskd' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'slskd didn’t accept that user name and password.',
      ),
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(errors).toEqual([]);
    expect(sent[0]).toEqual({
      url: '/api/drives/move/1/slskd-session',
      method: 'POST',
      body: { username: 'slskd', password: 'wrong' },
    });
    accept = true;
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to slskd' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    // the password isn't kept in the page once it's sent
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveValue(''));
  });

  it('"Leave Downloads on Macintosh HD" takes Downloads out of this move and checks again', async () => {
    const m = checked([SLSKD_ROW]);
    const { sent } = renderCheck(m, () => ok(m));
    fireEvent.click(screen.getByRole('radio', { name: /Leave Downloads on Macintosh HD/ }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toEqual({
      url: '/api/drives/move/1/choice',
      method: 'PUT',
      body: { downloads_left: true },
    });
    expect(sent[1]!.url).toBe('/api/drives/move/1/check');
  });

  it('once settled, the row says so and See the plan is there', () => {
    const m = checked(
      [
        {
          ...SLSKD_ROW,
          tone: 'success',
          tag: 'Signed in as slskd',
          needs_choice: false,
          signed_in: true,
          detail: 'SYNCHRO.S restarts slskd once at the switch, then forgets the sign-in.',
        },
      ],
      true,
    );
    renderCheck(m, () => ok(m));
    expect(screen.getByText('Signed in as slskd')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByRole('button', { name: 'See the plan' })).toBeEnabled();
  });
});

describe('the Docker step on Windows (19b)', () => {
  it('says the install folder, the lines and the command as Windows writes them', () => {
    expect(windowsFolder('~/SoulSync')).toBe('C:\\SoulSync');
    expect(windowsFolder('D:\\Apps\\SoulSync')).toBe('D:\\Apps\\SoulSync');
    expect(windowsRestartCommand('')).toBe(
      "Set-Location -LiteralPath 'C:\\SoulSync'; if ($?) { docker compose up -d }",
    );
    expect(windowsComposeLines('e', './slskd:/slskd-config')).toEqual([
      { text: '  soulsync:', added: false },
      { text: '    volumes:', added: false },
      { text: '      - ./music:/app/Transfer', added: false },
      { text: '      - E:\\:/drives/e', added: true },
      { text: '      - ./slskd:/slskd-config', added: true },
      { text: '  slskd:', added: false },
      { text: '    volumes:', added: false },
      { text: '      - E:\\:/drives/e', added: true },
    ]);
  });

  it('quotes the folder, so spaces and (x86) work and nothing in it is run', () => {
    expect(windowsRestartCommand('C:\\Program Files (x86)\\SoulSync')).toBe(
      "Set-Location -LiteralPath 'C:\\Program Files (x86)\\SoulSync'; if ($?) { docker compose up -d }",
    );
    // quotes, $…, backticks and ; can't be typed into the folder
    expect(cleanWindowsFolder("C:\\Soul'Sync$(rm)`x;y")).toBe('C:\\SoulSync(rm)xy');
    expect(windowsRestartCommand("C:\\Soul'Sync$(Get-Process)")).toBe(
      "Set-Location -LiteralPath 'C:\\SoulSync(Get-Process)'; if ($?) { docker compose up -d }",
    );
    render(
      <WindowsSteps folder="" slskdLine="./slskd:/slskd-config" copied={null} onCopy={vi.fn()} />,
    );
    const field = screen.getByLabelText('The folder SYNCHRO.S was installed in');
    fireEvent.change(field, { target: { value: 'D:\\My $Music`' } });
    expect(field).toHaveValue('D:\\My Music');
  });

  it('three steps by hand: copy the file, add the lines in Notepad, restart from PowerShell', () => {
    const onCopy = vi.fn();
    render(
      <WindowsSteps
        folder="~/SoulSync"
        slskdLine="./slskd:/slskd-config"
        copied={null}
        onCopy={onCopy}
      />,
    );
    expect(screen.getByText('Keep a copy of your set-up file')).toBeInTheDocument();
    expect(screen.getByText('Add the lines in Notepad')).toBeInTheDocument();
    expect(screen.getByText('Restart SYNCHRO.S from PowerShell')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Set-Location -LiteralPath 'C:\\SoulSync'; if ($?) { docker compose up -d }",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'The drive’s letter' }), {
      target: { value: 'F' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy the line' }));
    expect(onCopy).toHaveBeenCalledWith('line', '      - F:\\:/drives/f');
    fireEvent.change(screen.getByLabelText('The folder SYNCHRO.S was installed in'), {
      target: { value: 'D:\\SoulSync' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenLastCalledWith(
      'restart',
      "Set-Location -LiteralPath 'D:\\SoulSync'; if ($?) { docker compose up -d }",
    );
    expect(
      screen.getByText(/Put the copy from step 1 back and run step 3 again/),
    ).toBeInTheDocument();
  });
});

describe('carrying on after a failure when Downloads moves', () => {
  it('asks for slskd’s sign-in when the server says so, then sends it', async () => {
    const m = move({
      status: 'failed',
      plan: PLAN,
      failure: { kind: 'drive_away', words: 'Music HD disconnected.', at: 0, matching_files: 10 },
    });
    const sent: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        // only the move's calls: a Folders card mounted by an earlier test
        // still takes its second look at the folders
        if (url.includes('/api/drives/move/')) sent.push({ url, body });
        if (!body?.username)
          return new Response(
            JSON.stringify({
              success: false,
              error: 'slskd has to restart… Sign in to slskd to carry on.',
              code: 'slskd_sign_in',
            }),
            { status: 409 },
          );
        return new Response(
          JSON.stringify({ success: true, move: m, boot_id: 'b', running: true }),
        );
      }),
    );
    const props = {
      ...runProps(m),
      act: async (fn: () => Promise<MovePayload>) => {
        try {
          await fn();
          return true;
        } catch {
          return false;
        }
      },
    };
    render(<FailureView {...props} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Plug it in and carry on' })[0]!);
    await waitFor(() => expect(screen.getByLabelText('slskd user name')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('slskd user name'), { target: { value: 'slskd' } });
    fireEvent.change(screen.getByLabelText('slskd password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Plug it in and carry on' })[0]!);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({
      url: '/api/drives/move/1/resume',
      body: { username: 'slskd', password: 'pw' },
    });
  });
});
