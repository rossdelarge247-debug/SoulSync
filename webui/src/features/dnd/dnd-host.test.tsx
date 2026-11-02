/**
 * Brief B's host and the mixing features (Settings → Library → DJ's "Show
 * the mixing features"): while something is lifted, the sidebar's Your sets
 * unfold under the Sets row as drop targets only while the features show;
 * hidden, no set is a target and the sets aren't read.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMixTabForTests } from '@/features/mix/mix-visibility';
import { HttpResponse, http, server } from '@/test/msw';
import { createTestQueryClient } from '@/test/query-client';

import type { SourceKind } from './dnd-model';

import { getTarget, pointerDown, resetDndForTests } from './dnd-engine';
import { DndHost } from './dnd-host';

vi.mock('@/platform/shell/route-controllers', () => ({
  useProfile: () => ({ profileId: 1, isAdmin: true }),
}));

function box(el: HTMLElement, width: number) {
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: 40, left: 0, right: width, width, height: 40, x: 0, y: 0 }) as DOMRect;
}

const paths: string[] = [];
const seen = ({ request }: { request: Request }) => paths.push(new URL(request.url).pathname);

beforeEach(() => {
  document.body.innerHTML = `
    <nav><a data-nav-row="sets" href="/library?view=sets">Sets</a></nav>
    <ul><li id="row"><span id="grip"></span>Static Bloom</li></ul>`;
  box(document.querySelector<HTMLElement>('a[data-nav-row="sets"]')!, 240);
  box(document.getElementById('row')!, 400);
  document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
  paths.length = 0;
  server.events.on('request:start', seen);
  server.use(
    http.get('*/api/sets', () =>
      HttpResponse.json({
        success: true,
        sets: [{ id: 7, name: 'Sunday Set', kind: 'hand', tracks: 3, updated_at: 1 }],
      }),
    ),
    http.get('*/api/sets/working', () => HttpResponse.json({ success: true, working: null })),
  );
});

afterEach(() => {
  server.events.removeListener('request:start', seen);
  cleanup();
  resetDndForTests();
  resetMixTabForTests();
});

function mount() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DndHost />
    </QueryClientProvider>,
  );
}

function lift(kind: SourceKind = 'tracks') {
  act(() => {
    pointerDown(
      { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 },
      document.getElementById('grip')!,
      () => ({
        items: [
          {
            id: '1',
            title: 'Static Bloom',
            artist: 'Ferrous',
            key: '9A',
            bpm: 123,
            queue: { id: '1' },
          },
        ],
        source: { kind, listId: kind, indexes: [0] },
        rows: [document.getElementById('row')!],
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 40 }),
    );
  });
}

describe('the sidebar’s Your sets during a drag (32a)', () => {
  it('shown: the sets unfold under the Sets row, each a drop target', async () => {
    resetMixTabForTests(true);
    mount();
    lift();
    await waitFor(() =>
      expect(document.querySelector('[data-dnd-side-sets]')?.textContent).toContain('Sunday Set'),
    );
    expect(getTarget('side-set:7')).toBeDefined();
  });

  it('hidden (the default): no Your sets, no set target, and neither the sets nor the working set is read', async () => {
    resetMixTabForTests();
    mount();
    lift();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.querySelector('[data-dnd-side-sets]')).toBeNull();
    expect(getTarget('side-set:7')).toBeUndefined();
    expect(paths.filter((p) => p.startsWith('/api/sets'))).toEqual([]);
  });
});

describe('the ghost (32a, 38g)', () => {
  it('from Tracks: title · key BPM', () => {
    mount();
    lift('tracks');
    const ghost = document.querySelector('[data-dnd-ghost]')!;
    expect(ghost.textContent).toContain('Static Bloom');
    expect(ghost.textContent).toContain('9A 123');
  });

  it('from anywhere else (Search, an album, Up next): title · artist, no key or BPM', () => {
    for (const kind of ['search', 'album', 'upnext'] as const) {
      mount();
      lift(kind);
      const ghost = document.querySelector('[data-dnd-ghost]')!;
      expect(ghost.textContent).toBe('Static BloomFerrous');
      cleanup();
      resetDndForTests();
    }
  });
});
