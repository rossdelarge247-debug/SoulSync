import { describe, expect, it, vi } from 'vitest';

import {
  applyOutput,
  listOutputs,
  OUTPUT_KEY,
  outputSupport,
  readSavedOutput,
  saveOutput,
  worthOffering,
} from './player-output';

const device = (deviceId: string, label = '', kind: MediaDeviceKind = 'audiooutput') => ({
  deviceId,
  label,
  kind,
  groupId: '',
});

describe('what the browser can do', () => {
  it('Firefox picker first, then setSinkId, then AirPlay, else nothing', () => {
    const enumerateDevices = async () => [];
    expect(outputSupport({ mediaDevices: { selectAudioOutput: async () => ({}) as never } })).toBe(
      'select',
    );
    expect(
      outputSupport({ mediaDevices: { enumerateDevices }, mediaPrototype: { setSinkId() {} } }),
    ).toBe('sink');
    expect(outputSupport({ mediaDevices: { enumerateDevices }, mediaPrototype: {} })).toBe('none');
    expect(outputSupport({ mediaDevices: null, airplay: true })).toBe('airplay');
    expect(outputSupport({})).toBe('none');
  });

  it('offers the button only when there is somewhere else to send the sound', () => {
    expect(worthOffering('none', 5, true)).toBe(false);
    expect(worthOffering('sink', 1, false)).toBe(false);
    expect(worthOffering('sink', 2, false)).toBe(true);
    expect(worthOffering('airplay', 0, false)).toBe(false);
    expect(worthOffering('airplay', 0, true)).toBe(true);
    expect(worthOffering('select', 0, false)).toBe(true);
  });
});

describe('the outputs', () => {
  it('folds the default aliases, drops inputs and repeats, numbers unnamed devices', () => {
    const { devices, unnamed } = listOutputs([
      device('default', 'Default'),
      device('communications', 'Comms'),
      device('mic', 'Mic', 'audioinput'),
      device('a', 'Speakers'),
      device('a', 'Speakers'),
      device('b'),
    ]);
    expect(devices).toEqual([
      { id: 'a', label: 'Speakers' },
      { id: 'b', label: 'Output 2' },
    ]);
    expect(unnamed).toBe(true);
  });

  it('sets the sink on every element and the audio graph', async () => {
    const el = { setSinkId: vi.fn(async () => undefined) };
    const ctx = { setSinkId: vi.fn(async () => undefined) };
    await expect(applyOutput('b', { elements: [el, null], context: ctx })).resolves.toBe(true);
    expect(el.setSinkId).toHaveBeenCalledWith('b');
    expect(ctx.setSinkId).toHaveBeenCalledWith('b');
  });

  it('says so when the audio graph cannot follow', async () => {
    await expect(applyOutput('b', { elements: [], context: {} })).resolves.toBe(false);
    await expect(applyOutput('', { elements: [], context: {} })).resolves.toBe(true);
    const failing = { setSinkId: async () => Promise.reject(new Error('no')) };
    await expect(applyOutput('b', { elements: [], context: failing })).resolves.toBe(false);
  });

  it('remembers the choice per browser, and the default is no entry', () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    expect(readSavedOutput(store)).toBe('');
    saveOutput(store, 'b');
    expect(data.get(OUTPUT_KEY)).toBe('b');
    expect(readSavedOutput(store)).toBe('b');
    saveOutput(store, '');
    expect(data.has(OUTPUT_KEY)).toBe(false);
    expect(readSavedOutput(null)).toBe('');
  });
});
