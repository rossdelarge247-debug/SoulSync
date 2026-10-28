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

const NOT_SET_UP = {
  success: true,
  state: 'not_set_up',
  tone: 'skipped',
  headline: 'The privacy check isn’t set up',
  configured: false,
  rows: [],
  settings: { gluetun_url: '', api_key_set: false, home_ip_lookup: false },
  vpn: null,
  addresses: { vpn: null, home: null, home_lookup: false },
  ran_at: Date.now() / 1000,
};

const PROTECTED = {
  success: true,
  state: 'protected',
  tone: 'ok',
  headline:
    'Soulseek and torrents go through Proton VPN (Netherlands) · port 51234 forwarded · if the VPN drops, they stop',
  configured: true,
  rows: [
    {
      id: 'privacy.vpn',
      title: 'VPN',
      status: 'ok',
      detail: 'Proton VPN is connected (Netherlands).',
      fix: '',
    },
    {
      id: 'privacy.port',
      title: 'Forwarded port',
      status: 'ok',
      detail: 'Port 51234 is forwarded and slskd and qBittorrent listen on it.',
      fix: '',
    },
  ],
  settings: { gluetun_url: 'http://gluetun:8000', api_key_set: true, home_ip_lookup: true },
  vpn: {
    up: true,
    status: 'running',
    name: 'Proton VPN',
    country: 'Netherlands',
    city: 'Amsterdam',
    forwarded_port: 51234,
  },
  addresses: { vpn: '185.65.134.10', home: '81.2.69.160', home_lookup: true },
  ran_at: Date.now() / 1000,
};

const VPN_DOWN = {
  ...PROTECTED,
  state: 'vpn_down',
  tone: 'error',
  headline: 'VPN is down: Soulseek and torrents are stopped until it’s back',
  rows: [
    {
      id: 'privacy.vpn',
      title: 'VPN',
      status: 'error',
      detail: 'Proton VPN isn’t connected (Gluetun says ‘stopped’).',
      fix: 'Gluetun reconnects by itself. If it stays down, open its log (`docker compose logs gluetun`).',
    },
  ],
  vpn: { ...PROTECTED.vpn, up: false, status: 'stopped', forwarded_port: null },
  addresses: { vpn: null, home: null, home_lookup: true },
};

