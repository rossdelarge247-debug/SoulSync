/**
 * The three long-running cards in "Database & Scanning" that share a
 * progress-section shape: Database Updater, Import IDs from File Tags, and
 * Duplicate Cleaner.
 *
 * Every label and threshold below is transcribed from the vanilla UI updaters
 * (`updateDbProgressUI`, `updateReconcileIdsProgressUI`,
 * `updateDuplicateCleanProgressUI`). The button text is load-bearing in the
 * vanilla — it doubles as the state machine, and one handler still branches on
 * it — so the exact strings matter.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PlanRefusal } from '@/features/safe-action/plan';
import type { SafeActionPhase } from '@/features/safe-action/safe-action-dialog';

import { Button } from '@/components/form';
import {
  deepScanCanMove,
  deepScanMoveCount,
  deepScanNeedsCheck,
} from '@/features/safe-action/deep-scan';
import {
  deepScanBlockedCopy,
  deepScanGuardMessage,
  useDeepScanFlow,
} from '@/features/safe-action/deep-scan-flow';
import {
  countLabel,
  formatBytes,
  isPlanRefusalCode,
  planExpired,
  saveTextFile,
  toCsv,
} from '@/features/safe-action/plan';
import { GuardBox, SafeActionDialog, StatusTag } from '@/features/safe-action/safe-action-dialog';
import safeStyles from '@/features/safe-action/safe-action.module.css';
import { useNow } from '@/features/safe-action/use-now';

import type {
  DatabaseStats,
  DbRefreshType,
  DbUpdateState,
  DuplicateCleanState,
  ReconcileIdsState,
} from '../-tools.types';

import {
  confirmDuplicateClean,
  fetchDatabaseStats,
  fetchDbUpdateStatus,
  fetchDuplicateCleanStatus,
  fetchDuplicatePlanItems,
  fetchReconcileIdsStatus,
  previewDuplicateClean,
  startDatabaseUpdate,
  startReconcileIds,
  stopDatabaseUpdate,
  stopDuplicateClean,
} from '../-tools.api';
import { formatFreedSpace } from '../-tools.core';
import { usePolledStatus, useSafetyPoll } from '../-tools.polling';
import { duplicateDialogContent } from './duplicate-cleaner-preview';
import { ToolCard, ToolProgress } from './tool-card';

const ACCENT_BAR = 'rgb(var(--accent-rgb))';
const ERROR_BAR = '#ff4444';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

const isRunning = (state: { status?: string }) => state.status === 'running';

// ── Database Updater ─────────────────────────────────────────────────────────

/**
 * `handleDbUpdateButtonClick` + `updateDbProgressUI` + `updateDbUpdaterCardInfo`.
 *
 * The button deliberately stays ENABLED while it reads "Starting…" so a wedged
 * start is still clickable — a second click falls through to the stop branch,
 * so there is no double-start risk (#859).
 */
