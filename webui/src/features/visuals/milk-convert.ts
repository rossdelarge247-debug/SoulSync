/**
 * Your own presets arrive as `.milk` text; this turns one into Butterchurn's
 * shape in the browser (milkdrop-preset-converter, MIT, with its MIT
 * hlslparser-js for the shaders). Loaded with `import()` only when one of
 * your own is picked.
 */

import { convertPreset } from 'milkdrop-preset-converter';

export async function convertMilk(text: string): Promise<Record<string, unknown>> {
  const preset = await convertPreset(text);
  if (!preset || typeof preset !== 'object') throw new Error('not a preset');
  return preset;
}
