/**
 * The Visuals overlay's pieces load lazily (visuals-mount.ts). Everything
 * beyond the SYNCHRO.S visuals hangs on that load: the header's Visuals
 * button, the panel, MilkDrop and Classic. A load that failed used to be
 * swallowed and never tried again, which looked like a Visuals button that did
 * nothing while V still stepped the SYNCHRO.S visuals.
 */

import { act, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VisualsController } from './visuals-controller';

import { LOAD_FAILED_MESSAGE, mountVisualsWhenNeeded } from './visuals-mount';

function markup() {
  document.body.innerHTML = `
    <div id="np-modal-overlay" class="hidden"><div class="np-modal">
      <button type="button" id="np-v2-visuals-panel-btn">Visuals</button>
    </div></div>
    <div id="np-v2-settings-panel" class="hidden"></div>`;
}

const overlay = () => document.getElementById('np-modal-overlay')!;
const button = () => document.getElementById('np-v2-visuals-panel-btn')!;
const flush = () => act(async () => {});

function fakeController() {
  return { togglePanel: vi.fn() } as unknown as VisualsController & {
    togglePanel: ReturnType<typeof vi.fn>;
  };
}

describe('mountVisualsWhenNeeded', () => {
  let toast: ReturnType<typeof vi.fn<NonNullable<Window['showToast']>>>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    markup();
    toast = vi.fn<NonNullable<Window['showToast']>>();
    window.showToast = toast;
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete window.showToast;
    error.mockRestore();
  });

  it('loads when the overlay opens, and once', async () => {
    const controller = fakeController();
    const load = vi.fn(async () => ({ mountVisualsHost: () => controller }));
    mountVisualsWhenNeeded(window, load);
    expect(load).not.toHaveBeenCalled();
    overlay().classList.remove('hidden');
    await flush();
    overlay().classList.add('hidden');
    overlay().classList.remove('hidden');
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('tries a failed load again on the next open', async () => {
    const controller = fakeController();
    const mountHost = vi.fn(() => controller);
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ mountVisualsHost: mountHost });
    mountVisualsWhenNeeded(window, load);
    overlay().classList.remove('hidden');
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(mountHost).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    overlay().classList.add('hidden');
    overlay().classList.remove('hidden');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(mountHost).toHaveBeenCalledTimes(1);
  });

  it('the Visuals button loads the pieces when they aren’t in yet, and opens the panel', async () => {
    const controller = fakeController();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ mountVisualsHost: () => controller });
    mountVisualsWhenNeeded(window, load);
    overlay().classList.remove('hidden');
    await flush();
    // the open's load failed; the overlay stays open and the person clicks Visuals
    button().click();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(controller.togglePanel).toHaveBeenCalledWith(true);
    expect(toast).not.toHaveBeenCalled();
    // from now on the host's own listener has the button
    button().click();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(controller.togglePanel).toHaveBeenCalledTimes(1);
  });

  it('a click while the open’s load is under way opens the panel once it’s in', async () => {
    const controller = fakeController();
    let resolveLoad!: (m: { mountVisualsHost: () => VisualsController }) => void;
    const load = vi.fn(
      () =>
        new Promise<{ mountVisualsHost: () => VisualsController }>((r) => {
          resolveLoad = r;
        }),
    );
    mountVisualsWhenNeeded(window, load);
    overlay().classList.remove('hidden');
    await flush();
    button().click();
    await flush();
    expect(controller.togglePanel).not.toHaveBeenCalled();
    resolveLoad({ mountVisualsHost: () => controller });
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(controller.togglePanel).toHaveBeenCalledTimes(1);
    expect(controller.togglePanel).toHaveBeenCalledWith(true);
  });

  it('says to reload when the pieces can’t be fetched', async () => {
    const load = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'));
    mountVisualsWhenNeeded(window, load);
    overlay().classList.remove('hidden');
    await flush();
    expect(toast).not.toHaveBeenCalled();
    button().click();
    await flush();
    expect(toast).toHaveBeenCalledWith(
      LOAD_FAILED_MESSAGE,
      'error',
      null,
      expect.objectContaining({ action: expect.objectContaining({ label: 'Reload' }) }),
    );
  });
});

describe('the Visuals button with the real host (index.html’s overlay)', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  // the host's module is transformed once here, so the clicks below wait on
  // the mount, not on the test runner
  beforeAll(async () => {
    await import('./visuals-host');
  }, 60_000);

  beforeEach(() => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceChildren(
      document.importNode(parsed.querySelector('#np-modal-overlay')!, true),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the panel from the header, the first time and after', async () => {
    mountVisualsWhenNeeded(window);
    act(() => overlay().classList.remove('hidden'));
    // clicked before the host has finished loading: the panel still opens
    act(() => button().click());
    await waitFor(() => expect(document.getElementById('ss-visuals-panel')).not.toBeNull(), {
      timeout: 5000,
    });
    expect(window.SoulSyncVisuals?.panelOpen()).toBe(true);
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    // the host's listener alone toggles it now: one click, one change
    act(() => button().click());
    await waitFor(() => expect(document.getElementById('ss-visuals-panel')).toBeNull());
    act(() => button().click());
    await waitFor(() => expect(document.getElementById('ss-visuals-panel')).not.toBeNull());
    // the families are there, MilkDrop among them
    expect(document.querySelector('#ss-visuals-panel [data-family="milkdrop"]')).not.toBeNull();
  });
});
