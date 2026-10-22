/**
 * Settings → Appearance, the accent colour (the "Settings Appearance" board,
 * 5f): a radio card per preset with the accent and its light shade side by
 * side, "Custom…" with a contrast check, and a preview strip of what the
 * accent touches.
 *
 * The page's own form keeps what's saved: the hidden #accent-preset (a
 * preset's hex, or "custom") and #accent-custom-color (the custom hex).
 * settings.js loads and saves those two as before; this module draws the
 * cards from them and writes back to them. A change fires "change" on the
 * select, which is what the settings page's autosave listens for.
 *
 * A custom hex is only used, and only saved, when dark text on its light
 * shade reaches 4.5:1. One that doesn't says so and offers the nearest
 * preset; the accent stays what it was.
 */

import {
  ACCENT_PRESETS,
  CUSTOM_ACCENT,
  DEFAULT_ACCENT,
  MIN_CONTRAST,
  accentLight,
  accentLine,
  accentReport,
  findPreset,
  formatRatio,
  hexToRgb,
  nearestPreset,
  normaliseHex,
  storedAccent,
} from '@/features/settings/accent';

export const ACCENT_APPLIED_EVENT = 'ss:accent-applied';

const IDS = {
  select: 'accent-preset',
  store: 'accent-custom-color',
  cards: 'accent-preset-cards',
  custom: 'custom-color-group',
  hex: 'accent-custom-hex',
  picker: 'accent-custom-picker',
  check: 'accent-custom-check',
  label: 'accent-preview-label',
  line: 'accent-preview-line',
  wave: 'accent-preview-wave',
} as const;

const HEX_HINT = 'Type # and six digits or letters a–f, like #8b5cf6.';

interface Els {
  select: HTMLSelectElement;
  store: HTMLInputElement;
  cards: HTMLElement;
  custom: HTMLElement;
  hex: HTMLInputElement;
  picker: HTMLInputElement | null;
  check: HTMLElement;
  label: HTMLElement | null;
  line: HTMLElement | null;
  wave: HTMLElement | null;
}

function els(): Els | null {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const select = get<HTMLSelectElement>(IDS.select);
  const store = get<HTMLInputElement>(IDS.store);
  const cards = get<HTMLElement>(IDS.cards);
  const custom = get<HTMLElement>(IDS.custom);
  const hex = get<HTMLInputElement>(IDS.hex);
  const check = get<HTMLElement>(IDS.check);
  if (!select || !store || !cards || !custom || !hex || !check) return null;
  return {
    select,
    store,
    cards,
    custom,
    hex,
    check,
    picker: get<HTMLInputElement>(IDS.picker),
    label: get<HTMLElement>(IDS.label),
    line: get<HTMLElement>(IDS.line),
    wave: get<HTMLElement>(IDS.wave),
  };
}

/** The user picked "Custom…" (even before the hex they type passes). */
let customChosen = false;

function appliedHex(e: Els): string {
  return storedAccent(e.select.value, e.store.value);
}

/** "Lilac", or the custom hex. */
function appliedName(e: Els): string {
  if (e.select.value === CUSTOM_ACCENT) return normaliseHex(e.store.value) ?? DEFAULT_ACCENT;
  return findPreset(e.select.value)?.name ?? 'Spotify Green';
}

/** Put an accent on the page: init.js's applier when it's there. */
function applyAccent(hex: string): void {
  if (typeof window.applyAccentColor === 'function') {
    window.applyAccentColor(hex);
    return;
  }
  const root = document.documentElement.style;
  root.setProperty('--accent-rgb', hexToRgb(hex).join(', '));
  root.setProperty('--accent-light-rgb', hexToRgb(accentLight(hex)).join(', '));
  window.dispatchEvent(new CustomEvent(ACCENT_APPLIED_EVENT, { detail: { hex } }));
}

/** Tell the settings page something changed, so its autosave runs. */
function notifyChanged(e: Els): void {
  e.select.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── the cards ────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function swatch(hex: string | null): HTMLElement {
  const box = el('span', hex ? 'accent-swatch' : 'accent-swatch accent-swatch--empty');
  box.setAttribute('aria-hidden', 'true');
  box.dataset.hex = hex ?? '';
  if (!hex) {
    box.textContent = '#';
    return box;
  }
  const base = el('span', 'accent-swatch-base');
  base.style.background = hex;
  const light = el('span', 'accent-swatch-light');
  light.style.background = accentLight(hex);
  box.append(base, light);
  return box;
}

function card(value: string, name: string): HTMLButtonElement {
  const button = el(
    'button',
    value === CUSTOM_ACCENT ? 'accent-card accent-card--custom' : 'accent-card',
  );
  button.type = 'button';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', 'false');
  button.tabIndex = -1;
  button.dataset.value = value;
  const text = el('span', 'accent-card-text');
  const note = el('span', 'accent-card-note');
  text.append(el('span', 'accent-card-name', name), note);
  button.append(swatch(value === CUSTOM_ACCENT ? null : value), text);
  return button;
}

function cardButtons(e: Els): HTMLButtonElement[] {
  return Array.from(e.cards.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

function buildCards(e: Els): void {
  if (e.cards.dataset.built === 'true') return;
  e.cards.dataset.built = 'true';
  e.cards.replaceChildren(
    ...ACCENT_PRESETS.map((preset) => card(preset.hex, preset.name)),
    card(CUSTOM_ACCENT, 'Custom…'),
  );
  e.cards.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="radio"]');
    if (!button || !e.cards.contains(button)) return;
    choose(e, button.dataset.value ?? '');
    button.focus();
  });
  // A radio group: the arrows move the choice and the focus together.
  e.cards.addEventListener('keydown', (event) => {
    const buttons = cardButtons(e);
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at === -1) return;
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % buttons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (at - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === -1) return;
    event.preventDefault();
    choose(e, buttons[next].dataset.value ?? '');
    buttons[next].focus();
  });
}

