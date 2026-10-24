import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import type { TraktorPreview, TraktorSettings } from './traktor.api';

import { TraktorCard, mountTraktorCard } from './traktor-card';
import { TraktorExportDialog } from './traktor-export-dialog';
import { exportLabel, exportTitle, folderLine, leftOutLines } from './traktor.format';

/**
 * "Export to Traktor…" (21a): the shared confirm (tiles, the Mac's path,
 * what was left out and why, how to import), the download and the export
 * folder with its ask-before-replacing; and the Settings → Library →
 * Traktor Pro 3 card (21b), admins only to change.
 */

const PREVIEW: TraktorPreview = {
  success: true,
  name: 'Sunday Set',
  filename: 'Sunday Set.nml',
  counts: { tracks: 24, found: 23, left_out: 1 },
  example_path: '/Volumes/Music HD/SoulSync/Transfer/Tidewater/Night Ferry EP/01 Night Ferry.flac',
  mac_path: '/Volumes/Music HD/SoulSync/Transfer',
  library_folder: '/app/Transfer',
  left_out: [
    {
      title: 'Copper Sky',
      artist: 'Tidewater',
      reason: 'not_in_library',
      words: "isn't a file in your library",
    },
  ],
  reasons: { not_in_library: 1 },
  keys: 20,
  can_edit: true,
  folder: { state: 'unset', shown: null, can_save: false },
};

let asked: Record<string, unknown>[] = [];
let answer: (body: Record<string, unknown>) => Response;

