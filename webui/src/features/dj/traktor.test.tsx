import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpResponse, http, server } from '@/test/msw';

import type { TraktorPreview, TraktorSettings } from './traktor.api';

import { TraktorCard, mountTraktorCard } from './traktor-card';
import { TraktorExportDialog } from './traktor-export-dialog';
import {
  dayWords,
  exportLabel,
  exportTitle,
  folderLine,
  folderName,
  leftOutLines,
  saveLabel,
  takenWords,
} from './traktor.format';

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
    expect(leftOutLines({ left_out: [], reasons: { lookup_limit: 2 } }, true)).toEqual([
      "2 tracks weren't looked for on disk: too many to look up in one export. Export them in smaller sets.",
    ]);
    expect(leftOutLines({ left_out: [], reasons: { no_mac_path: 3 } }, false)[0]).toContain(
      'An admin sets it in Settings → Library → DJ.',
    );
  });

  it('titles and labels', () => {
    expect(exportTitle('Sunday Set', null)).toBe('Export “Sunday Set” to Traktor?');
    expect(exportTitle(null, 12)).toBe('Export 12 tracks to Traktor?');
    expect(exportTitle(null, 1)).toBe('Export 1 track to Traktor?');
    expect(exportLabel(23)).toBe('Export 23 tracks');
    expect(folderLine('unset')).toBe('Optional. Otherwise exports download in the browser.');
  });

  it('the folder case’s words (234, 23d)', () => {
    expect(saveLabel(23)).toBe('Save 23 tracks');
    expect(saveLabel(1)).toBe('Save 1 track');
    expect(folderName('/app/Transfer/Traktor exports')).toBe('Traktor exports');
    expect(folderName('/Volumes/Music HD/Traktor exports/')).toBe('Traktor exports');
    expect(folderName(null)).toBe('the export folder');
    const now = new Date(2026, 9, 24, 12).getTime();
    const oct22 = new Date(2026, 9, 22, 9).getTime() / 1000;
    expect(dayWords(oct22, now)).toBe('22 October');
    expect(dayWords(new Date(2025, 9, 22, 9).getTime() / 1000, now)).toBe('22 October 2025');
    expect(takenWords('Sunday Set.nml', 'Traktor exports', oct22, now)).toEqual({
      wide: 'Sunday Set.nml is already in Traktor exports, from 22 October. Replacing it doesn’t change what Traktor imported then.',
      phone: 'Sunday Set.nml is already there, from 22 October.',
    });
    expect(takenWords('Sunday Set.nml', 'Traktor exports', null, now).phone).toBe(
      'Sunday Set.nml is already there.',
    );
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
      within(dialog).getByRole('button', { name: 'Open Settings → Library → DJ' }),
    ).toBeTruthy();
  });

  it('saves into the export folder: “Save 23 tracks”, the folder named (234, 23d)', async () => {
    const shown = '/Volumes/Music HD/SoulSync/Transfer/Traktor exports';
    const toast = vi.fn();
    window.showToast = toast;
    answer = (body) =>
      body.action === 'save'
        ? HttpResponse.json({ success: true, filename: 'Sunday Set.nml', folder: shown })
        : HttpResponse.json({
            ...PREVIEW,
            folder: { state: 'ok', shown, can_save: true, exists_at: null },
          });
    const onClose = vi.fn();
    render(
      <TraktorExportDialog
        from={{ source: 'playlist', playlist_id: 4 }}
        name="Sunday Set"
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    const save = await within(dialog).findByRole('button', { name: 'Save 23 tracks' });
    expect(dialog.textContent).toContain('Saves Sunday Set.nml to Traktor exports.');
    expect(within(dialog).getByText('Traktor exports').closest('[title]')).toHaveAttribute(
      'title',
      shown,
    );
    // Download instead beside it
    const footer = save.parentElement!;
    expect(within(footer).getByRole('button', { name: 'Download instead' })).toBeTruthy();
    expect(save.getAttribute('data-tone')).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(asked.at(-1)).toMatchObject({ action: 'save', overwrite: false });
    expect(toast).toHaveBeenCalledWith(
      'Saved to Traktor exports · import it in Traktor',
      'success',
    );
  });

  it('a name already there: a warning Notice and Replace it in the warning tone (234, 23d)', async () => {
    const shown = '/Volumes/Music HD/SoulSync/Transfer/Traktor exports';
    const at = new Date(new Date().getFullYear(), 9, 22, 12).getTime() / 1000;
    answer = (body) =>
      body.action === 'save'
        ? HttpResponse.json({ success: true, filename: 'Sunday Set.nml', folder: shown })
        : HttpResponse.json({
            ...PREVIEW,
            folder: { state: 'ok', shown, can_save: true, exists_at: at },
          });
    const onClose = vi.fn();
    render(
      <TraktorExportDialog
        from={{ source: 'playlist', playlist_id: 4 }}
        name="Sunday Set"
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    const replace = await within(dialog).findByRole('button', { name: 'Replace it' });
    expect(replace.getAttribute('data-variant')).toBe('primary');
    expect(replace.getAttribute('data-tone')).toBe('warning');
    expect(replace).not.toHaveFocus();
    const notice = dialog.querySelector('[data-traktor-taken]')!;
    expect(notice.getAttribute('data-tone')).toBe('warning');
    expect(notice.textContent).toContain(
      'Sunday Set.nml is already in Traktor exports, from 22 October. Replacing it doesn’t change what Traktor imported then.',
    );
    expect(notice.textContent).toContain('Sunday Set.nml is already there, from 22 October.');
    // the sentence it replaces has gone; Download instead stays beside it
    expect(dialog.textContent).not.toContain('Saves Sunday Set.nml to');
    expect(
      within(replace.parentElement!).getByRole('button', { name: 'Download instead' }),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Save 23 tracks' })).toBeNull();
    fireEvent.click(replace);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(asked.at(-1)).toMatchObject({ action: 'save', overwrite: true });
  });

  it('a name taken since the preview: the save’s 409 turns the primary into Replace it, focus on the warning', async () => {
    const shown = '/Volumes/Music HD/SoulSync/Transfer/Traktor exports';
    let saves = 0;
    answer = (body) => {
      if (body.action === 'save') {
        saves += 1;
        return body.overwrite
          ? HttpResponse.json({ success: true, filename: 'Sunday Set.nml', folder: shown })
          : HttpResponse.json(
              {
                success: false,
                exists: true,
                exists_at: null,
                error: 'Sunday Set.nml is already there.',
              },
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
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Save 23 tracks' }));
    const replace = await within(dialog).findByRole('button', { name: 'Replace it' });
    const notice = dialog.querySelector<HTMLElement>('[data-traktor-taken]')!;
    expect(notice.textContent).toContain('Sunday Set.nml is already in Traktor exports.');
    await waitFor(() => expect(notice).toHaveFocus());
    expect(replace).not.toHaveFocus();
    expect(asked.at(-1)).toMatchObject({ action: 'save', overwrite: false });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(replace);
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
    // 230 (23c): the hint says where to find it
    expect(card.textContent).toContain(
      'The left side of ./music:/app/Transfer in your compose file.',
    );
    expect(within(card).getByLabelText('Your music on the Mac')).toHaveAccessibleDescription(
      'The left side of ./music:/app/Transfer in your compose file.',
    );
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
          success: true,
          export_folder_state: 'unset',
          collection: SETTINGS.collection,
          can_edit: false,
          // a member is told whether it's set, not where (the review's finding 5)
          mac_path_set: true,
          mac_path_from_helper_set: true,
        }),
      ),
    );
    render(<TraktorCard />);
    const card = await screen.findByRole('region', { name: 'Traktor Pro 3' });
    await within(card).findByText('Checked');
    expect(within(card).getByText('Set by an admin')).toBeTruthy();
    expect(card.textContent).not.toContain('/app/Transfer');
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
