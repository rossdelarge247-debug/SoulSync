/**
 * Move your music to another drive: the flow's host and controller.
 *
 * Opened from Settings → Library → Folders' "Move to another drive…",
 * Maintenance's tool row, Home's reminder, Activity's row and the /move link
 * (the phone's Docker step hands that to the computer). The move's state is
 * the server's (GET /api/drives/move): the view follows its status, and the
 * draft's sub-step follows what's done (checks, plan), so a reload, a second
 * device or SYNCHRO.S restarting opens it in the same place.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';

import { Notice } from '@/components/primitives';

import type { Move, MovePayload } from './drives.api';

import { DockerStep } from './docker-step';
import { drivesApi, DrivesError } from './drives.api';
import { CopyStep, DoneStep, EndView, FailureView, SwitchStep } from './move-run';
import { FlowShell } from './move-shell';
import { CheckStep, ChooseStep, PlanStep } from './move-steps';
import styles from './move.module.css';

type DraftView = 'choose' | 'docker' | 'check' | 'plan';

interface MoveFlowStore {
  open: boolean;
  view: DraftView | null;
  begin: (view?: DraftView) => void;
  close: () => void;
}

export const useMoveFlow = create<MoveFlowStore>((set) => ({
  open: false,
  view: null,
  begin: (view) => set({ open: true, view: view ?? null }),
  close: () => set({ open: false, view: null }),
}));

const VIEW_KEY = 'soulsync.driveMove.view';

function rememberView(view: DraftView | null): void {
  try {
    if (view) sessionStorage.setItem(VIEW_KEY, view);
    else sessionStorage.removeItem(VIEW_KEY);
  } catch {
    /* private window: the flow still starts from what the server says */
  }
}

function rememberedView(): DraftView | null {
  try {
    const v = sessionStorage.getItem(VIEW_KEY);
    return v === 'choose' || v === 'docker' || v === 'check' || v === 'plan' ? v : null;
  } catch {
    return null;
  }
}

/** The draft's step from what the server holds. */
export function draftView(move: Move, asked: DraftView | null): DraftView {
  if (asked === 'docker' || asked === 'choose') return asked;
  if (asked === 'plan' && move.plan) return 'plan';
  if (asked === 'check' && move.checks) return 'check';
  if (move.plan) return 'plan';
  if (move.checks) return 'check';
  return 'choose';
}

/** Keep the legacy Settings page's folder fields in step with a switch, so
 *  its next save doesn't carry the old paths. */
function syncLegacyFolders(move: Move, which: 'dests' | 'sources'): void {
  const plan = move.plan;
  if (!plan) return;
  const ids: Record<string, string> = {
    library: 'transfer-path',
    downloads: 'download-path',
    staging: 'staging-path',
  };
  for (const [role, path] of Object.entries(plan[which])) {
    const input = document.getElementById(ids[role]) as HTMLInputElement | null;
    if (input && path) input.value = path;
  }
}

function isPhone(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches === true
  );
}

