import { appURL } from '@/platform/url-base';

/**
 * Settings → Library → DJ's Between tracks (33e) from anywhere (Player
 * settings' "Style and key lock…"), as the Traktor card's link does.
 */
function scrollToCard(): void {
  let tries = 0;
  const look = () => {
    const card = document.querySelector<HTMLElement>(
      '#ss-between-tracks-library [data-between-tracks]',
    );
    if (card && card.offsetParent !== null) {
      card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      card.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
      return;
    }
    tries += 1;
    if (tries < 20) setTimeout(look, 150);
  };
  look();
}

export function openBetweenTracksSettings(): void {
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