beforeEach(() => {
  asked = [];
  answer = (body) =>
    body.action === 'download'
      ? new HttpResponse('<NML/>', {
          headers: { 'Content-Disposition': 'attachment; filename="Sunday Set.nml"' },
        })
      : HttpResponse.json(PREVIEW);
  server.use(
    http.post('/api/library/dj/traktor/export', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      asked.push(body);
      return answer(body);
    }),
  );
  window.showToast = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:nml');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => cleanup());

describe('the words', () => {
  it('says why things were left out, one sentence per reason', () => {
    expect(leftOutLines(PREVIEW, true)).toEqual(["“Copper Sky” isn't a file in your library."]);
    const many = leftOutLines(
      {
        left_out: [
          { title: 'A', artist: '', reason: 'outside', words: '' },
          { title: 'B', artist: '', reason: 'outside', words: '' },
          { title: 'C', artist: '', reason: 'outside', words: '' },
        ],
        reasons: { outside: 5, too_many: 2, no_mac_path: 0 },
      },
      true,
    );
    expect(many).toEqual([
      "5 tracks are in folders the Mac path doesn't cover: “A”, “B” and 3 more.",
      '2 tracks are past the 1,000 one export takes.',
    ]);
    expect(leftOutLines({ left_out: [], reasons: { no_mac_path: 3 } }, false)[0]).toContain(
      'An admin sets it in Settings → Library → Traktor Pro 3.',
    );
  });

  it('titles and labels', () => {
    expect(exportTitle('Sunday Set', null)).toBe('Export “Sunday Set” to Traktor?');
    expect(exportTitle(null, 12)).toBe('Export 12 tracks to Traktor?');
    expect(exportTitle(null, 1)).toBe('Export 1 track to Traktor?');
    expect(exportLabel(23)).toBe('Export 23 tracks');
    expect(folderLine('unset')).toBe('Optional. Otherwise exports download in the browser.');
  });
});

describe('the confirm (21a)', () => {
  it('shows the tiles, the path once, what was left out and how to import', async () => {
    render(
      <TraktorExportDialog
        from={{ source: 'playlist', playlist_id: 4 }}
        name="Sunday Set"
        onClose={() => undefined}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Export “Sunday Set” to Traktor?' });
    await within(dialog).findByText('Found on your Mac');
    expect(asked[0]).toEqual({ action: 'preview', source: 'playlist', playlist_id: 4 });
    expect(within(dialog).getByText('24')).toBeTruthy();
    expect(within(dialog).getByText('23')).toBeTruthy();
    expect(within(dialog).getByText('Paths as your Mac sees them')).toBeTruthy();
    expect(within(dialog).getByText(PREVIEW.example_path!)).toBeTruthy();
    expect(dialog.textContent).toContain("Left out: “Copper Sky” isn't a file in your library.");
    expect(dialog.textContent).toContain('Saves Sunday Set.nml to your Downloads.');
    expect(dialog.textContent).toContain(
      'In Traktor: File → Import Playlist… (or right-click Playlists → Import Playlist).',
    );
    expect(dialog.textContent).toContain("Traktor Pro 3's playlist format (.nml)");
    expect(within(dialog).getByRole('button', { name: 'Change…' })).toBeTruthy();
  });

  it('downloads through the browser and says how to import', async () => {
    const onClose = vi.fn();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(
      <TraktorExportDialog from={{ source: 'tracks', track_ids: ['1', '2'] }} onClose={onClose} />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Export 2 tracks to Traktor?' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Export 23 tracks' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(asked[1]).toEqual({ action: 'download', source: 'tracks', track_ids: ['1', '2'] });
    expect(clicked).toHaveBeenCalled();
    expect(window.showToast).toHaveBeenCalledWith(
      'Saved Sunday Set.nml to your Downloads. In Traktor: File → Import Playlist…',
      'success',
    );
    clicked.mockRestore();
  });

  it('with nothing found the export waits, with its reason', async () => {
    answer = () =>
      HttpResponse.json({
        ...PREVIEW,
        counts: { tracks: 2, found: 0, left_out: 2 },
        example_path: null,
        mac_path: null,
        left_out: [],
        reasons: { no_mac_path: 2 },
      });
    render(
      <TraktorExportDialog from={{ source: 'tracks', track_ids: ['1', '2'] }} onClose={() => {}} />,
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/doesn't know where your music is on the Mac yet/);
    expect(within(dialog).getByRole('button', { name: 'Export 0 tracks' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(within(dialog).getByText('Nothing here can go to Traktor yet.')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Open Settings → Library → Traktor Pro 3' }),
    ).toBeTruthy();
  });

  it('saves into the export folder, and asks before replacing a file', async () => {
    const shown = '/Volumes/Music HD/SoulSync/Transfer/Traktor exports';
    let saves = 0;
    answer = (body) => {
      if (body.action === 'save') {
        saves += 1;
        return body.overwrite
          ? HttpResponse.json({ success: true, filename: 'Sunday Set.nml', folder: shown })
          : HttpResponse.json(
              { success: false, exists: true, error: 'Sunday Set.nml is already there.' },
              { status: 409 },
            );
      }
      return HttpResponse.json({ ...PREVIEW, folder: { state: 'ok', shown, can_save: true } });
    };
    const onClose = vi.fn();
    render(
      <TraktorExportDialog
        from={{ source: 'playlist', playlist_id: 4 }}
        name="Sunday Set"
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(shown);
    expect(dialog.textContent).toContain(`Saves Sunday Set.nml to ${shown}.`);
    expect(within(dialog).getByRole('button', { name: 'Download instead' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export 23 tracks' }));
    await within(dialog).findByText('Sunday Set.nml is already in the export folder');
    expect(asked.at(-1)).toMatchObject({ action: 'save', overwrite: false });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace it' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(asked.at(-1)).toMatchObject({ action: 'save', overwrite: true });
    expect(saves).toBe(2);
  });

  it('a failed look offers Try again', async () => {
    answer = () =>
      HttpResponse.json({ success: false, error: 'Playlist not found' }, { status: 404 });
    render(
      <TraktorExportDialog from={{ source: 'playlist', playlist_id: 9 }} onClose={() => {}} />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Playlist not found');
    answer = () => HttpResponse.json(PREVIEW);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Found on your Mac');
  });
});

const SETTINGS: TraktorSettings = {
  success: true,
  mac_path: '',
  mac_path_from_helper: null,
  library_folder: '/app/Transfer',
  export_folder: '',
  export_folder_state: 'unset',
  export_folder_on_mac: null,
  collection: 'collection.nml in Documents/Native Instruments/Traktor 3.x',
  can_edit: true,
};

describe('Settings → Library → Traktor Pro 3 (21b)', () => {
  let saved: unknown[] = [];
  beforeEach(() => {
    saved = [];
    server.use(
      http.get('/api/library/dj/traktor/settings', () => HttpResponse.json(SETTINGS)),
      http.put('/api/library/dj/traktor/settings', async ({ request }) => {
        const body = (await request.json()) as { mac_path: string; export_folder: string };
        saved.push(body);
        if (body.export_folder === '/elsewhere')
          return HttpResponse.json(
            {
              success: false,
              field: 'export_folder',
              error: 'The export folder has to be inside one of your music folders or Downloads.',
            },
            { status: 400 },
          );
        return HttpResponse.json({ ...SETTINGS, mac_path: body.mac_path });
      }),
    );
  });

  it('an admin sets the Mac path and saves', async () => {
    render(<TraktorCard />);
    const card = await screen.findByRole('region', { name: 'Traktor Pro 3' });
    await within(card).findByText('Not set');
    expect(card.textContent).toContain('Where the Mac keeps what SYNCHRO.S calls /app/Transfer.');
    expect(card.textContent).toContain(
      'collection.nml in Documents/Native Instruments/Traktor 3.x',
    );
    const save = within(card).getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(within(card).getByLabelText('Your music on the Mac'), {
      target: { value: '/Users/ross/SoulSync/music' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await within(card).findByText('Typed in');
    expect(saved).toEqual([{ mac_path: '/Users/ross/SoulSync/music', export_folder: '' }]);
  });

  it("puts a refused folder's reason under its field", async () => {
    render(<TraktorCard />);
    const card = await screen.findByRole('region', { name: 'Traktor Pro 3' });
    await within(card).findByText('Not set');
    fireEvent.change(within(card).getByLabelText('Export folder'), {
      target: { value: '/elsewhere' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await within(card).findByText(
      'The export folder has to be inside one of your music folders or Downloads.',
    );
    expect(within(card).getByLabelText('Export folder')).toHaveAttribute('aria-invalid', 'true');
  });

  it('a member reads it without fields or Save', async () => {
    server.use(
      http.get('/api/library/dj/traktor/settings', () =>
        HttpResponse.json({
          ...SETTINGS,
          can_edit: false,
          mac_path: '/Volumes/Music HD/SoulSync/Transfer',
          mac_path_from_helper: '/Volumes/Music HD/SoulSync/Transfer',
        }),
      ),
    );
    render(<TraktorCard />);
    const card = await screen.findByRole('region', { name: 'Traktor Pro 3' });
    await within(card).findByText('Checked');
    expect(within(card).getByText('/Volumes/Music HD/SoulSync/Transfer')).toBeTruthy();
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(card.textContent).toContain('Filled in by the drive helper.');
  });

  it('mounts after BPM, key and energy in the legacy page', () => {
    // the card waits until it's on screen: nothing is asked here
    class NeverSeen {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', NeverSeen);
    document.body.innerHTML =
      '<div id="panel"><div id="dj-settings-group"></div><div id="after"></div></div>';
    expect(mountTraktorCard()).toBe(true);
    const host = document.querySelector('[data-traktor-card-host]');
    expect(host?.previousElementSibling?.id).toBe('dj-settings-group');
    expect(mountTraktorCard()).toBe(false);
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });
});
