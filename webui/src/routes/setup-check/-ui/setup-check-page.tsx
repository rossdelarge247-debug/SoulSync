import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/components/form';
import { Skeleton } from '@/components/primitives';
import { useProfile, useReactPageShell } from '@/platform/shell/route-controllers';

import type { SetupCheckReport } from '../-setup-check.types';

import { isForbidden, setupCheckQueryOptions, setupStatusQueryOptions } from '../-setup-check.api';
import { copyText } from '../-setup-check.clipboard';
import {
  firstRunSteps,
  formatDuration,
  formatRelative,
  formatReportText,
  formatTimestamp,
  groupChecks,
  plural,
} from '../-setup-check.helpers';
import { CheckGroups } from './check-groups';
import { FirstRunSteps } from './first-run-steps';
import { ClockIcon, ErrorIcon, OkIcon, RefreshIcon, WarningIcon } from './icons';
import styles from './setup-check-page.module.css';

/** The server gives the full run 25 seconds before it reports a check as not finished. */
const FULL_RUN_DEADLINE_S = 25;

function toast(message: string, type: 'success' | 'info' | 'error' = 'success') {
  window.showToast?.(message, type);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : 'Something went wrong';
  return message.replace(/[.\s]+$/, '');
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function PageHeading({ actions }: { actions?: ReactNode }) {
  return (
    <header className={styles.header} data-tour="setup-check">
      <div className={styles.headText}>
        <h1 className={styles.title}>Setup check</h1>
        <p className={styles.subtitle}>
          Checks your folders, slskd and your media server, and says how to fix anything that’s
          wrong. Run it again after you change docker-compose or a setting.
        </p>
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
  );
}

function AdminOnly() {
  return (
    <section className={styles.panel} aria-labelledby="setup-check-admin-only">
      <h2 id="setup-check-admin-only" className={styles.panelTitle}>
        Only an admin can run the setup check
      </h2>
      <p className={styles.panelText}>
        The setup check shows folder paths, server addresses and the user SoulSync runs as, so it’s
        kept to admin profiles. Ask whoever set up SoulSync to run it from an admin profile.
      </p>
    </section>
  );
}

export function SetupCheckPage() {
  useReactPageShell('setup-check');
  const { isAdmin } = useProfile();

  if (!isAdmin) {
    return (
      <div className={styles.page}>
        <PageHeading />
        <AdminOnly />
      </div>
    );
  }
  return <AdminSetupCheck />;
}

function Tile({
  icon,
  value,
  label,
  extra,
  tone,
}: {
  icon: ReactNode;
  value: ReactNode;
  label: ReactNode;
  extra?: ReactNode;
  tone: 'ok' | 'warning' | 'error' | 'time';
}) {
  return (
    <div className={styles.tile} data-tone={tone}>
      <span className={styles.tileIcon}>{icon}</span>
      <span className={styles.tileText}>
        <span className={tone === 'time' ? styles.tileTime : styles.tileValue}>{value}</span>
        <span className={styles.tileLabel}>{label}</span>
        {extra ? <span className={styles.tileLabel}>{extra}</span> : null}
      </span>
    </div>
  );
}

function SummaryTiles({
  report,
  partial,
  now,
}: {
  report: SetupCheckReport;
  partial: boolean;
  now: number;
}) {
  const { summary } = report;
  return (
    <div className={styles.tiles} data-testid="setup-check-summary">
      <Tile
        tone="ok"
        icon={<OkIcon size={28} />}
        value={summary.ok}
        label={summary.ok === 1 ? 'check OK' : 'checks OK'}
        extra={summary.skipped ? `${summary.skipped} skipped` : undefined}
      />
      <Tile
        tone="warning"
        icon={<WarningIcon size={28} />}
        value={summary.warning}
        label={summary.warning === 1 ? 'warning' : 'warnings'}
      />
      <Tile
        tone="error"
        icon={<ErrorIcon size={28} />}
        value={summary.error}
        label={summary.error === 1 ? 'problem' : 'problems'}
      />
      {partial ? (
        <Tile
          tone="time"
          icon={<ClockIcon size={28} />}
          value="Checking…"
          label="folder checks so far"
        />
      ) : (
        <Tile
          tone="time"
          icon={<ClockIcon size={28} />}
          value={
            <time title={formatTimestamp(report.ranAt)}>{formatRelative(report.ranAt, now)}</time>
          }
          label={`last checked, took ${formatDuration(report.durationMs)}`}
        />
      )}
    </div>
  );
}

function Progress({ elapsedS, haveLocal }: { elapsedS: number; haveLocal: boolean }) {
  const shown = Math.min(elapsedS, FULL_RUN_DEADLINE_S);
  return (
    <section className={styles.progress} aria-labelledby="setup-check-progress">
      <p id="setup-check-progress" className={styles.progressTitle} role="status">
        {haveLocal ? 'Checking slskd and your media server…' : 'Running the setup check…'}
      </p>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-labelledby="setup-check-progress"
        aria-valuemin={0}
        aria-valuemax={FULL_RUN_DEADLINE_S}
        aria-valuenow={shown}
        aria-valuetext={`${plural(shown, 'second')} of up to ${FULL_RUN_DEADLINE_S}`}
      >
        <span
          className={styles.progressFill}
          style={{ width: `${Math.max(4, (shown / FULL_RUN_DEADLINE_S) * 100)}%` }}
        />
      </div>
      <p className={styles.progressText}>
        {haveLocal
          ? `This can take up to ${FULL_RUN_DEADLINE_S} seconds. Your folder results are below.`
          : `This can take up to ${FULL_RUN_DEADLINE_S} seconds.`}{' '}
        {elapsedS > 0 ? `${plural(elapsedS, 'second')} so far.` : null}
      </p>
    </section>
  );
}

function LoadingSkeleton() {
  return (
    <div className={styles.skeletons} aria-hidden="true">
      <div className={styles.tiles}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className={styles.tileSkeleton} />
        ))}
      </div>
      {[0, 1].map((i) => (
        <Skeleton key={i} className={styles.groupSkeleton} />
      ))}
    </div>
  );
}

