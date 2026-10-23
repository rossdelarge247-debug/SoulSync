// The two packages ship no types; these are the parts the Visuals use.

declare module 'butterchurn' {
  export interface ButterchurnVisualizer {
    loadPreset(preset: Record<string, unknown>, blendTime?: number): void;
    setRendererSize(width: number, height: number, opts?: { pixelRatio?: number }): void;
    render(opts?: {
      audioLevels?: {
        timeByteArray: Uint8Array;
        timeByteArrayL: Uint8Array;
        timeByteArrayR: Uint8Array;
      };
      elapsedTime?: number;
    }): void;
  }
  export interface Butterchurn {
    createVisualizer(
      context: AudioContext | null,
      canvas: HTMLCanvasElement,
      opts: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
    ): ButterchurnVisualizer;
  }
  const butterchurn: Butterchurn | { default: Butterchurn };
  export default butterchurn;
}

declare module 'milkdrop-preset-converter' {
  export function convertPreset(
    text: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}
