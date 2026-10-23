/**
 * The accent colour picker (the "Settings Appearance" board, 5f): a radio
 * card per preset with the accent and its light shade side by side,
 * "Custom…" with a contrast check, and a preview strip of what the accent
 * touches.
 *
 * Each profile picks its own (HANDOFF 35): a choice here is this profile's,
 * saved with `PUT /api/profiles/me/appearance`
 * (src/features/settings/profile-accent.ts). Profiles that haven't picked
 * use the install's accent, which admins set from the same card ("Make …
 * the default"); that one is still kept in Settings → Appearance's form,
 * the hidden #accent-preset (a preset's hex, or "custom") and
 * #accent-custom-color, which settings.js loads and autosaves as before.
 *
 * The picker is drawn into Settings → Appearance (#accent-picker, admins)
 * and into a member's My Account (src/shell/my-accounts.ts), since members
 * don't have Settings. Both read one store, so they agree.
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
import {
  accentStore,
  appliedAccent,
  loadProfileAccent,
  onAccentStore,
  saveProfileAccent,
  setInstallAccent,
} from '@/features/settings/profile-accent';

export const ACCENT_APPLIED_EVENT = 'ss:accent-applied';

const HEX_HINT = 'Type # and six digits or letters a–f, like #8b5cf6.';
/** A custom colour that passes is saved once typing pauses this long. */
const CUSTOM_SAVE_MS = 450;

/** Settings → Appearance's form: the install's accent (admins). */
const FORM = { select: 'accent-preset', store: 'accent-custom-color' } as const;

function formEls(): { select: HTMLSelectElement; store: HTMLInputElement } | null {
  const select = document.getElementById(FORM.select) as HTMLSelectElement | null;
  const store = document.getElementById(FORM.store) as HTMLInputElement | null;
  return select && store ? { select, store } : null;
}