function AdminSetupCheck() {
  const local = useQuery(setupCheckQueryOptions('local', true));
  const full = useQuery(setupCheckQueryOptions('all', true));
  const setupStatus = useQuery(setupStatusQueryOptions(true));

  const running = full.isFetching;
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useEffect(() => {
    setStartedAt(running ? Date.now() : null);
  }, [running]);
  const now = useNow(running ? 1000 : 30_000);
  const elapsedS = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;

  // the full report once it's in; the fast local one while the full run is
  // still going, or when its latest attempt failed
  let report: SetupCheckReport | undefined;
  let partial = false;
  if (full.data && !running && !full.isError) {
    report = full.data;
  } else if (local.data && !local.isFetching) {
    report = local.data;
    partial = running;
  } else if (full.data) {
    report = full.data;
  } else if (local.data) {
    report = local.data;
    partial = running;
  }

  const groups = useMemo(() => (report ? groupChecks(report.checks) : []), [report]);
  const steps = useMemo(
    () => (report ? firstRunSteps(report.checks, report.scope === 'local' && running) : []),
    [report, running],
  );

  const forbidden = isForbidden(full.error) || isForbidden(local.error);
  const rerun = () => {
    void local.refetch();
    void full.refetch();
  };

  const copyReport = async () => {
    if (!report) return;
    const ok = await copyText(formatReportText(report));
    toast(
      ok ? 'Setup check copied. Paste it into your bug report.' : 'Copying isn’t available here',
      ok ? 'success' : 'info',
    );
  };

  if (forbidden) {
    return (
      <div className={styles.page}>
        <PageHeading />
        <AdminOnly />
      </div>
    );
  }

  const fullFailed = full.isError && !running;
  const bothFailed = fullFailed && local.isError && !local.isFetching && !report;

  return (
    <div className={styles.page}>
      <PageHeading
        actions={
          <>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => void copyReport()}
              disabled={!report}
            >
              Copy for a bug report
            </Button>
            <Button variant="primary" size="lg" onClick={rerun} disabled={running}>
              <RefreshIcon size={18} />
              {running ? 'Checking…' : 'Run the check again'}
            </Button>
          </>
        }
      />

      {setupStatus.data === false && report ? (
        <FirstRunSteps steps={steps} problems={report.summary.error} />
      ) : null}

      {running ? <Progress elapsedS={elapsedS} haveLocal={partial} /> : null}

      {bothFailed ? (
        <section className={styles.panel} role="alert">
          <h2 className={styles.panelTitle}>The setup check couldn’t run</h2>
          <p className={styles.panelText}>{errorMessage(full.error)}.</p>
          <div>
            <Button size="lg" onClick={rerun}>
              Try again
            </Button>
          </div>
        </section>
      ) : fullFailed ? (
        <section className={styles.panel} role="alert" data-tone="warning">
          <h2 className={styles.panelTitle}>slskd and the media server weren’t checked</h2>
          <p className={styles.panelText}>
            The full check didn’t finish: {errorMessage(full.error)}.
            {report?.scope === 'local'
              ? ' The results below are from the folder checks only.'
              : report
                ? ' The results below are from the last check that finished.'
                : ''}
          </p>
          <div>
            <Button size="lg" onClick={rerun}>
              Try again
            </Button>
          </div>
        </section>
      ) : null}

      {report ? (
        <div className={styles.results} aria-busy={running}>
          <SummaryTiles report={report} partial={partial} now={now} />
          <CheckGroups groups={groups} onRerun={rerun} rerunning={running} />
        </div>
      ) : !bothFailed ? (
        <LoadingSkeleton />
      ) : null}
    </div>
  );
}
