import { openDjSettings } from './dj-settings-link';

/**
 * Settings → Library → Traktor Pro 3 from anywhere (the export dialog's
 * "Change…"): it lives in the DJ section now (UX-13), opened and scrolled to.
 */
export function openTraktorSettings(): void {
  openDjSettings('traktor');
}
