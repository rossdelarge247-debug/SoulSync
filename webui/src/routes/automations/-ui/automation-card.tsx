/**
 * One automation in the list (board 2i). Every card has its name, how it
 * runs, an On / Paused tag and its last run. The selected card also lists
 * its steps as sentences and carries Preview a run, Run now and Edit; a
 * paused card is the quieter wash with Resume where Run now would be.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/form';
import { StatusTag } from '@/components/primitives';

import type { AutomationRunState } from '../-automations.progress';
import type { Automation } from '../-automations.types';

import { automationOutcome, parseServerTime } from '../-automations.format';
import { automationActMode } from '../-automations.helpers';
import { hasFailed, isEnabled, isSystem } from '../-automations.list';
import { durationWords } from '../-automations.runs';
import {
  dayAndTime,
  nextPhrase,
  schedulePhrase,
  stepCount,
  stepSentences,
  type SentenceContext,
} from '../-automations.steps';
import { ActionMenu, type MenuEntry } from './action-menu';
import styles from './automations.module.css';

/**
 * "Every 6 hours · next at 16:00 · 3 steps"; a built-in one starts with
 * "Built-in", so it's recognisable under All (Design, HANDOFF 23 and 3a).
 */
export function scheduleLine(
  a: Automation,
  ctx: SentenceContext,
  masterOn: boolean,
  now = Date.now(),
): string {
  const parts = isSystem(a) ? ['Built-in'] : [];
  parts.push(schedulePhrase(a, ctx.blocks));
  if (isEnabled(a) && masterOn) {
    const next = nextPhrase(a, now);
    if (next) parts.push(next);
  }
  const n = stepCount(a);
  parts.push(n === 1 ? '1 step' : `${n} steps`);
  return parts.join(' · ');
}

/** "Last run today 09:15 · 12 found · 4 min", or why it failed. */
export function lastRunLine(
  a: Automation,
  now = Date.now(),
  duration?: number | null,
): { text: string; failed: boolean } {
  if (!a.last_run) return { text: 'Not run yet', failed: false };
  const when = dayAndTime(parseServerTime(a.last_run), now);
  if (hasFailed(a))
    return {
      text: `Last run ${when} failed: ${String(a.last_error).replace(/\.$/, '')}`,
      failed: true,
    };
  const outcome = automationOutcome(a.action_type, a.last_result);
  const took = durationWords(duration ?? null);
  return {
    text: [`Last run ${when}`, outcome?.text, took].filter(Boolean).join(' · '),
    failed: false,
  };
}

export interface CardHandlers {
  onSelect: (a: Automation) => void;
  onPreview: (a: Automation) => void;
  onRun: (a: Automation) => void;
  onEdit: (a: Automation) => void;
  onToggle: (a: Automation) => void;
  onDuplicate: (a: Automation) => void;
  onGroup: (a: Automation) => void;
  onDelete: (a: Automation) => void;
  /** "Explain": asks the Assistant about it (only while it can be used). */
  onExplain?: (a: Automation) => void;
}

function StateTag({ a, running }: { a: Automation; running: boolean }) {
  if (running) {
    return (
      <StatusTag tone="info" live>
        Running
      </StatusTag>
    );
  }
  return isEnabled(a) ? (
    <StatusTag tone="success">On</StatusTag>
  ) : (
    <StatusTag tone="neutral">Paused</StatusTag>
  );
}

