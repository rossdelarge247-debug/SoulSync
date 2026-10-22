/**
 * The accent colour: the presets Settings → Appearance offers, the light
 * shade the app makes from any accent, and the contrast check a custom one
 * has to pass (docs/design/DESIGN-SYSTEM.md, "Colour").
 *
 * The light shade is the accent with +16% HSL lightness, capped at 95%: the
 * same sum `applyAccentColor` (static/init.js) and the page shell
 * (`_initial_appearance_context` in web_server.py) do. Primary buttons put
 * dark text (#0b0b0f) on it, so a custom accent must give that text 4.5:1.
 *
 * What's stored (`ui_appearance.accent_preset`) is a preset's hex, or
 * "custom" with the hex in `ui_appearance.accent_color`. Never a name: a
 * preset can be renamed ("Boulder Purple" is "Lilac" now) without touching
 * anyone's config.
 */

export interface AccentPreset {
  hex: string;
  name: string;
}

/** In the order Settings shows them. index.html's #accent-preset lists the same. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { hex: '#8b5cf6', name: 'Lilac' },
  { hex: '#1db954', name: 'Spotify Green' },
  { hex: '#1d8ab9', name: 'Ocean Blue' },
  { hex: '#a78bfa', name: 'Pale Purple' },
  { hex: '#f59e0b', name: 'Sunset Orange' },
  { hex: '#f43f5e', name: 'Rose' },
  { hex: '#14b8a6', name: 'Teal' },
];

/** New installs start here (Ross hasn't moved the default to Lilac). */
export const DEFAULT_ACCENT = '#1db954';

/** The preset value that means "the hex in accent_color". */
export const CUSTOM_ACCENT = 'custom';

/** Dark text on accent-light: primary buttons, selected tabs on phones. */
export const TEXT_ON_ACCENT = '#0b0b0f';

/** WCAG AA for body-size text. */
export const MIN_CONTRAST = 4.5;

export type Rgb = [number, number, number];

/** "#8B5CF6", "8b5cf6", "#85f" → "#8b5cf6"; anything else → null. */
export function normaliseHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw
      .split('')
      .map((c) => c + c)
      .join('')}`;
  }
  return null;
}

export function hexToRgb(hex: string): Rgb {
  const clean = normaliseHex(hex) ?? DEFAULT_ACCENT;
  return [
    parseInt(clean.slice(1, 3), 16),
    parseInt(clean.slice(3, 5), 16),
    parseInt(clean.slice(5, 7), 16),
  ];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function hue2rgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

/** The accent's light shade, as applyAccentColor computes it. */
export function accentLight(hex: string): string {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const lightL = Math.min(l + 0.16, 0.95);
  if (s === 0) {
    const v = Math.round(lightL * 255);
    return rgbToHex([v, v, v]);
  }
  const q = lightL < 0.5 ? lightL * (1 + s) : lightL + s - lightL * s;
  const p = 2 * lightL - q;
  return rgbToHex([
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * "9.7:1", to one decimal. A ratio that misses 4.5 never reads as 4.5 next
 * to "doesn't pass": 4.46 shows as 4.4.
 */
export function formatRatio(ratio: number): string {
  let shown = Math.round(ratio * 10) / 10;
  if (ratio < MIN_CONTRAST && shown >= MIN_CONTRAST) shown = MIN_CONTRAST - 0.1;
  return `${shown.toFixed(1)}:1`;
}

export interface AccentReport {
  hex: string;
  light: string;
  /** Dark text (#0b0b0f) on the light shade. */
  contrast: number;
  passes: boolean;
}

export function accentReport(hex: string): AccentReport {
  const clean = normaliseHex(hex) ?? DEFAULT_ACCENT;
  const light = accentLight(clean);
  const contrast = contrastRatio(TEXT_ON_ACCENT, light);
  return { hex: clean, light, contrast, passes: contrast >= MIN_CONTRAST };
}

/** The mono line under the preview: "#8b5cf6 → light #c2a9fa · dark text on it 9.7:1". */
export function accentLine(report: AccentReport): string {
  return `${report.hex} → light ${report.light} · dark text on it ${formatRatio(report.contrast)}`;
}

export function findPreset(hex: string | null | undefined): AccentPreset | null {
  const clean = normaliseHex(hex ?? '');
  return clean ? (ACCENT_PRESETS.find((preset) => preset.hex === clean) ?? null) : null;
}

function toLab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** HSL hue in degrees and saturation 0–1. */
function hueAndSaturation(hex: string): [number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return [0, 0];
  const l = (max + min) / 2;
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s];
}

/**
 * The preset most like a colour. A custom accent fails for being too dark,
 * so lightness is the one thing it shouldn't match on: the nearest hue wins.
 * A grey has no hue, so it goes by plain colour distance (CIE76). Every
 * preset passes the check.
 */
export function nearestPreset(hex: string): AccentPreset {
  const [hue, saturation] = hueAndSaturation(hex);
  let best = ACCENT_PRESETS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  const lab = toLab(hex);
  for (const preset of ACCENT_PRESETS) {
    let distance: number;
    if (saturation < 0.15) {
      const [pl, pa, pb] = toLab(preset.hex);
      distance = (lab[0] - pl) ** 2 + (lab[1] - pa) ** 2 + (lab[2] - pb) ** 2;
    } else {
      const [presetHue] = hueAndSaturation(preset.hex);
      const turn = Math.abs(hue - presetHue) % 360;
      distance = Math.min(turn, 360 - turn);
    }
    if (distance < bestDistance) {
      best = preset;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The accent in use from what's stored: a preset's hex, or "custom" and the
 * custom hex. Anything unreadable is the default, as the page shell does.
 */
export function storedAccent(preset: unknown, custom: unknown): string {
  if (preset === CUSTOM_ACCENT) return normaliseHex(custom) ?? DEFAULT_ACCENT;
  return normaliseHex(preset) ?? DEFAULT_ACCENT;
}
