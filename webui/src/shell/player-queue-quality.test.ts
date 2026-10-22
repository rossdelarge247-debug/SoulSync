/**
 * HANDOFF 44: a queued track below the quality target shows its format in the
 * warning colour on its meta line, judged lazily as rows come into view.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BELOW_CLASS,
  bootQueueQuality,
  libraryTrackId,
  markMeta,
  verdictFrom,
  type QueueTrackLike,
} from './player-queue-quality';

function respond(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: async () => body } as Response;
}

/** Rows as media-player.js draws them: .np-queue-item[data-qindex] with the meta line. */
function drawRows(list: HTMLElement, queue: QueueTrackLike[], metas: string[], played = 0) {
  list.textContent = '';
  queue.forEach((_, i) => {
    const row = document.createElement('div');
    row.className = `np-queue-item ${i < played ? 'played' : 'upnext'}`;
    row.dataset.qindex = String(i);
    const meta = document.createElement('span');
    meta.className = 'np-queue-item-artist';
    meta.textContent = metas[i];
    row.appendChild(meta);
    list.appendChild(row);
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe('the pieces', () => {
  it('judges library tracks only', () => {
    expect(libraryTrackId({ id: 7, is_library: true })).toBe('7');
    expect(libraryTrackId({ id: 't4', kind: 'library' })).toBe('t4');
    expect(libraryTrackId({ id: 7 })).toBeNull();
    expect(libraryTrackId({ id: 'ep', kind: 'podcast' })).toBeNull();
    expect(libraryTrackId({ kind: 'library' })).toBeNull();
  });

  it('calls a track below only when the server says so', () => {
    expect(verdictFrom({ quality: { at_target: false } })).toBe('below');
    expect(verdictFrom({ quality: { at_target: true } })).toBe('ok');
    expect(verdictFrom({ quality: null })).toBe('unknown');
    expect(verdictFrom({})).toBe('unknown');
  });

  it('wraps the format in the warning span with words for a screen reader', () => {
    const meta = document.createElement('span');
    meta.textContent = 'Saltmarsh · MP3 320';
    expect(markMeta(meta, true)).toBe(true);
    expect(meta.querySelector(`.${BELOW_CLASS}`)?.textContent).toBe('MP3 320');
    expect(meta.querySelector('.ss-sr')?.textContent).toBe(' · below your quality target');
    expect(meta.title).toBe('MP3 320 is below your quality target');
    // once only
    expect(markMeta(meta, true)).toBe(true);
    expect(meta.querySelectorAll(`.${BELOW_CLASS}`)).toHaveLength(1);
    markMeta(meta, false);
    expect(meta.textContent).toBe('Saltmarsh · MP3 320');
    expect(meta.querySelector(`.${BELOW_CLASS}`)).toBeNull();
  });

  it('leaves a line without a format alone', () => {
    const meta = document.createElement('span');
    meta.textContent = 'Saltmarsh';
    expect(markMeta(meta, true)).toBe(false);
    expect(meta.textContent).toBe('Saltmarsh');
  });
});

describe('loading lazily', () => {
  const queue: QueueTrackLike[] = [
    { id: 't1', kind: 'library' },
    { id: 't4', kind: 'library' },
    { id: 't5', kind: 'library' },
    { id: 'ep', kind: 'podcast' },
  ];
  const metas = [
    'Pale Harbour · FLAC',
    'Saltmarsh · MP3 320',
    'Saltmarsh · MP3 320',
    'Show · podcast',
  ];
  const details = (url: string) => respond({ quality: { at_target: !url.includes('/t4/') } });

  it('asks only for rows that come into view, and marks the one below target', async () => {
    const observed: Element[] = [];
    let fire: (els: Element[]) => void = () => {};
    class FakeIO {
      constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
        fire = (els) =>
          cb(els.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry));
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {
        observed.length = 0;
      }
    }
    (window as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
    const list = document.createElement('div');
    drawRows(list, queue, metas);
    const fetcher = vi.fn(async (url: string) => details(url));
    const qq = bootQueueQuality({ list, queue: () => queue, fetcher: fetcher as never });
    qq.refresh();
    expect(observed).toHaveLength(4);
    expect(fetcher).not.toHaveBeenCalled();
    // only the second row scrolls into view
    fire([list.children[1]]);
    await flush();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/library/tracks/t4/details');
    expect(list.children[1].querySelector(`.${BELOW_CLASS}`)?.textContent).toBe('MP3 320');

    // the queue redraws: the verdict is remembered, nothing is asked again
    drawRows(list, queue, metas);
    qq.refresh();
    expect(list.children[1].querySelector(`.${BELOW_CLASS}`)?.textContent).toBe('MP3 320');
    fire([list.children[1], list.children[3]]);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    qq.dispose();
  });

  it('without an observer, judges the first rows up next only', async () => {
    const list = document.createElement('div');
    drawRows(list, queue, metas, 1);
    const fetcher = vi.fn(async (url: string) => details(url));
    bootQueueQuality({
      list,
      queue: () => queue,
      fetcher: fetcher as never,
      fallbackRows: 1,
    }).refresh();
    await flush();
    await flush();
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['/api/library/tracks/t4/details']);
    expect(list.children[1].querySelector(`.${BELOW_CLASS}`)).not.toBeNull();
    expect(list.children[0].querySelector(`.${BELOW_CLASS}`)).toBeNull();
  });

  it('leaves the row as it was when the details can’t be read', async () => {
    const list = document.createElement('div');
    drawRows(list, queue, metas);
    const fetcher = vi.fn(async () => {
      throw new Error('offline');
    });
    bootQueueQuality({ list, queue: () => queue, fetcher: fetcher as never }).refresh();
    await flush();
    expect(list.querySelector(`.${BELOW_CLASS}`)).toBeNull();
    expect(list.children[1].textContent).toBe('Saltmarsh · MP3 320');
  });
});
