import { useEffect, useState } from 'react';

/**
 * The current time, re-read every `intervalMs` while `active`. A preview stops
 * working after 15 minutes; a card that says "Preview ready" must notice when
 * it no longer is without waiting for a click to be refused.
 */
export function useNow(active: boolean, intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
