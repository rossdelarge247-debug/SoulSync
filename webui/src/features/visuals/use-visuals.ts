import { createContext, useContext, useSyncExternalStore } from 'react';

import type { VisualsController, VisualsSnapshot } from './visuals-controller';

export const VisualsContext = createContext<VisualsController | null>(null);

export function useVisualsController(): VisualsController {
  const c = useContext(VisualsContext);
  if (!c) throw new Error('VisualsContext missing');
  return c;
}

export function useVisuals(): VisualsSnapshot {
  const c = useVisualsController();
  return useSyncExternalStore(c.subscribe, c.snapshot, c.snapshot);
}
