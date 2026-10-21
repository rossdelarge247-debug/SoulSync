import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Discover batch 1: the shell and the music hero.
 *
 * Two layout failures that only ever showed up in a screenshot:
 *
 * * the hero's carousel dots and its Watch All / View Recommended pills were
 *   two absolutely positioned boxes sharing `bottom: 24px`, one centred and
 *   one right-aligned, so on narrow desktop and on every phone the dots
 *   painted straight through the pill;
 * * resizing a desktop window down through the breakpoint left the drawer
 *   sliding across the content instead of starting closed.
 *
 * jsdom does not lay out, so this pins the DECLARATIONS that have to agree.
 * The geometry itself is checked in tests/pages against a real browser.
 */

const CSS = readFileSync(resolve(process.cwd(), 'static/style.css'), 'utf8');
const INIT = readFileSync(resolve(process.cwd(), 'static/init.js'), 'utf8');
const HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const HERO = readFileSync(
  resolve(process.cwd(), 'src/routes/discover/-ui/discover-hero.tsx'),
  'utf8',
);

function rule(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector} {`);
  expect(at, `${selector} has no own rule`).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('}', at) + 1);
}

describe('the music hero foot', () => {
  it('puts the dots and the bulk actions in one row instead of one corner', () => {
    // Both used to be `position: absolute; bottom: 24px`. Two absolute boxes
    // at the same coordinate is the collision, whatever their left/right is.
    const indicators = rule(CSS, '.discover-hero-indicators');
    const actions = rule(CSS, '.discover-hero-bottom-actions');
    expect(indicators).not.toContain('position: absolute');
    expect(actions).not.toContain('position: absolute');

    const row = rule(CSS, '.discover-hero-controls');
    expect(row).toContain('display: flex');
    expect(row).toContain('justify-content: space-between');
    expect(row).toContain('flex-wrap: wrap');
  });

  it('the hero is a column, so the strip is a real row under the content', () => {
    const hero = rule(CSS, '.discover-hero');
    expect(hero).toContain('flex-direction: column');
    // The content can no longer be height:100% or it would push the strip out.
    expect(rule(CSS, '.discover-hero-content')).toContain('flex: 1 1 auto');
  });

  it('markup wraps both in the strip', () => {
    const strip = HERO.indexOf('discover-hero-controls');
    expect(strip).toBeGreaterThan(-1);
    expect(HERO.indexOf('discover-hero-indicators')).toBeGreaterThan(strip);
    expect(HERO.indexOf('discover-hero-bottom-actions')).toBeGreaterThan(strip);
  });

  it('an indicator is a small dot inside a finger-sized target', () => {
    // A bare 8px button is smaller than any thumb, and mobile.css excludes
    // .hero-indicator from its blanket min-height precisely because that rule
    // used to stretch it. The target carries the size now; the dot is a span.
    const indicator = rule(CSS, '.hero-indicator');
    expect(indicator).toContain('width: 36px');
    expect(indicator).toContain('height: 36px');
    const dot = rule(CSS, '.hero-indicator-dot');
    expect(dot).toContain('width: 8px');
    expect(HERO).toContain('hero-indicator-dot');
    // Keyboard users have to be able to see where they are.
    expect(CSS).toContain('.hero-indicator:focus-visible');
  });
});

// The off-canvas drawer became the navigation shell's phone tab bar and
// sheets (src/shell/nav-shell.ts; behaviour tested in nav-shell.test.ts).
// The same promises hold for the sheet.
describe('the phone nav sheet', () => {
  const SHELL = readFileSync(resolve(process.cwd(), 'src/shell/nav-shell.ts'), 'utf8');

  it('closes when the viewport crosses the breakpoint', () => {
    expect(SHELL).toContain("PHONE_QUERY = '(max-width: 768px)'");
    const handler = SHELL.slice(
      SHELL.indexOf('const onBreakpoint'),
      SHELL.indexOf('};', SHELL.indexOf('const onBreakpoint')),
    );
    expect(handler).toContain('closeSheet(false)');
    // and the drawer is gone with its hamburger
    expect(HTML).not.toContain('id="hamburger-btn"');
    expect(INIT).not.toContain('function openMobileNav');
  });

  it('each opener says whether its sheet is open, and points at it', () => {
    expect(HTML).toContain('aria-controls="app-sidebar"');
    expect(HTML).toContain('id="app-sidebar"');
    expect(SHELL).toContain(
      "tab.setAttribute('aria-expanded', tab.dataset.tab === group ? 'true' : 'false')",
    );
  });

  it('Escape closes it and hands focus back to the opener', () => {
    const esc = SHELL.slice(SHELL.indexOf("if (e.key === 'Escape') {"));
    expect(esc.slice(0, 260)).toContain('closeSheet(true)');
    expect(SHELL).toContain('if (restoreFocus) opener?.focus();');
  });

  it('opening moves focus into the sheet', () => {
    const open = SHELL.slice(
      SHELL.indexOf('function openSheet'),
      SHELL.indexOf('function closeSheet'),
    );
    expect(open).toContain('firstFocusable(sidebar!, view)?.focus()');
  });
});

describe('the music cards', () => {
  const MIX = readFileSync(resolve(process.cwd(), 'src/routes/discover/-ui/mix-shelf.tsx'), 'utf8');
  const ALBUM = readFileSync(
    resolve(process.cwd(), 'src/routes/discover/-ui/album-shelves.tsx'),
    'utf8',
  );

  it('no clickable div is the only way in', () => {
    expect(MIX).not.toMatch(/<div className="discover-mix-card"[^>]*onClick/);
    expect(ALBUM).not.toMatch(/<div className="ya-card discover-album-card"[^>]*onClick/);
  });

  it('the mix play button is visible without a pointer hovering it', () => {
    // It was opacity: 0 until :hover, which on a touch screen means the only
    // way to play a mix was to open the modal first.
    const play = rule(CSS, '.mix-card-play');
    expect(play).not.toContain('opacity: 0;');
    expect(play).toContain('opacity: 0.82');
  });
});