export function MoveFlow() {
  const open = useMoveFlow((s) => s.open);
  const asked = useMoveFlow((s) => s.view);
  const close = useMoveFlow((s) => s.close);
  const [payload, setPayload] = useState<MovePayload | null>(null);
  const [view, setView] = useState<DraftView | null>(asked ?? rememberedView());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const lastStatus = useRef<string | null>(null);

  const accept = useCallback((next: MovePayload) => {
    setPayload((prev) => ({ ...next, overview: next.overview ?? prev?.overview }));
    const move = next.move;
    if (move && lastStatus.current !== move.status) {
      if (move.status === 'switched' && lastStatus.current && lastStatus.current !== 'switched')
        syncLegacyFolders(move, 'dests');
      if (move.status === 'switched_back') syncLegacyFolders(move, 'sources');
      lastStatus.current = move.status;
    }
  }, []);

  // open: the move there is, or a new draft
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoadError(null);
    void (async () => {
      try {
        let got = await drivesApi.move();
        if (!got.move || ['stopped', 'removed', 'switched_back'].includes(got.move.status)) {
          if (!got.move || asked) got = await drivesApi.draft();
        }
        if (live) accept(got);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : 'SYNCHRO.S didn’t answer.');
      }
    })();
    return () => {
      live = false;
    };
  }, [open, asked, accept]);

  useEffect(() => {
    if (asked) setView(asked);
  }, [asked]);

  useEffect(() => rememberView(view), [view]);

  // while it runs on the server, read it every 1.5 s
  const status = payload?.move?.status;
  useEffect(() => {
    if (!open || !status || !['copying', 'verifying', 'switching'].includes(status)) return;
    const t = setInterval(() => {
      void drivesApi.move().then(accept, () => undefined);
    }, 1500);
    return () => clearInterval(t);
  }, [open, status, accept]);

  const act = useCallback(
    async (fn: () => Promise<MovePayload>) => {
      setBusy(true);
      setError(null);
      try {
        accept(await fn());
        return true;
      } catch (e) {
        setError(
          e instanceof DrivesError || e instanceof Error ? e.message : 'That didn’t go through.',
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [accept],
  );

  const shut = useCallback(() => {
    rememberView(null);
    setView(null);
    setPayload(null);
    lastStatus.current = null;
    close();
  }, [close]);

  const leave = useCallback(() => {
    const move = payload?.move;
    if (move && move.status === 'draft') void drivesApi.leave(move.id).catch(() => undefined);
    shut();
  }, [payload, shut]);

  const done = useCallback(() => {
    shut();
    void window.navigateToPage?.('settings');
  }, [shut]);

  if (!open) return null;
  const move = payload?.move;
  if (!payload || !move) {
    return (
      <FlowShell
        step={null}
        promise={{ tone: 'success', words: 'Nothing has changed yet' }}
        leaveLabel="Leave"
        onLeave={shut}
      >
        {loadError ? (
          <Notice tone="danger" title="SYNCHRO.S didn’t answer" role="alert">
            <p>{loadError} Nothing has changed. Try again in a moment.</p>
          </Notice>
        ) : (
          <p className={styles.note} role="status">
            Loading…
          </p>
        )}
      </FlowShell>
    );
  }

  const run = { payload, move, busy, error, act, close: shut, done };
  switch (move.status) {
    case 'copying':
      return <CopyStep {...run} />;
    case 'verifying':
    case 'switching':
      return <SwitchStep {...run} />;
    case 'switched':
    case 'removed':
      return <DoneStep {...run} />;
    case 'failed':
      return <FailureView {...run} />;
    case 'stopped':
    case 'switched_back':
      return <EndView {...run} />;
    default:
      break;
  }
  const step = { payload, move, busy, error, act, leave, go: (v: DraftView) => setView(v) };
  const current = draftView(move, view);
  if (current === 'docker') {
    return (
      <DockerStep
        promise={move.promise}
        onBack={() => {
          setView('choose');
          // the drives may be visible now: read them again
          void drivesApi.move().then(accept, () => undefined);
        }}
        onLeave={leave}
        phone={isPhone()}
      />
    );
  }
  if (current === 'check') return <CheckStep {...step} />;
  if (current === 'plan') return <PlanStep {...step} />;
  return <ChooseStep {...step} />;
}

declare global {
  interface Window {
    openDriveMove?: (view?: DraftView) => void;
  }
}

const HOST_ID = 'soulsync-drive-move-root';

export function openDriveMove(view?: DraftView): void {
  useMoveFlow.getState().begin(view);
}

export function mountDriveMoveHost(): void {
  if (typeof document === 'undefined' || document.getElementById(HOST_ID)) return;
  const el = document.createElement('div');
  el.id = HOST_ID;
  document.body.appendChild(el);
  createRoot(el).render(<MoveFlow />);
  window.openDriveMove = openDriveMove;
}
