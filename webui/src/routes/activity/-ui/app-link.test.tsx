import { afterEach, describe, expect, it, vi } from 'vitest';

import { revealWhenReady, toolNavigated } from './app-link';

describe('Preview again hand-off to the Tools page', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete window.revealToolsTabFor;
    document.body.innerHTML = '';
  });

  it('waits for the Tools page, switches to the tab with the card, then scrolls to it', async () => {
    vi.useFakeTimers();
    revealWhenReady('#duplicate-cleaner-card');

    // the Tools page hasn't mounted yet: nothing to do
    await vi.advanceTimersByTimeAsync(300);

    const card = document.createElement('div');
    card.id = 'duplicate-cleaner-card';
    const scrollIntoView = vi.fn();
    card.scrollIntoView = scrollIntoView;
    document.body.appendChild(card);
    const reveal = vi.fn(() => true);
    window.revealToolsTabFor = reveal;

    await vi.advanceTimersByTimeAsync(200);
    expect(reveal).toHaveBeenCalledWith('#duplicate-cleaner-card');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('gives up quietly when the card never appears', async () => {
    vi.useFakeTimers();
    const reveal = vi.fn(() => false);
    window.revealToolsTabFor = reveal;
    revealWhenReady('#nowhere', 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('only hands off for tools with a card to show', () => {
    expect(toolNavigated({ href: '/tools', reveal: '#db-updater-card' })).toBeTypeOf('function');
    expect(toolNavigated({ href: '/active-downloads' })).toBeUndefined();
  });
});
