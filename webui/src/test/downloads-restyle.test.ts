/**
 * HANDOFF 30: upstream's Downloads page restyled to the design system through
 * CSS only. jsdom can't measure layout, so these pin the overrides in
 * static/downloads-premier.css: they come last (a later upstream rule would
 * win otherwise) and carry the tokens the answer names.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'static/downloads-premier.css'), 'utf8');
const marker = 'Design system restyle (HANDOFF 30';
const block = css.slice(css.indexOf(marker));

/** The declarations of the first rule in the block whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(block);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

describe('the Downloads restyle (HANDOFF 30)', () => {
  it('sits after every upstream rule', () => {
    expect(css.indexOf(marker)).toBeGreaterThan(0);
    // nothing of upstream's after the block: it's the file's last section
    expect(css.lastIndexOf('/* ══')).toBe(css.lastIndexOf(`/* ══ ${marker}`));
  });

  it('makes the count chips OptionButtons: 44px, 10px radius, the selected wash', () => {
    const chip = rule('.dlh-chip');
    expect(chip).toContain('min-height: 44px');
    expect(chip).toContain('border-radius: var(--ss-radius-control)');
    expect(chip).toContain('font-size: 15px');
    expect(block).toMatch(
      /\.dlh-chip-on,\s*\.dlh-chip-on:hover \{[^}]*--ss-selected-fill[^}]*--ss-selected-border/,
    );
  });

  it('makes buttons 44px with the primary in accent-light and dark text', () => {
    expect(rule('.dlc-btn')).toContain('height: 44px');
    expect(rule('.dlc-icon-btn')).toContain('width: 44px');
    const primary = rule('.dlc-btn-primary');
    expect(primary).toContain('rgb(var(--ss-accent-light-rgb))');
    expect(primary).toContain('var(--ss-text-on-accent)');
  });

  it("uses Wanted's row grid and 15/14 type", () => {
    expect(rule('.dlc-row')).toContain('min-height: 72px');
    expect(rule('.dlc-row')).toContain('padding: 12px 24px');
    expect(block).toContain('grid-template-columns: 48px minmax(0, 1fr) auto minmax(64px, auto)');
    expect(rule('.dlc-title')).toContain('font-size: 15px');
    expect(rule('.dlc-sub')).toContain('font-size: 14px');
    expect(rule('.dlc-meta')).toContain('font-size: 14px');
  });

  it('turns tags and states into StatusTags (12% colour, 6px radius, 14/600)', () => {
    const tag = rule('.dlc-tag');
    expect(tag).toContain('border-radius: var(--ss-radius-tag)');
    expect(tag).toContain('font-size: 14px');
    expect(rule('.dlc-state')).toContain('color-mix(in srgb, currentColor 12%, transparent)');
    expect(rule('.dlc-state::before')).toContain('width: 8px');
  });

  it('drops the gradient wash from the live strip and the blurred art', () => {
    expect(rule('.dlh-strip')).toContain('background: var(--ss-surface-card)');
    expect(rule('.dlc-wash')).toContain('display: none');
  });

  it('never fades a disabled button', () => {
    expect(block).toMatch(
      /\.dlc-btn:disabled,\s*\.dlc-btn\[aria-disabled='true'\] \{\s*opacity: 1;/,
    );
  });
});
