import { Outlet } from '@tanstack/react-router';

import { useReactPageShell } from '@/platform/shell/route-controllers';

import styles from './podcasts-page.module.css';

/**
 * Layout shell for all /podcasts/* routes.
 *
 * Episodes play in the app's player (the bar along the bottom of the window,
 * board 6a), so there's no player bar here any more; the PodcastProvider in
 * route.tsx mirrors what that player has loaded for the episode lists.
 */
export function PodcastsLayout() {
  useReactPageShell('podcasts');
  return (
    <div className={`page-shell ${styles.podcastsContainer}`}>
      <Outlet />
    </div>
  );
}
