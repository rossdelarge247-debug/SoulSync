/**
 * Deep Scan's preview → confirm flow, shared by the Tools page's Database
 * Updater card and the Dashboard's library menu.
 *
 * `begin()` asks the backend what a deep scan would move. On a media server
 * nothing moves, so it answers 'no-moves' and the caller keeps its ordinary
 * "this may take a while" confirm. In SoulSync standalone mode it opens the
 * confirm dialog on the preview:
 *
 * - files to move     → counts, a sample (file → Staging), the expiry, and
 *                       "Move N files", which sends the plan id
 * - a ratio / empty-database guard tripped → the same, plus a warning and a
 *                       checkbox that must be ticked before "Move N files"
 *                       works; the confirm then also sends confirm_large_move
 * - a hard block (permanent library, desync) or nothing to move → says so,
 *                       and offers the scan alone, which moves nothing
 *
 * A refused confirm (used / expired / unknown preview) shows the backend's
 * message and "Preview again".
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import type { SafeActionPhase, SafeActionRow } from './safe-action-dialog';

import {
  type DeepScanItem,
  type DeepScanPreview,
  deepScanCanMove,
  deepScanMoveCount,
  deepScanNeedsCheck,
  fetchDeepScanPlanItems,
  fetchDeepScanPreview,
  stagingRelative,
  startDeepScan,
} from './deep-scan';
import { baseName, countLabel, folderTail, formatBytes, saveTextFile, toCsv } from './plan';
import { SafeActionDialog } from './safe-action-dialog';
import styles from './safe-action.module.css';

function toast(message: string, type = 'info') {
  window.showToast?.(message, type);
}

const STATUS_POLL_MS = 2000;

/** The warning a confirmable guard shows, from the preview's own numbers. */
export function deepScanGuardMessage(preview: DeepScanPreview): ReactNode {
  const n = deepScanMoveCount(preview);
  const files = countLabel(n, 'file');
  if (preview.block_reason === 'empty_database') {
    return (
      <>
        <strong>
          SoulSync&apos;s database has no tracks, so all {files} in your music folder look new.
        </strong>{' '}
        That usually means the database was reset or a drive was missing, not that you added {files}
        . It won&apos;t run unless you confirm.
      </>
    );
  }
  const pct = Math.round(preview.untracked_percent ?? 0);
  const limit = preview.max_move_percent;
  return (
    <>
      <strong>
        This would move {files}, {pct}% of your library.
      </strong>{' '}
      {typeof limit === 'number'
        ? `That's more than the ${limit}% safety limit, which usually means a folder or drive is missing rather than ${countLabel(n, 'new file')}.`
        : `That's more than Deep Scan moves in one run without a check, which usually means a folder or drive is missing rather than ${countLabel(n, 'new file')}.`}{' '}
      It won&apos;t run unless you confirm.
    </>
  );
}

/** Why nothing will move, for the blocks no checkbox can lift. */
export function deepScanBlockedCopy(preview: DeepScanPreview): string {
  const n = preview.untracked ?? deepScanMoveCount(preview);
  const files = countLabel(n, 'file');
  if (preview.block_reason === 'transfer_permanent') {
    return (
      `${files} in your music folder ${n === 1 ? "isn't" : "aren't"} in the database. Your music folder ` +
      'is set as your permanent library (Settings: "Music Library is my permanent library"), so Deep ' +
      'Scan leaves them where they are.'
    );
  }
  if (preview.block_reason === 'desync') {
    const pct = Math.round(preview.untracked_percent ?? 0);
    return (
      `${files} of ${(preview.library_files ?? 0).toLocaleString()} (${pct}%) aren't in the ` +
      "database. That usually means the database is out of sync with the disk, so Deep Scan won't " +
      'move anything. Re-sync or import before you scan again.'
    );
  }
  return preview.message || "Deep Scan won't move any files this time.";
}

function sampleRows(preview: DeepScanPreview, withDest: boolean): SafeActionRow[] {
  return (preview.sample ?? []).map((item: DeepScanItem, index) => {
    const file = (
      <div key="file">
        <div className={styles.primaryCell}>{baseName(item.path)}</div>
        <div className={styles.secondary}>{folderTail(item.path)}</div>
      </div>
    );
    return {
      key: `${item.path}-${index}`,
      cells: withDest
        ? [file, <span key="dest">{stagingRelative(item.dest, preview.staging_path)}</span>]
        : [file],
    };
  });
}

