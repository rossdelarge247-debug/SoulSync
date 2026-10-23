import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DriveStatus, Move, MovePayload } from './drives.api';

import { CheckAgainAnswer, linesSnippet } from './docker-step';
import { awayRole, DriveAwayNotice } from './drive-away-notice';
import { resetDriveStatus } from './drive-status';
import { durationWords, lastSeenLine, seenWords, sizeOf, sizeWords } from './drives.format';
import { ChangeFolderDialog, FoldersCard, mountFoldersCard } from './folders-card';
import { draftView, MoveFlow, useMoveFlow } from './move-flow';
import { CopyStep, DoneStep, FailureView, failureTitle, SwitchStep } from './move-run';
import { destinations, driveFor } from './move-steps';

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
    for (const kind of ['full', 'mismatch', 'unreadable', 'refused', 'restart'] as const) {
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
      screen.getByText(/Anything added on Music HD since is copied back first/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Music HD' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the old copies…' }));
    await screen.findByText('Remove the old copies from Macintosh HD?');
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
