import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shell bundle (vite.shell.config.ts) is an IIFE built in library mode,
 * which doesn't replace `process.env.NODE_ENV`. React's CommonJS entry reads
 * it, so a module anywhere under src/shell/index.ts that imports React stops
 * the whole shell at load ("process is not defined"): no sidebar state, no
 * page names, no player. This walks the shell's own imports (relative and
 * "@/" ones; packages are leaves) and fails on any React import.
 */
const SRC = resolve(__dirname, '..');
const REACT = /^(react|react-dom)(\/|$)/;
const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

function resolveModule(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? resolve(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  }
  return null;
}

function walk(entry: string): { file: string; spec: string }[] {
  const seen = new Set<string>();
  const offenders: { file: string; spec: string }[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      if (/^import\s+type\s/.test(match[0].trim()) || /^export\s+type\s/.test(match[0].trim()))
        continue;
      if (REACT.test(spec)) offenders.push({ file: file.slice(SRC.length + 1), spec });
      else if (spec.startsWith('.') || spec.startsWith('@/')) {
        const next = resolveModule(file, spec);
        if (next) queue.push(next);
      }
    }
  }
  return offenders;
}

describe('the shell bundle', () => {
  it('imports no React, directly or through what it imports', () => {
    expect(walk(resolve(SRC, 'shell/index.ts'))).toEqual([]);
  });
});
