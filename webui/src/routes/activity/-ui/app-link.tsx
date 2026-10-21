import { useRouter } from '@tanstack/react-router';
import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';

import { appURL } from '@/platform/url-base';

import type { ToolDestination } from '../-activity.helpers';

function plainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  /** An app path from the feed ("/automations"), without the URL base. */
  to: string;
  /** Runs after the in-app navigation starts (plain clicks only). */
  onNavigated?: () => void;
};

/**
 * A real link (open in a new tab works) that navigates inside the app on a
 * plain click. Feed links point at React and legacy pages alike; the router's
 * catch-all hands legacy paths to the shell.
 */
export const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(function AppLink(
  { to, onClick, onNavigated, ...props },
  ref,
) {
  const router = useRouter();
  return (
    <a
      ref={ref}
      href={appURL(to)}
      onClick={(event) => {
        onClick?.(event);
        if (!plainLeftClick(event)) return;
        event.preventDefault();
        void router.navigate({ href: appURL(to) });
        onNavigated?.();
      }}
      {...props}
    />
  );
});

/**
 * After navigating to the Tools page, bring one tool card into view. The page
 * keeps both tabs mounted and publishes window.revealToolsTabFor so a hand-off
 * can switch to the tab that holds the card (the helper's search does the
 * same). Gives up quietly after a few seconds.
 */
export function revealWhenReady(selector: string, timeoutMs = 4000): void {
  const started = Date.now();
  const attempt = () => {
    const target = document.querySelector<HTMLElement>(selector);
    if (target && typeof window.revealToolsTabFor === 'function') {
      let switched = false;
      try {
        switched = window.revealToolsTabFor(selector);
      } catch {
        switched = false;
      }
      // a tab that just switched paints on the next frame
      window.setTimeout(
        () => target.scrollIntoView?.({ behavior: 'smooth', block: 'center' }),
        switched ? 60 : 0,
      );
      return;
    }
    if (Date.now() - started < timeoutMs) window.setTimeout(attempt, 100);
  };
  window.setTimeout(attempt, 0);
}

export function toolNavigated(destination: ToolDestination): (() => void) | undefined {
  const { reveal } = destination;
  return reveal ? () => revealWhenReady(reveal) : undefined;
}
