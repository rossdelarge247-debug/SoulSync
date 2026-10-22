import { useEffect, useState } from 'react';

/** The shell's phone layout starts at 768px (static/shell.css). */
export const PHONE_QUERY = '(max-width: 768px)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

/**
 * Whether a media query matches, kept current. Used where the phone layout
 * moves something in the DOM (the Runs panel goes under the selected card),
 * which CSS alone can't do. False where matchMedia doesn't exist.
 */
export function useMediaQuery(query: string = PHONE_QUERY): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const update = () => setValue(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, [query]);
  return value;
}