/** The accent's name: "Lilac", or the hex. */
export function accentName(hex: string): string {
  return findPreset(hex)?.name ?? normaliseHex(hex) ?? DEFAULT_ACCENT;
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

function toast(message: string, tone: 'error' | 'success' = 'error'): void {
  window.showToast?.(message, tone);
}

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

type CheckState = 'pass' | 'fail' | 'invalid' | 'typing' | 'none';

export interface PickerOptions {
  /** id prefix, so labels and live regions stay unique ("accent" in Settings) */
  prefix: string;
  /** Settings → Appearance: admins also set the install's default here */
  installDefault?: boolean;
}

/** One picker drawn into one root. */
class AccentPicker {
  readonly root: HTMLElement;
  readonly opts: PickerOptions;
  private cards!: HTMLElement;
  private custom!: HTMLElement;
  private hex!: HTMLInputElement;
  private picker!: HTMLInputElement;
  private check!: HTMLElement;
  private source!: HTMLElement;
  private sourceText!: HTMLElement;
  private reset!: HTMLButtonElement;
  private defaults: HTMLElement | null = null;
  private defaultsText: HTMLElement | null = null;
  private makeDefault: HTMLButtonElement | null = null;
  private label!: HTMLElement;
  private line!: HTMLElement;
  /** "Custom…" is chosen (even before the hex typed passes) */
  private customChosen = false;
  private saveTimer: number | null = null;

  constructor(root: HTMLElement, opts: PickerOptions) {
    this.root = root;
    this.opts = opts;
    this.build();
  }

  // ── building ──────────────────────────────────────────────────────────

  private build(): void {
    const p = this.opts.prefix;
    this.root.classList.add('accent-picker');
    this.root.dataset.built = 'true';

    this.cards = el('div', 'accent-cards');
    this.cards.id = `${p}-preset-cards`;
    this.cards.setAttribute('role', 'radiogroup');
    this.cards.setAttribute('aria-label', 'Accent colour');
    this.cards.replaceChildren(
      ...ACCENT_PRESETS.map((preset) => card(preset.hex, preset.name)),
      card(CUSTOM_ACCENT, 'Custom…'),
    );
    this.cards.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="radio"]');
      if (!button || !this.cards.contains(button)) return;
      this.choose(button.dataset.value ?? '');
      button.focus();
    });
    // A radio group: the arrows move the choice and the focus together.
    this.cards.addEventListener('keydown', (event) => {
      const buttons = this.cardButtons();
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
      this.choose(buttons[next].dataset.value ?? '');
      buttons[next].focus();
    });

    this.custom = el('div', 'accent-custom');
    this.custom.id = `${p}-custom-group`;
    this.custom.hidden = true;
    const hexLabel = el('label', 'accent-custom-label', 'Custom colour');
    hexLabel.htmlFor = `${p}-custom-hex`;
    const fields = el('div', 'accent-custom-fields');
    this.hex = el('input', 'accent-custom-hex');
    Object.assign(this.hex, {
      type: 'text',
      id: `${p}-custom-hex`,
      inputMode: 'text',
      autocomplete: 'off',
      spellcheck: false,
      maxLength: 7,
      placeholder: DEFAULT_ACCENT,
    });
    this.hex.setAttribute('aria-describedby', `${p}-custom-check`);
    this.picker = el('input', 'accent-custom-picker');
    this.picker.type = 'color';
    this.picker.id = `${p}-custom-picker`;
    this.picker.value = DEFAULT_ACCENT;
    this.picker.setAttribute('aria-label', 'Pick a colour');
    fields.append(this.hex, this.picker);
    this.check = el('div', 'accent-check');
    this.check.id = `${p}-custom-check`;
    this.check.setAttribute('aria-live', 'polite');
    this.custom.append(hexLabel, fields, this.check);
    this.hex.addEventListener('input', () => this.evaluate(this.hex.value, true, false));
    this.hex.addEventListener('blur', () => this.evaluate(this.hex.value, true, true));
    this.hex.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.evaluate(this.hex.value, true, true);
    });
    this.picker.addEventListener('input', () => {
      this.hex.value = this.picker.value;
      this.evaluate(this.picker.value, true, true);
    });

    this.source = el('div', 'accent-source');
    this.sourceText = el('p', 'accent-source-text');
    this.sourceText.id = `${p}-source`;
    this.reset = el('button', 'appearance-btn');
    this.reset.type = 'button';
    this.reset.addEventListener('click', () => void this.save(null));
    this.source.append(this.sourceText, this.reset);

    const preview = el('div', 'accent-preview');
    this.label = el('p', 'accent-preview-label');
    this.label.id = `${p}-preview-label`;
    const strip = el('div', 'accent-preview-strip');
    const samples = el('div', 'accent-preview-samples');
    samples.setAttribute('aria-hidden', 'true');
    const wave = el('span', 'accent-sample-wave');
    wave.id = `${p}-preview-wave`;
    wave.replaceChildren(
      ...waveHeights().map((bar) => {
        const span = document.createElement('span');
        span.style.height = `${bar.height}px`;
        if (bar.played) span.dataset.played = 'true';
        return span;
      }),
    );
    samples.append(
      el('span', 'accent-sample-primary', 'Add to Wanted'),
      el('span', 'accent-sample-selected', 'Selected row'),
      el('span', 'accent-sample-link', 'A link'),
      el('span', 'accent-sample-focus', 'Keyboard focus'),
      wave,
    );
    this.line = el('p', 'accent-preview-line');
    this.line.id = `${p}-preview-line`;
    strip.append(samples, this.line);
    preview.append(this.label, strip);

    const parts: HTMLElement[] = [this.cards, this.custom, this.source];
    if (this.opts.installDefault) {
      this.defaults = el('div', 'accent-default');
      this.defaults.hidden = true;
      this.defaultsText = el('p', 'accent-default-text');
      this.defaultsText.id = `${p}-default`;
      this.makeDefault = el('button', 'appearance-btn');
      this.makeDefault.type = 'button';
      this.makeDefault.addEventListener('click', () => this.makeInstallDefault());
      this.defaults.append(this.defaultsText, this.makeDefault);
      parts.push(this.defaults);
    }
    parts.push(preview);
    this.root.replaceChildren(...parts);
  }

  private cardButtons(): HTMLButtonElement[] {
    return Array.from(this.cards.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  }

  // ── what's shown ──────────────────────────────────────────────────────

  private checkedValue(): string {
    if (this.customChosen) return CUSTOM_ACCENT;
    return findPreset(appliedAccent())?.hex ?? CUSTOM_ACCENT;
  }

  /** Draw from the store (and keep a half-typed custom colour as it is). */
  render(): void {
    const store = accentStore();
    const applied = appliedAccent();
    if (!this.customChosen && !findPreset(applied)) this.customChosen = true;
    const checked = this.checkedValue();
    for (const button of this.cardButtons()) {
      const value = button.dataset.value ?? '';
      const on = value === checked;
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
      const note = button.querySelector<HTMLElement>('.accent-card-note');
      if (value === CUSTOM_ACCENT) {
        const inUse = findPreset(applied) ? null : applied;
        const current = button.querySelector<HTMLElement>('.accent-swatch');
        if (current && current.dataset.hex !== (inUse ?? '')) current.replaceWith(swatch(inUse));
        if (note) note.textContent = inUse ?? 'Any hex; checked for contrast';
        continue;
      }
      if (!note) continue;
      const bits: string[] = [];
      if (on) bits.push('Selected');
      // "the default" is what profiles without a pick get: the install's
      if (value === store.install) bits.push(on ? 'the default' : 'The default');
      note.textContent = bits.join(' · ');
    }

    this.custom.hidden = !this.customChosen;
    if (this.customChosen) {
      // a custom colour in use fills the field; a half-typed one is left alone
      if (document.activeElement !== this.hex && !findPreset(applied)) {
        this.hex.value = applied;
        this.picker.value = applied;
      }
      const shown = normaliseHex(this.hex.value);
      if (shown) this.renderCheck(accentReport(shown).passes ? 'pass' : 'fail', shown);
    } else {
      this.renderCheck('none');
    }

    const installName = accentName(store.install);
    if (store.mine) {
      this.sourceText.textContent = `Yours: ${accentName(store.mine)}. Profiles that haven’t picked their own use ${installName}.`;
      this.reset.textContent = `Use the default, ${installName}`;
      this.reset.hidden = store.mine === store.install;
    } else {
      this.sourceText.textContent = `You’re using this SYNCHRO.S’s default, ${installName}. Pick one above to make it yours.`;
      this.reset.hidden = true;
    }

    if (this.defaults && this.defaultsText && this.makeDefault) {
      this.defaults.hidden = !store.isAdmin;
      this.defaultsText.textContent = `Default for profiles that haven’t picked: ${installName}.`;
      this.makeDefault.textContent = `Make ${accentName(applied)} the default`;
      this.makeDefault.hidden = applied === store.install;
    }

    this.label.textContent = store.mine
      ? findPreset(applied)
        ? `With ${accentName(applied)}, yours`
        : 'With your custom colour'
      : `With ${installName}, the default`;
    this.line.textContent = accentLine(accentReport(applied));
  }

  // ── the custom colour ─────────────────────────────────────────────────

  private renderCheck(state: CheckState, raw = ''): void {
    // Same answer as on show: leave it. Leaving the field (blur) re-checks it,
    // and redrawing then would take "Use … instead" away from under the click.
    const said = state === 'typing' || state === 'none' ? '' : raw.trim().toLowerCase();
    const key = `${state}|${said}|${appliedAccent()}`;
    if (this.check.dataset.key === key) return;
    this.check.dataset.key = key;
    this.check.dataset.state = state;
    this.hex.setAttribute('aria-invalid', String(state === 'fail' || state === 'invalid'));
    const line = (text: string) => el('p', 'accent-check-line', text);
    if (state === 'none') {
      this.check.replaceChildren();
      return;
    }
    if (state === 'typing') {
      this.check.replaceChildren(line(HEX_HINT));
      return;
    }
    if (state === 'invalid') {
      this.check.replaceChildren(line(`“${raw.trim()}” isn't a hex colour. ${HEX_HINT}`));
      return;
    }
    const hex = normaliseHex(raw) ?? DEFAULT_ACCENT;
    const report = accentReport(hex);
    if (state === 'pass') {
      this.check.replaceChildren(
        line(
          `Dark text on its light shade, ${report.light}, is ${formatRatio(report.contrast)}, so buttons stay readable.`,
        ),
      );
      return;
    }
    const nearest = nearestPreset(hex);
    const stays =
      appliedAccent() === hex
        ? 'It’s in use now; pick a preset or another hex to change it.'
        : `Your accent stays ${accentName(appliedAccent())}.`;
    const offer = el('button', 'appearance-btn', `Use ${nearest.name} instead`);
    offer.type = 'button';
    offer.addEventListener('click', () => {
      this.choose(nearest.hex);
      this.cardButtons()
        .find((button) => button.dataset.value === nearest.hex)
        ?.focus();
    });
    this.check.replaceChildren(
      line(
        `${hex} is too dark for an accent. Dark text on its light shade, ${report.light}, is ${formatRatio(
          report.contrast,
        )}, and buttons need ${MIN_CONTRAST}:1. ${stays}`,
      ),
      offer,
    );
  }

  /**
   * Check what's in the hex field. A passing colour is shown at once and
   * saved when typing pauses (`commit`); `final` is a blur or Enter, when a
   * half-typed value becomes an error rather than a hint.
   */
  private evaluate(raw: string, commit: boolean, final: boolean): void {
    const hex = normaliseHex(raw);
    if (!hex) {
      this.renderCheck(final && raw.trim() ? 'invalid' : 'typing', raw);
      return;
    }
    const report = accentReport(hex);
    if (!report.passes) {
      this.renderCheck('fail', hex);
      return;
    }
    this.renderCheck('pass', hex);
    if (this.picker.value !== hex) this.picker.value = hex;
    if (!commit || hex === accentStore().mine) return;
    applyAccent(hex);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    const run = () => {
      this.saveTimer = null;
      void this.save(hex);
    };
    if (final) run();
    else this.saveTimer = window.setTimeout(run, CUSTOM_SAVE_MS);
  }

  // ── choosing ──────────────────────────────────────────────────────────

  choose(value: string): void {
    if (value === CUSTOM_ACCENT) {
      this.customChosen = true;
      // start from the accent in use: picking Custom changes nothing by
      // itself; the first different hex that passes does
      const start = appliedAccent();
      this.hex.value = start;
      this.picker.value = start;
      this.render();
      this.evaluate(start, false, true);
      return;
    }
    const preset = findPreset(value);
    if (!preset) return;
    this.customChosen = false;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (preset.hex === appliedAccent() && accentStore().mine) {
      this.render();
      return;
    }
    void this.save(preset.hex);
  }

  /** Save this profile's pick (null follows the default) and paint it. */
  private async save(hex: string | null): Promise<void> {
    if (hex === null) this.customChosen = false;
    // the store changes before the request goes, so the page follows at once
    const pending = saveProfileAccent(hex);
    applyAccent(appliedAccent());
    const result = await pending;
    if (!result.ok) {
      applyAccent(appliedAccent());
      toast(result.error);
    }
  }

  /** Admins: the accent this profile uses becomes the install's default. */
  private makeInstallDefault(): void {
    const form = formEls();
    if (!form) return;
    const hex = appliedAccent();
    if (findPreset(hex)) {
      form.select.value = hex;
    } else {
      form.store.value = hex;
      form.select.value = CUSTOM_ACCENT;
    }
    setInstallAccent(hex);
    // the settings page's autosave listens for this
    form.select.dispatchEvent(new Event('change', { bubbles: true }));
    toast(
      `${accentName(hex)} is the default for profiles that haven’t picked their own.`,
      'success',
    );
  }
}

