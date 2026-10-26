import { afterEach, describe, expect, it } from 'vitest';

import {
  DRAFT_STORAGE_PREFIX,
  clearDraft,
  readDraft,
  resetDraftsForTests,
  writeDraft,
} from './draft-store';

afterEach(() => {
  window.localStorage.clear();
  resetDraftsForTests();
});

describe('the draft, kept per browser and per profile (HANDOFF 246)', () => {
  it('keeps a draft for its profile only', () => {
    writeDraft(2, {
      name: 'Sunday',
      kind: 'hand',
      rows: [{ track_id: '1', artist: 'A', title: 'B', state: 'owned' }],
    });
    expect(readDraft(2)?.name).toBe('Sunday');
    expect(readDraft(3)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(`${DRAFT_STORAGE_PREFIX}2`)!).rows).toHaveLength(
      1,
    );
    clearDraft(2);
    expect(readDraft(2)).toBeNull();
  });

  it('ignores a stored draft that is not one', () => {
    window.localStorage.setItem(`${DRAFT_STORAGE_PREFIX}4`, '{"name": 3}');
    expect(readDraft(4)).toBeNull();
    resetDraftsForTests();
    window.localStorage.setItem(`${DRAFT_STORAGE_PREFIX}4`, 'not json');
    expect(readDraft(4)).toBeNull();
  });
});
