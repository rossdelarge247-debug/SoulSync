/**
 * Running an automation whose step moves or deletes files: it goes through
 * preview-then-confirm (SafeActionDialog over the tool's own plan,
 * core/library/action_plans.py) instead of starting straight away, whatever
 * its "Act without a preview" switch says. That switch still governs
 * scheduled runs.
 *
 * Each file step uses the flow its tool already has:
 * - Clear quarantine: the permanent-delete confirm for the quarantine.
 * - Clear quarantine + empty recycle bin: the quarantine, then the files the
 *   recycle bin's keep window lets go, one confirm each.
 * - Full Cleanup: the quarantine confirm, then the rest of the sweep.
 * - Deep Scan: the Deep Scan preview (a media-server scan moves nothing, so
 *   it just runs).
 * - Duplicate cleaner: its preview is a background scan with its own card on
 *   Maintenance, so Run now opens that card.
 */

import { useRouter } from '@tanstack/react-router';
import { useCallback, type ReactNode } from 'react';

import { useDeepScanFlow } from '@/features/safe-action/deep-scan-flow';
import { usePermanentDelete } from '@/features/safe-action/permanent-delete-flow';
import { appURL } from '@/platform/url-base';

import type { Automation } from '../-automations.types';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

function flag(config: Record<string, unknown> | null | undefined, key: string): boolean {
  const value = config?.[key];
  if (value == null) return true;
  if (typeof value === 'string')
    return !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
  return Boolean(value);
}

/** Bring a Maintenance card into view once the Tools page is up. */
export function revealToolCard(selector: string, timeoutMs = 4000): void {
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

export interface FileStepRun {
  /** Preview, then confirm, the automation's file step. */
  start: (automation: Automation) => Promise<void>;
  dialogs: ReactNode;
}

export function useFileStepRun(runAutomation: (automation: Automation) => void): FileStepRun {
  const permanent = usePermanentDelete();
  const deepScan = useDeepScanFlow({
    onStarted: () => toast('Deep Scan started. Its progress is on Maintenance.', 'info'),
  });
  const router = useRouter();
  const beginDelete = permanent.begin;
  const beginDeepScan = deepScan.begin;

  const start = useCallback(
    async (a: Automation) => {
      const config = (a.action_config ?? {}) as Record<string, unknown>;
      switch (a.action_type) {
        case 'clear_quarantine':
          await beginDelete({ kind: 'quarantine' });
          return;
        case 'library_cleanup': {
          const quarantine = flag(config, 'quarantine');
          const bin = flag(config, 'recycle_bin');
          const emptyBin = () => void beginDelete({ kind: 'recycle-bin', retention: true });
          if (quarantine && bin) {
            await beginDelete({ kind: 'quarantine' }, undefined, {
              label: 'Next: empty the recycle bin',
              run: emptyBin,
            });
          } else if (quarantine) {
            await beginDelete({ kind: 'quarantine' });
          } else if (bin) {
            emptyBin();
          } else {
            toast('Both halves of this step are switched off, so there is nothing to run.', 'info');
          }
          return;
        }
        case 'full_cleanup':
        case 'video_full_cleanup':
          await beginDelete({ kind: 'quarantine' }, undefined, {
            label: 'Run the rest of the clean-up',
            run: () => runAutomation(a),
          });
          return;
        case 'deep_scan_library': {
          const outcome = await beginDeepScan();
          if (outcome === 'no-moves') runAutomation(a);
          return;
        }
        case 'run_duplicate_cleaner':
          toast('Preview the duplicates on Maintenance. Nothing moves until you confirm.', 'info');
          await router.navigate({ href: appURL('/tools') });
          revealToolCard('#duplicate-cleaner-card');
          return;
        default:
          runAutomation(a);
      }
    },
    [beginDelete, beginDeepScan, router, runAutomation],
  );

  return {
    start,
    dialogs: (
      <>
        {permanent.dialog}
        {deepScan.dialog}
      </>
    ),
  };
}
