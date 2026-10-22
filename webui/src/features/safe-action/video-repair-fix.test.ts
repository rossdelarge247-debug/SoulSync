/**
 * The video repair confirm's words (Design, HANDOFF 26): the title names the
 * worst thing that happens, and the lead has the full picture.
 */

import { describe, expect, it } from 'vitest';

import { videoRepairFixCopy } from './video-repair-fix';

describe('the video repair confirm', () => {
  it('says "Permanently delete" whenever any delete is permanent, with the full picture', () => {
    const copy = videoRepairFixCopy({
      total: 4,
      by_effect: { delete: 2, recycle: 1, move: 1 },
      files_by_effect: { delete: 2, recycle: 1, move: 1 },
    });
    expect(copy.title).toBe('Permanently delete 2 files?');
    expect(copy.lead).toBe(
      "This can't be undone. Fixes 4 findings: 2 files deleted for good, 1 moved to the recycle bin, 1 renamed.",
    );
    expect(copy.confirm).toBe('Fix 4 findings');
    expect(copy.deleted).toBe(2);
  });

  it('counts files, not fixes: a movie can have several', () => {
    const copy = videoRepairFixCopy({
      total: 1,
      by_effect: { delete: 1 },
      files_by_effect: { delete: 3 },
    });
    expect(copy.title).toBe('Permanently delete 3 files?');
    expect(copy.lead).toBe("This can't be undone. Fixes 1 finding: 3 files deleted for good.");
  });

  it('says "Fix N findings?" only when nothing is permanent', () => {
    const copy = videoRepairFixCopy({
      total: 3,
      by_effect: { recycle: 2, move: 1 },
      files_by_effect: { recycle: 2, move: 1 },
    });
    expect(copy.title).toBe('Fix 3 findings?');
    expect(copy.lead).toBe('Fixes 3 findings: 2 files moved to the recycle bin, 1 renamed.');
  });

  it('names the fixes that only change records', () => {
    expect(
      videoRepairFixCopy({
        total: 5,
        by_effect: { move: 1, write: 2, library: 2 },
        files_by_effect: { move: 1 },
      }).lead,
    ).toBe(
      'Fixes 5 findings: 1 file renamed; the other 4 only change the wishlist, the library record or the download queue.',
    );
    expect(videoRepairFixCopy({ total: 2, by_effect: { write: 2 } }).lead).toBe(
      'Fixes 2 findings: they only change the wishlist, the library record or the download queue.',
    );
  });

  it('counts movies when the preview has no file counts', () => {
    const copy = videoRepairFixCopy({ total: 2, by_effect: { delete: 1, recycle: 1 } });
    expect(copy.title).toBe('Permanently delete 1 movie?');
    expect(copy.lead).toBe(
      "This can't be undone. Fixes 2 findings: 1 movie deleted for good, 1 moved to the recycle bin.",
    );
  });
});
