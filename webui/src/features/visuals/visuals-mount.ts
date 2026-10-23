/**
 * The Visuals overlay's new pieces load the first time they're needed: when
 * the overlay opens or Player settings shows (its MilkDrop group). Until
 * then the page carries only this, and Butterchurn and the presets load
 * later still, when MilkDrop is first picked (visuals-controller.ts).
 */

const WATCHED = ['np-modal-overlay', 'np-v2-settings-panel'];

export function mountVisualsWhenNeeded(win: Window = window): void {
  const doc = win.document;
  const nodes = WATCHED.map((id) => doc.getElementById(id)).filter((n): n is HTMLElement =>
    Boolean(n),
  );
  if (!nodes.length) return;
  let started = false;
  const observer = new MutationObserver(() => check());
  function start(): void {
    if (started) return;
    started = true;
    observer.disconnect();
    void import('./visuals-host').then((m) => m.mountVisualsHost(win));
  }
  function check(): void {
    if (nodes.some((n) => !n.classList.contains('hidden'))) start();
  }
  for (const n of nodes) observer.observe(n, { attributes: true, attributeFilter: ['class'] });
  check();
}
