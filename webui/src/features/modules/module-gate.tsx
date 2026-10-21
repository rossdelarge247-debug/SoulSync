import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, type MouseEvent, type ReactNode } from 'react';

import type { ShellPageId } from '@/platform/shell/route-manifest';

import { useProfile, useShellBridge } from '@/platform/shell/route-controllers';
import { appURL } from '@/platform/url-base';

import { modulesQueryKey, modulesQueryOptions } from './modules.api';
import {
  findModule,
  MODULE_DISABLED_EVENT,
  moduleOffCopy,
  MODULES_CHANGED_EVENT,
  MODULES_SETTINGS_PATH,
  normalizeModules,
  withModuleOff,
  type ModuleState,
} from './modules.helpers';

/**
 * The module switches, kept in step with the legacy shell (its
 * MODULES_CHANGED_EVENT after a change in Settings) and with any API call
 * that answers 409 module_disabled (the api client's MODULE_DISABLED_EVENT).
 */
export function useModuleStates() {
  const queryClient = useQueryClient();
  const query = useQuery(modulesQueryOptions());

  useEffect(() => {
    const onChanged = (event: Event) => {
      const next = normalizeModules((event as CustomEvent<{ modules?: unknown }>).detail?.modules);
      if (next.length) queryClient.setQueryData(modulesQueryKey, next);
    };
    const onDisabled = (event: Event) => {
      const name = (event as CustomEvent<{ module?: unknown }>).detail?.module;
      if (typeof name !== 'string' || !name) return;
      queryClient.setQueryData<ModuleState[]>(modulesQueryKey, (old) =>
        withModuleOff(old ?? [], name),
      );
    };
    window.addEventListener(MODULES_CHANGED_EVENT, onChanged);
    window.addEventListener(MODULE_DISABLED_EVENT, onDisabled);
    return () => {
      window.removeEventListener(MODULES_CHANGED_EVENT, onChanged);
      window.removeEventListener(MODULE_DISABLED_EVENT, onDisabled);
    };
  }, [queryClient]);

  return query;
}

/**
 * The module when it is known to be turned off; null when it is on (or its
 * state couldn't be read); undefined while the first states are loading.
 */
export function useModuleOff(name: string): ModuleState | null | undefined {
  const { data, isPending } = useModuleStates();
  if (isPending) return undefined;
  const state = data ? findModule(data, name) : undefined;
  return state && !state.enabled ? state : null;
}

function openModulesSettings(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  if (typeof window.openModulesSettings !== 'function') return; // the href does it
  event.preventDefault();
  window.openModulesSettings();
}

export interface ModuleOffNoticeProps {
  module: Pick<ModuleState, 'name' | 'display_name'>;
  isAdmin: boolean;
}

/** "Podcasts is turned off", with the way back for an admin. */
export function ModuleOffNotice({ module, isAdmin }: ModuleOffNoticeProps) {
  const titleId = useId();
  const copy = moduleOffCopy(module, isAdmin);
  return (
    <section className="module-off-notice" data-module={module.name} aria-labelledby={titleId}>
      <p className="module-off-status">
        <span className="module-off-dot" aria-hidden="true" />
        Module off
      </p>
      <h2 className="module-off-title" id={titleId}>
        {copy.title}
      </h2>
      <p className="module-off-body">{copy.body}</p>
      <p className="module-off-hint">{copy.hint}</p>
      {copy.action ? (
        <a
          className="module-off-action"
          href={appURL(MODULES_SETTINGS_PATH)}
          onClick={openModulesSettings}
        >
          {copy.action}
        </a>
      ) : null}
    </section>
  );
}

/** A whole page's worth of "turned off": shows the React host like the page would. */
export function ModuleOffPage({
  module,
  pageId,
}: {
  module: ModuleState;
  /** The page this stands in for; none for a path with no shell page (video). */
  pageId?: ShellPageId;
}) {
  const bridge = useShellBridge();
  const profile = useProfile();

  useLayoutEffect(() => {
    if (!bridge) return;
    if (pageId) bridge.setActivePageChrome(pageId);
    bridge.showReactHost(pageId ?? 'dashboard');
  }, [bridge, pageId]);

  return (
    <div className="page-shell module-off-page-shell">
      <ModuleOffNotice module={module} isAdmin={profile.isAdmin} />
    </div>
  );
}

/**
 * Renders the page only while its module is on. A turned-off module's page
 * shows ModuleOffPage instead, so nothing on it calls an API that would
 * answer 409. Waits for the first module states (they come with the page, so
 * normally there is no wait); if they can't be read, the page renders.
 */
export function ModuleGate({
  module,
  pageId,
  children,
}: {
  module: string;
  pageId?: ShellPageId;
  children: ReactNode;
}) {
  const { data, isPending } = useModuleStates();
  if (isPending) return null;
  const state = data ? findModule(data, module) : undefined;
  if (state && !state.enabled) return <ModuleOffPage module={state} pageId={pageId} />;
  return <>{children}</>;
}
