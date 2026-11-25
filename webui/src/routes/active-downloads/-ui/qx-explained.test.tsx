/**
 * Quarantine, explained (boards 10 and 11): the overview by verdict, a
 * group's songs with each try's verdict and sentence on the page, the bulk
 * actions behind a preview and a confirm, the AcoustID banner and re-check,
 * and the plain list for a profile that can't use it.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import type { AdlQuarantineEntry } from '../-adl.types';
import type { QxOverview, QxSong } from '../-qx.api';

import { QuarantineExplained, QxSongFocus } from './qx-explained';

let confirmAnswer = true;
let confirms: Record<string, unknown>[] = [];
let posts: { url: string; body: unknown }[] = [];

beforeEach(() => {
  confirmAnswer = true;
  confirms = [];
  posts = [];
  window.showToast = vi.fn();
  window.showConfirmDialog = vi.fn((options?: Record<string, unknown>) => {
    confirms.push(options ?? {});
    return Promise.resolve(confirmAnswer);
  });
});

afterEach(cleanup);

const handlers = {
  onPlay: vi.fn(),
  onCompare: vi.fn(),
  onAudit: vi.fn(),
  onApprove: vi.fn(),
  onDelete: vi.fn(),
};

function overview(over: Partial<QxOverview> = {}): QxOverview {
  return {
    ready: true,
    files: 2568,
    songs: 900,
    groups: [
      {
        kind: 'right_song',
        files: 1075,
        songs: 400,
        example: {
          title: 'Fighting Fire (Original)',
          length: '5:48',
          spotify_length: '6:20',
          size_bytes: 1,
        },
      },
      {
        kind: 'cut_off',
        files: 210,
        songs: 190,
        example: { title: 'Firestarter', length: '0:30', spotify_length: '4:40', size_bytes: 1 },
      },
      {
        kind: 'broken',
        files: 172,
        songs: 170,
        example: { title: 'True (Original Mix)', length: '', spotify_length: '', size_bytes: 0 },
      },
    ],
    acoustid: {
      available: false,
      reason: 'No AcoustID API key configured',
      refused: false,
      working: false,
      settings_url: '/settings?tab=connections',
    },
    recheck: {
      status: 'idle',
      total: 0,
      done: 0,
      confirmed: 0,
      different: 0,
      no_match: 0,
      errors: 0,
      key_refused: false,
      active: false,
      pending: 2568,
    },
    keep_best: { status: 'idle' },
    ...over,
  };
}

const tryEntry = (
  id: string,
  over: Partial<AdlQuarantineEntry['explained']> = {},
): AdlQuarantineEntry =>
  ({
    id,
    filename: `${id}.mp3.quarantined`,
    original_filename: `${id}.mp3`,
    reason: 'Integrity check failed: Duration mismatch: file is 348.0s, expected 380.0s',
    expected_track: 'Fighting Fire',
    expected_artist: 'Breakage',
    group_key: 'k',
    timestamp: '',
    size_bytes: 1,
    has_full_context: true,
    trigger: 'integrity',
    source_username: 'magammon',
    source_filename: '',
    thumb_url: '',
    quality: '',
    explained: {
      kind: 'right_song',
      label: 'Right song',
      text: 'Probably the right song, 32 s shorter than Spotify’s length. Plays to the end.',
      length: '5:48',
      spotify_length: '6:20',
      quality: 'MP3 320',
      ...over,
    },
  }) as AdlQuarantineEntry;

const SONG: QxSong = {
  key: 'k',
  title: 'Fighting Fire',
  artist: 'Breakage',
  best: 'best-one',
  summary: 'Probably the right song in 2 of 3 tries. The best is marked. Spotify lists it at 6:20.',
  kinds: ['right_song', 'cut_off'],
  tries: [
    tryEntry('best-one', { verdict: 'best', verdict_label: 'Best' }),
    tryEntry('other-one', {
      verdict: 'right_song',
      verdict_label: 'Right song',
      quality: 'MP3 192',
    }),
    tryEntry('clip', {
      kind: 'cut_off',
      label: 'Cut off',
      verdict: 'cut_off',
      verdict_label: 'Cut off',
      text: 'Only 0:30 of a 6:20 song.',
      length: '0:30',
      quality: 'MP3 128',
    }),
  ],
};

function serve(data: QxOverview, opts: { songs?: QxSong[]; status?: number } = {}) {
  server.use(
    http.get('*/api/quarantine/explained/overview', () =>
      opts.status
        ? new HttpResponse(null, { status: opts.status })
        : HttpResponse.json({ success: true, ...data }),
    ),
    http.get('*/api/quarantine/explained/songs', () =>
      HttpResponse.json({
        success: true,
        ready: true,
        total: opts.songs?.length ?? 0,
        songs: opts.songs ?? [],
      }),
    ),
    http.post('*/api/quarantine/explained/:a/:b', async ({ request }) => {
      const body = await request.json();
      posts.push({ url: new URL(request.url).pathname, body });
      if (request.url.endsWith('/bulk/preview')) {
        return HttpResponse.json({
          success: true,
          plan_id: 'plan-1',
          ...(body as object),
          songs: 190,
          files: 210,
          keep: 400,
          delete: 675,
          bytes: 2048,
        });
      }
      return HttpResponse.json({ success: true, files_removed: 210, songs: 400 });
    }),
    http.post('*/api/quarantine/explained/recheck', async ({ request }) => {
      posts.push({ url: '/api/quarantine/explained/recheck', body: await request.json() });
      return HttpResponse.json({ success: true });
    }),
  );
}

