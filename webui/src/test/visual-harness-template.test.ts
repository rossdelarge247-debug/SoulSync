import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The visual baselines render index.html the way Flask would
 * (tests/visual/harness.ts), and stop at a template expression they don't
 * know: every route failed at once when the Mix tab's flag was added
 * (Brief F step 7). This keeps the two in step without a browser.
 */
describe('the visual harness knows every template expression in index.html', () => {
  it('each {{ … }} (but url_for and vite_assets) has a value in renderIndex', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const harness = readFileSync(resolve(process.cwd(), 'tests/visual/harness.ts'), 'utf8');
    const exprs = new Set(
      [...html.matchAll(/\{\{\s*(.+?)\s*\}\}/g)]
        .map((m) => m[1]!)
        .filter((e) => !e.startsWith('url_for(') && !e.startsWith('vite_assets(')),
    );
    expect(exprs.size).toBeGreaterThan(0);
    const unknown = [...exprs].filter(
      (e) =>
        !harness.includes(`'${e}':`) &&
        !new RegExp(`^\\s*${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm').test(harness),
    );
    expect(unknown).toEqual([]);
  });
});
