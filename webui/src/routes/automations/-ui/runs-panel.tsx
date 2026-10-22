/**
 * The selected automation's runs: how many in 30 days, three numbers the
 * history really holds, then one row per run (Done, Failed, Preview,
 * Skipped) whose log opens under it. A run in progress sits on top, live.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { Button, OptionButton } from '@/components/form';
import { Notice, Skeleton, StatusTag } from '@/components/primitives';

import type { AutomationRunState } from '../-automations.progress';
import type { Automation } from '../-automations.types';

import { automationHistoryQueryOptions } from '../-automations.api';
import { runNumbers, runRow, runsWindow, sortRuns } from '../-automations.runs';
import styles from './automations.module.css';

const FIRST_ROWS = 5;
const MORE_ROWS = 10;

export function RunsSkeleton() {
  return (
    <div className={styles.runsSkeleton} aria-hidden="true">
      <div className={styles.numbers} data-count={3}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={styles.number}>
            <Skeleton style={{ width: 72, height: 14 }} />
            <Skeleton style={{ width: 56, height: 28, marginTop: 6 }} />
          </div>
        ))}
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={styles.runRow}>
          <Skeleton style={{ width: 88, height: 14 }} />
          <Skeleton style={{ width: '80%', height: 14 }} />
          <Skeleton style={{ width: 64, height: 24 }} />
        </div>
      ))}
    </div>
  );
}

export function RunsPanel({
  automation,
  progress,
  embedded = false,
}: {
  automation: Automation;
  progress?: AutomationRunState;
  /** Inside the selected card on a phone, not the sticky side panel. */
  embedded?: boolean;
}) {
  const query = useQuery(automationHistoryQueryOptions(automation.id));
  const [shown, setShown] = useState(FIRST_ROWS);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const now = Date.now();
  const history = sortRuns(query.data?.history ?? []);
  const window = runsWindow(history, query.data?.total, now);
  const numbers = runNumbers(window.runs, automation.action_type);
  const rows = history.slice(0, shown).map((run) => runRow(run, now));
  const running = progress?.status === 'running';
  const percent = Number(progress?.progress);
  const [liveOpen, setLiveOpen] = useState(false);
  const liveSummary =
    [progress?.phase, Number.isFinite(percent) && percent > 0 ? `${Math.round(percent)}%` : '']
      .filter(Boolean)
      .join(' · ') || 'Starting';

  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section
      className={styles.runsPanel}
      data-embedded={embedded ? 'true' : undefined}
      aria-label={`Runs: ${automation.name}`}
      data-testid="runs-panel"
      data-tour="automation-runs"
    >
      <div className={styles.runsHead}>
        <h2 className={styles.panelTitle}>
          Runs<span className={styles.runsName}>: {automation.name}</span>
        </h2>
        {query.isSuccess ? (
          <span className={styles.panelMeta} data-testid="runs-count">
            {window.label}
          </span>
        ) : null}
      </div>

      {query.isPending ? (
        <div className={styles.runsBody} aria-busy="true">
          <p className={styles.srOnly} role="status">
            Loading the runs…
          </p>
          <RunsSkeleton />
        </div>
      ) : query.isError ? (
        <div className={styles.runsBody}>
          <Notice
            tone="danger"
            role="alert"
            title="Couldn't load the runs"
            actions={
              <Button size="lg" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          >
            SoulSync didn't answer. The automation keeps running as set; this is a display problem.
          </Notice>
        </div>
      ) : (
        <>
          <dl className={styles.numbers} data-count={3} data-testid="runs-numbers">
            {numbers.map((n) => (
              <div key={n.label} className={styles.number}>
                <dt>{n.label}</dt>
                <dd>{n.value}</dd>
              </div>
            ))}
          </dl>
          {!window.complete ? (
            <p className={styles.runsNote}>
              SoulSync keeps the newest {history.length} runs, so these numbers start{' '}
              {window.label.split('since ')[1]}.
            </p>
          ) : null}
          <ol className={styles.runList}>
            {running ? (
              <li className={styles.runItem} data-live="true">
                <button
                  type="button"
                  className={styles.runRow}
                  data-button="true"
                  aria-expanded={liveOpen}
                  aria-label={`Running now: ${liveSummary}. ${liveOpen ? 'Hide' : 'Show'} what it’s doing`}
                  onClick={() => setLiveOpen((o) => !o)}
                >
                  <span className={styles.runWhen}>Now</span>
                  <span className={styles.runSummary}>{liveSummary}</span>
                  <StatusTag tone="info" live>
                    Running
                  </StatusTag>
                </button>
                {liveOpen && progress?.log?.length ? (
                  <pre className={styles.runLog} aria-live="polite">
                    {progress.log.map((line, i) => (
                      <span key={i} className={styles.logLine} data-type={line.type ?? 'info'}>
                        {line.text ?? ''}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                ) : null}
              </li>
            ) : null}
            {rows.length === 0 && !running ? (
              <li className={styles.runsEmpty}>
                No runs yet. Preview a run to see what it would do.
              </li>
            ) : null}
            {rows.map((row) => {
              const hasLog = row.log.length > 0;
              const expanded = open.has(row.id);
              const inner = (
                <>
                  <span className={styles.runWhen}>{row.when}</span>
                  <span className={styles.runSummary}>{row.summary}</span>
                  <StatusTag tone={row.tone}>{row.tag}</StatusTag>
                </>
              );
              return (
                <li key={row.id} className={styles.runItem}>
                  {hasLog ? (
                    <button
                      type="button"
                      className={styles.runRow}
                      data-button="true"
                      aria-expanded={expanded}
                      aria-label={`${row.when}, ${row.summary}, ${row.tag}. ${expanded ? 'Hide' : 'Show'} its log`}
                      onClick={() => toggle(row.id)}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className={styles.runRow}>{inner}</div>
                  )}
                  {hasLog && expanded ? (
                    <pre className={styles.runLog}>
                      {row.log.map((line, i) => (
                        <span key={i} className={styles.logLine} data-type={line.type ?? 'info'}>
                          {line.text ?? ''}
                          {'\n'}
                        </span>
                      ))}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div className={styles.runsFoot}>
            <span className={styles.panelMeta}>
              {Math.min(shown, history.length)} of{' '}
              {window.complete && window.runs.length === history.length
                ? history.length
                : `${history.length} kept runs`}
            </span>
            <span className={styles.runsFootActions}>
              {shown < history.length ? (
                <OptionButton variant="ghost" onClick={() => setShown((n) => n + MORE_ROWS)}>
                  Show more
                </OptionButton>
              ) : null}
              <Link className={styles.link} to="/activity" search={{ show: 'automations' }}>
                All runs in Activity
              </Link>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
