import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

const LOCAL_CHECKS = [
  {
    id: 'folder.downloads',
    title: 'Download folder',
    status: 'ok',
    detail: '/downloads exists and SoulSync can read and write it; 214 GB free.',
    fix: '',
    category: 'folders',
    data: { path: '/downloads', free_gb: 214 },
  },
  {
    id: 'folder.transfer',
    title: 'Music library folder',
    status: 'error',
    detail: "The music library folder /music doesn't exist.",
    fix:
      "Map a folder from your server to it: add a line like `- /path/on/your/server:/music` under SoulSync's " +
      'volumes in docker-compose and recreate the container (docker compose up -d).',
    category: 'folders',
  },
  {
    id: 'folders.layout',
    title: 'Folder layout',
    status: 'ok',
    detail: 'Your download and music library folders are separate folders.',
    fix: '',
    category: 'folders',
  },
  {
    id: 'system.user',
    title: 'User SoulSync runs as',
    status: 'warning',
    detail: 'SoulSync is running as root.',
    fix: 'Set PUID and PGID in docker-compose to your own user’s IDs (run `id` on the server to see them).',
    category: 'system',
  },
];

const NETWORK_CHECKS = [
  {
    id: 'slskd.connection',
    title: 'slskd connection',
    status: 'ok',
    detail: 'Connected to slskd at http://slskd:5030.',
    fix: '',
    category: 'downloads',
  },
  {
    id: 'media_server.connection',
    title: 'Media server connection',
    status: 'ok',
    detail: 'Connected to Plex at http://plex:32400.',
    fix: '',
    category: 'media_server',
  },
  {
    id: 'media_server.library_path',
    title: 'Media server sees the music library folder',
    status: 'skipped',
    detail: 'Plex doesn’t report where its music folder is.',
    fix: '',
    category: 'media_server',
  },
];

function report(scope: 'all' | 'local') {
  const checks = scope === 'local' ? LOCAL_CHECKS : [...LOCAL_CHECKS, ...NETWORK_CHECKS];
  return {
    success: true,
    status: 'error',
    summary: { ok: 0, warning: 0, error: 0, skipped: 0 },
    checks,
    scope,
    ran_at: Date.now() / 1000,
    duration_ms: scope === 'local' ? 300 : 4200,
  };
}

type Calls = Array<'all' | 'local'>;

function mockSetupCheckApi({
  gate,
  setupComplete = true,
  status = 200,
  fullFails = false,
}: {
  gate?: Promise<void>;
  setupComplete?: boolean;
  status?: number;
  fullFails?: boolean;
} = {}): Calls {
  const calls: Calls = [];
  server.use(
    http.get('/api/setup/check', async ({ request }) => {
      const scope = new URL(request.url).searchParams.get('scope') === 'local' ? 'local' : 'all';
      calls.push(scope);
      if (status !== 200) {
        return HttpResponse.json({ success: false, error: 'Admin access required' }, { status });
      }
      if (scope === 'all' && fullFails) {
        return HttpResponse.json({ success: false, error: 'boom' }, { status: 500 });
      }
      if (scope === 'all' && gate) await gate;
      return HttpResponse.json(report(scope));
    }),
    http.get('/api/setup/status', () => HttpResponse.json({ setup_complete: setupComplete })),
  );
  return calls;
}

function renderPage(isAdmin = true) {
  window.SoulSyncWebShellBridge = createShellBridge({
    getCurrentProfileContext: vi.fn(() => ({ profileId: isAdmin ? 1 : 3, isAdmin })),
  });
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: ['/setup-check'] });
  const router = createAppRouter({ history, queryClient });
  return render(<AppRouterProvider router={router} queryClient={queryClient} />);
}

function groupHeadings() {
  return screen
    .getAllByTestId('setup-check-group')
    .map((group) => within(group).getByRole('heading', { level: 2 }).textContent);
}

