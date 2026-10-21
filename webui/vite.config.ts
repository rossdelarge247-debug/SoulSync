import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ command, mode }) => ({
  plugins: [
    tanstackRouter({
      target: 'react',
      // each route's component becomes its own chunk, loaded when the route
      // is first matched (or hovered: defaultPreload is 'intent'), so a page
      // load no longer downloads every page. loaders stay in the entry chunk.
      // off under vitest (mode 'test'): route tests that render a page off
      // the route tree time out waiting for the lazy chunk, and splitting is
      // a bundling concern the build covers.
      autoCodeSplitting: mode !== 'test',
    }),
    react(),
  ],
  base: command === 'serve' ? '/static/dist/' : './',
  server: {
    // the page is served by flask on :8008 and pulls react from here on :5173,
    // so every module load is cross-origin. vite only allows localhost origins
    // by default, which blanks every react page on a phone under `dev.py --lan`.
    // allow private lan addresses too, nothing public.
    cors: {
      origin:
        /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)(?::\d+)?$/,
    },
  },
  root: import.meta.dirname,
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: `${path.resolve(import.meta.dirname, 'src')}/`,
      },
    ],
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'static/dist'),
    emptyOutDir: true,
    manifest: true,
    rolldownOptions: {
      input: [path.resolve(import.meta.dirname, 'src/app/main.tsx')],
    },
  },
}));
