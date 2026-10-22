/**
 * Turning on "keep lossy output only" asks first, in the shared dialog with
 * the danger button, and says plainly what it does to new downloads and to
 * files already in the library. Only the confirm says yes.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LOSSY_DELETE_CONFIRM,
  LOSSY_DELETE_TITLE,
  LossyDeleteOriginalHost,
  lossyCopyName,
} from './lossy-delete-original';

afterEach(() => {
  cleanup();
});

async function ask(options = { codec: 'mp3', bitrate: '320' }) {
  render(<LossyDeleteOriginalHost />);
  let answer: Promise<boolean> | undefined;
  await act(async () => {
    answer = window.confirmLossyDeleteOriginal?.(options);
  });
  return { dialog: await screen.findByRole('dialog'), answer: answer as Promise<boolean> };
}

describe('the delete-original confirm', () => {
  it('says plainly what turning it on does, with the danger button', async () => {
    const { dialog } = await ask();
    expect(within(dialog).getByText(LOSSY_DELETE_TITLE)).toBeTruthy();
    expect(
      within(dialog).getByText(
        /^This can't be undone\. With this on, SoulSync keeps only the MP3 320 kbps copy/,
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/^New downloads: the original is deleted for good/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/listed in Activity/)).toBeTruthy();
    expect(
      within(dialog).getByText(/Lossy Converter's Convert shows the list of originals first/),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: LOSSY_DELETE_CONFIRM });
    expect(confirm.getAttribute('data-tone')).toBe('danger');
  });

  it('the confirm turns it on', async () => {
    const { dialog, answer } = await ask();
    fireEvent.click(within(dialog).getByRole('button', { name: LOSSY_DELETE_CONFIRM }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancel keeps it off', async () => {
    const { dialog, answer } = await ask({ codec: 'opus', bitrate: '256' });
    expect(within(dialog).getByText(/keeps only the Opus 256 kbps copy/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expect(answer).resolves.toBe(false);
  });

  it('names the copy from the codec and bitrate on screen', () => {
    expect(lossyCopyName({ codec: 'aac', bitrate: '256' })).toBe('AAC 256 kbps');
    expect(lossyCopyName({})).toBe('MP3');
  });
});
