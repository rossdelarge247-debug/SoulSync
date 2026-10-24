/**
 * The computer's own names for the music folders (125, 160): the Folders
 * card, the Remove list (19c) and the move flow show the drives helper's host
 * path where SYNCHRO.S trusts one, else the container's path with one line
 * offering the helper's `--names`.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FoldersPayload, Move, RemovePreview } from './drives.api';

import { relativeTo, shownPath, wantsNames } from './drives.format';
import { FoldersCard } from './folders-card';
import { DoneStep } from './move-run';
import { planTarget } from './move-steps';
import { RemoveOldCopies, removeRows, rootHead } from './remove-old-copies';

const GB = 1e9;
const HOST = '/Users/ross/SoulSync/music';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function folders(patch: Partial<FoldersPayload> = {}, named = true): FoldersPayload {
  const row = (role: 'library' | 'downloads' | 'staging', path: string, host: string | null) => ({
    role,
    label: role[0].toUpperCase() + role.slice(1),
    path,
    drive: 'Macintosh HD',
    holds: 'x',
    files: 1,
    bytes: GB,
    host_path: host,
    volume: host ? 'Macintosh HD' : null,
    host_source: host ? ('hint' as const) : null,
  });
  return {
    success: true,
    platform: 'mac',
    move: null,
    compose_folder: '~/SoulSync',
    folders: [
      row('library', '/app/Transfer', HOST),
      row('downloads', '/app/downloads', named ? '/Users/ross/SoulSync/downloads' : null),
      row('staging', '/app/Staging', named ? '/Users/ross/SoulSync/staging' : null),
    ],
    drive: {
      label: 'Macintosh HD',
      free: 41 * GB,
      total: 494 * GB,
      percent: 91.7,
      tone: 'warning',
    },
    ...patch,
  };
}

/** fetch answering by route; every call is recorded. */
function serve(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = input;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const key = Object.keys(routes).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? routes[key] : { success: false }), {
      status: key ? 200 : 404,
    });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const COMMAND = {
  success: true,
  command:
    "cd ~/SoulSync && curl -fsSL 'http://h/api/drives/helper.sh?t=T' -o drives-helper.sh && sh drives-helper.sh --names",
  undo: '',
  expires_at: 0,
  platform: 'mac',
  lines: { mounts: [], slskd_config: '' },
  compose_folder: '~/SoulSync',
  names: true,
};

describe('words', () => {
  it('shows the computer’s path when known, and paths relative to a folder', () => {
    expect(shownPath({ path: '/app/Transfer', host_path: HOST })).toBe(HOST);
    expect(shownPath({ path: '/app/Transfer', host_path: null })).toBe('/app/Transfer');
    expect(relativeTo('/app/Transfer/A/b.flac', '/app/Transfer/')).toBe('A/b.flac');
    expect(relativeTo('/app/Transfer-2/b.flac', '/app/Transfer')).toBe('/app/Transfer-2/b.flac');
    expect(wantsNames([{ host_path: HOST }, { host_path: null }], 'mac')).toBe(true);
    expect(wantsNames([{ host_path: null }], 'windows')).toBe(false);
    expect(wantsNames([{ host_path: HOST }], 'linux')).toBe(false);
  });
});