export function AutomationCard({
  automation: a,
  selected,
  ctx,
  masterOn,
  progress,
  lastDuration,
  runsLink,
  handlers: on,
  children,
}: {
  automation: Automation;
  selected: boolean;
  ctx: SentenceContext;
  masterOn: boolean;
  progress?: AutomationRunState;
  /** The latest run's duration, from the history (selected card only). */
  lastDuration?: number | null;
  /** Phones: the "61 runs · last failed …" line that opens the runs. */
  runsLink?: { label: string; expanded: boolean; onToggle: () => void };
  handlers: CardHandlers;
  /** Phones: the runs panel, under the selected card. */
  children?: ReactNode;
}) {
  const enabled = isEnabled(a);
  const system = isSystem(a);
  const running = progress?.status === 'running';
  const now = Date.now();
  const last = lastRunLine(a, now, lastDuration);
  const actMode = automationActMode(a);
  const percent = Number(progress?.progress);
  const runningLine = [
    'Running now',
    progress?.phase,
    Number.isFinite(percent) && percent > 0 ? `${Math.round(percent)}%` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const menu: MenuEntry[] = [
    enabled
      ? { key: 'pause', label: 'Pause this automation', onSelect: () => on.onToggle(a) }
      : { key: 'resume', label: 'Turn it on again', onSelect: () => on.onToggle(a) },
    ...(!enabled
      ? [{ key: 'run-once', label: 'Run it once now', onSelect: () => on.onRun(a) }]
      : []),
    ...(system
      ? []
      : [
          { key: 'duplicate', label: 'Duplicate', onSelect: () => on.onDuplicate(a) },
          {
            key: 'group',
            label: a.group_name ? `Move to another group…` : 'Put in a group…',
            onSelect: () => on.onGroup(a),
          },
        ]),
    ...(system
      ? []
      : [
          { key: 'sep', separator: true as const },
          {
            key: 'delete',
            label: 'Delete…',
            tone: 'danger' as const,
            onSelect: () => on.onDelete(a),
          },
        ]),
  ];

  return (
    <article
      className={styles.card}
      data-selected={selected ? 'true' : undefined}
      data-paused={enabled ? undefined : 'true'}
      aria-current={selected ? 'true' : undefined}
      data-testid={`automation-card-${a.id}`}
      data-tour={selected ? 'automation-card' : undefined}
    >
      {!selected ? (
        <button
          type="button"
          className={styles.cardSelect}
          aria-label={`${a.name}: show its steps and runs`}
          onClick={() => on.onSelect(a)}
        />
      ) : null}
      <div className={styles.cardHead}>
        <div className={styles.cardTitleBlock}>
          <h3 className={styles.cardTitle}>{a.name}</h3>
          <p className={styles.cardMeta}>
            {scheduleLine(a, ctx, masterOn, now)}
            {a.group_name && !system ? ` · ${a.group_name}` : ''}
          </p>
        </div>
        <StateTag a={a} running={running} />
      </div>

      {selected ? (
        <ol className={styles.stepSentences}>
          {stepSentences(a, ctx).map((sentence, index) => (
            <li key={index}>{sentence}</li>
          ))}
        </ol>
      ) : null}

      {selected && actMode ? (
        <p className={styles.cardNote}>
          {actMode === 'preview'
            ? 'Scheduled runs only report what this step would move or delete. Run now shows the list and asks before anything changes.'
            : 'Scheduled runs move or delete files without asking. Run now still shows the list and asks first.'}
        </p>
      ) : null}

      <div className={styles.cardFoot}>
        <p className={styles.cardMeta} data-tone={last.failed && !running ? 'danger' : undefined}>
          {running ? runningLine : last.text}
        </p>
        {selected ? (
          <div className={styles.cardActions}>
            <Button
              size="lg"
              aria-label="Preview a run"
              data-tour="automation-preview"
              onClick={() => on.onPreview(a)}
            >
              <span>
                Preview<span className={styles.wordsOnWide}> a run</span>
              </span>
            </Button>
            {enabled ? (
              <Button size="lg" onClick={() => on.onRun(a)}>
                Run now
              </Button>
            ) : (
              <Button size="lg" onClick={() => on.onToggle(a)}>
                Resume
              </Button>
            )}
            <Button size="lg" variant="ghost" onClick={() => on.onEdit(a)}>
              Edit
            </Button>
            {on.onExplain ? (
              <button
                type="button"
                className={styles.explainLink}
                aria-label={`Explain ${a.name}`}
                onClick={() => on.onExplain?.(a)}
              >
                Explain
              </button>
            ) : null}
            <ActionMenu label={`More for ${a.name}`} entries={menu} />
          </div>
        ) : !enabled ? (
          <div className={styles.cardActions} data-raised="true">
            <Button size="lg" onClick={() => on.onToggle(a)} aria-label={`Resume ${a.name}`}>
              Resume
            </Button>
          </div>
        ) : null}
      </div>

      {selected && runsLink ? (
        <button
          type="button"
          className={styles.runsLink}
          aria-expanded={runsLink.expanded}
          data-tour="automation-runs-link"
          onClick={runsLink.onToggle}
        >
          {runsLink.label}
        </button>
      ) : null}
      {children}
    </article>
  );
}
