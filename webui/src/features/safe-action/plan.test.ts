import { describe, expect, it } from 'vitest';

import {
  folderTail,
  formatBytes,
  isPlanRefusalCode,
  pathTail,
  planExpired,
  previewWindowText,
  readRefusal,
  toCsv,
} from './plan';

describe('readRefusal', () => {
  it('accepts a 2xx that does not say success: false', () => {
    expect(readRefusal(200, { success: true })).toBeNull();
    expect(readRefusal(200, {})).toBeNull();
  });

  it("keeps the backend's own copy and offers a new preview for every plan code", () => {
    for (const code of ['plan_required', 'plan_unknown', 'plan_expired', 'plan_wrong_tool']) {
      expect(readRefusal(409, { success: false, code, error: 'Preview again.' })).toEqual({
        code,
        message: 'Preview again.',
        previewAgain: true,
      });
    }
  });

  it('does not offer a new preview for a refusal a preview cannot fix', () => {
    expect(readRefusal(409, { success: false, error: 'A scan is already in progress' })).toEqual({
      code: '',
      message: 'A scan is already in progress',
      previewAgain: false,
    });
    expect(readRefusal(200, { success: false }, 'Nope')).toMatchObject({ message: 'Nope' });
  });

  it('treats confirm_large_move_required as its own thing, not a stale plan', () => {
    expect(isPlanRefusalCode('confirm_large_move_required')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats sizes the way the confirm screen shows them', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB');
    expect(formatBytes(150 * 1024 ** 2)).toBe('150 MB');
  });

  it('shows the tail of a path', () => {
    expect(pathTail('/music/Radiohead/OK Computer/01 Airbag.flac')).toBe(
      'Radiohead/OK Computer/01 Airbag.flac',
    );
    expect(folderTail('/music/Radiohead/OK Computer/01 Airbag.flac')).toBe('Radiohead/OK Computer');
    expect(pathTail('C:\\Music\\A\\b.mp3', 2)).toBe('A/b.mp3');
  });

  it('quotes every CSV cell and doubles quotes', () => {
    expect(
      toCsv([
        ['a', 'say "hi"'],
        [1, null],
      ]),
    ).toBe('"a","say ""hi"""\r\n"1",""');
  });
});

describe('the preview window', () => {
  it('is expired only once its expiry has passed, and never when unknown', () => {
    expect(planExpired({ expires_at: 100 }, 99_000)).toBe(false);
    expect(planExpired({ expires_at: 100 }, 100_000)).toBe(true);
    expect(planExpired({ expires_at: null }, Date.now())).toBe(false);
    expect(planExpired(null)).toBe(false);
  });

  it('says when it was made and when it stops working', () => {
    const text = previewWindowText(1_800_000_000, 1_800_000_900);
    expect(text).toMatch(
      /^This preview was made at .+ and works until .+\. After that, preview again/,
    );
    expect(previewWindowText(null, 1)).toBe('');
  });
});
