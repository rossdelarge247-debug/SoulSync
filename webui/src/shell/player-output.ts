/**
 * The player's Output button: browser-side only (CONTRACTS.md, "The player").
 *
 * - Chrome and Edge: HTMLMediaElement.setSinkId / AudioContext.setSinkId with
 *   the outputs navigator.mediaDevices.enumerateDevices() lists. The player
 *   routes its audio through a Web Audio graph (visualizer, EQ), so once that
 *   graph exists the device has to be set on the AudioContext too.
 * - Firefox: navigator.mediaDevices.selectAudioOutput(), the browser's own picker.
 * - Safari: the AirPlay picker (webkitShowPlaybackTargetPicker).
 * - Anything else: the button stays hidden.
 *
 * No server casting: playing on a Plex, Jellyfin or Navidrome client isn't
 * proposed yet.
 */

export const OUTPUT_KEY = 'ssPlayerOutput';

export type OutputSupport = 'sink' | 'select' | 'airplay' | 'none';

export interface OutputDevice {
  id: string;
  label: string;
}

interface MediaDevicesLike {
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  addEventListener?: (type: string, fn: () => void) => void;
}

interface EnvLike {
  mediaDevices?: MediaDevicesLike | null;
  mediaPrototype?: object | null;
  airplay?: boolean;
}

/** What this browser can do, best first. */
export function outputSupport(env: EnvLike): OutputSupport {
  const md = env.mediaDevices;
  if (md && typeof md.selectAudioOutput === 'function') return 'select';
  if (
    md &&
    typeof md.enumerateDevices === 'function' &&
    env.mediaPrototype &&
    'setSinkId' in env.mediaPrototype
  ) {
    return 'sink';
  }
  if (env.airplay) return 'airplay';
  return 'none';
}

export function browserEnv(win: Window): EnvLike {
  const nav = win.navigator as Navigator & { mediaDevices?: MediaDevicesLike };
  return {
    mediaDevices: nav.mediaDevices ?? null,
    mediaPrototype:
      (win as unknown as { HTMLMediaElement?: { prototype: object } }).HTMLMediaElement
        ?.prototype ?? null,
    airplay: 'WebKitPlaybackTargetAvailabilityEvent' in win,
  };
}

/**
 * The outputs worth offering: one row per device, the "default" and
 * "communications" aliases folded into "This device". Unnamed devices (the
 * browser hides names until it's been allowed the microphone) are numbered.
 */
export function listOutputs(
  devices: Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label' | 'groupId'>[],
): {
  devices: OutputDevice[];
  unnamed: boolean;
} {
  const seen = new Set<string>();
  const out: OutputDevice[] = [];
  let unnamed = false;
  let n = 0;
  for (const d of devices) {
    if (d.kind !== 'audiooutput') continue;
    if (d.deviceId === 'default' || d.deviceId === 'communications' || !d.deviceId) continue;
    if (seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    n += 1;
    if (!d.label) unnamed = true;
    out.push({ id: d.deviceId, label: d.label || `Output ${n}` });
  }
  return { devices: out, unnamed };
}

/** Offer the button only when there's somewhere else to send the sound. */
export function worthOffering(
  support: OutputSupport,
  deviceCount: number,
  airplayAvailable: boolean,
): boolean {
  if (support === 'select') return true;
  if (support === 'sink') return deviceCount >= 2;
  if (support === 'airplay') return airplayAvailable;
  return false;
}

interface SinkTarget {
  setSinkId?: (id: string) => Promise<void>;
}

const asSink = (t: unknown): SinkTarget | null =>
  t && typeof t === 'object' ? (t as SinkTarget) : null;

/**
 * Send the sound to `deviceId` ('' is the system default) on every element and
 * the audio graph. Resolves false when the graph exists but can't follow
 * (an AudioContext without setSinkId), so the caller can say so.
 */
export async function applyOutput(
  deviceId: string,
  targets: { elements: readonly unknown[]; context?: unknown },
): Promise<boolean> {
  const jobs: Promise<unknown>[] = [];
  for (const el of targets.elements.map(asSink)) {
    if (el && typeof el.setSinkId === 'function')
      jobs.push(el.setSinkId(deviceId).catch(() => undefined));
  }
  let ok = true;
  const ctx = asSink(targets.context);
  if (ctx) {
    if (typeof ctx.setSinkId === 'function') {
      jobs.push(
        ctx.setSinkId(deviceId).catch(() => {
          ok = false;
        }),
      );
    } else if (deviceId) {
      ok = false;
    }
  }
  await Promise.all(jobs);
  return ok;
}

export function readSavedOutput(store: Pick<Storage, 'getItem'> | null | undefined): string {
  try {
    return store?.getItem(OUTPUT_KEY) || '';
  } catch {
    return '';
  }
}

export function saveOutput(
  store: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined,
  id: string,
): void {
  try {
    if (id) store?.setItem(OUTPUT_KEY, id);
    else store?.removeItem(OUTPUT_KEY);
  } catch {
    /* blocked: the choice holds for this visit */
  }
}
