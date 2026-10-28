import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/form';
import { Badge, type BadgeTone } from '@/components/primitives';
import { mixSupport } from '@/features/automix/support';
import { openDjSettings } from '@/features/dj/dj-settings-link';

import type { CheckGroup, CheckStatus, SetupCheckResult } from '../-setup-check.types';

import { copyText } from '../-setup-check.clipboard';
import {
  STATUS_WORD,
  fixBlocks,
  groupSuffix,
  isExpanded,
  parseFixText,
} from '../-setup-check.helpers';
import { InfoIcon, StatusIcon } from './icons';
import styles from './setup-check-page.module.css';

const TAG_TONE: Record<CheckStatus, BadgeTone> = {
  ok: 'success',
  warning: 'warning',
  error: 'danger',
  skipped: 'neutral',
};

export function StatusTag({ status }: { status: CheckStatus }) {
  return (
    <Badge className={styles.statusTag} tone={TAG_TONE[status]}>
      {STATUS_WORD[status]}
    </Badge>
  );
}

function toast(message: string, type: 'success' | 'info' = 'success') {
  window.showToast?.(message, type);
}

function CodeLine({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyText(code);
    if (!ok) {
      toast(
        'Copying isn’t available in this browser. Select the line and copy it by hand.',
        'info',
      );
      return;
    }
    toast('Copied');
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.codeLine}>
      <code className={styles.codeBlock}>{code}</code>
      <Button variant="secondary" size="lg" aria-label={`Copy ${code}`} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export function FixText({ fix }: { fix: string }) {
  const blocks = fixBlocks(parseFixText(fix));
  return (
    <>
      {blocks.map((block, index) => {
        const [first] = block;
        if (first?.kind === 'line') return <CodeLine key={index} code={first.code} />;
        return (
          <p key={index} className={styles.fixText}>
            {block.map((segment, i) =>
              segment.kind === 'code' ? (
                <code key={i} className={styles.inlineCode}>
                  {segment.code}
                </code>
              ) : segment.kind === 'text' ? (
                <span key={i}>{segment.text}</span>
              ) : null,
            )}
          </p>
        );
      })}
    </>
  );
}

export function CheckRow({
  check,
  onRerun,
  rerunning,
}: {
  check: SetupCheckResult;
  onRerun: () => void;
  rerunning: boolean;
}) {
  if (!isExpanded(check)) {
    return (
      <li className={clsx(styles.row, styles.rowCompact)} data-status={check.status}>
        <StatusIcon className={styles.rowIcon} status={check.status} />
        <div className={styles.rowBody}>
          <div className={styles.rowHead}>
            <span className={styles.rowTitle}>{check.title}</span>
            <StatusTag status={check.status} />
          </div>
          {check.detail ? <p className={styles.compactDetail}>{check.detail}</p> : null}
        </div>
      </li>
    );
  }

  const attention = check.status === 'error' || check.status === 'warning';
  return (
    <li className={styles.row} data-status={check.status}>
      <StatusIcon className={styles.rowIcon} status={check.status} />
      <div className={styles.rowBody}>
        <div className={styles.rowHead}>
          <span className={styles.rowTitle}>{check.title}</span>
          <StatusTag status={check.status} />
        </div>
        {check.detail ? <p className={styles.detail}>{check.detail}</p> : null}
        {check.fix ? (
          <div className={styles.fixBox}>
            <p className={styles.fixLabel}>{attention ? 'How to fix it' : 'What you can do'}</p>
            <FixText fix={check.fix} />
            {attention ? (
              <div className={styles.fixActions}>
                <Button size="lg" onClick={onRerun} disabled={rerunning}>
                  {rerunning ? 'Checking…' : 'Run this check again'}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function CheckGroups({
  groups,
  onRerun,
  rerunning,
}: {
  groups: CheckGroup[];
  onRerun: () => void;
  rerunning: boolean;
}) {
  return (
    <>
      {groups.map((group) => {
        const headingId = `setup-check-group-${group.category || 'other'}`;
        return (
          <section
            key={group.category}
            aria-labelledby={headingId}
            className={styles.group}
            data-testid="setup-check-group"
          >
            <h2 id={headingId} className={styles.groupLabel}>
              {group.label} <span aria-hidden="true">·</span> {groupSuffix(group)}
            </h2>
            <ul className={styles.checkList}>
              {group.checks.map((check, index) => (
                <CheckRow
                  key={`${check.id}-${index}`}
                  check={check}
                  onRerun={onRerun}
                  rerunning={rerunning}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/**
 * This browser (312): an info row the server can't run, since only the
 * browser knows whether it may run Auto mix's decks (https, or SYNCHRO.S
 * opened on its own computer). Never a warning: Auto mix is optional.
 */
export function BrowserInfo({
  support = mixSupport,
}: {
  support?: () => string | null;
} = {}) {
  const why = support();
  return (
    <section
      aria-labelledby="setup-check-group-browser"
      className={styles.group}
      data-setup-browser=""
    >
      <h2 id="setup-check-group-browser" className={styles.groupLabel}>
        This browser
      </h2>
      <ul className={styles.checkList}>
        <li className={clsx(styles.row, styles.rowCompact)} data-status="info">
          <InfoIcon className={styles.rowIcon} />
          <div className={styles.rowBody}>
            <div className={styles.rowHead}>
              <span className={styles.rowTitle}>Auto mix</span>
              <Badge className={styles.statusTag} tone="info">
                Info
              </Badge>
            </div>
            <p className={styles.compactDetail}>
              {why
                ? /https/.test(why)
                  ? 'Over plain http from another computer, Auto mix can only cut on the phrase or play straight on: its blends and echo outs need SYNCHRO.S on https, or opened on its own computer (localhost). Settings → Connections says how.'
                  : "This browser can't run Auto mix's decks, so Auto mix can only cut on the phrase or play straight on here. A current Chrome, Edge, Firefox or Safari can."
                : 'Auto mix can run in this browser: SYNCHRO.S is on https here, or open on its own computer.'}{' '}
              Between tracks is chosen in{' '}
              <button
                type="button"
                className={styles.inlineLink}
                onClick={() => openDjSettings('between')}
              >
                Settings → Library → DJ
              </button>
              .
            </p>
          </div>
        </li>
      </ul>
    </section>
  );
}