describe('the overview', () => {
  it('groups by what to do, with counts, why and an example', async () => {
    serve(overview());
    render(<QuarantineExplained handlersFor={() => handlers} fallback={<p>plain list</p>} />);
    expect(await screen.findByRole('heading', { name: 'Quarantine' })).toBeInTheDocument();
    expect(
      screen.getByText(/2,568 downloads were held back instead of going into your library/),
    ).toBeInTheDocument();
    const groups = screen.getByRole('list');
    const rows = within(groups).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('1,075');
    expect(rows[0]).toHaveTextContent('Probably the right song, a slightly different edit');
    expect(rows[0]).toHaveTextContent('e.g. Fighting Fire (Original) · 5:48, Spotify lists 6:20');
    expect(
      within(rows[0]).getByRole('button', { name: 'Keep the best of each' }),
    ).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: 'Delete all 210' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('e.g. True (Original Mix) · 0 bytes');
  });

  it('links to the AcoustID setting when it isn’t working', async () => {
    serve(overview());
    render(<QuarantineExplained handlersFor={() => handlers} fallback={null} />);
    const banner = await screen.findByRole('region', { name: 'AcoustID' });
    expect(banner).toHaveTextContent("AcoustID isn't working.");
    expect(within(banner).getByRole('link', { name: 'Fix AcoustID' })).toHaveAttribute(
      'href',
      '/settings?tab=connections',
    );
  });

  it('says when AcoustID refused the key', async () => {
    serve(overview({ acoustid: { ...overview().acoustid!, available: true, refused: true } }));
    render(<QuarantineExplained handlersFor={() => handlers} fallback={null} />);
    expect(await screen.findByRole('region', { name: 'AcoustID' })).toHaveTextContent(
      'AcoustID refused the key.',
    );
  });

  it('offers the re-check when AcoustID works, and starts it', async () => {
    serve(overview({ acoustid: { ...overview().acoustid!, available: true, working: true } }));
    render(<QuarantineExplained handlersFor={() => handlers} fallback={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-check 2,568 with AcoustID' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: '/api/quarantine/explained/recheck',
        body: { action: 'start' },
      }),
    );
  });

  it('shows the re-check running, with Pause and Cancel', async () => {
    serve(
      overview({
        acoustid: { ...overview().acoustid!, available: true, working: true },
        recheck: {
          ...overview().recheck!,
          status: 'running',
          active: true,
          total: 2568,
          done: 412,
          confirmed: 300,
          different: 12,
          no_match: 100,
        },
      }),
    );
    render(<QuarantineExplained handlersFor={() => handlers} fallback={null} />);
    const banner = await screen.findByRole('region', { name: 'AcoustID re-check' });
    expect(banner).toHaveTextContent('Re-checking with AcoustID: 412 of 2,568.');
    expect(banner).toHaveTextContent('300 confirmed, 12 another song, 100 with no match.');
    expect(within(banner).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '16');
    fireEvent.click(within(banner).getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        url: '/api/quarantine/explained/recheck',
        body: { action: 'pause' },
      }),
    );
    expect(within(banner).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows the plain list to a profile that can’t use it', async () => {
    serve(overview(), { status: 403 });
    render(<QuarantineExplained handlersFor={() => handlers} fallback={<p>plain list</p>} />);
    expect(await screen.findByText('plain list')).toBeInTheDocument();
  });

  it('can switch to the plain list and back', async () => {
    serve(overview());
    render(<QuarantineExplained handlersFor={() => handlers} fallback={<p>plain list</p>} />);
    fireEvent.click(await screen.findByRole('button', { name: 'List every file instead' }));
    expect(screen.getByText('plain list')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Group by what to do' }));
    expect(await screen.findByRole('heading', { name: 'Quarantine' })).toBeInTheDocument();
  });
});

