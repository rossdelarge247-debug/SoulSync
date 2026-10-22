import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import { SetQualityTargetDialog } from './set-quality-target-dialog';

const profile = { isAdmin: true };

const PRESETS = {
  success: true,
  total: 4980,
  unknown_format: 12,
  presets: [
    { key: 'mp3_320', name: 'MP3 320', meeting: 4931, total: 4980, estimated: false },
    { key: 'flac', name: 'FLAC', meeting: 4512, total: 4980, estimated: false },
    { key: 'flac_24', name: 'FLAC 24-bit', meeting: 612, total: 4980, estimated: true },
    { key: 'lossless', name: 'Any lossless', meeting: 4560, total: 4980, estimated: false },
  ],
  current: {
    preset: 'flac',
    name: 'FLAC or better',
    quality_profile_id: 1,
    quality_profile_name: 'Default',
    updated_at: 1773489600,
    upgrade_existing: true,
    fallback_enabled: true,
  },
};

const UPGRADES = {
  id: 3,
  name: 'Apply Quality Upgrades',
  enabled: true,
  trigger_type: 'daily_time',
  trigger_config: { time: '02:00' },
  action_type: 'apply_quality_upgrades',
  next_run: null,
};

function routes({ automations = [UPGRADES] }: { automations?: unknown[] } = {}) {
  const puts: unknown[] = [];
  server.use(
    http.get('/api/quality/presets', () => HttpResponse.json(PRESETS)),
    http.get('/api/automations', () => HttpResponse.json(automations)),
    http.get('/api/automations/master', () => HttpResponse.json({ music: true, video: true })),
    http.put('/api/quality/target', async ({ request }) => {
      const body = (await request.json()) as { preset: string };
      puts.push(body);
      return HttpResponse.json({
        ...PRESETS,
        current: {
          ...PRESETS.current,
          preset: body.preset,
          name: 'MP3 320 or better',
          updated_at: 1773450000,
        },
      });
    }),
  );
  return puts;
}

function renderDialog() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SetQualityTargetDialog open onClose={onClose} onSaved={onSaved} isAdmin={profile.isAdmin} />
    </QueryClientProvider>,
  );
  return { onClose, onSaved };
}

/** The first answer can take a while on a busy machine; later steps are quick. */
const SLOW = { timeout: 5000 };

const dialog = () => screen.getByRole('dialog');
const radio = (key: string) => within(screen.getByTestId(`preset-${key}`)).getByRole('radio');

beforeEach(() => {
  profile.isAdmin = true;
  window.showToast = vi.fn();
});

afterEach(() => {
  cleanup();
  delete window.showToast;
});

describe('Set a quality target', () => {
  it('shows the four presets with real counts, on the current target', async () => {
    routes();
    renderDialog();

    expect(
      await screen.findByText('4,512 of 4,980 tracks already meet it', undefined, SLOW),
    ).toBeInTheDocument();
    expect(screen.getByText('About 612 of 4,980 tracks already meet it')).toBeInTheDocument();
    expect(radio('flac')).toBeChecked();
    expect(
      screen.getByText('Current target: FLAC or better, saved 14 March 2026'),
    ).toBeInTheDocument();
    // it's already the target: nothing to save, and the button says so
    const set = within(dialog()).getByRole('button', { name: 'Set target to FLAC' });
    expect(set).toHaveAttribute('aria-disabled', 'true');
  });

  it('follows the selection in the consequence panel and the primary', async () => {
    routes();
    renderDialog();
    await screen.findByTestId('preset-mp3_320', undefined, SLOW);

    fireEvent.click(radio('flac_24'));

    const panel = screen.getByTestId('quality-consequence');
    expect(panel).toHaveTextContent('With FLAC 24-bit:');
    expect(panel).toHaveTextContent(
      '4,368 tracks you already have are below it; Apply Quality Upgrades adds better copies',
    );
    expect(
      within(dialog()).getByRole('button', { name: 'Set target to FLAC 24-bit' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('offers "Upgrade what I already have" only when an automation can do it', async () => {
    routes({ automations: [] });
    renderDialog();
    await screen.findByTestId('preset-mp3_320', undefined, SLOW);

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByTestId('quality-consequence')).toHaveTextContent(
      'Nothing replaces them on its own yet',
    );
  });

  it('saves the preset with the upgrade choice and the version it was based on', async () => {
    const puts = routes();
    const { onClose, onSaved } = renderDialog();
    await screen.findByTestId('preset-mp3_320', undefined, SLOW);

    fireEvent.click(radio('mp3_320'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Upgrade what I already have/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Set target to MP3 320' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts).toEqual([{ preset: 'mp3_320', upgrade_existing: false, based_on: 1773489600 }]);
    expect(onSaved).toHaveBeenCalled();
    expect(window.showToast).toHaveBeenCalledWith(
      'Quality target set to MP3 320 or better',
      'success',
    );
  });

  it('keeps the profile’s upgrade setting when nothing can honour the box', async () => {
    const puts = routes({ automations: [] });
    const { onClose } = renderDialog();
    await screen.findByTestId('preset-mp3_320', undefined, SLOW);

    fireEvent.click(radio('lossless'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Set target to Any lossless' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts).toEqual([{ preset: 'lossless', upgrade_existing: true, based_on: 1773489600 }]);
  });

  it('fades the cards and offers the new numbers when the target changed meanwhile (409)', async () => {
    routes();
    server.use(
      http.put('/api/quality/target', () =>
        HttpResponse.json(
          {
            success: false,
            error: 'target_changed',
            message:
              'The quality target was changed somewhere else while this was open. Nothing was saved.',
          },
          { status: 409 },
        ),
      ),
    );
    const { onClose } = renderDialog();
    await screen.findByTestId('preset-mp3_320', undefined, SLOW);

    fireEvent.click(radio('mp3_320'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Set target to MP3 320' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The target changed while this was open');
    expect(alert).toHaveTextContent('Nothing was saved.');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Quality target' })).toBeDisabled();

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Show the new numbers' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(radio('flac')).toBeChecked();
  });

  it('says what went wrong when the save fails', async () => {
    routes();
    server.use(
      http.put('/api/quality/target', () =>
        HttpResponse.json(
          { success: false, error: 'write_failed', message: 'The database is locked.' },
          { status: 500 },
        ),
      ),
    );
    renderDialog();
    await screen.findByTestId('preset-mp3_320', undefined, SLOW);
    fireEvent.click(radio('mp3_320'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Set target to MP3 320' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That didn’t go through');
    expect(alert).toHaveTextContent('The database is locked.');
  });

  it('says only an admin can save, for anyone else', async () => {
    profile.isAdmin = false;
    routes();
    renderDialog();
    await screen.findByTestId('preset-mp3_320', undefined, SLOW);
    fireEvent.click(radio('mp3_320'));

    const set = within(dialog()).getByRole('button', { name: 'Set target to MP3 320' });
    expect(set).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Only an admin can change the quality target.')).toBeInTheDocument();
  });

  it('says so when the library can’t be counted', async () => {
    routes();
    server.use(
      http.get('/api/quality/presets', () => HttpResponse.json({ error: 'x' }, { status: 500 })),
    );
    renderDialog();

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t count your library');
  });
});
