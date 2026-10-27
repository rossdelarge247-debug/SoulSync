import { describe, expect, it } from 'vitest';

import { mixSupport } from './support';

describe('can this page run the decks', () => {
  it('a secure page with AudioWorklet can; plain http on another address can’t, and says why', () => {
    const worklet = function AudioWorkletNode() {};
    expect(mixSupport({ isSecureContext: true, AudioWorkletNode: worklet })).toBeNull();
    expect(mixSupport({ isSecureContext: false, AudioWorkletNode: worklet })).toMatch(
      /^Auto mix needs SYNCHRO.S on https/,
    );
    expect(mixSupport({ isSecureContext: true })).toBe("This browser can't run Auto mix's decks");
    expect(mixSupport(null)).toBeNull();
  });
});