export function DbUpdaterCard() {
  const [refreshType, setRefreshType] = useState<DbRefreshType>('incremental');
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [starting, setStarting] = useState(false);

  const loadStats = useCallback(async () => {
    const next = await fetchDatabaseStats();
    if (next) setStats(next);
  }, []);

  // `initializeToolsPage` hydrated these on load — without it the card renders
  // a confident 0 artists / 0.00 MB over a real library until a run finishes.
  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const poll = usePolledStatus<DbUpdateState>({
    fetcher: fetchDbUpdateStatus,
    isRunning,
    intervalMs: 1000,
    onState: (state) => {
      setStarting(false);
      // Final stats refresh once the run lands, exactly as the vanilla does.
      if (state.status === 'finished' || state.status === 'error') {
        setTimeout(() => void loadStats(), 500);
      }
    },
  });

  const safety = useSafetyPoll<DbUpdateState>(fetchDbUpdateStatus, isRunning, () =>
    setStarting(false),
  );

  // SoulSync standalone Deep Scan can move files to Staging, so it previews
  // first and only moves on a confirmed plan (#904). On a media server the
  // preview answers "moves nothing" and the ordinary confirm below runs.
  const deep = useDeepScanFlow({
    onStarted: () => {
      toast('Database update started!', 'success');
      void poll.refresh().then(() => {
        poll.arm();
        safety.arm();
      });
    },
  });

  const state = poll.state;
  const running = Boolean(state && isRunning(state));
  const standalone = stats?.server_source === 'soulsync';
  const idleLabel = refreshType === 'deep' && standalone ? 'Preview Deep Scan' : 'Update Database';
  // 'Starting…' also counts as busy for the label, but the button stays live.
  const buttonLabel = running
    ? 'Stop Update'
    : starting
      ? 'Starting...'
      : deep.previewing
        ? 'Previewing...'
        : idleLabel;

  const onClick = useCallback(async () => {
    if (buttonLabel === 'Previewing...') return;
    if (buttonLabel === 'Update Database' || buttonLabel === 'Preview Deep Scan') {
      if (refreshType === 'deep') {
        // Preview first: in standalone mode this opens the confirm on what
        // would move; only a media server ('no-moves') falls through.
        const outcome = await deep.begin();
        if (outcome !== 'no-moves') return;
      }
      if (refreshType === 'full') {
        const ok = await window.showConfirmDialog?.({
          title: 'Full Refresh',
          message:
            'This will clear and rebuild the database for the active server. It can take a long time.\n\nAre you sure you want to proceed?',
          confirmText: 'Proceed',
        });
        if (!ok) return;
      } else if (refreshType === 'deep') {
        const ok = await window.showConfirmDialog?.({
          title: 'Deep Scan',
          message:
            'A deep scan re-checks every track in your media server library against the database.\n\n• Adds any new tracks that were missed\n• Removes tracks no longer on your server\n• Preserves all existing metadata and enrichment data\n\nThis may take a while for large libraries. Proceed?',
          confirmText: 'Proceed',
        });
        if (!ok) return;
      }
      setStarting(true);
      try {
        const result = await startDatabaseUpdate(refreshType);
        if (!result.ok) {
          setStarting(false);
          toast(`Error: ${result.error}`, 'error');
          return;
        }
        toast('Database update started!', 'success');
        await poll.refresh();
        poll.arm();
        safety.arm();
      } catch {
        // A network failure must restore the button, not strand it on
        // "Starting…" behind an unhandled rejection.
        setStarting(false);
        toast('Failed to start update process.', 'error');
      }
      return;
    }
    // "Stop Update" — and the "Starting…" fall-through that makes a wedged
    // start cancellable.
    try {
      const ok = await stopDatabaseUpdate();
      toast(ok ? 'Stop request sent.' : 'Failed to send stop request.', ok ? 'info' : 'error');
    } catch {
      toast('Error sending stop request.', 'error');
    }
  }, [buttonLabel, deep, poll, refreshType, safety]);

  const deepPreview = refreshType === 'deep' && !running ? deep.preview : null;
  const now = useNow(Boolean(deepPreview));
  const deepStale = Boolean(
    deepPreview && deepScanCanMove(deepPreview) && planExpired(deepPreview, now),
  );
  const lastMoves =
    refreshType === 'deep' && !running && !deepPreview ? state?.deep_scan_moves : null;

  const processed = state?.processed ?? 0;
  const total = state?.total ?? 0;
  const percent = state?.progress ?? 0;

  let phase = 'Idle';
  // Matches the markup's initial text until the first status lands; the vanilla
  // only blanks this once its `else` branch runs.
  let details = state ? '' : '0 / 0 artists (0.0%)';
  let barPercent = 0;
  let barColor: string | undefined;

  if (running) {
    phase = state?.phase || 'Processing...';
    // The unit comes from the backend: "artists" while the scan walks the
    // library, "tracks" while the post-scan reconcile reads file tags.
    const unit = state?.unit || 'artists';
    details = `${processed} / ${total} ${unit} (${percent.toFixed(1)}%)`;
    barPercent = percent;
  } else if (state?.status === 'error') {
    phase = `Error: ${state.error_message}`;
    barColor = ERROR_BAR;
  } else if (state) {
    phase = state.phase || 'Idle';
    barColor = ACCENT_BAR;
    // finished keeps a full bar; every other terminal state clears it, so a
    // completed run doesn't leave a frozen partial bar behind (#859).
    if (state.status === 'finished') barPercent = 100;
  }

  const serverName = stats?.server_source
    ? stats.server_source.charAt(0).toUpperCase() + stats.server_source.slice(1)
    : null;

  return (
    <ToolCard
      id="db-updater-card"
      title={serverName ? `${serverName} Database Updater` : 'Database Updater'}
      helpTool="db-updater"
      info={
        <>
          Last Full Refresh:{' '}
          <span id="db-last-refresh">
            {/* Naive LOCAL time from `datetime.now()` — parsed as local, which
                is already correct. Do NOT normalise this one to UTC. */}
            {stats?.last_full_refresh
              ? new Date(stats.last_full_refresh).toLocaleString()
              : 'Never'}
          </span>
        </>
      }
      stats={[
        {
          label: 'Artists:',
          valueId: 'db-stat-artists',
          value: (stats?.artists ?? 0).toLocaleString(),
        },
        {
          label: 'Albums:',
          valueId: 'db-stat-albums',
          value: (stats?.albums ?? 0).toLocaleString(),
        },
        {
          label: 'Tracks:',
          valueId: 'db-stat-tracks',
          value: (stats?.tracks ?? 0).toLocaleString(),
        },
        {
          label: 'Size:',
          valueId: 'db-stat-size',
          value: `${(stats?.database_size_mb ?? 0).toFixed(2)} MB`,
        },
      ]}
      controls={
        <>
          <select
            id="db-refresh-type"
            value={refreshType}
            disabled={running}
            onChange={(event) => setRefreshType(event.target.value as DbRefreshType)}
          >
            <option value="incremental">Incremental Update</option>
            <option value="full">Full Refresh</option>
            <option value="deep">Deep Scan</option>
          </select>
          <button
            type="button"
            id="db-update-button"
            disabled={buttonLabel === 'Previewing...'}
            onClick={() => void onClick()}
          >
            {buttonLabel}
          </button>
        </>
      }
      progress={
        <ToolProgress
          phase={phase}
          details={details}
          percent={barPercent}
          barColor={barColor}
          phaseId="db-phase-label"
          barId="db-progress-bar"
          detailsId="db-progress-label"
        />
      }
    >
      {deepPreview ? (
        <div className={safeStyles.panel} data-testid="deep-scan-preview-state">
          {deepStale ? (
            <>
              <StatusTag>Preview out of date</StatusTag>
              <p className={safeStyles.note}>
                A preview works for 15 minutes. Preview again so you confirm what&apos;s on disk
                now.
              </p>
            </>
          ) : deepScanNeedsCheck(deepPreview) ? (
            <GuardBox
              message={deepScanGuardMessage(deepPreview)}
              checked={deep.largeOk}
              onChange={deep.setLargeOk}
            >
              <Button size="lg" onClick={deep.openReview}>
                See the {countLabel(deepScanMoveCount(deepPreview), 'file')}
              </Button>
              <Button
                size="lg"
                variant="primary"
                disabled={!deep.largeOk}
                onClick={() => void deep.confirmMove()}
              >
                Move {countLabel(deepScanMoveCount(deepPreview), 'file')}
              </Button>
            </GuardBox>
          ) : deepScanCanMove(deepPreview) ? (
            <>
              <StatusTag tone="info">
                Preview ready · {countLabel(deepScanMoveCount(deepPreview), 'file')}
              </StatusTag>
              <p className={safeStyles.note}>
                {countLabel(deepScanMoveCount(deepPreview), 'file')} (
                {formatBytes(deepPreview.total_bytes)}) would move to Staging. Nothing has moved
                yet.
              </p>
              <div className={safeStyles.actions}>
                <Button size="lg" variant="primary" onClick={deep.openReview}>
                  Review preview
                </Button>
              </div>
            </>
          ) : deepPreview.mode === 'blocked' ? (
            <>
              <StatusTag tone="warning">Nothing will move</StatusTag>
              <p className={safeStyles.note}>{deepScanBlockedCopy(deepPreview)}</p>
            </>
          ) : (
            <StatusTag tone="success">Nothing to move</StatusTag>
          )}
        </div>
      ) : lastMoves?.mode === 'moved' ? (
        <div className={safeStyles.panel}>
          <StatusTag tone="success">
            Last deep scan moved {countLabel(lastMoves.moved ?? 0, 'file')} to Staging
          </StatusTag>
        </div>
      ) : lastMoves?.mode === 'preview' && (lastMoves.would_move ?? 0) > 0 ? (
        <div className={safeStyles.panel}>
          <StatusTag>
            Last deep scan moved nothing · {countLabel(lastMoves.would_move ?? 0, 'file')} could
            move
          </StatusTag>
          <p className={safeStyles.note}>Preview the deep scan to review and move them.</p>
        </div>
      ) : null}
      {deep.dialog}
    </ToolCard>
  );
}

