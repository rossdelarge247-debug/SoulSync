import type { ReactNode } from 'react';

/**
 * A page's help on phones (Design, HANDOFF 25). Phones have no floating
 * buttons, so a page with a tour has a "?" in its header: it opens the help
 * menu (helper.js) under it, with this page's tour first. Wide screens keep
 * the floating "?", so the button is hidden there (static/shell.css,
 * `.ss-page-help`; the Settings page's static header uses the same class).
 */

export const PAGE_HELP_LABEL = 'Help and a tour of this page';

/** Whether helper.js has a tour for this page (by its page id). */
export function pageHasTour(page: string): boolean {
  return typeof window !== 'undefined' && Boolean(window.pageTourFor?.(page));
}

function HelpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  );
}

export function PageHelpButton({ page }: { page: string }) {
  if (!pageHasTour(page)) return null;
  return (
    <button
      type="button"
      className="ss-page-help"
      aria-label={PAGE_HELP_LABEL}
      title={PAGE_HELP_LABEL}
      data-page-help={page}
      onClick={(event) => window.toggleHelperMode?.(event.currentTarget)}
    >
      <HelpIcon />
    </button>
  );
}

/**
 * The page's title with its "?" beside it on phones. On wide screens the row
 * takes no part in layout (`display: contents`), so the title sits as before.
 */
export function TitleWithHelp({ page, children }: { page: string; children: ReactNode }) {
  return (
    <div className="ss-page-title-row">
      {children}
      <PageHelpButton page={page} />
    </div>
  );
}
