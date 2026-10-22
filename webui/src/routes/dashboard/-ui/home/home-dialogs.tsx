/**
 * The two dialogs Home opens in place of a page: "Mirror a playlist" (the
 * Mirrored playlists card and the setup panel) and "Set a quality target"
 * (the Quality card's "Change target" and "Set a quality target").
 *
 * A save refreshes the targets, so the card shows the new numbers straight
 * away. Setting the target is admin only (PUT /api/quality/target), so a
 * member doesn't get the button at all.
 */

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { MirrorPlaylistDialog } from '@/features/mirror/mirror-playlist-dialog';
import { SetQualityTargetDialog } from '@/features/quality/set-quality-target-dialog';

import type { HomeDialog, LinkView } from '../../-home.targets';

import { HOME_QUERY_KEY } from '../../-home.api';
import { isDialogAction } from '../../-home.targets';
import { HomeLink, useHomeNav } from './home-nav';

interface HomeDialogs {
  open: (dialog: HomeDialog) => void;
}

const HomeDialogsContext = createContext<HomeDialogs>({ open: () => undefined });

export function HomeDialogsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { isAdmin } = useHomeNav();
  const [openDialog, setOpenDialog] = useState<HomeDialog | null>(null);
  const open = useCallback((dialog: HomeDialog) => setOpenDialog(dialog), []);
  const value = useMemo(() => ({ open }), [open]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: [...HOME_QUERY_KEY, 'targets'] });
  };
  return (
    <HomeDialogsContext.Provider value={value}>
      {children}
      <MirrorPlaylistDialog
        open={openDialog === 'mirror'}
        onClose={() => setOpenDialog(null)}
        onMirrored={refresh}
      />
      <SetQualityTargetDialog
        open={openDialog === 'quality'}
        onClose={() => setOpenDialog(null)}
        onSaved={refresh}
        isAdmin={isAdmin}
      />
    </HomeDialogsContext.Provider>
  );
}

export function useHomeDialogs(): HomeDialogs {
  return useContext(HomeDialogsContext);
}

/** One of Home's actions: a link to a page, or a button that opens a dialog. */
export function HomeAction({
  action,
  className,
  buttonClassName,
}: {
  action: LinkView;
  /** For the link. */
  className?: string;
  /** For the button; defaults to `className`. */
  buttonClassName?: string;
}) {
  const dialogs = useHomeDialogs();
  const { isAdmin } = useHomeNav();
  if (!isDialogAction(action)) {
    return (
      <HomeLink route={action.route} className={className}>
        {action.label}
      </HomeLink>
    );
  }
  if (action.dialog === 'quality' && !isAdmin) return null;
  return (
    <button
      type="button"
      className={buttonClassName ?? className}
      aria-haspopup="dialog"
      onClick={() => dialogs.open(action.dialog)}
    >
      {action.label}
    </button>
  );
}