// ── Import IDs from File Tags ────────────────────────────────────────────────

/** `handleReconcileIdsButtonClick` + `updateReconcileIdsProgressUI`. */
export function ReconcileIdsCard() {
  // The vanilla has THREE button states, not two: 'Scan Library' ->
  // 'Starting...' (set on click) -> 'Scanning…' (set by the UI updater once the
  // status says running). Collapsing the middle one loses the feedback between
  // the click and the first status.
  const [starting, setStarting] = useState(false);
  // The completion toast fires only if we SAW the run in progress — otherwise
  // simply opening the page after a finished scan would announce it again.
  const wasRunningRef = useRef(false);
  const [justFinished, setJustFinished] = useState(false);

  const poll = usePolledStatus<ReconcileIdsState>({
    fetcher: fetchReconcileIdsStatus,
    isRunning,
    intervalMs: 1500,
    onState: (state) => {
      setStarting(false);
      if (isRunning(state)) {
        wasRunningRef.current = true;
        return;
      }
      if (state.status === 'done' && wasRunningRef.current && !justFinished) {
        setJustFinished(true);
        toast(
          `Tag import complete — ${state.ids_filled} IDs filled` +
            (state.conflicts ? `, ${state.conflicts} conflicts skipped` : ''),
          'success',
        );
      }
    },
  });

  const state = poll.state;
  const running = Boolean(state && isRunning(state));

  const onClick = useCallback(async () => {
    // The vanilla guards on the button text; the equivalent here is the busy
    // flag, which covers the same "already running" case.
    if (running || starting) return;
    const ok = await window.showConfirmDialog?.({
      title: 'Import IDs from File Tags',
      message:
        'Scan every library file for embedded provider IDs and fill any that are missing in the database?\n\nEach file is read once. Existing matches are never overwritten. This can take a while on large libraries.',
      confirmText: 'Scan Library',
    });
    if (!ok) return;
    setStarting(true);
    try {
      const result = await startReconcileIds();
      if (!result.ok) {
        setStarting(false);
        toast(`Error: ${result.error}`, 'error');
        return;
      }
      toast('Tag import started!', 'success');
      setJustFinished(false);
      await poll.refresh();
      poll.arm();
    } catch {
      setStarting(false);
      toast('Failed to start tag import.', 'error');
    }
  }, [poll, running, starting]);

  const processed = state?.processed ?? 0;
  const total = state?.total ?? 0;
  const percent = total > 0 ? (processed / total) * 100 : 0;

  let phase = 'Ready to scan';
  let details = '0 / 0 files scanned (0.0%)';
  let barPercent = 0;

  if (running) {
    phase = state?.current ? `Scanning: ${state.current}` : 'Scanning…';
    details = `${processed} / ${total} files scanned (${percent.toFixed(1)}%)`;
    barPercent = percent;
  } else if (state?.status === 'done') {
    const filled = state.ids_filled ?? 0;
    const updated = state.entities_updated ?? 0;
    phase = `Done — filled ${filled} ID${filled === 1 ? '' : 's'} across ${updated} row${updated === 1 ? '' : 's'}`;
    details = `${processed} / ${total} files scanned (100%)`;
    barPercent = 100;
  }

  return (
    <ToolCard
      id="reconcile-ids-card"
      title="Import IDs from File Tags"
      helpTool="reconcile-ids"
      info={
        <>
          Read provider IDs (Spotify, MusicBrainz, iTunes, Deezer&hellip;) already embedded in your
          files and fill them into the database &mdash; lets enrichment workers skip redundant API
          lookups. Only fills blanks; never overwrites an existing match.
        </>
      }
      stats={[
        { label: 'IDs Filled:', valueId: 'reconcile-stat-filled', value: state?.ids_filled ?? 0 },
        {
          label: 'Rows Updated:',
          valueId: 'reconcile-stat-updated',
          value: state?.entities_updated ?? 0,
        },
        { label: 'Conflicts:', valueId: 'reconcile-stat-conflicts', value: state?.conflicts ?? 0 },
        {
          label: 'Unreadable:',
          valueId: 'reconcile-stat-unreadable',
          value: state?.unreadable ?? 0,
        },
      ]}
      controls={
        <button
          type="button"
          id="reconcile-ids-button"
          disabled={running || starting}
          onClick={() => void onClick()}
        >
          {running ? 'Scanning…' : starting ? 'Starting...' : 'Scan Library'}
        </button>
      }
      progress={
        <ToolProgress
          phase={phase}
          details={details}
          percent={barPercent}
          barColor={running ? undefined : ACCENT_BAR}
          phaseId="reconcile-phase-label"
          barId="reconcile-progress-bar"
          detailsId="reconcile-progress-label"
        />
      }
    />
  );
}

