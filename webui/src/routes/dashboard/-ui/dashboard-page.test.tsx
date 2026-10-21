/**
 * /dashboard is Home: the page shell, end to end through the router.
 *
 * - id="dashboard-page" on the root (worker-orbs' anchor, the stylesheet's
 *   scope, the tour), WITHOUT the `page` class (the label-detail trap:
 *   `.page` is display:none unless the vanilla shell adds `.active`).
 * - the design's content first: the header, Targets, Latest; then "Library
 *   and system" with everything the dashboard had, the tour's ids and the
 *   orb stage intact.
 * - the worker-orbs re-ping on mount (the shell bridge's setPage fires before
 *   React paints; the orb layer re-anchors lazily on this second call).
 */

import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRouterProvider, createAppRouter } from '@/app/router';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';
import { createShellBridge } from '@/test/shell-bridge';

function mockApi() {
  server.use(
    http.get('/api/targets/summary', () =>
      HttpResponse.json({
        success: true,
        any_set_up: true,
        targets: [
          { key: 'wanted', set_up: true, status: 'searching', items: 12, have: 2, in_progress: 10 },
          { key: 'mirrored', set_up: false, status: 'not_set_up' },
          { key: 'followed', set_up: false, status: 'not_set_up' },
          { key: 'quality', set_up: true, status: 'ok', name: 'FLAC or better', items: 4, have: 4 },
        ],
      }),
    ),
    http.get('/api/activity', () => HttpResponse.json({ success: true, items: [] })),
    // the rest of the page ("Library and system") renders around failures
    http.all('*', () => HttpResponse.json({}, { status: 404 })),
  );
}

function renderHome() {
  window.SoulSyncWebShellBridge = createShellBridge({
    getProfileHomePage: vi.fn(() => 'dashboard' as const),
  });
  const queryClient = createTestQueryClient();
  const history = createMemoryHistory({ initialEntries: ['/dashboard'] });
  const router = createAppRouter({ history, queryClient });
  return render(<AppRouterProvider router={router} queryClient={queryClient} />);
}

afterEach(() => {
  cleanup();
  window.SoulSyncWebShellBridge = undefined;
  delete window.workerOrbs;
});

describe('the Home page shell', () => {
  it('keeps the id, drops the .page class, and puts the design first', async () => {
    mockApi();
    const view = renderHome();
    await screen.findByText('12 tracks', undefined, { timeout: 10_000 });

    const root = view.container.querySelector('#dashboard-page')!;
    expect(root).not.toBeNull();
    expect(root.classList.contains('page')).toBe(false);

    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(
      screen.getByText('What you want, what you have, and what SoulSync is doing about the gap.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search for music' })).toHaveAttribute(
      'href',
      '/search',
    );

    // in page order: Targets, Latest, then the rest under its own heading
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent)
      .filter((t) => ['Targets', 'Latest', 'Library and system'].includes(t ?? ''));
    expect(headings).toEqual(['Targets', 'Latest', 'Library and system']);
    expect(screen.getAllByTestId('home-target')).toHaveLength(4);
  });

  it('keeps every section of the old dashboard under "Library and system"', async () => {
    mockApi();
    const view = renderHome();
    await screen.findByText('12 tracks', undefined, { timeout: 10_000 });
    const more = screen.getByTestId('home-more');

    expect(within(more).getByRole('heading', { level: 3, name: 'Library' })).toBeInTheDocument();
    expect(within(more).getByRole('heading', { name: 'Enrichment workers' })).toBeInTheDocument();
    const cards = Array.from(more.querySelectorAll('[data-card]')).map((c) =>
      c.getAttribute('data-card'),
    );
    for (const card of ['library', 'active-downloads', 'listen', 'sync', 'automations']) {
      expect(cards, card).toContain(card);
    }
    // the tour's anchors and worker-orbs' stage
    for (const selector of [
      '#library-status-card',
      '#watchlist-button',
      '#wishlist-button',
      '#manage-enrichment-btn',
      '.dashboard-header .header-actions',
      '.dash-footer .dash-quick-settings',
    ]) {
      expect(more.querySelector(selector), selector).not.toBeNull();
    }
    expect(
      view.container.querySelector('#dashboard-page .orb-stage .header-actions'),
    ).not.toBeNull();
    // the greeting went with the old hero; Home's header replaced it
    expect(view.container.querySelector('.hello-greeting')).toBeNull();
  });

  it('re-pings worker-orbs after mount so the lazy re-anchor finds the stage', async () => {
    mockApi();
    const setPage = vi.fn();
    window.workerOrbs = { setPage, onStatus: vi.fn() } as never;
    renderHome();
    await screen.findByText('12 tracks', undefined, { timeout: 10_000 });
    expect(setPage).toHaveBeenCalledWith('dashboard');
  });
});
