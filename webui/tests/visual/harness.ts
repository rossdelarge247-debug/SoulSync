import type { Page } from '@playwright/test';

import { getResponse, type RequestHandler } from 'msw';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const WEBUI = process.cwd();
const STATIC = resolve(WEBUI, 'static');
/** A made-up origin: every request to it is answered by `installShell`. */
export const ORIGIN = 'http://soulsync.visual';

const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.html': 'text/html',
};

type ManifestChunk = { file: string; css?: string[]; imports?: string[] };

/** Mirrors build_webui_vite_assets (core/webui/assets.py). */
function viteAssets(placement: 'head' | 'body') {
  const manifestPath = resolve(STATIC, 'dist/.vite/manifest.json');
  const manifest: Record<string, ManifestChunk> = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entryKey = 'src/app/main.tsx';
  const entry = manifest[entryKey];
  if (placement === 'head') {
    // the entry's static imports (route chunks load on demand): their CSS,
    // dependencies first, and a modulepreload for each chunk
    const chunks: string[] = [];
    const css: string[] = [];
    const seen = new Set<string>();
    const visit = (key: string) => {
      const chunk = manifest[key];
      if (seen.has(key) || !chunk) return;
      seen.add(key);
      if (key !== entryKey && !chunks.includes(chunk.file)) chunks.push(chunk.file);
      (chunk.imports ?? []).forEach(visit);
      (chunk.css ?? []).forEach((file) => css.includes(file) || css.push(file));
    };
    visit(entryKey);
    return [
      ...css.map((file) => `<link rel="stylesheet" href="/static/dist/${file}">`),
      ...chunks.map((file) => `<link rel="modulepreload" href="/static/dist/${file}">`),
    ].join('\n');
  }
  return `<script type="module" src="/static/dist/${entry.file}"></script>`;
}

/** Render webui/index.html the way Flask would, with default appearance settings. */
export function renderIndex() {
  const ctx: Record<string, string> = {
    'request.script_root': '',
    initial_accent_color: '#8b5cf6',
    initial_accent_rgb: '139, 92, 246',
    initial_accent_light_rgb: '194, 169, 250',
    initial_accent_neon_rgb: '237, 230, 255',
    'initial_particles_enabled | tojson': 'false',
    'initial_worker_orbs_enabled | tojson': 'false',
    'initial_reduce_effects | tojson': 'false',
    'initial_max_performance | tojson': 'false',
    'profile_gate_rules | tojson': 'null',
    // no module switched off: every sidebar entry shows
    'initial_modules | default([]) | tojson': '[]',
    soulsync_base_version: '0.0.0',
  };
  const flags: Record<string, boolean> = {
    initial_reduce_effects: false,
    initial_max_performance: false,
    'not initial_particles_enabled or initial_reduce_effects': true,
  };
  let html = readFileSync(resolve(WEBUI, 'index.html'), 'utf8');
  html = html.replace(/\{%\s*include '([^']+)'\s*%\}/g, (_, file) =>
    readFileSync(resolve(WEBUI, file), 'utf8'),
  );
  html = html.replace(/\{%\s*if (.+?)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g, (_, cond, body) => {
    if (!(cond in flags)) throw new Error(`visual harness: unknown template condition: ${cond}`);
    return flags[cond] ? body : '';
  });
  html = html.replace(/\{\{\s*url_for\('static', filename='([^']+)'[^}]*\}\}/g, '/static/$1');
  html = html.replace(/\{\{\s*vite_assets\('(head|body)'\)\|safe\s*\}\}/g, (_, p) => viteAssets(p));
  html = html.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
    if (!(expr in ctx)) throw new Error(`visual harness: unknown template expression: ${expr}`);
    return ctx[expr];
  });
  return html;
}

/**
 * Serve the whole app from disk, with no server and no network.
 *
 * - documents get the rendered index.html, so any path boots the shell
 * - /static/* comes from webui/static (the Vite build lands in static/dist)
 * - every other same-origin request is offered to `handlers`, the same MSW
 *   `http.*` handlers the vitest route tests use; unmatched ones get `{}`,
 *   which every page already treats as "nothing here yet"
 * - anything off-origin (cover art, fonts, CDNs) is aborted
 *
 * Returns the /static/ paths that weren't on disk. A missing bundle (say
 * dist/shell.js after a bare `vite build`) still boots a page that looks
 * nearly right, so the spec fails on any of these rather than on a pixel diff.
 */
export async function installShell(page: Page, handlers: RequestHandler[] = []): Promise<string[]> {
  const missing: string[] = [];
  const index = renderIndex();
  await page.route(/.*/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (request.resourceType() === 'document') {
      return route.fulfill({ body: index, contentType: 'text/html' });
    }
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith('/static/')) {
      const file = resolve(STATIC, path.slice('/static/'.length));
      try {
        const body = readFileSync(file);
        const contentType = MIME[extname(file)] ?? 'application/octet-stream';
        return route.fulfill({ body, contentType });
      } catch {
        missing.push(path);
        return route.fulfill({ status: 404, body: '' });
      }
    }
    if (path.startsWith('/socket.io/')) return route.abort();
    const mocked = await getResponse(
      handlers,
      new Request(url, {
        method: request.method(),
        headers: request.headers(),
        body: ['GET', 'HEAD'].includes(request.method())
          ? undefined
          : (request.postData() ?? undefined),
      }),
    );
    if (mocked) {
      return route.fulfill({
        status: mocked.status,
        headers: Object.fromEntries(mocked.headers),
        body: Buffer.from(await mocked.arrayBuffer()),
      });
    }
    if (request.resourceType() === 'image') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ json: {} });
  });
  return missing;
}
