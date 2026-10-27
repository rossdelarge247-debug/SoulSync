/**
 * The Visuals overlay's new pieces load the first time they're needed: when
 * the overlay opens or Player settings shows (its MilkDrop group). Until
 * then the page carries only this, and Butterchurn and the presets load
 * later still, when MilkDrop is first picked (visuals-controller.ts).
 *
 * Everything the overlay has beyond the SYNCHRO.S visuals hangs on that one
 * load: the header's Visuals button, the panel with MilkDrop and Classic, and
 * the keys reaching them. Without it the legacy player still draws and V still
 * steps through the SYNCHRO.S visuals, so a load that failed looked like a
 * Visuals button that does nothing, for as long as the page stayed open. Now a
 * failed load is tried again on the next open; the Visuals button loads the
 * pieces itself and opens the panel; and when they can't be fetched (the usual
 * reason: SYNCHRO.S was updated after the page opened, and the old build's
 * files are gone) the button says to reload, since a browser keeps a module
 * that failed to fetch failed for the rest of the page's life.
 */

import type { VisualsController } from './visuals-controller';

const WATCHED = ['np-modal-overlay', 'np-v2-settings-panel'];
const PANEL_BUTTON = 'np-v2-visuals-panel-btn';

export const LOAD_FAILED_MESSAGE =
  'The Visuals panel didn’t load. If SYNCHRO.S was updated after this page opened, reload the page.';

type HostModule = Pick<typeof import('./visuals-host'), 'mountVisualsHost'>;

export function mountVisualsWhenNeeded(
  win: Window = window,
  load: () => Promise<HostModule> = () => import('./visuals-host'),
): void {
  const doc = win.document;
  const nodes = WATCHED.map((id) => doc.getElementById(id)).filter((n): n is HTMLElement =>
    Boolean(n),
  );
  if (!nodes.length) return;
  let pending: Promise<VisualsController | null> | null = null;
  let mounted = false;
  const observer = new MutationObserver(() => check());

  function start(): Promise<VisualsController | null> {
    pending ??= load()
      .then((m) => {
        const controller = m.mountVisualsHost(win);
        if (!controller) throw new Error('the Visuals overlay’s markup is missing');
        mounted = true;
        observer.disconnect();
        return controller;
      })
      .catch((err: unknown) => {
        // not for good: the next open, or a click on Visuals, tries again
        pending = null;
        console.error('Visuals: the panel and MilkDrop could not load', err);
        return null;
      });
    return pending;
  }
  function check(): void {
    if (!mounted && nodes.some((n) => !n.classList.contains('hidden'))) void start();
  }

  // Until the pieces are in, the Visuals button loads them and opens the
  // panel; from then on visuals-host.tsx's own listener toggles it.
  doc.getElementById(PANEL_BUTTON)?.addEventListener('click', () => {
    if (mounted) return;
    void start().then((controller) => {
      if (controller) controller.togglePanel(true);
      else
        win.showToast?.(LOAD_FAILED_MESSAGE, 'error', null, {
          action: { label: 'Reload', run: () => win.location.reload() },
        });
    });
  });

  for (const n of nodes) observer.observe(n, { attributes: true, attributeFilter: ['class'] });
  check();
}