function checkedValue(e: Els): string {
  if (customChosen || e.select.value === CUSTOM_ACCENT) return CUSTOM_ACCENT;
  return findPreset(e.select.value)?.hex ?? DEFAULT_ACCENT;
}

function syncCards(e: Els): void {
  const checked = checkedValue(e);
  for (const button of cardButtons(e)) {
    const value = button.dataset.value ?? '';
    const on = value === checked;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
    const note = button.querySelector<HTMLElement>('.accent-card-note');
    if (value === CUSTOM_ACCENT) {
      const inUse = e.select.value === CUSTOM_ACCENT ? normaliseHex(e.store.value) : null;
      const current = button.querySelector<HTMLElement>('.accent-swatch');
      if (current && current.dataset.hex !== (inUse ?? '')) current.replaceWith(swatch(inUse));
      if (note) note.textContent = inUse ?? 'Any hex; checked for contrast';
      continue;
    }
    if (!note) continue;
    const bits: string[] = [];
    if (on) bits.push('Selected');
    if (value === DEFAULT_ACCENT) bits.push(on ? 'the default' : 'The default');
    note.textContent = bits.join(' · ');
  }
}

// ── the custom colour ───────────────────────────────────────────────────────

type CheckState = 'pass' | 'fail' | 'invalid' | 'typing' | 'none';

function line(text: string): HTMLParagraphElement {
  return el('p', 'accent-check-line', text);
}

function renderCheck(e: Els, state: CheckState, raw = ''): void {
  // Same answer as on show: leave it. Leaving the field (blur) re-checks it,
  // and redrawing then would take "Use … instead" away from under the click.
  // (the hint while typing is one sentence: not re-announced per keystroke)
  const said = state === 'typing' || state === 'none' ? '' : raw.trim().toLowerCase();
  const key = `${state}|${said}|${e.select.value}|${e.store.value}`;
  if (e.check.dataset.key === key) return;
  e.check.dataset.key = key;
  e.check.dataset.state = state;
  e.hex.setAttribute('aria-invalid', String(state === 'fail' || state === 'invalid'));
  if (state === 'none') {
    e.check.replaceChildren();
    return;
  }
  if (state === 'typing') {
    e.check.replaceChildren(line(HEX_HINT));
    return;
  }
  if (state === 'invalid') {
    e.check.replaceChildren(line(`“${raw.trim()}” isn't a hex colour. ${HEX_HINT}`));
    return;
  }
  const hex = normaliseHex(raw) ?? DEFAULT_ACCENT;
  const report = accentReport(hex);
  if (state === 'pass') {
    e.check.replaceChildren(
      line(
        `Dark text on its light shade, ${report.light}, is ${formatRatio(report.contrast)}, so buttons stay readable.`,
      ),
    );
    return;
  }
  const nearest = nearestPreset(hex);
  const stays =
    e.select.value === CUSTOM_ACCENT && normaliseHex(e.store.value) === hex
      ? 'It’s in use now; pick a preset or another hex to change it.'
      : `Your accent stays ${appliedName(e)}.`;
  const offer = el('button', 'appearance-btn', `Use ${nearest.name} instead`);
  offer.type = 'button';
  offer.addEventListener('click', () => {
    choose(e, nearest.hex);
    cardButtons(e)
      .find((button) => button.dataset.value === nearest.hex)
      ?.focus();
  });
  e.check.replaceChildren(
    line(
      `${hex} is too dark for an accent. Dark text on its light shade, ${report.light}, is ${formatRatio(
        report.contrast,
      )}, and buttons need ${MIN_CONTRAST}:1. ${stays}`,
    ),
    offer,
  );
}

/**
 * Check what's in the hex field. A passing colour is used and saved at
 * once (`commit`); `final` is a blur or Enter, when a half-typed value
 * becomes an error rather than a hint.
 */