describe('the bulk actions', () => {
  it('Delete all previews, asks with the counts, then runs that plan', async () => {
    serve(overview());
    render(<QuarantineExplained handlersFor={() => handlers} fallback={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all 210' }));
    await waitFor(() => expect(confirms).toHaveLength(1));
    expect(String(confirms[0].message)).toMatch(
      /^Delete 210 files \(190 songs, 2(\.0)? KB\) for good\?/,
    );
    expect(String(confirms[0].message)).toContain('go back to Waiting');
    await waitFor(() =>
      expect(posts.map((p) => p.url)).toEqual([
        '/api/quarantine/explained/bulk/preview',
        '/api/quarantine/explained/bulk/confirm',
      ]),
    );
    expect(posts[0].body).toEqual({ kind: 'cut_off', action: 'delete' });
    expect(posts[1].body).toEqual({ plan_id: 'plan-1', action: 'delete' });
  });

  it('nothing is deleted when the confirm is cancelled', async () => {
    confirmAnswer = false;
    serve(overview());
    render(<QuarantineExplained handlersFor={() => handlers} fallback={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all 172' }));
    await waitFor(() => expect(confirms).toHaveLength(1));
    expect(posts.map((p) => p.url)).toEqual(['/api/quarantine/explained/bulk/preview']);
  });

  it('Keep the best of each previews and confirms a keep-best plan', async () => {
    serve(overview());
    render(<QuarantineExplained handlersFor={() => handlers} fallback={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep the best of each' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(String(confirms[0].message)).toContain('Keep the best try of 190 songs');
    expect(posts[1].body).toEqual({ plan_id: 'plan-1', action: 'keep_best' });
  });
});

describe('a group, song by song', () => {
  it('shows every try with its verdict and reason on the page', async () => {
    serve(overview(), { songs: [SONG] });
    render(<QuarantineExplained handlersFor={() => handlers} fallback={null} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open Probably the right song, a slightly different edit',
      }),
    );
    const song = await screen.findByRole('article', { name: 'Fighting Fire' });
    expect(song).toHaveTextContent('Probably the right song in 2 of 3 tries. The best is marked.');
    const tries = within(song).getAllByRole('listitem');
    expect(tries).toHaveLength(3);
    // the verdict, its sentence and the lengths are text, not a hover title
    expect(tries[0]).toHaveTextContent('Best');
    expect(tries[0]).toHaveTextContent('32 s shorter than Spotify’s length. Plays to the end.');
    expect(tries[0]).toHaveTextContent('5:48 · Spotify 6:20');
    expect(tries[0]).toHaveTextContent('MP3 320');
    expect(tries[0]).toHaveTextContent('from magammon');
    expect(tries[2]).toHaveTextContent('Only 0:30 of a 6:20 song.');
    // real buttons with names
    expect(within(tries[0]).getByRole('button', { name: 'Play best-one.mp3' })).toBeInTheDocument();
    expect(within(tries[0]).getByRole('button', { name: 'Keep best-one.mp3' })).toBeInTheDocument();
    fireEvent.click(within(tries[2]).getByRole('button', { name: 'Delete clip.mp3' }));
    expect(handlers.onDelete).toHaveBeenCalled();
    expect(
      within(song).getByRole('button', { name: 'Keep the best, delete the rest' }),
    ).toBeInTheDocument();
    expect(within(song).getByRole('button', { name: 'Delete all 3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '← All groups' }));
    expect(await screen.findByRole('heading', { name: 'Quarantine' })).toBeInTheDocument();
  });
});

describe('one song from a link', () => {
  it('shows that song’s tries', async () => {
    server.use(
      http.get('*/api/quarantine/explained/song', () =>
        HttpResponse.json({ success: true, song: SONG }),
      ),
    );
    render(
      <QxSongFocus
        entryId="best-one"
        handlersFor={() => handlers}
        onShowAll={vi.fn()}
        fallback={<p>old</p>}
      />,
    );
    expect(await screen.findByRole('article', { name: 'Fighting Fire' })).toBeInTheDocument();
    expect(screen.getByTestId('quarantine-focus')).toHaveTextContent(
      'Every try at “Fighting Fire”.',
    );
  });

  it('falls back to the plain view when it can’t be read', async () => {
    server.use(
      http.get('*/api/quarantine/explained/song', () => new HttpResponse(null, { status: 403 })),
    );
    render(
      <QxSongFocus
        entryId="x"
        handlersFor={() => handlers}
        onShowAll={vi.fn()}
        fallback={<p>old</p>}
      />,
    );
    expect(await screen.findByText('old')).toBeInTheDocument();
  });
});
