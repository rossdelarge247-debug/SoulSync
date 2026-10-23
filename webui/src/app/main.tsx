import '@vitejs/plugin-react/preamble';
import { createRoot } from 'react-dom/client';

import { mountCandidateInspectorHost } from '@/features/downloads/inspector-modal';
import { mountFoldersCard } from '@/features/drives/folders-card';
import { mountDriveMoveHost } from '@/features/drives/move-flow';
import { mountOnboardingHost } from '@/features/onboarding/host';
import { mountAddToPlaylistHost } from '@/features/playlists/add-to-playlist';
import { mountLossyDeleteOriginalHost } from '@/features/safe-action/lossy-delete-original';
import { mountPermanentDeleteHost } from '@/features/safe-action/permanent-delete-flow';
import { mountVideoRepairFixHost } from '@/features/safe-action/video-repair-fix-flow';
import { mountLibraryDiscographySourceSelector } from '@/features/settings/library-discography-source';
import { mountSpotifyPausedHost } from '@/features/spotify-pause/spotify-paused-host';
import { mountVisualsWhenNeeded } from '@/features/visuals/visuals-mount';
import { bindWindowWebRouter } from '@/platform/shell/bridge';
import { ROUTER_ROOT_ID } from '@/platform/shell/route-controllers';
// Route components are code-split, so a route module's top-level code only runs
// once its route loads. The discover download bar's store publishes window
// globals at module load that wishlist-tools.js and init.js use on every page
// (discoverDownloads, hydrateDiscoverDownloadsFromSnapshot), so it has to be in
// the entry chunk. entry-side-effects.test.ts keeps the next one honest.
import '@/routes/discover/-discover.use-download-bar';

import { createAppQueryClient } from './query-client';
import { AppRouterProvider, createAppRouter } from './router';

// Safeguard against browser translation and async unmount DOM race conditions:
// If an extension or rapid async unmount removes a DOM child before React reconciles it,
// parent.removeChild(child) throws NotFoundError, crashing the React app boundary.
if (typeof Node === 'function' && Node.prototype) {
  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(child: T): T {
    if (child.parentNode !== this) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('Cannot remove child: not a child of this node', child);
      }
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };
  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(
    newNode: T,
    referenceNode: Node | null,
  ): T {
    if (referenceNode && referenceNode.parentNode !== this) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          'Cannot insert before: reference node is not a child of this node',
          referenceNode,
        );
      }
      return newNode;
    }
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };
}

export async function bootstrapApp() {
  const container = document.getElementById(ROUTER_ROOT_ID);
  if (!container) return null;

  const queryClient = createAppQueryClient();
  const router = createAppRouter({ queryClient });

  bindWindowWebRouter(router);
  createRoot(container).render(<AppRouterProvider router={router} queryClient={queryClient} />);

  return { queryClient, router };
}

// before init.js's DOMContentLoaded handler, which opens it on first run
mountOnboardingHost();
void mountLibraryDiscographySourceSelector();
mountCandidateInspectorHost();
mountAddToPlaylistHost();
mountPermanentDeleteHost();
mountVideoRepairFixHost();
mountLossyDeleteOriginalHost();
mountSpotifyPausedHost();
mountVisualsWhenNeeded();
mountDriveMoveHost();
mountFoldersCard();
void bootstrapApp();
