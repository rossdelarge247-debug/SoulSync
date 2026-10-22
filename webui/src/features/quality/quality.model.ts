/**
 * The quality target, judged in the browser the way the server judges it.
 *
 * `meetsTarget` is `AudioQuality.matches_target` (core/quality/model.py),
 * kbps heuristics included: where a file doesn't say its bit depth or sample
 * rate, a FLAC counts as 24-bit at 1450 kbps or more, and a sample-rate floor
 * is checked against the bitrate it implies. `qualityFromPath` is
 * `audio_quality` (core/quality/presets.py): the extension decides the format,
 * and an .m4a at 500 kbps or more counts as ALAC.
 */

export type PresetKey = 'mp3_320' | 'flac' | 'flac_24' | 'lossless';

export const PRESET_KEYS: readonly PresetKey[] = ['mp3_320', 'flac', 'flac_24', 'lossless'];

/** One ranked target of a quality profile, as GET /api/quality/presets sends the bar. */
export interface QualityRule {
  label?: string;
  format?: string;
  bit_depth?: number;
  min_sample_rate?: number;
  min_bitrate?: number;
}

export interface AudioQuality {
  /** lowercase: flac, alac, wav, dsf, mp3, aac, ogg, opus, wma, unknown */
  format: string;
  bitrate?: number | null;
  sampleRate?: number | null;
  bitDepth?: number | null;
}

export const LOSSLESS_FORMATS: ReadonlySet<string> = new Set(['flac', 'alac', 'wav', 'dsf']);

/** core/quality/source_map.py _EXTENSION_FORMAT_MAP */
const EXTENSION_FORMATS: Readonly<Record<string, string>> = {
  flac: 'flac',
  alac: 'alac',
  wav: 'wav',
  wave: 'wav',
  aiff: 'wav',
  aif: 'wav',
  aifc: 'wav',
  mp3: 'mp3',
  m4a: 'aac',
  mp4: 'aac',
  aac: 'aac',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'opus',
  wma: 'wma',
  dsf: 'dsf',
  dff: 'dsf',
};

const ALAC_MIN_KBPS = 500;

/** A format name ('FLAC', 'flac', 'mp3') or an extension, as the model's format. */
export function normalizeFormat(value: string | null | undefined): string {
  const key = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
  return EXTENSION_FORMATS[key] ?? (key || 'unknown');
}

/** The quality of a library file from its path and stored bitrate. */
export function qualityFromPath(
  path: string | null | undefined,
  bitrate?: number | null,
): AudioQuality {
  const match = /\.([a-z0-9]{2,4})$/i.exec(String(path ?? ''));
  const ext = match ? match[1].toLowerCase() : '';
  let format = EXTENSION_FORMATS[ext] ?? 'unknown';
  if (format === 'aac' && (ext === 'm4a' || ext === 'mp4') && (bitrate ?? 0) >= ALAC_MIN_KBPS) {
    format = 'alac';
  }
  return { format, bitrate: bitrate || null };
}

/** core/quality/model.py _sample_rate_to_min_kbps */
function sampleRateToMinKbps(sampleRate: number, bitDepth: number): number {
  return Math.floor(((sampleRate * 2 * bitDepth) / 1000) * 0.55);
}

export function meetsTarget(quality: AudioQuality, target: QualityRule): boolean {
  const format = quality.format.toLowerCase();
  if (target.format && target.format.toLowerCase() !== format) return false;
  if (target.min_bitrate && (quality.bitrate ?? 0) < target.min_bitrate) return false;
  if (target.min_sample_rate) {
    if (quality.sampleRate != null) {
      if (quality.sampleRate < target.min_sample_rate) return false;
    } else if (format === 'flac' && quality.bitrate) {
      if (quality.bitrate < sampleRateToMinKbps(target.min_sample_rate, target.bit_depth || 24)) {
        return false;
      }
    } else {
      return false;
    }
  }
  if (target.bit_depth) {
    if (quality.bitDepth != null) {
      if (quality.bitDepth < target.bit_depth) return false;
    } else if (format === 'flac' && target.bit_depth >= 24) {
      if (!quality.bitrate || quality.bitrate < 1450) return false;
    }
  }
  return true;
}

/** Meets any target of the bar. An empty bar accepts anything. */
export function meetsBar(quality: AudioQuality, bar: readonly QualityRule[]): boolean {
  if (!bar.length) return true;
  return bar.some((target) => meetsTarget(quality, target));
}

function khz(sampleRate: number): string {
  const value = sampleRate >= 1000 ? sampleRate / 1000 : sampleRate;
  return String(Math.round(value * 10) / 10);
}

/** "FLAC 24/96", "FLAC", "MP3 320", "AAC 256", '' when unknown. */
export function qualityLabel(quality: AudioQuality): string {
  if (!quality.format || quality.format === 'unknown') return '';
  const name = quality.format === 'dsf' ? 'DSD' : quality.format.toUpperCase();
  if (LOSSLESS_FORMATS.has(quality.format)) {
    return quality.bitDepth && quality.sampleRate
      ? `${name} ${quality.bitDepth}/${khz(quality.sampleRate)}`
      : name;
  }
  return quality.bitrate ? `${name} ${quality.bitrate}` : name;
}

/**
 * An ordering for "is this copy better than that one": lossless above lossy,
 * then depth and rate (lossless) or bitrate (lossy). Only for comparing two
 * copies of the same thing; the target decides what's good enough.
 */
export function qualityRank(quality: AudioQuality): number {
  if (LOSSLESS_FORMATS.has(quality.format)) {
    return (
      10_000 + (quality.bitDepth ?? 16) * 100 + Math.min((quality.sampleRate ?? 44_100) / 1000, 99)
    );
  }
  if (quality.format === 'unknown') return 0;
  return quality.bitrate ?? 1;
}

/** What each preset card says, long (desktop) and short (phone, board 2r). */
export const PRESET_COPY: Readonly<
  Record<PresetKey, { title: string; long: string; short: string }>
> = {
  mp3_320: {
    title: 'MP3 320',
    long: 'Smallest files. Fine for phones and cars; most Soulseek results qualify.',
    short: 'Smallest files.',
  },
  flac: {
    title: 'FLAC',
    long: 'Lossless CD quality (16-bit, 44.1 kHz). The usual choice for a library you keep.',
    short: 'Lossless CD quality.',
  },
  flac_24: {
    title: 'FLAC 24-bit',
    long: 'Hi-res only. Far fewer copies exist; expect long waits and big files.',
    short: 'Hi-res only.',
  },
  lossless: {
    title: 'Any lossless',
    long: 'FLAC, ALAC, WAV or DSD. Accepts more results; mixed formats in your library.',
    short: 'FLAC, ALAC, WAV or DSD.',
  },
};

export function isPresetKey(value: unknown): value is PresetKey {
  return typeof value === 'string' && (PRESET_KEYS as readonly string[]).includes(value);
}