describe('setup check route', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.showToast = vi.fn();
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    window.SoulSyncWebShellBridge = undefined;
    window.showToast = undefined;
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('carries the guided tour’s anchor on its header', async () => {
    mockSetupCheckApi();
    renderPage();
    const title = await screen.findByRole('heading', { level: 1, name: 'Setup check' });
    expect(title.closest('[data-tour="setup-check"]')).not.toBeNull();
  });

  it('renders the results grouped by category, problems first', async () => {
    mockSetupCheckApi();
    renderPage();

    expect(await screen.findByText('Media server connection')).toBeInTheDocument();
    expect(groupHeadings()).toEqual([
      'Folders · 1 problem',
      'System · 1 warning',
      'Downloads (slskd) · all OK',
      'Media server · all OK',
    ]);

    // inside a group the problem leads, with its status word next to it
    const folders = screen.getAllByTestId('setup-check-group')[0];
    const rows = within(folders).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Music library folder');
    expect(within(rows[0]).getByText('Problem')).toBeInTheDocument();
    expect(within(rows[0]).getByText('How to fix it')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Download folder');
    expect(within(rows[1]).getByText('OK')).toBeInTheDocument();
    // an OK row is one line: no fix box
    expect(within(rows[1]).queryByText('How to fix it')).not.toBeInTheDocument();

    const summary = screen.getByTestId('setup-check-summary');
    expect(summary).toHaveTextContent('4checks OK');
    expect(summary).toHaveTextContent('1 skipped');
    expect(summary).toHaveTextContent('1warning');
    expect(summary).toHaveTextContent('1problem');
    expect(summary).toHaveTextContent('last checked, took 4.2 s');
  });

  it('shows the fix text with copyable code', async () => {
    mockSetupCheckApi();
    renderPage();

    const line = await screen.findByText('- /path/on/your/server:/music');
    expect(line.tagName).toBe('CODE');
    // short code stays inline in the sentence
    expect(screen.getByText('id').tagName).toBe('CODE');

    fireEvent.click(screen.getByRole('button', { name: 'Copy - /path/on/your/server:/music' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('- /path/on/your/server:/music'));
    expect(
      await screen.findByRole('button', { name: 'Copy - /path/on/your/server:/music' }),
    ).toHaveTextContent('Copied');
  });

  it('copies a plain-text report for a bug report', async () => {
    mockSetupCheckApi();
    renderPage();

    await screen.findByText('Media server connection');
    fireEvent.click(screen.getByRole('button', { name: 'Copy for a bug report' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain('SoulSync setup check');
    expect(text).toContain('[Problem] Music library folder');
    expect(text).toContain('[Warning] User SoulSync runs as');
    expect(text).toContain('[OK] slskd connection');
  });

  it('runs the whole check again from the header and from a fix box', async () => {
    const calls = mockSetupCheckApi();
    renderPage();

    await screen.findByText('Media server connection');
    expect([...calls].sort()).toEqual(['all', 'local']);

    fireEvent.click(screen.getByRole('button', { name: 'Run the check again' }));
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.slice(2).sort()).toEqual(['all', 'local']);

    await screen.findByRole('button', { name: 'Run the check again' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Run this check again' })[0]);
    await waitFor(() => expect(calls).toHaveLength(6));
  });

  it('shows the local results and progress while slskd and the media server are checked', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockSetupCheckApi({ gate });
    renderPage();

    expect(await screen.findByText('Music library folder')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '25');
    expect(screen.getByText('Checking slskd and your media server…')).toBeInTheDocument();
    expect(screen.getByTestId('setup-check-summary')).toHaveTextContent('Checking…');
    // the header button and the fix boxes' buttons wait for the run
    const busy = screen.getAllByRole('button', { name: 'Checking…' });
    expect(busy.length).toBeGreaterThan(1);
    for (const button of busy) expect(button).toBeDisabled();
    expect(screen.queryByText('slskd connection')).not.toBeInTheDocument();

    release();
    expect(await screen.findByText('slskd connection')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run the check again' })).toBeEnabled();
  });

  it('keeps the folder results and offers a retry when the full run fails', async () => {
    const calls = mockSetupCheckApi({ fullFails: true });
    renderPage();

    expect(await screen.findByText('Music library folder')).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('slskd and the media server weren’t checked');
    expect(alert).toHaveTextContent('The full check didn’t finish: boom.');
    expect(alert).toHaveTextContent('from the folder checks only');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toHaveLength(4));
  });

  it('tells a non-admin the check is admin-only without calling it', async () => {
    const calls = mockSetupCheckApi();
    renderPage(false);

    expect(
      await screen.findByRole('heading', { name: 'Only an admin can run the setup check' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run the check again' })).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('shows the admin-only message rather than an error when the server refuses', async () => {
    mockSetupCheckApi({ status: 403 });
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Only an admin can run the setup check' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the first-run steps only while first-run setup is unfinished', async () => {
    mockSetupCheckApi({ setupComplete: false });
    const view = renderPage();

    const steps = await screen.findByRole('heading', { name: 'First-run setup' });
    const section = steps.closest('section') as HTMLElement;
    await within(section).findByText(/Step 3 · Done/);
    expect(
      within(section).getByText('1 problem left to fix.', { exact: false }),
    ).toBeInTheDocument();
    // the folders step is the first one that isn't done
    expect(within(section).getByText('Choose your folders').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    view.unmount();

    mockSetupCheckApi({ setupComplete: true });
    renderPage();
    await screen.findByText('Media server connection');
    expect(screen.queryByRole('heading', { name: 'First-run setup' })).not.toBeInTheDocument();
  });
});
