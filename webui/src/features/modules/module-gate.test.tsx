/**
 * A turned-off module's pages show "<Module> is turned off" instead of the
 * page: on load (from the states the page shell rendered with, or GET
 * /api/modules), and as soon as one of the page's calls answers 409
 * module_disabled.
 */

import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

const PODCASTS = { name: 'podcasts', display_name: 'Podcasts', pages: ['podcasts'] };
const AUDIOBOOKS = { name: 'audiobooks', display_name: 'Audiobooks', pages: ['audiobooks'] };
const STUDIO = { name: 'sample_studio', display_name: 'Sample Studio', pages: ['sample-studio'] };
const VIDEO = {
  name: 'video',
  display_name: 'Video',
  pages: ['video-dashboard', 'video-library', 'video-downloads'],
};

function renderAt(path: string) {
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ history, queryClient });
  render(<AppRouterProvider router={router} queryClient={queryClient} />);
  return router;
}

function serveModules(modules: object[]) {
  const asked = vi.fn();
  server.use(
    http.get('/api/modules', () => {
      asked();
      return HttpResponse.json({ success: true, modules });
    }),
  );
  return asked;
}

const disabled = (module: string, display: string) =>
  HttpResponse.json(
    {
      success: false,
      error: 'module_disabled',
      module,
      message: `${display} is turned off. An admin can turn it back on in Settings.`,
    },
    { status: 409 },
  );

beforeEach(() => {
  window.SoulSyncWebShellBridge = createShellBridge();
});

afterEach(() => {
  cleanup();
  delete window.SOULSYNC_MODULES;
  delete window.openModulesSettings;
});

describe('a turned-off module page', () => {
  it('shows the notice and never calls the module API', async () => {
    serveModules([{ ...PODCASTS, enabled: false }]);
    const calls = vi.fn();
    server.use(
      http.get('/api/podcasts/*', () => {
        calls();
        return disabled('podcasts', 'Podcasts');
      }),
    );
    renderAt('/podcasts');

    expect(await screen.findByRole('heading', { name: 'Podcasts is turned off' })).toBeVisible();
    expect(
      screen.getByText("Podcasts' pages and downloads are off until the module is turned back on."),
    ).toBeInTheDocument();
    expect(screen.getByText('Module off')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings → Modules' })).toHaveAttribute(
      'href',
      '/settings?tab=modules',
    );
    expect(calls).not.toHaveBeenCalled();
    // it still takes over the React host like the page would
    expect(window.SoulSyncWebShellBridge!.showReactHost).toHaveBeenCalledWith('podcasts');
  });

  it('uses the states the page shell rendered with, without asking again', async () => {
    window.SOULSYNC_MODULES = [{ ...AUDIOBOOKS, enabled: false }];
    const asked = serveModules([{ ...AUDIOBOOKS, enabled: false }]);
    renderAt('/audiobooks');
    expect(await screen.findByRole('heading', { name: 'Audiobooks is turned off' })).toBeVisible();
    expect(asked).not.toHaveBeenCalled();
  });

  it('gates Sample Studio the same way', async () => {
    serveModules([{ ...STUDIO, enabled: false }]);
    renderAt('/sample-studio');
    expect(
      await screen.findByRole('heading', { name: 'Sample Studio is turned off' }),
    ).toBeVisible();
  });

  it('tells a non-admin who can turn it back on, with no Settings link', async () => {
    window.SoulSyncWebShellBridge = createShellBridge({
      getCurrentProfileContext: vi.fn(() => ({ profileId: 4, isAdmin: false })),
    });
    serveModules([{ ...PODCASTS, enabled: false }]);
    renderAt('/podcasts');
    expect(await screen.findByRole('heading', { name: 'Podcasts is turned off' })).toBeVisible();
    expect(
      screen.getByText('An admin can turn it back on in Settings → Modules.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Settings/ })).toBeNull();
  });

  it('the link hands off to the shell when it can', async () => {
    const open = vi.fn();
    window.openModulesSettings = open;
    serveModules([{ ...PODCASTS, enabled: false }]);
    renderAt('/podcasts');
    (await screen.findByRole('link', { name: 'Open Settings → Modules' })).click();
    expect(open).toHaveBeenCalledOnce();
  });

  it('a bookmarked video page says Video is off', async () => {
    serveModules([{ ...VIDEO, enabled: false }]);
    renderAt('/video-library');
    expect(await screen.findByRole('heading', { name: 'Video is turned off' })).toBeVisible();
    expect(
      screen.getByText(
        'Movies, TV and YouTube pages and video downloads are off until the module is turned back on.',
      ),
    ).toBeInTheDocument();
  });

  it('a video page while Video is on goes to the legacy shell as before', async () => {
    serveModules([{ ...VIDEO, enabled: true }]);
    renderAt('/video-library');
    await vi.waitFor(() =>
      expect(window.SoulSyncWebShellBridge!.activateLegacyPath).toHaveBeenCalledWith(
        '/video-library',
      ),
    );
    expect(screen.queryByRole('heading', { name: 'Video is turned off' })).toBeNull();
  });
});

describe('a module turned off while its page is open', () => {
  it('a 409 module_disabled answer swaps the page for the notice', async () => {
    serveModules([{ ...PODCASTS, enabled: true }]);
    server.use(
      http.get('/api/podcasts/*', () => disabled('podcasts', 'Podcasts')),
      http.post('/api/podcasts/*', () => disabled('podcasts', 'Podcasts')),
    );
    renderAt('/podcasts');
    expect(await screen.findByRole('heading', { name: 'Podcasts is turned off' })).toBeVisible();
    expect(screen.queryByPlaceholderText(/Search podcasts/i)).toBeNull();
  });

  it('follows the shell when Settings turns the module off', async () => {
    serveModules([{ ...STUDIO, enabled: true }]);
    server.use(
      http.get('/api/sample/*', () => HttpResponse.json({ success: true, data: {} })),
      http.get('/api/library/tracks*', () => HttpResponse.json({ success: true, data: [] })),
    );
    renderAt('/sample-studio');
    await vi.waitFor(() =>
      expect(window.SoulSyncWebShellBridge!.showReactHost).toHaveBeenCalledWith('sample-studio'),
    );
    window.dispatchEvent(
      new CustomEvent('soulsync:modules-changed', {
        detail: { modules: [{ ...STUDIO, enabled: false }] },
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Sample Studio is turned off' }),
    ).toBeVisible();
  });
});
