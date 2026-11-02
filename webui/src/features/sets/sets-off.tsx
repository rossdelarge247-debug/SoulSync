import { useId, type MouseEvent } from 'react';

import { DJ_SETTINGS_URL, openDjSettings } from '@/features/dj/dj-settings-link';
import { appURL } from '@/platform/url-base';

/**
 * Library → Sets reached by its link while the mixing features are hidden
 * (Settings → Library → DJ's "Show the mixing features", off by default;
 * mix-visibility.ts): the module switches' quiet "turned off" state
 * (features/modules/module-gate.tsx, its classes in static/modules.css),
 * with the way back for an admin. Nothing on the page is read meanwhile;
 * the sets themselves are kept.
 */
export function SetsOffNotice({ isAdmin }: { isAdmin: boolean }) {
  const titleId = useId();
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    openDjSettings('section');
  };
  return (
    <div className="page-shell module-off-page-shell">
      <section className="module-off-notice" data-sets-off="" aria-labelledby={titleId}>
        <p className="module-off-status">
          <span className="module-off-dot" aria-hidden="true" />
          Turned off
        </p>
        <h2 className="module-off-title" id={titleId}>
          Sets are turned off
        </h2>
        <p className="module-off-body">
          Sets go with the other mixing features, which are hidden for now. Your sets are kept.
        </p>
        <p className="module-off-hint">
          {isAdmin
            ? 'You can show them again in Settings → Library → DJ.'
            : 'An admin can show them again in Settings → Library → DJ.'}
        </p>
        {isAdmin ? (
          <a className="module-off-action" href={appURL(DJ_SETTINGS_URL)} onClick={open}>
            Open Settings → Library → DJ
          </a>
        ) : null}
      </section>
    </div>
  );
}
