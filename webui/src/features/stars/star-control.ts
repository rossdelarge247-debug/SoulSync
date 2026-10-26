/**
 * The star's one control (24a: "one control on legacy and React pages
 * alike"). `starAttributes` is what every star button carries, whichever
 * side draws it: React (`<StarButton>`, star-button.tsx) spreads it, the
 * shell and the legacy pages get a self-updating button from
 * `createStarButton` (window.SoulSyncStarButton). The look is one
 * stylesheet, static/stars.css (class `ss-star`).
 *
 * - In a row (`variant: 'row'`) the column is always reserved: the outline
 *   star shows on the row's hover and keyboard focus (a row marks itself
 *   with `data-star-row`), the filled star (accent-light) stays once
 *   starred. On a phone only a starred row shows it (28d).
 * - In the player (`'player'`) the outline shows at rest, at 62% (28c).
 * - A track without a library file shows nothing (`data-star="none"`, the
 *   space kept): starring one is impossible, so no star is ever disabled.
 */
import { showsStar, starLabel, starStore, type StarState, type StarStore } from './stars-store';

export type StarVariant = 'row' | 'player';

/** The star's outline (24px box); filled when starred. */
export const STAR_PATH =
  'M12 3.2l2.63 5.33 5.88.86-4.26 4.15 1.01 5.86L12 16.63 6.74 19.4l1.01-5.86L3.49 9.39l5.88-.86L12 3.2z';

export function starAttributes(
  state: StarState | undefined,
  title: string | undefined,
  variant: StarVariant,
): Record<string, string | undefined> {
  const shown = showsStar(state);
  const on = Boolean(state?.starred);
  return {
    class: 'ss-star',
    'data-star': shown ? (on ? 'on' : 'off') : 'none',
    'data-star-variant': variant,
    'aria-pressed': shown ? String(on) : undefined,
    'aria-label': starLabel(on, title),
    'aria-hidden': shown ? undefined : 'true',
    title: shown ? `${on ? 'Unstar' : 'Star'} (S)` : undefined,
    tabindex: shown ? undefined : '-1',
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function starSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', STAR_PATH);
  svg.appendChild(path);
  return svg;
}

function paint(
  button: HTMLButtonElement,
  state: StarState | undefined,
  title: string,
  variant: StarVariant,
) {
  const attrs = starAttributes(state, title, variant);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') continue;
    if (value === undefined) button.removeAttribute(name);
    else button.setAttribute(name, value);
  }
  button.disabled = attrs['data-star'] === 'none';
}

export interface StarButtonHandle {
  button: HTMLButtonElement;
  /** point it at another track (the player's next one); '' or null hides it */
  setTrack(id: string | null, title?: string): void;
  destroy(): void;
}

/**
 * A star button for the shell and the legacy pages: it looks itself up,
 * redraws when the store changes, and toggles on click. `destroy()` lets it
 * go (the shell keeps its buttons for the page's life).
 */
export function createStarButton(
  id: string | null,
  options: { title?: string; variant?: StarVariant; store?: StarStore } = {},
): StarButtonHandle {
  const store = options.store ?? starStore();
  const variant = options.variant ?? 'row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ss-star';
  button.appendChild(starSvg());
  let track = id ? String(id) : '';
  let title = options.title ?? '';
  const draw = () => paint(button, track ? store.get(track) : undefined, title, variant);
  const unsubscribe = store.subscribe(draw);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (track) void store.toggle(track, title);
  });
  const handle: StarButtonHandle = {
    button,
    setTrack(next, nextTitle) {
      track = next ? String(next) : '';
      title = nextTitle ?? '';
      if (track) store.want([track]);
      draw();
    },
    destroy: unsubscribe,
  };
  handle.setTrack(track, title);
  return handle;
}

/**
 * S (24a): star or unstar the focused row's track (a row that carries
 * `data-star-row` and a shown star), else the playing library track.
 * Returns what it did, for the caller's status line.
 */
export function starFromKeyboard(
  playing: { id: string; title: string } | null,
  store: StarStore = starStore(),
): { id: string; title: string } | null {
  const focused = document.activeElement?.closest?.('[data-star-row]') as HTMLElement | null;
  const star = focused?.querySelector<HTMLButtonElement>('.ss-star:not([data-star="none"])');
  const rowId = focused?.getAttribute('data-star-row') ?? '';
  if (star && rowId) {
    void store.toggle(rowId, star.getAttribute('aria-label')?.replace(/^(Un)?[Ss]tar /, '') ?? '');
    return { id: rowId, title: '' };
  }
  if (!playing?.id) return null;
  const id = playing.id;
  const state = store.get(id);
  if (!showsStar(state)) {
    // not looked up yet: ask, and toggle once it's known. One wait per id:
    // a second press meanwhile does nothing, and a lookup that fails gives
    // up after a while instead of leaving a listener behind
    if (!state && !waitingFor.has(id)) {
      waitingFor.add(id);
      const done = () => {
        waitingFor.delete(id);
        clearTimeout(timer);
        stop();
      };
      const stop = store.subscribe(() => {
        const s = store.get(id);
        if (!s) return;
        done();
        if (showsStar(s)) void store.toggle(id, playing.title);
      });
      const timer = setTimeout(done, LOOKUP_WAIT_MS);
      store.want([id]);
    }
    return state ? null : playing;
  }
  void store.toggle(id, playing.title);
  return playing;
}

/** S on a track not looked up yet: one wait per id (L4). */
const waitingFor = new Set<string>();
const LOOKUP_WAIT_MS = 10_000;
