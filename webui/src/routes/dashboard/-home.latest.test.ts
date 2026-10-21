import { describe, expect, it } from 'vitest';

import type { LatestItem } from './-home.api';

import { latestAction, latestTag, splitDetail } from './-home.latest';

function item(partial: Partial<LatestItem>): LatestItem {
  return {
    id: 'x',
    time: 1,
    kind: 'download',
    status: 'ok',
    title: 'Downloaded 12 tracks',
    detail: '',
    link: null,
    needsYou: false,
    ...partial,
  };
}

describe('latestTag', () => {
  it('always has a word, and "Needs you" wins', () => {
    expect(latestTag(item({ status: 'ok' }))).toEqual({ word: 'Done', tone: 'success' });
    expect(latestTag(item({ status: 'running' }))).toEqual({
      word: 'Running',
      tone: 'info',
      live: true,
    });
    expect(latestTag(item({ status: 'warning' }))).toEqual({
      word: 'Partly done',
      tone: 'warning',
    });
    expect(latestTag(item({ status: 'error' }))).toEqual({ word: 'Failed', tone: 'danger' });
    expect(latestTag(item({ status: 'info' }))).toEqual({ word: 'Info', tone: 'neutral' });
    expect(latestTag(item({ status: 'error', needsYou: true }))).toEqual({
      word: 'Needs you',
      tone: 'warning',
    });
  });
});

describe('latestAction', () => {
  it('offers one link only for what needs you', () => {
    expect(latestAction(item({ link: '/active-downloads' }))).toBeNull();
    expect(latestAction(item({ kind: 'safety', needsYou: true, link: '/tools' }))).toEqual({
      label: 'Preview again',
      href: '/tools',
    });
    expect(latestAction(item({ kind: 'import', needsYou: true, link: '/import' }))?.label).toBe(
      'Choose',
    );
    expect(latestAction(item({ kind: 'safety', needsYou: true, link: null }))).toBeNull();
  });

  it('links the words where the sentence already says them', () => {
    expect(
      splitDetail('Nothing was changed. Preview again to recycle 214 files.', 'Preview again'),
    ).toEqual({
      before: 'Nothing was changed. ',
      after: ' to recycle 214 files.',
      inline: true,
    });
    expect(splitDetail('Nothing was imported.', 'Choose')).toEqual({
      before: 'Nothing was imported.',
      after: '',
      inline: false,
    });
  });
});