export interface DeepScanFlow {
  /** Preview the scan. 'no-moves' (media server): run your ordinary confirm. */
  begin: () => Promise<'no-moves' | 'preview' | 'error'>;
  previewing: boolean;
  /** The latest standalone preview, kept after the dialog closes. */
  preview: DeepScanPreview | null;
  largeOk: boolean;
  setLargeOk: (checked: boolean) => void;
  /** Reopen the dialog on the current preview. */
  openReview: () => void;
  confirmMove: () => Promise<void>;
  scanOnly: () => Promise<void>;
  /** Forget the current preview (a scan started some other way). */
  clear: () => void;
  dialog: ReactNode;
}

export function useDeepScanFlow({ onStarted }: { onStarted?: () => void } = {}): DeepScanFlow {
  const [preview, setPreview] = useState<DeepScanPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<SafeActionPhase>({ kind: 'review' });
  const [largeOk, setLargeOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const confirmedCount = useRef(0);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  const begin = useCallback(async () => {
    setPreviewing(true);
    try {
      const result = await fetchDeepScanPreview();
      if (result.kind === 'error') {
        toast(result.message, 'error');
        return 'error' as const;
      }
      if (result.kind === 'no-moves') return 'no-moves' as const;
      setPreview(result.preview);
      setLargeOk(false);
      setPhase({ kind: 'review' });
      setOpen(true);
      return 'preview' as const;
    } finally {
      setPreviewing(false);
    }
  }, []);

  const openReview = useCallback(() => {
    if (!preview) return;
    setPhase({ kind: 'review' });
    setOpen(true);
  }, [preview]);

  const confirmMove = useCallback(async () => {
    if (!preview || !deepScanCanMove(preview)) return;
    if (deepScanNeedsCheck(preview) && !largeOk) return;
    setBusy(true);
    setOpen(true);
    try {
      const result = await startDeepScan({
        planId: preview.plan_id,
        confirmLargeMove: deepScanNeedsCheck(preview) && largeOk,
      });
      if (!result.ok) {
        setPhase({
          kind: 'refused',
          message: result.refusal.message,
          previewAgain: result.refusal.previewAgain,
        });
        if (result.refusal.previewAgain) setPreview(null);
        return;
      }
      confirmedCount.current = deepScanMoveCount(preview);
      // spent by this run: the card must not offer it again
      setPreview(null);
      setPhase({
        kind: 'working',
        message: `Moving ${countLabel(confirmedCount.current, 'file')} to Staging, then checking every track…`,
      });
      onStartedRef.current?.();
    } finally {
      setBusy(false);
    }
  }, [largeOk, preview]);

  const scanOnly = useCallback(async () => {
    setBusy(true);
    try {
      const result = await startDeepScan();
      if (!result.ok) {
        toast(`Error: ${result.refusal.message}`, 'error');
        return;
      }
      setOpen(false);
      setPreview(null);
      onStartedRef.current?.();
    } finally {
      setBusy(false);
    }
  }, []);

  const downloadList = useCallback(async () => {
    const planId = preview?.plan_id;
    if (!planId) return;
    setListBusy(true);
    try {
      const items = await fetchDeepScanPlanItems(planId);
      const csv = toCsv([
        ['File', 'Moves to', 'Size (bytes)', 'Reason'],
        ...items.map((item) => [item.path, item.dest ?? '', item.size ?? '', item.reason ?? '']),
      ]);
      if (!saveTextFile('deep-scan-preview.csv', csv)) toast('Could not save the list.', 'error');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setListBusy(false);
    }
  }, [preview]);

  // While a confirmed move runs, watch it so the dialog can say what happened.
  useEffect(() => {
    if (!open || phase.kind !== 'working') return undefined;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const response = await fetch('/api/database/update/status');
        if (!response.ok || !live) return;
        const status = (await response.json()) as {
          status?: string;
          phase?: string;
          error_message?: string;
          deep_scan_moves?: DeepScanPreview | null;
        };
        if (!live) return;
        if (status.status === 'running') return;
        const report = status.deep_scan_moves;
        if (status.status === 'error') {
          setPhase({
            kind: 'done',
            tone: 'warning',
            title: 'The deep scan stopped',
            body: status.error_message || 'The deep scan stopped before it finished.',
          });
        } else if (report?.mode === 'moved') {
          const moved = report.moved ?? 0;
          const missed = Math.max(0, confirmedCount.current - moved);
          setPhase({
            kind: 'done',
            title: `Moved ${countLabel(moved, 'file')} to Staging`,
            body: (
              <>
                Auto-import picks them up from Staging. Nothing was deleted, and the deep scan
                finished checking your library.
                {missed
                  ? ` ${countLabel(missed, 'previewed file')} stayed put: ${missed === 1 ? 'it' : 'they'} changed since the preview, or a file with that name was already in Staging.`
                  : ''}
              </>
            ),
          });
        } else {
          setPhase({
            kind: 'done',
            tone: 'warning',
            title: 'Nothing was moved',
            body:
              report?.message ||
              'The deep scan finished, but the preview could no longer be used, so no files moved. Preview again to move them.',
          });
        }
      } catch {
        // a blip: keep watching
      }
    }, STATUS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, phase.kind]);

  const close = useCallback(() => setOpen(false), []);
  const clear = useCallback(() => setPreview(null), []);

  const dialog = (
    <SafeActionDialog
      open={open}
      onClose={close}
      phase={phase}
      onPreviewAgain={() => void begin()}
      {...(preview
        ? deepScanDialogContent(preview, {
            largeOk,
            setLargeOk,
            busy,
            listBusy,
            onConfirm: () => void confirmMove(),
            onScanOnly: () => void scanOnly(),
            onDownload: () => void downloadList(),
          })
        : { title: 'Deep Scan' })}
    />
  );

  return {
    begin,
    previewing,
    preview,
    largeOk,
    setLargeOk,
    openReview,
    confirmMove,
    scanOnly,
    clear,
    dialog,
  };
}

