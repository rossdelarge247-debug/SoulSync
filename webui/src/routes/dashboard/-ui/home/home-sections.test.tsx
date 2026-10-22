/**
 * Home's Targets and Latest sections, rendered with their real queries over
 * MSW: every card state (live, searching, not set up, can't search), the
 * fold into one panel when nothing is set up, Latest, the links, and the
 * loading and failure states.
 */

import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { delay } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import { latestActivityQueryOptions, targetsSummaryQueryOptions } from '../../-home.api';
import { HomeDialogsProvider } from './home-dialogs';
import { HomeNavProvider, type HomeNav } from './home-nav';
import { LatestSection } from './latest-section';
import { TargetsSection } from './targets-section';

const NOW = new Date(2026, 9, 21, 19, 30).getTime();
const at = (day: number, hh: number, mm = 0) => new Date(2026, 9, day, hh, mm).getTime() / 1000;

const T = {
  wanted: {
    key: 'wanted',
    set_up: true,
    status: 'searching',
    items: 312,
    have: 248,
    in_progress: 41,
    not_found_yet: 23,
    next_search_at: at(21, 21, 30),
    schedule_paused: false,
  },
  mirroredOff: { key: 'mirrored', set_up: false, status: 'not_set_up', items: 0, playlists: 0 },
  mirrored: {
    key: 'mirrored',
    set_up: true,
    status: 'ok',
    items: 1140,
    have: 1140,
    in_progress: 0,
    not_found_yet: 0,
    playlists: 3,
    next_search_at: at(22, 6),
  },
  followedOff: { key: 'followed', set_up: false, status: 'not_set_up', artists: 0 },
  followed: {
    key: 'followed',
    set_up: true,
    status: 'searching',
    items: 52,
    have: 31,
    in_progress: 14,
    not_found_yet: 7,
    artists: 18,
    next_search_at: at(22, 6),
  },
  wantedOff: { key: 'wanted', set_up: false, status: 'not_set_up', items: 0 },
  quality: {
    key: 'quality',
    set_up: true,
    status: 'searching',
    name: 'FLAC or better',
    tracks_checked: 4980,
    items: 4980,
    have: 4512,
    in_progress: 120,
    not_found_yet: 348,
    next_search_at: at(22, 2),
  },
};

const REASON =
  "Soulseek (slskd) didn't answer when SoulSync last checked, 4 minutes ago, so searches can't run.";
const cant = (t: Record<string, unknown>) => ({ ...t, status: 'cant_search', reason: REASON });

function summary(targets: Record<string, unknown>[]) {
  return {
    success: true,
    targets,
    any_set_up: targets.some((t) => t.key !== 'quality' && t.set_up),
    generated_at: NOW / 1000,
  };
}

function mockSummary(targets: Record<string, unknown>[]) {
  let calls = 0;
  server.use(
    http.get('/api/targets/summary', () => {
      calls += 1;
      return HttpResponse.json(summary(targets));
    }),
  );
  return () => calls;
}

const LATEST = [
  {
    id: 'lh:1',
    time: at(21, 14, 2),
    kind: 'download',
    status: 'ok',
    title: 'Downloaded 12 tracks',
    detail: 'Lantern by Saltmarsh and 1 more · Soulseek · FLAC',
    link: '/active-downloads',
    needs_you: false,
  },
  {
    id: 'safety:31',
    time: at(21, 13, 40),
    kind: 'safety',
    status: 'warning',
    title: 'Duplicate cleaner preview expired',
    detail: 'Nothing was changed. Preview again to recycle 214 duplicate files (3.2 GB).',
    link: '/tools',
    needs_you: true,
  },
  {
    id: 'automation:812',
    time: at(20, 9, 15),
    kind: 'automation',
    status: 'error',
    title: 'Automation "Fill Wanted" failed',
    detail: "Soulseek wasn't reachable.",
    link: '/automations',
    needs_you: false,
  },
];

function Targets() {
  const query = useQuery(targetsSummaryQueryOptions(1));
  return <TargetsSection query={query} nowMs={NOW} />;
}

