/**
 * "Preview a run": what a run would do right now, with these steps, and
 * proof that nothing changed. The editor shows it in its right-hand panel;
 * the list shows the same content in a dialog.
 */

import type { ReactNode } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import { Notice, Spinner } from '@/components/primitives';
import { formatBytes } from '@/features/safe-action/plan';

import type { PreviewResult } from '../-automations.types';

import { durationWords } from '../-automations.runs';
import styles from './automations.module.css';

/** "just now · under a second". */
export function previewedLabel(
  result: Pick<PreviewResult, 'previewed_at' | 'duration_ms'>,
  now = Date.now(),
): string {
  const age = Math.max(0, Math.round(now / 1000 - result.previewed_at));
  const when =
    age < 60
      ? 'just now'
      : age < 3600
        ? `${Math.round(age / 60)} min ago`
        : `at ${new Date(result.previewed_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  const took = durationWords(result.duration_ms / 1000);
  return took ? `${when} · ${took}` : when;
}

function countValue(value: number, unit?: string): string {
  return unit === 'bytes' ? formatBytes(value) : value.toLocaleString();
}

function noun(n: number, one: string): string {
  return n === 1 ? one : `${one}s`;
}

/** The numbers, the sample and the follow-up notes of one preview. */
export function PreviewBody({ result }: { result: PreviewResult }) {
  if (!result.available) {
    return (
      <Notice
        tone="neutral"
        title="A preview isn't available for this step"
        data-testid="preview-unavailable"
      >
        {result.reason}
      </Notice>
    );
  }
  const counts = result.counts ?? [];
  const sample = result.sample ?? [];
  const total = result.sample_total ?? sample.length;
  const thenNotes = result.steps.filter((s) => s.kind === 'then' && s.note);
  return (
    <div className={styles.previewBody}>
      {result.summary ? <p className={styles.previewSummary}>{result.summary}</p> : null}
      {counts.length ? (
        <dl className={styles.numbers} data-count={counts.length}>
          {counts.map((count) => (
            <div key={count.key} className={styles.number}>
              <dt>{count.label}</dt>
              <dd>{countValue(count.value, count.unit)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {sample.length ? (
        <>
          <ul className={styles.sampleList} aria-label="A sample of what a run would work on">
            {sample.map((row, index) => (
              <li key={`${row.title}-${index}`} className={styles.sampleRow}>
                <span className={styles.sampleTitle}>{row.title}</span>
                {row.detail ? <span className={styles.sampleDetail}>{row.detail}</span> : null}
              </li>
            ))}
          </ul>
          <p className={styles.sampleFoot}>
            {sample.length < total
              ? `${sample.length} of ${total.toLocaleString()} ${noun(total, result.sample_noun ?? 'item')} shown`
              : `All ${total.toLocaleString()} ${noun(total, result.sample_noun ?? 'item')} shown`}
          </p>
        </>
      ) : null}
      {thenNotes.length ? (
        <ul className={styles.thenNotes}>
          {thenNotes.map((step) => (
            <li key={step.position}>
              Step {step.position}: {step.note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: PreviewResult };

function PreviewStatus({
  state,
  onPreview,
  intro,
}: {
  state: PreviewState;
  onPreview: () => void;
  intro: ReactNode;
}) {
  if (state.kind === 'loading') {
    return (
      <p className={styles.previewLoading} role="status">
        <Spinner size={18} />
        <span>Working out what a run would do…</span>
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <Notice
        tone="danger"
        role="alert"
        title="Couldn't preview this run"
        actions={
          <Button size="lg" onClick={onPreview}>
            Try again
          </Button>
        }
      >
        {state.message.replace(/\.?$/, '.')} Nothing was changed.
      </Notice>
    );
  }
  if (state.kind === 'done') return <PreviewBody result={state.result} />;
  return <p className={styles.previewSummary}>{intro}</p>;
}

/** The editor's sticky right-hand panel. */
export function PreviewPanel({
  state,
  onPreview,
  runAction,
}: {
  state: PreviewState;
  onPreview: () => void;
  /** "Run this now" and the sentence beside it; omitted for a new automation. */
  runAction?: { onRun: () => void; note: string; disabledReason?: string };
}) {
  return (
    <aside className={styles.previewPanel} aria-label="Preview" data-testid="preview-panel">
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Preview</h2>
        {state.kind === 'done' ? (
          <span className={styles.panelMeta}>{previewedLabel(state.result)}</span>
        ) : null}
      </div>
      <div className={styles.previewContent} aria-live="polite">
        <PreviewStatus
          state={state}
          onPreview={onPreview}
          intro="See what a run would do right now, with these steps. Nothing is downloaded, moved or changed."
        />
        {state.kind === 'idle' ? (
          <div>
            <Button size="lg" onClick={onPreview}>
              Preview a run
            </Button>
          </div>
        ) : null}
      </div>
      {runAction ? (
        <div className={styles.panelFoot}>
          <Button
            size="lg"
            onClick={runAction.onRun}
            disabled={Boolean(runAction.disabledReason)}
            disabledReason={runAction.disabledReason}
          >
            Run this now
          </Button>
          {runAction.disabledReason ? null : (
            <span className={styles.panelMeta}>{runAction.note}</span>
          )}
        </div>
      ) : null}
    </aside>
  );
}

/** The list's "Preview a run": the same content, in a dialog. */
export function PreviewDialog({
  open,
  name,
  state,
  onPreview,
  onClose,
  onRun,
  runLabel,
}: {
  open: boolean;
  name: string;
  state: PreviewState;
  onPreview: () => void;
  onClose: () => void;
  onRun?: () => void;
  runLabel: string;
}) {
  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className={styles.previewDialog}
    >
      <DialogHeader title={`Preview: ${name}`}>
        {state.kind === 'done' ? (
          <span className={styles.panelMeta}>{previewedLabel(state.result)}</span>
        ) : null}
      </DialogHeader>
      <DialogBody>
        <div aria-live="polite" className={styles.previewContent}>
          <PreviewStatus state={state} onPreview={onPreview} intro="" />
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onClose}>
          Close
        </Button>
        {onRun ? (
          <Button
            size="lg"
            variant="primary"
            onClick={onRun}
            disabled={state.kind === 'loading'}
            focusableWhenDisabled
          >
            {runLabel}
          </Button>
        ) : null}
      </DialogFooter>
    </DialogFrame>
  );
}
