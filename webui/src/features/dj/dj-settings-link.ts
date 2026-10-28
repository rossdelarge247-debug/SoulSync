/**
 * Settings → Library → DJ (33e; UX-13, Ross 28 October): its own folded
 * section on the Library tab (index.html `[data-settings-section="dj"]`:
 * Between tracks, BPM, key and energy, Traktor Pro 3). Every link that says
 * "Settings → Library → DJ" comes here: Settings opens on Library with the
 * section expanded and scrolled into view, then the card asked for is
 * focused. The URL form is /settings?tab=library&section=dj
 * (static/settings.js reads it, and `requestSettingsSection`).
 */
import { appURL } from '@/platform/url-base';

export type DjSettingsTarget = 'section' | 'between' | 'traktor';

export const DJ_SETTINGS_URL = '/settings?tab=library&section=dj';

const TARGETS: Record<DjSettingsTarget, { card: string; focus: string }> = {
  section: { card: '[data-settings-section="dj"]', focus: '' },
  between: {
    card: '#ss-between-tracks-library [data-between-tracks]',
    focus: '[aria-checked="true"]',
  },
  traktor: { card: '[data-traktor-card]', focus: 'input' },
};

/** Expand the DJ section (if it's folded), then scroll to and focus the card. */
function reveal(target: DjSettingsTarget): void {
  let tries = 0;
  const look = () => {
    window.openSettingsSection?.('dj');
    const { card, focus } = TARGETS[target];
    const el = document.querySelector<HTMLElement>(card);
    if (el && el.offsetParent !== null) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (focus) el.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
      return;
    }
    tries += 1;
    if (tries < 20) setTimeout(look, 150);
  };
  look();
}

export function openDjSettings(target: DjSettingsTarget = 'section'): void {
  const page = document.getElementById('settings-page');
  if (page && page.offsetParent !== null && typeof window.switchSettingsTab === 'function') {
    window.switchSettingsTab('library');
    reveal(target);
    return;
  }
  window.requestSettingsTab?.('library');
  window.requestSettingsSection?.('dj');
  if (typeof window.navigateToPage === 'function') {
    void window.navigateToPage('settings');
    reveal(target);
    return;
  }
  window.location.assign(appURL(DJ_SETTINGS_URL));
}
