import { Outlet } from '@tanstack/react-router';

import { useReactPageShell } from '@/platform/shell/route-controllers';

import styles from './audiobooks-page.module.css';

/**
 * Layout shell for all /audiobooks/* routes.
 *
 * Samples play in the app's player (the bar along the bottom of the window,
 * board 6a), so a preview started on the browse page keeps playing on a
 * detail page, or anywhere else. The provider lives in route.tsx.
 */
export function AudiobooksLayout() {
  useReactPageShell('audiobooks');
  return (
    <div className={`page-shell ${styles.audiobooksContainer}`}>
      <Outlet />
    </div>
  );
}