function Latest() {
  const query = useQuery(latestActivityQueryOptions(1));
  return <LatestSection query={query} nowMs={NOW} />;
}

const allowAll: HomeNav = { isAdmin: true, isPageAllowed: () => true };

function renderWith(ui: React.ReactNode, nav: HomeNav = allowAll) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <HomeNavProvider value={nav}>
        <HomeDialogsProvider>{ui}</HomeDialogsProvider>
      </HomeNavProvider>
    </QueryClientProvider>,
  );
}

const card = (key: string) =>
  screen.getAllByTestId('home-target').find((el) => el.getAttribute('data-target') === key)!;

let navigateToPage: ReturnType<typeof vi.fn<(pageId: string) => void>>;
let requestSettingsTab: ReturnType<typeof vi.fn<(tab: string) => void>>;

beforeEach(() => {
  navigateToPage = vi.fn<(pageId: string) => void>();
  requestSettingsTab = vi.fn<(tab: string) => void>();
  window.navigateToPage = navigateToPage;
  window.requestSettingsTab = requestSettingsTab;
});

afterEach(() => {
  Reflect.deleteProperty(window, 'navigateToPage');
  Reflect.deleteProperty(window, 'requestSettingsTab');
});

describe('Targets', () => {
  it('shows the four targets in their fixed order, live and not set up', async () => {
    mockSummary([T.quality, T.followedOff, T.wanted, T.mirroredOff]);
    renderWith(<Targets />);
    await screen.findByText('312 tracks');

    const cards = screen.getAllByTestId('home-target');
    expect(cards.map((c) => c.getAttribute('data-target'))).toEqual([
      'wanted',
      'mirrored',
      'followed',
      'quality',
    ]);
    expect(cards.map((c) => c.getAttribute('data-state'))).toEqual([
      'live',
      'not-set-up',
      'not-set-up',
      'live',
    ]);
    expect(screen.getByRole('heading', { level: 2, name: 'Targets' })).toBeInTheDocument();
    expect(screen.getByText('Searches run on the Automations schedule.')).toBeInTheDocument();
  });

  it('a live card: label, title, a status word, the bar and three numbers', async () => {
    mockSummary([T.wanted, T.mirroredOff, T.followedOff, T.quality]);
    renderWith(<Targets />);
    await screen.findByText('312 tracks');

    const wanted = within(card('wanted'));
    expect(wanted.getByText('Wanted')).toBeInTheDocument();
    expect(
      wanted.getByText('Searching', { selector: '[data-slot="status-tag"]' }),
    ).toBeInTheDocument();
    const bar = wanted.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '248');
    expect(bar).toHaveAttribute('aria-valuetext', '248 of 312 tracks');
    const values = Array.from(card('wanted').querySelectorAll('dd')).map((d) => d.textContent);
    expect(values).toEqual(['248', '41', '23']);
    expect(card('wanted')).toHaveTextContent('Next search in about 2 hours');

    const quality = within(card('quality'));
    expect(quality.getByRole('heading', { name: 'FLAC or better' })).toBeInTheDocument();
    expect(
      quality.getByText('Upgrading', { selector: '[data-slot="status-tag"]' }),
    ).toBeInTheDocument();
    expect(card('quality')).toHaveTextContent(
      '4,980 tracks checked · Next search tonight at 02:00',
    );
  });

  it('a searching card and a complete one, all set up', async () => {
    mockSummary([T.wanted, T.mirrored, T.followed, T.quality]);
    renderWith(<Targets />);
    await screen.findByText('3 playlists · 1,140 tracks');
    expect(within(card('mirrored')).getByText('Complete')).toBeInTheDocument();
    expect(within(card('followed')).getByText('18 artists · 52 new tracks')).toBeInTheDocument();
    expect(card('followed').querySelector('[data-live="true"]')).toHaveTextContent('Searching');
  });

  it('a card not set up: a "Not set up" tag, one sentence and one button', async () => {
    mockSummary([T.wanted, T.mirroredOff, T.followedOff, T.quality]);
    renderWith(<Targets />);
    await screen.findByText('312 tracks');

    const mirrored = within(card('mirrored'));
    expect(mirrored.getByText('Not set up')).toBeInTheDocument();
    expect(
      mirrored.getByRole('heading', { name: 'Keep a playlist complete in your library' }),
    ).toBeInTheDocument();
    expect(card('mirrored').querySelectorAll('a, button')).toHaveLength(1);
    expect(card('mirrored').querySelector('dd')).toBeNull();
    // mirroring happens in its dialog, on Home
    expect(mirrored.getByRole('button', { name: 'Mirror a playlist' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    expect(
      within(card('followed')).getByRole('link', { name: 'Follow an artist' }),
    ).toHaveAttribute('href', '/wanted?tab=followed');
  });

  it('can\'t search: keeps its numbers, a danger tag, "—", and Run Setup check · Try now', async () => {
    const calls = mockSummary([cant(T.wanted), T.mirroredOff, T.followedOff, cant(T.quality)]);
    let tested: unknown;
    server.use(
      http.post('/api/test-connection', async ({ request }) => {
        tested = await request.json();
        return HttpResponse.json({
          success: false,
          error: 'slskd is not connected to the Soulseek network.',
        });
      }),
    );
    renderWith(<Targets />);
    await screen.findByText('312 tracks');

    const wanted = within(card('wanted'));
    expect(card('wanted')).toHaveAttribute('data-state', 'cant-search');
    expect(wanted.getByText("Can't search")).toHaveAttribute('data-tone', 'danger');
    const values = Array.from(card('wanted').querySelectorAll('dd')).map((d) => d.textContent);
    expect(values).toEqual(['248', '—Not known while searches can’t run', '64']);
    expect(card('wanted')).toHaveTextContent(REASON);
    expect(wanted.queryByRole('link', { name: 'Open Wanted' })).toBeNull();
    expect(wanted.getByRole('link', { name: 'Run Setup check' })).toHaveAttribute(
      'href',
      '/setup-check',
    );

    const before = calls();
    fireEvent.click(wanted.getByRole('button', { name: 'Try now' }));
    expect(await wanted.findByRole('status')).toHaveTextContent(
      'Checked just now and it still didn’t answer: slskd is not connected to the Soulseek network.',
    );
    expect(tested).toEqual({ service: 'soulseek' });
    await waitFor(() => expect(calls()).toBeGreaterThan(before));
  });

  it("hides Run Setup check from a profile that isn't an admin", async () => {
    mockSummary([cant(T.wanted), T.mirroredOff, T.followedOff, cant(T.quality)]);
    renderWith(<Targets />, { isAdmin: false, isPageAllowed: () => true });
    await screen.findByText('312 tracks');
    expect(within(card('wanted')).queryByRole('link', { name: 'Run Setup check' })).toBeNull();
    expect(within(card('wanted')).getByRole('button', { name: 'Try now' })).toBeInTheDocument();
  });

  it('folds into one "Tell SoulSync what you want" panel with nothing set up', async () => {
    mockSummary([T.wantedOff, T.mirroredOff, T.followedOff, T.quality]);
    renderWith(<Targets />);
    const panel = await screen.findByTestId('home-setup-panel');
    expect(screen.queryAllByTestId('home-target')).toHaveLength(0);
    expect(
      within(panel).getByRole('heading', { name: 'Tell SoulSync what you want' }),
    ).toBeInTheDocument();
    // pages are links; the two jobs done in a dialog on Home are buttons
    expect(
      Array.from(panel.querySelectorAll('a, button')).map((el) => [
        el.textContent,
        el.getAttribute('href') ?? el.getAttribute('aria-haspopup'),
      ]),
    ).toEqual([
      ['Add to Wanted', '/search'],
      ['Mirror a playlist', 'dialog'],
      ['Follow an artist', '/wanted?tab=followed'],
      ['Set a quality target', 'dialog'],
    ]);
  });

  it('says it is loading, in words, with card placeholders', async () => {
    server.use(http.get('/api/targets/summary', () => delay('infinite')));
    renderWith(<Targets />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your targets…');
    expect(screen.getByRole('heading', { name: 'Targets' })).toBeInTheDocument();
  });

  it('a failed load keeps the heading, says so, and Try again loads it', async () => {
    let fail = true;
    server.use(
      http.get('/api/targets/summary', () =>
        fail
          ? HttpResponse.json({ success: false, error: 'boom' }, { status: 500 })
          : HttpResponse.json(summary([T.wanted, T.mirroredOff, T.followedOff, T.quality])),
      ),
    );
    renderWith(<Targets />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load your targets');
    expect(alert).toHaveTextContent('Nothing is lost; this is a display problem.');
    expect(within(alert).getByRole('link', { name: 'Run Setup check' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Targets' })).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('312 tracks')).toBeInTheDocument();
  });
});

describe('the links', () => {
  it('open in the app through navigateToPage', async () => {
    mockSummary([T.wanted, T.mirroredOff, T.followedOff, T.quality]);
    renderWith(<Targets />);
    await screen.findByText('312 tracks');

    const open = within(card('wanted')).getByRole('link', { name: 'Open Wanted' });
    expect(open).toHaveAttribute('href', '/wanted');
    fireEvent.click(open);
    expect(navigateToPage).toHaveBeenLastCalledWith('wanted');
    expect(requestSettingsTab).not.toHaveBeenCalled();
  });

  it('load a link with a query normally, so the tab survives', async () => {
    mockSummary([T.wanted, T.mirroredOff, T.followedOff, T.quality]);
    renderWith(<Targets />);
    await screen.findByText('312 tracks');
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener('click', stop);
    fireEvent.click(within(card('followed')).getByRole('link', { name: 'Follow an artist' }));
    document.removeEventListener('click', stop);
    expect(navigateToPage).not.toHaveBeenCalled();
  });

  it('leave a modified click (new tab) to the browser', async () => {
    mockSummary([T.wanted, T.mirroredOff, T.followedOff, T.quality]);
    renderWith(<Targets />);
    await screen.findByText('312 tracks');
    // jsdom can't open a tab; stop the browser's own default after the app passed
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener('click', stop);
    fireEvent.click(within(card('wanted')).getByRole('link', { name: 'Open Wanted' }), {
      ctrlKey: true,
    });
    document.removeEventListener('click', stop);
    expect(navigateToPage).not.toHaveBeenCalled();
  });

  it("aren't drawn to a page this profile can't open", async () => {
    mockSummary([T.wanted, T.mirroredOff, T.followedOff, T.quality]);
    renderWith(<Targets />, { isAdmin: false, isPageAllowed: (id) => id !== 'settings' });
    await screen.findByText('312 tracks');
    // setting the target is admin only, so a member gets no button for it
    expect(within(card('quality')).queryByRole('button', { name: 'Change target' })).toBeNull();
    expect(within(card('wanted')).getByRole('link', { name: 'Open Wanted' })).toBeInTheDocument();
  });
});

describe('the dialogs Home opens', () => {
  function dialogRoutes() {
    server.use(
      http.get('/api/spotify/playlists', () =>
        HttpResponse.json([{ id: 'p1', name: 'Coastal evenings', owner: 'Ross', track_count: 3 }]),
      ),
      http.get('/api/mirrored-playlists', () => HttpResponse.json([])),
      http.get('/api/quality/presets', () =>
        HttpResponse.json({
          success: true,
          total: 10,
          unknown_format: 0,
          presets: [
            { key: 'mp3_320', name: 'MP3 320', meeting: 10, total: 10, estimated: false },
            { key: 'flac', name: 'FLAC', meeting: 8, total: 10, estimated: false },
            { key: 'flac_24', name: 'FLAC 24-bit', meeting: 1, total: 10, estimated: true },
            { key: 'lossless', name: 'Any lossless', meeting: 8, total: 10, estimated: false },
          ],
          current: { preset: 'flac', name: 'FLAC or better', updated_at: null },
        }),
      ),
      http.get('/api/automations', () => HttpResponse.json([])),
      http.get('/api/automations/master', () => HttpResponse.json({ music: true })),
    );
  }

  it('"Mirror a playlist" opens the mirror dialog', async () => {
    mockSummary([T.wanted, T.mirroredOff, T.followedOff, T.quality]);
    dialogRoutes();
    renderWith(<Targets />);
    await screen.findByText('312 tracks');

    fireEvent.click(within(card('mirrored')).getByRole('button', { name: 'Mirror a playlist' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Mirror a playlist' })).toBeInTheDocument();
    expect(await within(dialog).findByText('Coastal evenings')).toBeInTheDocument();
    expect(navigateToPage).not.toHaveBeenCalled();
  });

  it('"Change target" opens the quality dialog on the current target', async () => {
    mockSummary([T.wanted, T.mirroredOff, T.followedOff, T.quality]);
    dialogRoutes();
    renderWith(<Targets />);
    await screen.findByText('312 tracks');

    fireEvent.click(within(card('quality')).getByRole('button', { name: 'Change target' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Quality target' })).toBeInTheDocument();
    const flac = await within(dialog).findByTestId('preset-flac');
    expect(flac).toHaveTextContent('8 of 10 tracks already meet it');
    expect(within(flac).getByRole('radio')).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Set target to FLAC' })).toBeInTheDocument();
    expect(requestSettingsTab).not.toHaveBeenCalled();
  });

  it('"Set a quality target" on the setup panel opens it too', async () => {
    mockSummary([T.wantedOff, T.mirroredOff, T.followedOff, T.quality]);
    dialogRoutes();
    renderWith(<Targets />);
    const panel = await screen.findByTestId('home-setup-panel');

    fireEvent.click(within(panel).getByRole('button', { name: 'Set a quality target' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Quality target');
  });
});

describe('Latest', () => {
  it('shows the newest three: time, a status word, the title and one sentence', async () => {
    server.use(
      http.get('/api/activity', () => HttpResponse.json({ success: true, items: LATEST })),
    );
    renderWith(<Latest />);
    const rows = await screen.findAllByTestId('home-latest-row');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector('time')!.textContent)).toEqual([
      '14:02',
      '13:40',
      'Yesterday',
    ]);
    expect(rows.map((r) => r.querySelector('[data-slot="status-tag"]')!.textContent)).toEqual([
      'Done',
      'Needs you',
      'Failed',
    ]);
    expect(rows[0]).toHaveTextContent('Downloaded 12 tracks');
    expect(rows[0]).toHaveTextContent('Lantern by Saltmarsh and 1 more · Soulseek · FLAC');
    // what needs you links its action where the sentence says it
    const preview = within(rows[1]).getByRole('link', { name: 'Preview again' });
    expect(preview).toHaveAttribute('href', '/tools');
    expect(rows[1]).toHaveTextContent(
      'Nothing was changed. Preview again to recycle 214 duplicate files (3.2 GB).',
    );
    fireEvent.click(preview);
    expect(navigateToPage).toHaveBeenCalledWith('tools');
    expect(within(rows[0]).queryByRole('link')).toBeNull();
  });

  it('"See all activity" goes to the Activity page', async () => {
    server.use(
      http.get('/api/activity', () => HttpResponse.json({ success: true, items: LATEST })),
    );
    renderWith(<Latest />);
    await screen.findAllByTestId('home-latest-row');
    const all = screen.getByRole('link', { name: /See all activity/ });
    expect(all).toHaveAttribute('href', '/activity');
    fireEvent.click(all);
    expect(navigateToPage).toHaveBeenCalledWith('activity');
  });

  it('says "Nothing yet" with no activity', async () => {
    server.use(http.get('/api/activity', () => HttpResponse.json({ success: true, items: [] })));
    renderWith(<Latest />);
    const empty = await screen.findByTestId('home-latest-empty');
    expect(empty).toHaveTextContent('Nothing yet');
    expect(empty).toHaveTextContent(
      'Downloads, imports and automation runs show here as they happen.',
    );
  });

  it('shows placeholders while loading and a Notice when it fails', async () => {
    server.use(http.get('/api/activity', () => delay('infinite')));
    const view = renderWith(<Latest />);
    expect(screen.getByTestId('home-latest-loading')).toBeInTheDocument();
    view.unmount();

    server.use(http.get('/api/activity', () => HttpResponse.json({}, { status: 500 })));
    renderWith(<Latest />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load the latest activity');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
