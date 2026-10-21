import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Files the entry chunk always loads; anything they import is eager. */
const ENTRY_FILES = ['src/app/main.tsx', 'src/routes/__root.tsx'];

/** A statement at column 0 that calls something: it runs when the module loads. */
const TOP_LEVEL_CALL = /^(?:void |await )?[A-Za-z_$][\w$.]*\(/m;

function routeModules(): string[] {
  return readdirSync('src/routes', { recursive: true, encoding: 'utf8' })
    .map((p) => p.replace(/\\/g, '/'))
    .filter(
      (p) =>
        /\.tsx?$/.test(p) &&
        !/\.test\.tsx?$/.test(p) &&
        !p.includes('__fixtures__') &&
        p !== '__root.tsx',
    )
    .sort();
}

/**
 * Route components are code-split (autoCodeSplitting in vite.config.ts), so a
 * route module's top-level code no longer runs at page load: it runs when the
 * route's chunk is first fetched. A module that publishes window globals at
 * load for the vanilla scripts (the discover download bar's store does) would
 * leave them undefined on every other page. Such modules must be imported by
 * the entry.
 */
describe('module-load side effects under src/routes', () => {
  it('are in modules the entry chunk imports', () => {
    const entry = ENTRY_FILES.map((file) => readFileSync(file, 'utf8')).join('\n');
    const notInEntry = routeModules()
      .filter((p) => TOP_LEVEL_CALL.test(readFileSync(join('src/routes', p), 'utf8')))
      .map((p) => p.replace(/\.tsx?$/, ''))
      .filter((p) => !entry.includes(`${p}'`));

    expect(notInEntry).toEqual([]);
  });
});
