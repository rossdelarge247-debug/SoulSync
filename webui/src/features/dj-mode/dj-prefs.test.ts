/** DJ mode's kept settings (step 5): zoom, the Tempo fader's direction, Auto-gain, per profile. */
import { describe, expect, it } from 'vitest';

import { DjPrefsStore, defaultPrefs, prefsKey, readPrefs, savePrefs } from './dj-prefs';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe('DJ prefs', () => {
  it('defaults: 16 bars a lane (S3), + at the bottom (M8), Auto-gain on (S6)', () => {
    expect(defaultPrefs()).toEqual({
      zoom: { a: 16, b: 16 },
      tempoPlus: 'down',
      autoGain: true,
      quantize: true,
    });
    expect(readPrefs(null)).toEqual(defaultPrefs());
    expect(readPrefs(memory(), 3)).toEqual(defaultPrefs());
  });

  it('kept per profile; anything odd read back as the default', () => {
    const s = memory();
    savePrefs(
      s,
      { zoom: { a: 4, b: 'whole' }, tempoPlus: 'up', autoGain: false, quantize: false },
      1,
    );
    expect(readPrefs(s, 1)).toEqual({
      zoom: { a: 4, b: 'whole' },
      tempoPlus: 'up',
      autoGain: false,
      quantize: false,
    });
    expect(readPrefs(s, 2)).toEqual(defaultPrefs());
    expect(prefsKey(null)).toBe('soulsync-dj-prefs:unscoped');
    s.setItem(prefsKey(5), JSON.stringify({ zoom: { a: 3 }, tempoPlus: 'sideways' }));
    expect(readPrefs(s, 5)).toEqual(defaultPrefs());
    s.setItem(prefsKey(6), '{not json');
    expect(readPrefs(s, 6)).toEqual(defaultPrefs());
  });

  it('the store saves a change and tells its listeners; blocked storage holds it for the visit', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const p = new DjPrefsStore(blocked);
    let told = 0;
    p.subscribe(() => (told += 1));
    p.set({ tempoPlus: 'up' });
    expect(told).toBe(1);
    expect(p.snapshot().tempoPlus).toBe('up');
  });
});