function evaluate(e: Els, raw: string, { commit, final }: { commit: boolean; final: boolean }) {
  const hex = normaliseHex(raw);
  if (!hex) {
    renderCheck(e, final && raw.trim() ? 'invalid' : 'typing', raw);
    return;
  }
  const report = accentReport(hex);
  if (!report.passes) {
    renderCheck(e, 'fail', hex);
    syncCards(e);
    return;
  }
  renderCheck(e, 'pass', hex);
  if (e.picker && e.picker.value !== hex) e.picker.value = hex;
  if (commit && (e.select.value !== CUSTOM_ACCENT || normaliseHex(e.store.value) !== hex)) {
    e.store.value = hex;
    e.select.value = CUSTOM_ACCENT;
    applyAccent(hex);
    notifyChanged(e);
  }
  syncCards(e);
  syncPreview(e);
}

function wireCustom(e: Els): void {
  if (e.hex.dataset.wired === 'true') return;
  e.hex.dataset.wired = 'true';
  e.hex.addEventListener('input', () => evaluate(e, e.hex.value, { commit: true, final: false }));
  e.hex.addEventListener('blur', () => evaluate(e, e.hex.value, { commit: true, final: true }));
  e.hex.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    evaluate(e, e.hex.value, { commit: true, final: true });
  });
  e.picker?.addEventListener('input', () => {
    if (!e.picker) return;
    e.hex.value = e.picker.value;
    evaluate(e, e.picker.value, { commit: true, final: true });
  });
}

// ── choosing ────────────────────────────────────────────────────────────────

function choose(e: Els, value: string): void {
  if (value === CUSTOM_ACCENT) {
    customChosen = true;
    e.custom.hidden = false;
    // start from the accent in use: picking Custom changes nothing by
    // itself; the first different hex that passes does
    const start = appliedHex(e);
    e.hex.value = start;
    if (e.picker) e.picker.value = start;
    evaluate(e, start, { commit: false, final: true });
    syncCards(e);
    return;
  }
  const preset = findPreset(value);
  if (!preset) return;
  customChosen = false;
  e.custom.hidden = true;
  renderCheck(e, 'none');
  if (e.select.value !== preset.hex) {
    e.select.value = preset.hex;
    applyAccent(preset.hex);
    notifyChanged(e);
  }
  syncCards(e);
  syncPreview(e);
}

// ── the preview strip ───────────────────────────────────────────────────────

/** Bar heights for the played-waveform sample (fixed, like the board's). */
export function waveHeights(count = 24, played = 10): { height: number; played: boolean }[] {
  const out: { height: number; played: boolean }[] = [];
  let seed = 11;
  for (let i = 0; i < count; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    out.push({
      height: Math.max(4, Math.round(24 * (0.3 + 0.7 * (seed / 233280)))),
      played: i < played,
    });
  }
  return out;
}

function syncPreview(e: Els): void {
  if (e.wave && !e.wave.childElementCount) {
    e.wave.replaceChildren(
      ...waveHeights().map((bar) => {
        const span = document.createElement('span');
        span.style.height = `${bar.height}px`;
        if (bar.played) span.dataset.played = 'true';
        return span;
      }),
    );
  }
  const hex = appliedHex(e);
  if (e.label) {
    e.label.textContent =
      e.select.value === CUSTOM_ACCENT
        ? 'With your custom colour'
        : `With ${findPreset(hex)?.name ?? 'Spotify Green'}`;
  }
  if (e.line) e.line.textContent = accentLine(accentReport(hex));
}

// ── public ──────────────────────────────────────────────────────────────────

/**
 * Bring the cards in line with the form: after settings.js loads the saved
 * values, and whenever an accent is applied from elsewhere (the dashboard's
 * quick swatches).
 */
export function syncAppearanceSettings(): void {
  const e = els();
  if (!e) return;
  buildCards(e);
  wireCustom(e);
  const preset = (e.select.value || '').toLowerCase();
  if (preset !== CUSTOM_ACCENT && !findPreset(preset)) e.select.value = DEFAULT_ACCENT;
  customChosen = e.select.value === CUSTOM_ACCENT;
  e.custom.hidden = !customChosen;
  if (customChosen) {
    const saved = normaliseHex(e.store.value) ?? DEFAULT_ACCENT;
    e.hex.value = saved;
    if (e.picker) e.picker.value = saved;
    // the saved colour is theirs even if it fails today's check: say so,
    // don't change it
    renderCheck(e, accentReport(saved).passes ? 'pass' : 'fail', saved);
  } else {
    renderCheck(e, 'none');
  }
  syncCards(e);
  syncPreview(e);
}

let listening = false;

/** Draw the cards (shell boot; the markup is parsed by then). */
export function initAppearanceSettings(): void {
  if (!listening) {
    listening = true;
    window.addEventListener(ACCENT_APPLIED_EVENT, () => {
      const e = els();
      if (e) syncPreview(e);
    });
  }
  syncAppearanceSettings();
}

/** Tests only. */
export function _resetAppearanceForTests(): void {
  customChosen = false;
}