const pickers = new Set<AccentPicker>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  onAccentStore(() => {
    for (const picker of pickers) {
      if (!picker.root.isConnected) pickers.delete(picker);
      else picker.render();
    }
  });
  window.addEventListener(ACCENT_APPLIED_EVENT, () => {
    for (const picker of pickers) if (picker.root.isConnected) picker.render();
  });
}

/**
 * Draw the picker into `root` (once per root) and fill it from this
 * profile's pick.
 */
export function mountAccentPicker(root: HTMLElement, opts: PickerOptions): void {
  listen();
  for (const picker of pickers) {
    if (picker.root === root) {
      picker.render();
      void loadProfileAccent();
      return;
    }
  }
  const picker = new AccentPicker(root, opts);
  pickers.add(picker);
  picker.render();
  void loadProfileAccent();
}

/** The install's accent from Settings → Appearance's form, when it's on the page. */
function readInstallFromForm(): void {
  const form = formEls();
  if (!form) return;
  const preset = (form.select.value || '').toLowerCase();
  if (preset !== CUSTOM_ACCENT && !findPreset(preset)) form.select.value = DEFAULT_ACCENT;
  setInstallAccent(storedAccent(form.select.value, form.store.value));
}

/**
 * Bring Settings → Appearance in line: after settings.js loads the saved
 * values (the install's accent), and on boot.
 */
export function syncAppearanceSettings(): void {
  const root = document.getElementById('accent-picker');
  if (!root) return;
  readInstallFromForm();
  mountAccentPicker(root, { prefix: 'accent', installDefault: true });
}

/** Draw the cards (shell boot; the markup is parsed by then). */
export function initAppearanceSettings(): void {
  listen();
  const root = document.getElementById('accent-picker');
  if (!root) return;
  readInstallFromForm();
  // mounted now, filled once Settings is opened (no fetch for pages that don't show it)
  if (!root.dataset.built) {
    const picker = new AccentPicker(root, { prefix: 'accent', installDefault: true });
    pickers.add(picker);
    picker.render();
  }
}

/** Tests only. */
export function _resetAppearanceForTests(): void {
  pickers.clear();
  listening = false;
}
