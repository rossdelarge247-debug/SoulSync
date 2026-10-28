/**
 * The setup check's info row for this browser (Design's 312): Auto mix
 * needs https or SYNCHRO.S opened on its own computer. Information, never a
 * warning, and the Connections card says the same with how.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HttpsNote } from '@/features/automix/https-note';

import { BrowserInfo } from './-ui/check-groups';

describe('312: this browser and https', () => {
  it('an info row: what Auto mix needs, here', () => {
    const { container, unmount } = render(
      <BrowserInfo support={() => 'Auto mix needs SYNCHRO.S on https'} />,
    );
    expect(screen.getByRole('heading', { name: 'This browser' })).toBeTruthy();
    const row = container.querySelector('[data-status]')!;
    expect(row).toHaveAttribute('data-status', 'info');
    expect(row).toHaveTextContent('Auto mix');
    expect(row).toHaveTextContent('Info');
    expect(row).toHaveTextContent(
      'Over plain http from another computer, Auto mix can only cut on the phrase or play straight on: its blends and echo outs need SYNCHRO.S on https, or opened on its own computer (localhost).',
    );
    expect(row).toHaveTextContent('Settings → Connections says how.');
    unmount();
    const browser = render(
      <BrowserInfo support={() => "This browser can't run Auto mix's decks"} />,
    );
    expect(browser.container).toHaveTextContent(/This browser can't run Auto mix's decks/);
    browser.unmount();
    render(<BrowserInfo support={() => null} />);
    expect(screen.getByText(/Auto mix can run in this browser/)).toBeTruthy();
  });

  it('Settings → Connections points at https', () => {
    const browser = render(<HttpsNote support={() => "This browser can't run Auto mix's decks"} />);
    expect(browser.container.querySelector('[data-https-note]')).toHaveAttribute(
      'data-https-note',
      'browser',
    );
    expect(browser.container).not.toHaveTextContent(/plain http/);
    browser.unmount();
    const { container, unmount } = render(<HttpsNote support={() => 'needs https'} />);
    expect(container.querySelector('[data-https-note]')).toHaveAttribute(
      'data-https-note',
      'insecure',
    );
    expect(container).toHaveTextContent('Open SYNCHRO.S on https');
    expect(container).toHaveTextContent('localhost');
    unmount();
    const secure = render(<HttpsNote support={() => null} />);
    expect(secure.container.querySelector('[data-https-note]')).toHaveAttribute(
      'data-https-note',
      'secure',
    );
  });
});
