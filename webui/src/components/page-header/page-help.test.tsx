/**
 * A page with a tour has a "?" in its header that opens the help menu on
 * phones, where the floating "?" is gone (Design, HANDOFF 25). shell.css
 * hides it on wide screens; here it's the markup and what it calls.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAGE_HELP_LABEL, PageHeader, PageHelpButton, TitleWithHelp } from '.';

afterEach(() => {
  cleanup();
  delete window.pageTourFor;
  delete window.toggleHelperMode;
});

describe('the page help', () => {
  it('shows on a page with a tour and opens the help menu by itself', () => {
    window.pageTourFor = (page) => (page === 'stats' ? 'stats' : null);
    const toggle = vi.fn();
    window.toggleHelperMode = toggle;
    render(<PageHelpButton page="stats" />);
    const button = screen.getByRole('button', { name: PAGE_HELP_LABEL });
    expect(button).toHaveClass('ss-page-help');
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledWith(button);
  });

  it("isn't there on a page without a tour, or before helper.js is", () => {
    render(<PageHelpButton page="stats" />);
    expect(screen.queryByRole('button')).toBeNull();
    window.pageTourFor = () => null;
    render(<PageHelpButton page="wanted" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('sits beside the title, which keeps its own name', () => {
    window.pageTourFor = () => 'issues-tour';
    render(
      <TitleWithHelp page="issues">
        <h1>Issues</h1>
      </TitleWithHelp>,
    );
    const heading = screen.getByRole('heading', { name: 'Issues' });
    expect(heading.parentElement).toHaveClass('ss-page-title-row');
    expect(heading.nextElementSibling).toBe(screen.getByRole('button', { name: PAGE_HELP_LABEL }));
  });

  it('comes with PageHeader when it names its page', () => {
    window.pageTourFor = () => 'import-music';
    render(<PageHeader title="Import" help="import" />);
    expect(screen.getByRole('heading', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PAGE_HELP_LABEL })).toBeInTheDocument();
    cleanup();
    render(<PageHeader title="Import" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
