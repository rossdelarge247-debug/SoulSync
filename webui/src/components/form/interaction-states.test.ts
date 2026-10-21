import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The interaction-state rules (docs/design/DESIGN-SYSTEM.md, "Interaction
 * states") as the stylesheets declare them. jsdom can't compute these (CSS
 * nesting, var()), so they are pinned as declarations, the way the other CSS
 * contract tests do it.
 */

const read = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS = read('static/tokens.css');
const FORM = read('src/components/form/form.module.css');
const PRIMITIVES = read('src/components/primitives/primitives.module.css');
const SAFE = read('src/features/safe-action/safe-action.module.css');
const DIALOG = read('src/components/dialog/dialog.module.css');
const MODULES = read('static/modules.css');
const MOBILE = read('static/mobile.css');

/** The declarations of the first `marker {…}` block after `after`. */
function block(css: string, marker: string, after = ''): string {
  const from = after ? css.indexOf(after) : 0;
  expect(from, `parent not found: ${after}`).toBeGreaterThan(-1);
  const at = css.indexOf(marker, from);
  expect(at, `block not found: ${marker}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

function cssModules(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((p) => join(dir, p).replace(/\\/g, '/'))
    .filter((p) => p.endsWith('.css'))
    .sort();
}

describe('design tokens (static/tokens.css)', () => {
  it('alias the accent pair the app already computes from the preset', () => {
    expect(TOKENS).toMatch(/--ss-accent-rgb:\s*var\(--accent-rgb\);/);
    expect(TOKENS).toMatch(/--ss-accent-light-rgb:\s*var\(--accent-light-rgb\);/);
  });

  it('carry the handoff radii, focus ring and motion', () => {
    expect(TOKENS).toMatch(/--ss-radius-tag:\s*6px;/);
    expect(TOKENS).toMatch(/--ss-radius-control:\s*10px;/);
    expect(TOKENS).toMatch(/--ss-radius-card:\s*14px;/);
    expect(TOKENS).toMatch(/--ss-radius-dialog:\s*16px;/);
    expect(TOKENS).toMatch(/--ss-focus-ring:\s*2px solid rgb\(var\(--ss-accent-light-rgb\)\);/);
    expect(TOKENS).toMatch(/--ss-hover-wash:\s*rgba\(255, 255, 255, 0\.06\);/);
    expect(TOKENS).toMatch(/--ss-motion:\s*120ms;/);
  });

  it('turn the transitions off under prefers-reduced-motion', () => {
    const at = TOKENS.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(at).toBeGreaterThan(-1);
    const reduced = TOKENS.slice(at, TOKENS.indexOf('}\n}', at));
    expect(reduced).toMatch(/--ss-motion:\s*0ms;/);
    expect(reduced).toMatch(/--ss-transition:\s*none;/);
  });

  it('define every --ss-* token the stylesheets read', () => {
    const defined = new Set([...TOKENS.matchAll(/(--ss-[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing: string[] = [];
    for (const file of [...cssModules('src'), 'static/modules.css']) {
      for (const [, name] of read(file).matchAll(/var\(\s*(--ss-[\w-]+)/g)) {
        if (!defined.has(name)) missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('form controls (components/form)', () => {
  it('focus from the keyboard is the accent-light outline, 2px out', () => {
    for (const parent of [
      '\n.button {',
      '\n.optionButton {',
      '\n.optionCard {',
      '\n.checkbox {',
      '\n.switch {',
    ]) {
      const focus = block(FORM, '&:focus-visible', parent);
      expect(focus, parent).toMatch(/outline:\s*var\(--ss-focus-ring\);/);
      expect(focus, parent).toMatch(/outline-offset:\s*var\(--ss-focus-offset\);/);
    }
  });

  it('inputs show focus with the accent-light border at 60%, no outline or glow', () => {
    const focus = block(FORM, '.textInput:focus,');
    expect(focus).toMatch(/outline:\s*none;/);
    expect(focus).toMatch(/border-color:\s*var\(--ss-input-focus-border\);/);
    expect(focus).not.toMatch(/box-shadow/);
    expect(block(FORM, '&:focus', '\n.select {')).toMatch(/var\(--ss-input-focus-border\)/);
    expect(block(FORM, ".textInput[aria-invalid='true'],")).toMatch(
      /var\(--ss-input-error-border\)/,
    );
  });

  it('nothing moves on hover or press', () => {
    // the switch knob's stretch is the one allowed bit of motion
    for (const [, selector, body] of FORM.matchAll(/([^{};]*:(?:hover|active)[^{]*)\{([^}]*)\}/g)) {
      if (selector.includes('switchThumb') || /\.switchThumb/.test(body)) continue;
      expect(body, selector.trim()).not.toMatch(/translate|scale/);
    }
    expect(block(FORM, '&:active:not(:disabled)', '\n.button {')).toMatch(
      /opacity:\s*var\(--ss-pressed-opacity\);/,
    );
    expect(block(FORM, "&[data-variant='primary']:hover", '\n.button {')).toMatch(
      /opacity:\s*var\(--ss-pressed-opacity\);/,
    );
  });

  it('selected is the 14% accent wash with the 45% accent border', () => {
    for (const parent of ['\n.optionButton {', '\n.optionCard {']) {
      const selected = block(FORM, "&[data-selected='true'],", parent);
      expect(selected).toMatch(/border-color:\s*var\(--ss-selected-border\);/);
      expect(selected).toMatch(/background:\s*var\(--ss-selected-fill\);/);
    }
  });

  it('disabled is neutral at full opacity, never a faded accent', () => {
    const neutral = block(FORM, '&.disabledNeutral,', '\n.button {');
    expect(neutral).toMatch(/opacity:\s*1;/);
    expect(neutral).toMatch(/color:\s*var\(--ss-disabled-text\);/);
    const primary = block(FORM, "&[data-variant='primary'].disabledNeutral,", '\n.button {');
    expect(primary).toMatch(/background:\s*var\(--ss-disabled-fill\);/);
    expect(primary).toMatch(/border-color:\s*var\(--ss-disabled-border\);/);
    expect(primary).not.toMatch(/accent/);
    expect(TOKENS).toMatch(/--ss-disabled-text:\s*rgba\(255, 255, 255, 0\.62\);/);
  });

  it('Button lg is 44px tall, and phones keep it at 44px', () => {
    expect(block(FORM, "&[data-size='lg']", '\n.button {')).toMatch(/min-height:\s*44px;/);
    const start = MOBILE.indexOf('button:not(.watchlist-card-remove)');
    const chain = MOBILE.slice(start, MOBILE.indexOf('{', start));
    expect(chain).toContain(':not([data-size="lg"])');
  });

  it('the input error message is the danger red at reading size', () => {
    const error = block(FORM, '.formError {');
    expect(error).toMatch(/color:\s*var\(--ss-danger\);/);
    expect(error).toMatch(/font-size:\s*14px;/);
    expect(TOKENS).toMatch(/--ss-danger:\s*#f87171;/);
  });
});

describe('status tags and the safe-action dialog', () => {
  it('status tags never react to hover', () => {
    expect(PRIMITIVES).not.toMatch(/\.statusTag[^{]*:hover/);
    expect(SAFE).not.toMatch(/\.tag[^{]*:hover/);
  });

  it('the v2 dialog: 680px, 16px radius, #17171c; the close button is 44px', () => {
    const popup = block(SAFE, '.popup.popup {');
    expect(popup).toMatch(/width:\s*min\(680px, 100%\);/);
    expect(popup).toMatch(/border-radius:\s*var\(--ss-radius-dialog\);/);
    expect(popup).toMatch(/background:\s*var\(--ss-ground-dialog\);/);
    expect(TOKENS).toMatch(/--ss-ground-dialog:\s*#17171c;/);
    const close = block(DIALOG, '.close {');
    expect(close).toMatch(/width:\s*44px;/);
    expect(close).toMatch(/height:\s*44px;/);
  });

  it('the disabled confirm reason sits on its own line above the buttons', () => {
    const reason = block(SAFE, ".popup.popup [data-slot='disabled-reason'] {");
    expect(reason).toMatch(/order:\s*-1;/);
    expect(reason).toMatch(/flex-basis:\s*100%;/);
  });

  it('a danger confirm is disabled the neutral way too', () => {
    const disabled = block(SAFE, '.dangerButton.dangerButton:disabled,');
    expect(disabled).toMatch(/background:\s*var\(--ss-disabled-fill\);/);
    expect(disabled).toMatch(/opacity:\s*1;/);
  });
});

describe('Settings → Modules (static/modules.css)', () => {
  it('the switch is a 44px control with a 10px radius, not a pill', () => {
    const control = block(MODULES, '#settings-page .module-switch {');
    expect(control).toMatch(/min-height:\s*44px;/);
    expect(control).toMatch(/min-width:\s*104px;/);
    expect(control).toMatch(/border-radius:\s*var\(--ss-radius-control\);/);
    const track = block(MODULES, '#settings-page .module-switch-track {');
    expect(track).toMatch(/width:\s*40px;/);
    expect(track).toMatch(/height:\s*24px;/);
  });

  it('keyboard focus is the accent-light ring', () => {
    expect(
      block(MODULES, '#settings-page .modules-settings .module-switch:focus-visible {'),
    ).toMatch(/outline:\s*var\(--ss-focus-ring\)/);
  });

  it('the confirm uses the shared Button look: dark text on accent-light', () => {
    const primary = block(MODULES, '#settings-page .module-btn--primary {');
    expect(primary).toMatch(/background:\s*rgb\(var\(--ss-accent-light-rgb\)\);/);
    expect(primary).toMatch(/color:\s*var\(--ss-text-on-accent\);/);
    expect(block(MODULES, '#settings-page .module-btn {')).toMatch(/min-height:\s*44px;/);
  });

  it('the result line uses a status dot, not a glyph', () => {
    expect(MODULES).not.toContain("content: '✓'");
    expect(
      block(MODULES, '#settings-page .module-row-status[data-tone="success"]::before,'),
    ).toMatch(/border-radius:\s*var\(--radius-circle\);/);
  });

  it('the confirm and restart boxes are 14px cards', () => {
    expect(block(MODULES, '#settings-page .module-confirm {')).toMatch(
      /border-radius:\s*var\(--ss-radius-card\);/,
    );
    expect(block(MODULES, '#settings-page .module-restart {')).toMatch(
      /border-radius:\s*var\(--ss-radius-card\);/,
    );
  });
});