// ── Duplicate Cleaner ────────────────────────────────────────────────────────

/**
 * Preview, then confirm (#1210: the cleaner once removed the only copy of a
 * song). The card's button only ever PREVIEWS: the backend scans and records a
 * plan of every file it would move to the recycle bin and which copy it keeps.
 * The card then says "Preview ready", and the dialog shows the plan and only
 * moves files when its own button, named for the move, sends the plan id
 * back. An automation in preview mode leaves a plan here too.
 */
export function DuplicateCleanerCard() {
  const [starting, setStarting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // a confirmed run started from the dialog, which then reports on it
  const [watchingApply, setWatchingApply] = useState(false);
  const [refusal, setRefusal] = useState<PlanRefusal | null>(null);
  const [listBusy, setListBusy] = useState(false);
  // a preview the backend refused (used, expired, SoulSync restarted): the
  // status still names it, but it must not read as ready any more
  const [deadPlanId, setDeadPlanId] = useState<string | null>(null);
  // toasts only for a run this card SAW running, so opening the page after a
  // finished preview or clean-up doesn't announce it all over again
  const sawRunningRef = useRef(false);

  const poll = usePolledStatus<DuplicateCleanState>({
    fetcher: fetchDuplicateCleanStatus,
    isRunning,
    intervalMs: 1000,
    onState: (state) => {
      setStarting(false);
      if (isRunning(state)) {
        sawRunningRef.current = true;
        return;
      }
      if (!sawRunningRef.current) return;
      sawRunningRef.current = false;
      if (state.status !== 'finished') return;
      if (state.mode === 'apply') {
        // The toast uses ONE decimal for MB; the stat row uses two.
        const freed = formatFreedSpace(state.space_freed_mb || 0, 1);
        toast(
          `Moved ${countLabel(state.deleted ?? 0, 'file')} to the recycle bin, ${freed} freed`,
          'success',
        );
      } else if (state.plan_id) {
        const found = state.plan?.total ?? state.duplicates_found ?? 0;
        toast(
          found
            ? `Preview ready: ${countLabel(found, 'duplicate file')} found. Nothing was moved.`
            : 'Preview ready: no duplicates found.',
          'success',
        );
      }
    },
  });

  const state = poll.state;
  const running = Boolean(state && isRunning(state));
  const finished = Boolean(state && !running && state.status === 'finished');
  const plan =
    finished && state?.mode === 'plan' && state.plan_id && state.plan ? state.plan : null;
  const planId = plan ? (state?.plan_id ?? null) : null;
  const now = useNow(Boolean(plan));
  const planStale = Boolean(
    plan && plan.total > 0 && (planExpired(plan, now) || planId === deadPlanId),
  );
  const planReady = Boolean(plan && plan.total > 0 && !planStale);
  const applied = finished && state?.mode === 'apply';
  const planRefused = state?.status === 'error' && isPlanRefusalCode(state.error_code);

  const preview = useCallback(async () => {
    setDialogOpen(false);
    setRefusal(null);
    setWatchingApply(false);
    setStarting(true);
    try {
      const result = await previewDuplicateClean();
      if (!result.ok) {
        setStarting(false);
        toast(`Error: ${result.error}`, 'error');
        return;
      }
      toast('Previewing duplicates. Nothing will move until you confirm.', 'info');
      await poll.refresh();
      poll.arm();
    } catch {
      setStarting(false);
      toast('Failed to start duplicate cleaner.', 'error');
    }
  }, [poll]);

  const onClick = useCallback(async () => {
    if (running) {
      try {
        const ok = await stopDuplicateClean();
        toast(ok ? 'Stop request sent.' : 'Failed to send stop request.', ok ? 'info' : 'error');
      } catch {
        toast('Error sending stop request.', 'error');
      }
      return;
    }
    await preview();
  }, [preview, running]);

  const openReview = useCallback(() => {
    setRefusal(null);
    setWatchingApply(false);
    setDialogOpen(true);
  }, []);

  const confirm = useCallback(async () => {
    if (!planId) return;
    setConfirming(true);
    try {
      const result = await confirmDuplicateClean(planId);
      if (!result.ok) {
        setRefusal(result.refusal);
        if (result.refusal.previewAgain) setDeadPlanId(planId);
        return;
      }
      setWatchingApply(true);
      sawRunningRef.current = true;
      await poll.refresh();
      poll.arm();
    } catch {
      setRefusal({ code: '', message: 'Could not start the clean-up.', previewAgain: false });
    } finally {
      setConfirming(false);
    }
  }, [planId, poll]);

  const downloadList = useCallback(async () => {
    if (!planId) return;
    setListBusy(true);
    try {
      const items = await fetchDuplicatePlanItems(planId);
      const csv = toCsv([
        ['Moves to the recycle bin', 'Copy kept', 'Size (bytes)', 'Reason'],
        ...items.map((item) => [item.path, item.keep ?? '', item.size ?? '', item.reason ?? '']),
      ]);
      if (!saveTextFile('duplicate-cleaner-preview.csv', csv)) {
        toast('Could not save the list.', 'error');
      }
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setListBusy(false);
    }
  }, [planId]);

  const percent = state?.progress ?? 0;

  let phase = 'Ready to preview';
  let details = '0 files scanned (0.0%)';
  let barPercent = 0;
  let barColor: string | undefined;

  if (running) {
    phase = state?.phase || 'Scanning...';
    details =
      state?.mode === 'apply'
        ? `${state?.deleted ?? 0} / ${state?.duplicates_found ?? 0} files moved to the recycle bin`
        : `${state?.files_scanned ?? 0} / ${state?.total_files ?? 0} files scanned (${percent.toFixed(1)}%)`;
    barPercent = percent;
  } else if (state?.status === 'error') {
    phase = `Error: ${state.error_message}`;
    barColor = ERROR_BAR;
  } else if (state) {
    phase = state.phase || 'Ready to preview';
    barColor = ACCENT_BAR;
    if (state.status === 'finished') details = `${state.files_scanned ?? 0} files scanned`;
  }

  let buttonLabel = planReady || plan || applied ? 'Preview Again' : 'Preview Duplicates';
  if (running) buttonLabel = state?.mode === 'apply' ? 'Stop Cleaning' : 'Stop Preview';
  else if (starting) buttonLabel = 'Starting...';

  // What the dialog shows: a refusal, the confirmed run, or the plan itself.
  let dialogPhase: SafeActionPhase = { kind: 'review' };
  if (refusal) {
    dialogPhase = { kind: 'refused', message: refusal.message, previewAgain: refusal.previewAgain };
  } else if (watchingApply && planRefused) {
    dialogPhase = {
      kind: 'refused',
      message: state?.error_message || 'That preview could no longer be used.',
      previewAgain: true,
    };
  } else if (watchingApply && state?.status === 'error') {
    dialogPhase = {
      kind: 'done',
      tone: 'warning',
      title: 'The clean-up stopped',
      body: state.error_message || 'The clean-up stopped before it finished.',
    };
  } else if (watchingApply && applied) {
    const moved = state?.deleted ?? 0;
    const refused = state?.refused ?? 0;
    const skipped = state?.skipped ?? 0;
    dialogPhase = {
      kind: 'done',
      title: `Moved ${countLabel(moved, 'file')} to the recycle bin`,
      body: (
        <>
          {formatFreedSpace(state?.space_freed_mb ?? 0, 1)} freed. Nothing was deleted: you can put
          any of them back from the recycle bin (Downloads, Review, Deleted).
          {refused
            ? ` ${countLabel(refused, 'file')} stayed because the copy to keep could not be checked.`
            : ''}
          {skipped
            ? ` ${countLabel(skipped, 'file')} had changed since the preview and stayed.`
            : ''}
        </>
      ),
      extra: {
        label: 'Open Downloads',
        onClick: () => {
          setDialogOpen(false);
          void window.navigateToPage?.('active-downloads');
        },
      },
    };
  } else if (watchingApply) {
    dialogPhase = {
      kind: 'working',
      message: `Moving ${countLabel(state?.duplicates_found ?? plan?.total ?? 0, 'file')} to the recycle bin… ${state?.deleted ?? 0} done.`,
    };
  }

  const dialogContent = plan
    ? duplicateDialogContent(plan, {
        busy: confirming,
        listBusy,
        onConfirm: () => void confirm(),
        onDownload: () => void downloadList(),
      })
    : { title: 'Duplicate Cleaner' };

  return (
    <ToolCard
      id="duplicate-cleaner-card"
      title="Duplicate Cleaner"
      helpTool="duplicate-cleaner"
      info="Finds the same track saved in more than one format in your output folder, keeps the best copy and moves the others to the recycle bin."
      stats={[
        {
          label: 'Files Scanned:',
          valueId: 'duplicate-stat-scanned',
          value: state?.files_scanned ?? 0,
        },
        {
          label: 'Duplicates Found:',
          valueId: 'duplicate-stat-found',
          value: state?.duplicates_found ?? 0,
        },
        { label: 'Moved to Bin:', valueId: 'duplicate-stat-deleted', value: state?.deleted ?? 0 },
        {
          label: 'Space Freed:',
          valueId: 'duplicate-stat-space',
          value: formatFreedSpace(state?.space_freed_mb ?? 0, 2),
        },
      ]}
      controls={
        <button
          type="button"
          id="duplicate-clean-button"
          disabled={starting}
          onClick={() => void onClick()}
        >
          {buttonLabel}
        </button>
      }
      progress={
        <ToolProgress
          phase={phase}
          details={details}
          percent={barPercent}
          barColor={barColor}
          phaseId="duplicate-phase-label"
          barId="duplicate-progress-bar"
          detailsId="duplicate-progress-label"
        />
      }
    >
      {running ? null : (
        <div className={safeStyles.panel} data-testid="duplicate-preview-state">
          {planReady && plan ? (
            <>
              <StatusTag tone="info">Preview ready · {countLabel(plan.total, 'file')}</StatusTag>
              <div className={safeStyles.actions}>
                <Button variant="primary" size="lg" onClick={openReview}>
                  Review preview
                </Button>
              </div>
            </>
          ) : planStale ? (
            <>
              <StatusTag>Preview out of date</StatusTag>
              <p className={safeStyles.note}>
                A preview works for 15 minutes and only once. Preview again so you confirm
                what&apos;s on disk now.
              </p>
            </>
          ) : plan ? (
            <StatusTag tone="success">No duplicates found</StatusTag>
          ) : applied ? (
            <>
              <StatusTag tone="success">
                Done · moved {countLabel(state?.deleted ?? 0, 'file')}
              </StatusTag>
              {state?.refused ? (
                <p className={safeStyles.note}>
                  {countLabel(state.refused, 'file')} stayed because the copy to keep could not be
                  checked.
                </p>
              ) : null}
            </>
          ) : planRefused ? (
            <>
              <StatusTag tone="warning">Preview no longer usable</StatusTag>
              <p className={safeStyles.note}>{state?.error_message}</p>
            </>
          ) : (
            <StatusTag>No preview yet</StatusTag>
          )}
        </div>
      )}
      <SafeActionDialog
        open={dialogOpen && (Boolean(plan) || dialogPhase.kind !== 'review')}
        onClose={() => {
          setDialogOpen(false);
          setRefusal(null);
          setWatchingApply(false);
        }}
        phase={dialogPhase}
        onPreviewAgain={() => void preview()}
        {...dialogContent}
      />
    </ToolCard>
  );
}
