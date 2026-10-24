import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildPresetIndex,
  curatedName,
  presetKey,
  readCuratedNames,
} from '../../scripts/milkdrop-presets.mjs';

/**
 * The build copies MilkDrop's presets out of the installed butterchurn-presets
 * (never into the repository) and the server lists them by the same key
 * (core/visuals/presets.py bundled_key).
 */
describe('the MilkDrop preset copy (scripts/milkdrop-presets.mjs)', () => {
  it('keys a preset by its name the way the server does', () => {
    expect(presetKey('Geiss - Eggs')).toBe('md-a2d4673ae1656827');
    expect(presetKey('Geiss - Eggs')).toMatch(/^md-[0-9a-f]{16}$/);
  });

  it('writes an index and one minified file per preset, skipping what isn’t JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'md-presets-'));
    const src = join(root, 'converted');
    const out = join(root, 'out');
    mkdirSync(src);
    writeFileSync(
      join(src, 'Geiss - Eggs.json'),
      JSON.stringify({ baseVals: { zoom: 1 } }, null, 2),
    );
    writeFileSync(join(src, 'Flexi - mindblob.json'), '{"shapes": []}');
    writeFileSync(join(src, 'broken.json'), '{not json');
    writeFileSync(join(src, 'readme.txt'), 'hello');
    const index = buildPresetIndex({ srcDir: src, outDir: out });
    expect(index.count).toBe(2);
    expect(index.presets.map((p) => p.name)).toEqual(['Flexi - mindblob', 'Geiss - Eggs']);
    const eggs = index.presets.find((p) => p.name === 'Geiss - Eggs')!;
    expect(readFileSync(join(out, `${eggs.key}.json`), 'utf8')).toBe('{"baseVals":{"zoom":1}}');
    expect(eggs.size).toBe(23);
    expect(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')).count).toBe(2);
    expect(readdirSync(out).sort()).toHaveLength(3);
  });

  it('marks the presets in the curated packs (101); without the packs, every one counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'md-curated-'));
    const src = join(root, 'converted');
    mkdirSync(src);
    writeFileSync(join(src, 'Geiss - Eggs.json'), '{}');
    writeFileSync(join(src, 'Anon - crude.json'), '{}');
    const index = buildPresetIndex({
      srcDir: src,
      outDir: join(root, 'out'),
      curated: new Set([curatedName('Geiss - Eggs.milk')]),
    });
    expect(index.curated).toBe(1);
    expect(Object.fromEntries(index.presets.map((p) => [p.name, p.curated]))).toEqual({
      'Anon - crude': false,
      'Geiss - Eggs': true,
    });
    const all = buildPresetIndex({ srcDir: src, outDir: join(root, 'out2') });
    expect(all.curated).toBe(2);
    expect(readCuratedNames(join(root, 'no-such-meta.js'))).toBeNull();
  });

  it('reads the curated packs from the installed package: 395 presets', () => {
    const names = readCuratedNames(
      resolve(
        process.cwd(),
        'node_modules/butterchurn-presets/lib/butterchurnPresetPackMeta.min.js',
      ),
    );
    expect(names?.size).toBe(395);
  });

  it('runs as the last step of the build, from npm’s copy', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toMatch(
      /vite build -c vite\.shell\.config\.ts && node scripts\/milkdrop-presets\.mjs$/,
    );
    expect(pkg.dependencies.butterchurn).toBeDefined();
    expect(pkg.dependencies['butterchurn-presets']).toBeDefined();
    expect(pkg.dependencies['milkdrop-preset-converter']).toBeDefined();
  });
});
