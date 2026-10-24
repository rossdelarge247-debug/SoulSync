// Copies MilkDrop's presets out of the installed butterchurn-presets package
// into the build (static/dist/visuals/milkdrop/): an index.json of
// {key, name, size} and one <key>.json per preset, minified. The server lists
// them (api/visuals.py) and hands one out by key when it's picked; the browser
// keeps it. Nothing is copied into the repository: the presets come from npm
// at build time, like every other dependency.
//
// Runs as the last step of `npm run build` (the react build empties
// static/dist first). A key is "md-" + the first 16 hex of sha1(name), the
// same as bundled_key() in core/visuals/presets.py.
//
// Each entry also says whether it's in one of the curated packs the package
// ships (its main pack, Extra, Extra 2 and MD1: 395 presets, HANDOFF 101).
// MilkDrop lists those by default; "Every preset" adds the rest.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The packs that make up the curated list, by their meta getter. */
export const CURATED_PACKS = [
  'getMainPresetMeta',
  'getExtraPresetKeys',
  'getExtra2PresetKeys',
  'getMD1PresetKeys',
];

/** A pack's name for a preset, as the converted file is named ("….milk" dropped). */
export function curatedName(name) {
  return String(name).replace(/\.milk$/i, '');
}

/**
 * The curated presets' names, from the package's pack meta. A meta that
 * can't be read gives null: then every preset counts as curated, so the
 * list is never empty.
 */
export function readCuratedNames(metaPath) {
  try {
    const meta = createRequire(import.meta.url)(metaPath);
    const names = new Set();
    for (const getter of CURATED_PACKS) {
      const pack = typeof meta[getter] === 'function' ? meta[getter]() : null;
      const list = pack && Array.isArray(pack.presets) ? pack.presets : null;
      if (!list) return null;
      for (const n of list) names.add(curatedName(n));
    }
    return names;
  } catch {
    return null;
  }
}

export function presetKey(name) {
  return `md-${createHash('sha1').update(String(name), 'utf8').digest('hex').slice(0, 16)}`;
}

/** Copy every converted preset; returns the index it wrote. `curated` is the
 *  set of curated names (null: all of them). */
export function buildPresetIndex({ srcDir, outDir, curated = null }) {
  const files = readdirSync(srcDir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
  mkdirSync(outDir, { recursive: true });
  const presets = [];
  const seen = new Set();
  for (const file of files) {
    const name = file.replace(/\.json$/i, '');
    const key = presetKey(name);
    if (seen.has(key)) continue;
    let body;
    try {
      body = JSON.stringify(JSON.parse(readFileSync(path.join(srcDir, file), 'utf8')));
    } catch {
      continue; // a preset that isn't JSON isn't offered
    }
    seen.add(key);
    writeFileSync(path.join(outDir, `${key}.json`), body);
    presets.push({
      key,
      name,
      size: Buffer.byteLength(body),
      curated: curated ? curated.has(curatedName(name)) : true,
    });
  }
  const index = {
    source: 'butterchurn-presets',
    count: presets.length,
    curated: presets.filter((p) => p.curated).length,
    presets,
  };
  writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index));
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(HERE, '..');
  const srcDir = path.join(root, 'node_modules', 'butterchurn-presets', 'presets', 'converted');
  const outDir = path.join(root, 'static', 'dist', 'visuals', 'milkdrop');
  const curated = readCuratedNames(
    path.join(
      root,
      'node_modules',
      'butterchurn-presets',
      'lib',
      'butterchurnPresetPackMeta.min.js',
    ),
  );
  const index = buildPresetIndex({ srcDir, outDir, curated });
  console.log(
    `milkdrop presets: ${index.count} copied to ${path.relative(root, outDir)}, ${index.curated} curated`,
  );
}