function mockPrivacy(body: object = NOT_SET_UP) {
  const puts: unknown[] = [];
  let gets = 0;
  server.use(
    http.get('/api/setup/privacy', () => {
      gets += 1;
      return HttpResponse.json(body);
    }),
    http.put('/api/setup/privacy/settings', async ({ request }) => {
      const sent = (await request.json()) as Record<string, unknown>;
      puts.push(sent);
      if (sent.gluetun_url === 'gluetun:8000') {
        return HttpResponse.json(
          {
            success: false,
            field: 'gluetun_url',
            error: 'Type Gluetun’s control address with http://',
          },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        success: true,
        settings: {
          gluetun_url: sent.gluetun_url,
          api_key_set: true,
          home_ip_lookup: sent.home_ip_lookup,
        },
      });
    }),
  );
  return { puts, gets: () => gets };
}

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
    http.get('/api/setup/privacy', () => HttpResponse.json(NOT_SET_UP)),
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
    expect(text).toContain('SYNCHRO.S setup check');
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

  describe('Privacy card', () => {
    it('says how to set it up when Gluetun’s address isn’t set', async () => {
      mockSetupCheckApi();
      mockPrivacy(NOT_SET_UP);
      renderPage();

      const card = await screen.findByTestId('privacy-card');
      expect(card).toHaveAttribute('data-state', 'not_set_up');
      expect(within(card).getByRole('status')).toHaveTextContent('The privacy check isn’t set up');
      expect(card).toHaveTextContent('everyone they connect to sees your home IP');
      expect(card).toHaveTextContent('Support/VPN.md');
      // the settings are open, and the home look-up is off and explained
      expect(within(card).getByLabelText('Gluetun’s control address')).toBeVisible();
      const lookup = within(card).getByRole('switch', { name: 'Compare with my home IP' });
      expect(lookup).toHaveAttribute('aria-checked', 'false');
      expect(card).toHaveTextContent('api.ipify.org');
      expect(card).toHaveTextContent('at most once an hour');
    });

    it('shows the plain-language state, the addresses and the rows when protected', async () => {
      mockSetupCheckApi();
      mockPrivacy(PROTECTED);
      renderPage();

      const card = await screen.findByTestId('privacy-card');
      await within(card).findByText(PROTECTED.headline);
      expect(within(card).getByRole('status')).toHaveTextContent('OK');
      const addresses = within(card).getByTestId('privacy-addresses');
      expect(addresses).toHaveTextContent('185.65.134.10');
      expect(addresses).toHaveTextContent('Proton VPN, Amsterdam, Netherlands');
      expect(addresses).toHaveTextContent('81.2.69.160');
      expect(within(card).getByText('Forwarded port')).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Check privacy again' })).toBeEnabled();
    });

    it('says plainly that downloads are stopped while the VPN is down', async () => {
      mockSetupCheckApi();
      mockPrivacy(VPN_DOWN);
      renderPage();

      const card = await screen.findByTestId('privacy-card');
      await within(card).findByText(VPN_DOWN.headline);
      expect(within(card).getByRole('status')).toHaveTextContent('Problem');
      expect(within(card).queryByTestId('privacy-addresses')).not.toBeInTheDocument();
      expect(within(card).getByText('How to fix it')).toBeInTheDocument();
    });

    it('saves the settings and checks again', async () => {
      mockSetupCheckApi();
      const api = mockPrivacy(NOT_SET_UP);
      renderPage();

      const card = await screen.findByTestId('privacy-card');
      fireEvent.change(within(card).getByLabelText('Gluetun’s control address'), {
        target: { value: 'http://gluetun:8000' },
      });
      fireEvent.change(within(card).getByLabelText('Gluetun key'), {
        target: { value: 'k3y' },
      });
      fireEvent.click(within(card).getByRole('switch', { name: 'Compare with my home IP' }));
      const before = api.gets();
      fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.puts).toHaveLength(1));
      expect(api.puts[0]).toEqual({
        gluetun_url: 'http://gluetun:8000',
        api_key: 'k3y',
        home_ip_lookup: true,
      });
      await waitFor(() => expect(api.gets()).toBeGreaterThan(before));
      expect(window.showToast).toHaveBeenCalledWith('Privacy check settings saved', 'success');
    });

    it('leaves a saved key alone when the field is empty, and shows a field error', async () => {
      mockSetupCheckApi();
      const api = mockPrivacy(NOT_SET_UP);
      renderPage();

      const card = await screen.findByTestId('privacy-card');
      fireEvent.change(within(card).getByLabelText('Gluetun’s control address'), {
        target: { value: 'gluetun:8000' },
      });
      fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(api.puts).toHaveLength(1));
      expect(api.puts[0]).toEqual({ gluetun_url: 'gluetun:8000', home_ip_lookup: false });
      expect(
        await within(card).findByText('Type Gluetun’s control address with http://'),
      ).toBeVisible();
    });

    it('keeps the privacy rows out of the generic groups', async () => {
      mockSetupCheckApi();
      mockPrivacy(PROTECTED);
      server.use(
        http.get('/api/setup/check', ({ request }) => {
          const scope =
            new URL(request.url).searchParams.get('scope') === 'local' ? 'local' : 'all';
          const body = report(scope);
          if (scope === 'all') {
            body.checks = [
              ...body.checks,
              {
                id: 'privacy.vpn',
                title: 'VPN',
                status: 'ok',
                detail: 'Proton VPN is connected (Netherlands).',
                fix: '',
                category: 'privacy',
              },
            ];
          }
          return HttpResponse.json(body);
        }),
      );
      renderPage();

      await screen.findByText('Media server connection');
      expect(groupHeadings().some((h) => h?.startsWith('Privacy'))).toBe(false);
    });

    it('isn’t shown to a non-admin', async () => {
      mockSetupCheckApi();
      const api = mockPrivacy(PROTECTED);
      renderPage(false);

      await screen.findByRole('heading', { name: 'Only an admin can run the setup check' });
      expect(screen.queryByTestId('privacy-card')).not.toBeInTheDocument();
      expect(api.gets()).toBe(0);
    });
  });
});