describe('the Folders card (14a, 125)', () => {
  it('shows each folder as the Mac names it, on its volume, with no names line', async () => {
    serve({ '/api/drives/folders': folders() });
    render(<FoldersCard />);
    await screen.findByText(HOST);
    expect(screen.getByText('/Users/ross/SoulSync/downloads')).toBeInTheDocument();
    expect(screen.queryByText('/app/Transfer')).toBeNull();
    expect(screen.getAllByText('on Macintosh HD')).toHaveLength(3);
    expect(document.querySelector('[data-host-names]')).toBeNull();
  });

  it('falls back to the container’s paths and copies the --names command', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const calls = serve({
      '/api/drives/folders': folders({}, false),
      '/api/drives/docker/command': COMMAND,
    });
    render(<FoldersCard />);
    await screen.findByText('/app/downloads');
    expect(screen.getByText(HOST)).toBeInTheDocument();
    const line = document.querySelector('[data-host-names]') as HTMLElement;
    expect(line).toHaveTextContent(
      'Paths as SYNCHRO.S sees them. To show your Mac’s names, copy the command for Terminal: it runs drives-helper.sh --names.',
    );
    fireEvent.click(within(line).getByRole('button', { name: 'copy the command' }));
    await screen.findByText(/Copied\. Paste it into Terminal on your Mac/);
    expect(writeText).toHaveBeenCalledWith(COMMAND.command);
    const post = calls.find((c) => c.url.includes('/api/drives/docker/command'));
    expect(post).toMatchObject({ method: 'POST', body: { names: true } });
  });

  it('offers no names line on Windows, which has no helper', async () => {
    serve({ '/api/drives/folders': folders({ platform: 'windows' }, false) });
    render(<FoldersCard />);
    await screen.findByText('/app/downloads');
    expect(document.querySelector('[data-host-names]')).toBeNull();
  });

  it('shows a hostile host path as text', async () => {
    const data = folders();
    data.folders[0].host_path = '/Users/<img src=x onerror=alert(1)>';
    serve({ '/api/drives/folders': data });
    render(<FoldersCard />);
    await screen.findByText('/Users/<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });
});

const ROOTS: RemovePreview['roots'] = {
  library: {
    role: 'library',
    label: 'Library',
    path: '/app/Transfer',
    drive: 'Macintosh HD',
    host_path: HOST,
    volume: 'Macintosh HD',
    host_source: 'hint',
  },
};

function preview(patch: Partial<RemovePreview> = {}): RemovePreview {
  return {
    success: true,
    plan_id: 'p1',
    total: 3671,
    total_bytes: 93.2 * GB,
    sample: [
      {
        path: '/app/Transfer/Pale Harbour/Low Tide EP/01 Harbour Light.flac',
        size: 38.1e6,
        action: 'delete',
        reason: 'x',
        role: 'library',
        rel: 'Pale Harbour/Low Tide EP/01 Harbour Light.flac',
      },
      {
        path: '/app/Transfer/Saltmarsh/Lantern/04 Static Bloom.flac',
        size: 29.4e6,
        action: 'delete',
        reason: 'x',
        role: 'library',
        rel: 'Saltmarsh/Lantern/04 Static Bloom.flac',
      },
    ],
    truncated: true,
    created_at: 0,
    expires_at: 0,
    roots: ROOTS,
    platform: 'mac',
    ...patch,
  };
}

const MOVE = {
  id: 1,
  status: 'switched',
  plan: { source_label: 'Macintosh HD', target_label: 'Music HD' },
} as unknown as Move;

describe('the Remove list (19c, 125)', () => {
  it('heads with the Mac’s folder and lists paths relative to it', async () => {
    serve({ '/remove-preview': preview() });
    render(<RemoveOldCopies move={MOVE} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('Pale Harbour/Low Tide EP/01 Harbour Light.flac');
    expect(screen.getByText('On Macintosh HD, in')).toBeInTheDocument();
    expect(screen.getByText(HOST)).toBeInTheDocument();
    expect(screen.getByText('Saltmarsh/Lantern/04 Static Bloom.flac')).toBeInTheDocument();
    expect(screen.queryByText(/\/app\/Transfer/)).toBeNull();
    expect(document.querySelector('[data-host-names]')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'File' })).toBeInTheDocument();
  });

  it('without the Mac’s names heads with the container’s folder and offers --names', async () => {
    const roots = {
      library: { ...ROOTS!.library!, host_path: null, volume: null, host_source: null },
    };
    serve({ '/remove-preview': preview({ roots }) });
    render(<RemoveOldCopies move={MOVE} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('Saltmarsh/Lantern/04 Static Bloom.flac');
    expect(screen.getByText('On Macintosh HD, in')).toBeInTheDocument();
    expect(screen.getByText('/app/Transfer')).toBeInTheDocument();
    expect(document.querySelector('[data-host-names]')).toHaveTextContent(
      'drives-helper.sh --names',
    );
  });

  it('a preview from before roots existed lists the full paths, as before', async () => {
    serve({ '/remove-preview': preview({ roots: undefined, platform: undefined }) });
    render(<RemoveOldCopies move={MOVE} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('/app/Transfer/Saltmarsh/Lantern/04 Static Bloom.flac');
    expect(screen.getByRole('columnheader', { name: 'File on Macintosh HD' })).toBeInTheDocument();
    expect(screen.queryByText('On Macintosh HD, in')).toBeNull();
  });

  it('over several folders, each heads its own rows', () => {
    const roots = {
      ...ROOTS,
      staging: {
        role: 'staging' as const,
        label: 'Staging',
        path: '/app/Staging',
        drive: 'Macintosh HD',
        host_path: null,
      },
    };
    const sample = [
      {
        path: '/app/Staging/A/01.flac',
        size: 1,
        action: 'delete',
        reason: '',
        role: 'staging' as const,
        rel: 'A/01.flac',
      },
      ...preview().sample,
    ];
    const out = removeRows({ sample, roots }, 'Macintosh HD');
    expect(out.head).toBeNull();
    expect(out.rows.map((r) => (r.heading ? 'head' : r.key))).toEqual([
      'head',
      '/app/Staging/A/01.flac',
      'head',
      sample[1].path,
      sample[2].path,
    ]);
    expect(rootHead(roots.staging, 'Macintosh HD')).toEqual({
      label: 'On Macintosh HD, in',
      path: '/app/Staging',
    });
    expect(rootHead(roots.library!, 'x')).toEqual({ label: 'On Macintosh HD, in', path: HOST });
  });

  it('confirms the preview’s own plan, whatever the names say', async () => {
    const calls = serve({
      '/remove-preview': preview(),
      '/api/drives/move/1/remove': {
        success: true,
        deleted: 2,
        freed_bytes: 1,
        skipped: 0,
        move: null,
      },
    });
    const onDone = vi.fn();
    render(<RemoveOldCopies move={MOVE} onClose={vi.fn()} onDone={onDone} />);
    await screen.findByText(HOST);
    fireEvent.click(screen.getByLabelText('I checked the list'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete 3,671 files' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3,671 files' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const remove = calls.find((c) => c.url.endsWith('/api/drives/move/1/remove'));
    expect(remove?.body).toEqual({ plan_id: 'p1' });
  });
});

describe('the move flow (125)', () => {
  const base = {
    order: ['library', 'staging'],
    dests: { library: '/drives/d/SYNCHRO.S/Library', staging: '/drives/d/SYNCHRO.S/Staging' },
  } as unknown as Move['plan'];
  const f = (role: 'library' | 'staging', host: string | null) => ({
    role,
    label: role,
    files: 0,
    bytes: 0,
    copied_files: 0,
    copied_bytes: 0,
    verified: 0,
    dest_host_path: host,
  });

  it('names the plan’s destination as the computer does', () => {
    expect(
      planTarget({
        plan: base,
        folders: [f('library', 'D:\\SYNCHRO.S\\Library'), f('staging', 'D:\\SYNCHRO.S\\Staging')],
      }),
    ).toBe('D:\\SYNCHRO.S');
    expect(
      planTarget({
        plan: base,
        folders: [f('library', 'D:\\SYNCHRO.S\\Library'), f('staging', null)],
      }),
    ).toBe('/drives/d/SYNCHRO.S');
  });

  it('Done’s check shows the computer’s path for the new folder', () => {
    const m = {
      id: 1,
      status: 'switched',
      promise: { tone: 'success', words: '' },
      plan: { source_label: 'C:', target_label: 'D:', total_bytes: 1, dests: {} },
      folders: [],
      result: {
        checks: [
          {
            key: 'library',
            ok: true,
            title: 'Library: 1 of 1 files found',
            detail: '/drives/d/SYNCHRO.S/Library',
            detail_host: 'D:\\SYNCHRO.S\\Library',
            mono: true,
          },
        ],
      },
    } as unknown as Move;
    render(
      <DoneStep
        payload={{ success: true, move: m, boot_id: 'b', running: false }}
        move={m}
        busy={false}
        error={null}
        act={vi.fn(async () => true)}
        close={vi.fn()}
        done={vi.fn()}
      />,
    );
    expect(screen.getByText('D:\\SYNCHRO.S\\Library')).toBeInTheDocument();
    expect(screen.queryByText('/drives/d/SYNCHRO.S/Library')).toBeNull();
  });
});
