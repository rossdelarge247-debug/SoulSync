/**
 * HANDOFF 44: a queued library track below your quality target shows its
 * format in the warning colour on its meta line ("Saltmarsh · MP3 320"),
 * nothing else. The judgement comes from the player's existing
 * GET /api/library/tracks/<id>/details, loaded lazily: only for rows that
 * come into view (an IntersectionObserver on the list), once per track, and
 * remembered for the session so a redrawn queue (media-player.js rebuilds
 * the rows on every change) is marked again without asking.
 *
 * The colour isn't the only signal: the row's meta also carries a
 * screen-reader note and a title saying it's below the target.
 */

export interface QueueTrackLike {
  id?: string | number | null;
  kind?: string | null;
  is_library?: boolean;
}

export type QualityVerdict = 'below' | 'ok' | 'unknown';

export const BELOW_CLASS = 'ss-player-queue-below';

/** A library track's id, or null for anything the details route can't judge. */
export function libraryTrackId(track: QueueTrackLike | null | undefined): string | null {
  if (!track) return null;
  const kind = track.kind || (track.is_library ? 'library' : 'stream');
  if (kind !== 'library') return null;
  if (track.id === undefined || track.id === null || track.id === '') return null;
  return String(track.id);
}

/** The details body's verdict: only an explicit `at_target: false` is "below". */
export function verdictFrom(body: unknown): QualityVerdict {
  const q = (body as { quality?: { at_target?: unknown } | null } | null)?.quality;
  if (!q || typeof q.at_target !== 'boolean') return 'unknown';
  return q.at_target ? 'ok' : 'below';
}

/**
 * Wrap the format part of "artist · format" in the warning span. Returns
 * false when the line has no format to mark (no " · ").
 */
export function markMeta(meta: HTMLElement, below: boolean): boolean {
  const doc = meta.ownerDocument;
  const existing = meta.querySelector(`.${BELOW_CLASS}`);
  if (!below) {
    if (existing) {
      meta.textContent = meta.textContent?.replace(/ · below your quality target$/, '') ?? '';
      meta.removeAttribute('title');
    }
    return false;
  }
  if (existing) return true;
  const text = meta.textContent ?? '';
  const at = text.lastIndexOf(' · ');
  if (at < 0) return false;
  const format = text.slice(at + 3);
  meta.textContent = text.slice(0, at + 3);
  const span = doc.createElement('span');
  span.className = BELOW_CLASS;
  span.textContent = format;
  const note = doc.createElement('span');
  note.className = 'ss-sr';
  note.textContent = ' · below your quality target';
  meta.append(span, note);
  meta.title = `${format} is below your quality target`;
  return true;
}

export interface QueueQualityOptions {
  list: HTMLElement;
  /** The queue as the engine holds it, read when a row needs its track. */
  queue: () => QueueTrackLike[];
  fetcher: typeof fetch;
  win?: Window;
  /** How many rows to judge when the browser has no IntersectionObserver. */
  fallbackRows?: number;
}

export interface QueueQuality {
  /** Call after the rows were redrawn. */
  refresh(): void;
  dispose(): void;
}

export function bootQueueQuality(options: QueueQualityOptions): QueueQuality {
  const { list, queue, fetcher } = options;
  const win = options.win ?? window;
  const verdicts = new Map<string, QualityVerdict>();
  const pending = new Set<string>();
  const IO = (win as Window & { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
  let observer: IntersectionObserver | null = null;

  const rows = () => [...list.querySelectorAll<HTMLElement>('.np-queue-item')];
  const trackOf = (row: HTMLElement) => queue()[Number(row.dataset.qindex)];

  function paint(row: HTMLElement): void {
    const id = libraryTrackId(trackOf(row));
    const meta = row.querySelector<HTMLElement>('.np-queue-item-artist');
    if (!id || !meta) return;
    markMeta(meta, verdicts.get(id) === 'below');
  }

  function paintId(id: string): void {
    for (const row of rows()) if (libraryTrackId(trackOf(row)) === id) paint(row);
  }

  async function load(id: string): Promise<void> {
    if (verdicts.has(id) || pending.has(id)) return;
    pending.add(id);
    try {
      const res = await fetcher(`/api/library/tracks/${encodeURIComponent(id)}/details`);
      verdicts.set(id, res.ok ? verdictFrom(await res.json()) : 'unknown');
    } catch {
      // a row without a verdict just shows its format as before; try again later
      pending.delete(id);
      return;
    }
    pending.delete(id);
    paintId(id);
  }

  function seen(row: HTMLElement): void {
    const id = libraryTrackId(trackOf(row));
    if (!id) return;
    if (verdicts.has(id)) paint(row);
    else void load(id);
  }

  function refresh(): void {
    observer?.disconnect();
    const all = rows();
    for (const row of all) paint(row);
    if (IO) {
      observer = new IO(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            observer?.unobserve(e.target);
            seen(e.target as HTMLElement);
          }
        },
        { root: null, rootMargin: '0px 0px 120px 0px' },
      );
      for (const row of all) observer.observe(row);
    } else {
      // no observer (old browsers, tests): the first few rows after the current one
      const upNext = all.filter((r) => !r.classList.contains('played'));
      for (const row of upNext.slice(0, options.fallbackRows ?? 8)) seen(row);
    }
  }

  return {
    refresh,
    dispose: () => {
      observer?.disconnect();
      observer = null;
    },
  };
}
