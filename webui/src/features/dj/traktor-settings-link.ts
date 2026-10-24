import { appURL } from '@/platform/url-base';

function scrollToCard(): void {
  let tries = 0;
  const look = () => {
    const card = document.querySelector<HTMLElement>('[data-traktor-card]');
    if (card && card.offsetParent !== null) {
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      card.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
      return;
    }
    tries += 1;
    if (tries < 20) setTimeout(look, 150);
  };
  look();
}

/** Settings → Library → Traktor Pro 3 from anywhere (the export dialog's "Change…"). */
export function openTraktorSettings(): void {
  const page = document.getElementById('settings-page');
  if (page && page.offsetParent !== null && typeof window.switchSettingsTab === 'function') {
    window.switchSettingsTab('library');
    scrollToCard();
    return;
  }
  window.requestSettingsTab?.('library');
  if (typeof window.navigateToPage === 'function') {
    void window.navigateToPage('settings');
    scrollToCard();
    return;
  }
  window.location.assign(appURL('/settings?tab=library'));
}
