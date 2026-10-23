import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the web app manifest (HANDOFF 59)', () => {
  it('grounds an installed app in the sidebar’s #101010', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'static/manifest.json'), 'utf8'),
    ) as { theme_color: string; background_color: string };
    expect(manifest.theme_color).toBe('#101010');
    expect(manifest.background_color).toBe('#101010');
  });
});
