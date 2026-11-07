import type { DjMixSession } from './dj-mix-session';
/**
 * DJ mode as the Visuals overlay draws it (Brief F, steps 2 and 3): the
 * lanes (dj-stage.tsx) with the mixer under them once B has a track
 * (dj-mixer.tsx, its decks dj-mix-session.ts) and Browse over them
 * (dj-browse.tsx); 3b's lane strips (Headphones, cues, Key lock) and zoom
 * pills (dj-strip.tsx) in the lanes' slots, and the outputs (dj-outputs-host.ts).
 */
import type { DjModeStore } from './dj-mode-store';
import type { DjOutputs } from './dj-outputs-host';

import { DjBrowse } from './dj-browse';
import { djMixSession, djOutputs } from './dj-mix-host';
import { DjMixer } from './dj-mixer';
import { djModeStore } from './dj-mode-store';
import { DjStage } from './dj-stage';
import { LaneStrip, LoopControls, ZoomPill } from './dj-strip';

export function DjModeStage({
  store = djModeStore(),
  session = djMixSession(),
  outputs = djOutputs(),
}: {
  store?: DjModeStore;
  session?: DjMixSession;
  outputs?: DjOutputs;
}) {
  return (
    <DjStage
      store={store}
      slots={{
        strip: {
          a: <LaneStrip deck="a" store={store} session={session} outputs={outputs} />,
          b: <LaneStrip deck="b" store={store} session={session} outputs={outputs} />,
        },
        lineEnd: {
          a: (
            <>
              <LoopControls deck="A" session={session} place="line" />
              <ZoomPill deck="a" store={store} />
            </>
          ),
          b: (
            <>
              <LoopControls deck="B" session={session} place="line" />
              <ZoomPill deck="b" store={store} />
            </>
          ),
        },
        mixer: (
          <>
            <DjMixer store={store} session={session} outputs={outputs} />
            <DjBrowse store={store} />
          </>
        ),
      }}
    />
  );
}
