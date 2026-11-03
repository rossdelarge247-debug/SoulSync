import type { DjMixSession } from './dj-mix-session';
/**
 * DJ mode as the Visuals overlay draws it (Brief F, steps 2 and 3): the
 * lanes (dj-stage.tsx) with the mixer under them once B has a track
 * (dj-mixer.tsx, its decks dj-mix-session.ts) and Browse over them
 * (dj-browse.tsx). 3b adds its lane strips and zoom through the same slots.
 */
import type { DjModeStore } from './dj-mode-store';

import { DjBrowse } from './dj-browse';
import { djMixSession } from './dj-mix-host';
import { DjMixer } from './dj-mixer';
import { djModeStore } from './dj-mode-store';
import { DjStage } from './dj-stage';

export function DjModeStage({
  store = djModeStore(),
  session = djMixSession(),
}: {
  store?: DjModeStore;
  session?: DjMixSession;
}) {
  return (
    <DjStage
      store={store}
      slots={{
        mixer: (
          <>
            <DjMixer store={store} session={session} />
            <DjBrowse store={store} />
          </>
        ),
      }}
    />
  );
}
