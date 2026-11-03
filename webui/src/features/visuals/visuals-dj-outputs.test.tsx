/**
 * Player settings → Playback → DJ outputs (3b, 37r) with DJ mode off:
 * opening Visuals lists no outputs, says nothing and saves nothing; the
 * panel lists them only once Player settings is open, and never says a word.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { djModeStore } from '@/features/dj-mode/dj-mode-store';
import { DJ_OUTPUTS_KEY } from '@/features/dj-mode/dj-outputs';

import { DjOutputsPortal } from './visuals-host';

const flush = () => act(async () => {});

describe('DJ outputs in Player settings, DJ mode off', () => {
  let enumerate: ReturnType<typeof vi.fn>;
  let announce: ReturnType<typeof vi.spyOn>;
  let setItem: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="np-v2-settings-panel" class="hidden"><div id="ss-dj-outputs-settings"></div></div>`;
    // the player's own output is a chosen device: before the fix the first
    // listing read as "Speakers back"
    localStorage.setItem('ssPlayerOutput', 'b1');
    enumerate = vi.fn(async () => [
      { deviceId: 'b1', label: 'Built-in Output', kind: 'audiooutput', groupId: 'b1' },
      { deviceId: 's2', label: 'Scarlett 2i2', kind: 'audiooutput', groupId: 's2' },
    ]);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: enumerate, addEventListener() {}, removeEventListener() {} },
    });
    announce = vi.spyOn(djModeStore(), 'announce');
    setItem = vi.spyOn(Storage.prototype, 'setItem');
  });

  afterEach(() => {
    announce.mockRestore();
    setItem.mockRestore();
    localStorage.clear();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  it('opening Visuals: nothing listed, said or saved', async () => {
    render(<DjOutputsPortal />);
    await flush();
    expect(document.querySelector('[data-dj-outputs]')).toBeNull();
    expect(enumerate).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalledWith(DJ_OUTPUTS_KEY, expect.anything());
  });

  it('Player settings opened: the outputs are listed, but nothing is said or saved', async () => {
    render(<DjOutputsPortal />);
    await flush();
    document.getElementById('np-v2-settings-panel')!.classList.remove('hidden');
    await flush();
    await flush();
    expect(document.querySelector('[data-dj-outputs]')).not.toBeNull();
    expect(enumerate).toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalledWith(DJ_OUTPUTS_KEY, expect.anything());
  });
});