interface ContentHandlers {
  largeOk: boolean;
  setLargeOk: (checked: boolean) => void;
  busy: boolean;
  listBusy: boolean;
  onConfirm: () => void;
  onScanOnly: () => void;
  onDownload: () => void;
}

/** The review screen for one preview, per mode. Exported for the tests. */
export function deepScanDialogContent(preview: DeepScanPreview, handlers: ContentHandlers) {
  const n = deepScanMoveCount(preview);
  const sampleCount = preview.sample?.length ?? 0;
  const shownLabel =
    sampleCount && n > sampleCount
      ? `${sampleCount.toLocaleString()} of ${countLabel(n, 'file')} shown`
      : sampleCount
        ? `All ${countLabel(sampleCount, 'file')} shown`
        : undefined;

  if (deepScanCanMove(preview)) {
    const needsCheck = deepScanNeedsCheck(preview);
    return {
      title: `Move ${countLabel(n, 'file')} to Staging?`,
      stats: [
        { label: 'Files', value: n.toLocaleString() },
        { label: 'Size', value: formatBytes(preview.total_bytes) },
        { label: 'In your library', value: (preview.library_files ?? 0).toLocaleString() },
      ],
      lead: (
        <>
          These files are in your music folder but not in SoulSync&apos;s database. Deep Scan moves
          them to Staging
          {preview.staging_path ? (
            <>
              {' '}
              (<code className={styles.code}>{preview.staging_path}</code>)
            </>
          ) : null}{' '}
          so auto-import can add them, keeping their folders. Nothing is deleted. Then it checks
          every track as usual.
        </>
      ),
      guard: needsCheck
        ? {
            message: deepScanGuardMessage(preview),
            checked: handlers.largeOk,
            onChange: handlers.setLargeOk,
          }
        : undefined,
      columns: ['File', 'Moves to'],
      rows: sampleRows(preview, true),
      shownLabel,
      fullList: preview.plan_id
        ? { label: 'Download the full list', onClick: handlers.onDownload, busy: handlers.listBusy }
        : undefined,
      createdAt: preview.created_at,
      expiresAt: preview.expires_at,
      confirmLabel: `Move ${countLabel(n, 'file')}`,
      confirmDisabled: needsCheck && !handlers.largeOk,
      confirmBusy: handlers.busy,
      onConfirm: handlers.onConfirm,
      secondary: { label: 'Scan without moving', onClick: handlers.onScanOnly },
    };
  }

  if (preview.mode === 'blocked') {
    return {
      title: "Deep Scan won't move any files",
      stats: [
        { label: 'Not in the database', value: (preview.untracked ?? 0).toLocaleString() },
        { label: 'In your library', value: (preview.library_files ?? 0).toLocaleString() },
      ],
      notice: { tone: 'warning' as const, content: deepScanBlockedCopy(preview) },
      lead: 'The scan still checks every track and removes records whose files are gone.',
      columns: ['Not in the database'],
      rows: sampleRows(preview, false),
      shownLabel:
        sampleCount && (preview.untracked ?? 0) > sampleCount
          ? `${sampleCount.toLocaleString()} of ${countLabel(preview.untracked ?? 0, 'file')} shown`
          : undefined,
      confirmLabel: 'Run Deep Scan',
      confirmBusy: handlers.busy,
      onConfirm: handlers.onScanOnly,
    };
  }

  return {
    title: 'Nothing to move',
    lead:
      "Every file in your music folder is already in the database, so Deep Scan won't move " +
      'anything. It still checks every track and removes records whose files are gone.',
    confirmLabel: 'Run Deep Scan',
    confirmBusy: handlers.busy,
    onConfirm: handlers.onScanOnly,
  };
}
