/**
 * A set row reads "—" and Not known yet only while the analysis may still
 * come (28e): a track it gave up on (failed, its file away) isn't "being
 * worked out" (Brief F re-review).
 */
import { describe, expect, it } from 'vitest';

import type { DjTrack } from '@/features/dj/dj.api';

import { beingWorkedOut } from './set-editor';

const track = (dj: Record<string, unknown> | null) =>
  ({ id: '1', title: 'A', dj }) as unknown as DjTrack;

describe('beingWorkedOut', () => {
  it('is true for a track not analysed yet', () => {
    expect(beingWorkedOut(track({ analyzed: false }))).toBe(true);
    expect(beingWorkedOut(track(null))).toBe(true);
  });

  it('is false once the analysis gave up on it', () => {
    expect(beingWorkedOut(track({ analyzed: false, left_out: 'failed' }))).toBe(false);
    expect(beingWorkedOut(track({ analyzed: false, left_out: 'unreachable' }))).toBe(false);
  });

  it('is false for an analysed track', () => {
    expect(beingWorkedOut(track({ analyzed: true, bpm: 124, key: '8A' }))).toBe(false);
  });
});
