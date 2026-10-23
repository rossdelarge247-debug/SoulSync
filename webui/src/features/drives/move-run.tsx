/**
 * The running half of the flow: Copying (14g, 14p), Checking then switching
 * (14h, 14q), Done with Remove the old copies… and Switch back… (14i, 14r),
 * the one failure shape (14j, 14s), and the end of a stopped move. The copy
 * runs on the server; this page only reads it (Activity's Library jobs shows
 * it too, with Stop).
 */

import { useState } from 'react';

import { Button } from '@/components/form';
import { Notice } from '@/components/primitives';

import type { Failure, Move, MovePayload, MoveFolder } from './drives.api';

import { drivesApi } from './drives.api';
import { count, durationWords, sizeOf, sizeWords, speedWords } from './drives.format';
import { FlowShell, Tick } from './move-shell';
import styles from './move.module.css';
import { RemoveOldCopies } from './remove-old-copies';

export interface RunProps {
  payload: MovePayload;
  move: Move;
  busy: boolean;
  error: string | null;
  act: (fn: () => Promise<MovePayload>) => Promise<boolean>;
  close: () => void;
  done: () => void;
}

function pausedWords(move: Move, short = false): string {
  const n = move.plan?.automations.length ?? 0;
  const autos = n ? `${n} ${n === 1 ? 'automation' : 'automations'}` : '';
  if (short)
    return ['Downloads', 'imports', autos]
      .filter(Boolean)
      .join(', ')
      .replace(/, ([^,]*)$/, ' and $1');
  return ['new downloads', 'Wanted’s searches', 'auto-import', autos]
    .filter(Boolean)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');
}

function folderLine(f: MoveFolder): string {
  return `${count(f.files, 'file')} · ${sizeWords(f.bytes)}`;
}

function StopAndUndo({ move, act, note }: { move: Move; act: RunProps['act']; note: string }) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <div className={styles.confirmInPlace} role="group" aria-label="Stop and undo">
        <p>
          Stop and delete the half-made copy? {sizeWords(move.progress.copied_bytes)} copied so far.
        </p>
        <Button size="lg" variant="secondary" onClick={() => setAsking(false)}>
          Keep copying
        </Button>
        <button
          type="button"
          className={styles.dangerButton}
          onClick={() => {
            setAsking(false);
            void act(() => drivesApi.stop(move.id));
          }}
        >
          Stop and undo
        </button>
      </div>
    );
  }
  return (
    <>
      <Button size="lg" variant="secondary" onClick={() => setAsking(true)}>
        Stop and undo
      </Button>
      <p className={styles.footNote}>{note}</p>
    </>
  );
}

// ── Copying (14g) ─────────────────────────────────────────────────────────────

export function CopyStep({ move, act, close, error }: RunProps) {
  const plan = move.plan;
  const target = plan?.target_label ?? 'the new drive';
  const source = plan?.source_label ?? 'the old drive';
  const p = move.progress;
  const pct = p.total_bytes ? Math.min(100, (p.copied_bytes / p.total_bytes) * 100) : 0;
  const speed = speedWords(p.speed);
  const line = [
    sizeOf(p.copied_bytes, p.total_bytes),
    p.eta_seconds !== null ? `about ${durationWords(p.eta_seconds)} left` : null,
    speed,
  ]
    .filter(Boolean)
    .join(' · ');
  const waiting = p.phase === 'waiting' && p.waiting_for?.length;
  return (
    <FlowShell
      step={3}
      promise={move.promise}
      leaveLabel="Close"
      onLeave={close}
      footer={
        <StopAndUndo
          move={move}
          act={act}
          note={`Deletes the half-made copy on ${target} and starts what was paused. Your music isn’t touched.`}
        />
      }
    >
      <h2 className={styles.title}>Copying to {target}</h2>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label="Copied"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.progressLine} aria-live="polite">
        {waiting ? `Waiting for ${p.waiting_for?.join(' and ')} to finish first` : line}
      </p>
      {error ? (
        <Notice tone="danger" title="That didn’t go through" role="alert">
          <p>{error}</p>
        </Notice>
      ) : null}
      <div className={styles.card}>
        {move.folders.map((f) => {
          const doneFolder = f.copied_files >= f.files && f.files > 0;
          const current = !doneFolder && p.role === f.role && p.phase === 'copying';
          const fpct = f.bytes
            ? Math.min(
                100,
                ((current ? Math.max(f.copied_bytes, 0) : f.copied_bytes) / f.bytes) * 100,
              )
            : 0;
          return (
            <div
              key={f.role}
              className={`${styles.row} ${styles.rowWithIcon}`}
              data-folder={f.role}
            >
              {doneFolder ? (
                <Tick />
              ) : current ? (
                <span className={styles.spinner} aria-hidden="true" />
              ) : (
                <span className={styles.numberChip} aria-hidden="true" />
              )}
              <div style={{ minWidth: 0 }}>
                <p className={styles.rowName}>{f.label}</p>
                {current ? (
                  <>
                    <div className={`${styles.bar} ${styles.barSmall} ${styles.hidePhone}`}>
                      <span style={{ width: `${fpct}%` }} />
                    </div>
                    <p
                      className={`${styles.rowMeta} ${styles.rowMetaEllipsis}`}
                      title={p.current ?? undefined}
                    >
                      <span className={styles.wide}>
                        {sizeOf(f.copied_bytes, f.bytes)} · {f.copied_files.toLocaleString('en-GB')}{' '}
                        of {count(f.files, 'file')}
                        {p.current ? ` · ${p.current}` : ''}
                      </span>
                      <span className={styles.phoneOnly}>
                        {f.copied_files.toLocaleString('en-GB')} of {count(f.files, 'file')}
                      </span>
                    </p>
                  </>
                ) : (
                  <p className={`${styles.rowMeta} ${styles.hidePhone}`}>{folderLine(f)}</p>
                )}
              </div>
              <span className={styles.rowEnd} data-tone={current ? 'accent' : undefined}>
                {doneFolder ? 'Copied' : current ? 'Copying' : 'Waiting'}
              </span>
            </div>
          );
        })}
      </div>
      <p className={styles.tintBox}>
        <span className={styles.dot} aria-hidden="true" />
        <span>
          <span className={styles.wide}>
            Paused meanwhile: {pausedWords(move)}. Your music plays from {source} as before; you can
            close this page and Activity will show the copy.
          </span>
          <span className={styles.phoneOnly}>
            {pausedWords(move, true)} are paused. You can close this; Activity shows the copy.
          </span>
        </span>
      </p>
    </FlowShell>
  );
}

// ── Checking every file, then switching over (14h) ────────────────────────────

export function SwitchStep({ move, act, close }: RunProps) {
  const plan = move.plan;
  const target = plan?.target_label ?? 'the new drive';
  const p = move.progress;
  const total = p.total ?? move.folders.reduce((n, f) => n + f.files, 0);
  const checked = p.checked ?? 0;
  const switching = move.status === 'switching';
  const checkedAll = switching || p.phase === 'verified';
  const pct = total ? Math.min(100, (checked / total) * 100) : 0;
  const media = 'Plex';
  const step = p.step;
  const rows: Array<{ n: number; title: string; meta: string; state: 'done' | 'now' | 'next' }> = [
    {
      n: 3,
      title: `Switch SYNCHRO.S to ${target}`,
      meta: `The three folder settings${plan?.library_paths ? ` and the ${plan.library_paths.toLocaleString('en-GB')} paths it keeps` : ''}`,
      state: switching ? (step === 'settings' ? 'now' : 'done') : 'next',
    },
    {
      n: 4,
      title: `Point slskd and ${media} at ${target}`,
      meta: `slskd rescans what it shares; ${media} gets the new folder in its Music library`,
      state: switching ? (step === 'services' ? 'now' : step === 'done' ? 'done' : 'next') : 'next',
    },
    {
      n: 5,
      title: 'Start what was paused',
      meta: pausedWords(move, true).replace(
        /^Downloads, imports/,
        'Downloads, Wanted’s searches, auto-import',
      ),
      state: 'next',
    },
  ];
  return (
    <FlowShell
      step={null}
      promise={move.promise}
      leaveLabel="Close"
      onLeave={close}
      phoneTitle="Move to another drive"
      footer={
        switching ? (
          <p className={styles.footNote}>The switch takes a few seconds.</p>
        ) : (
          <StopAndUndo move={move} act={act} note="Available until the switch starts." />
        )
      }
    >
      <h2 className={styles.title}>Checking every file, then switching over</h2>
      <p className={styles.lead}>
        Nothing switches until every file matches. The switch itself takes a few seconds; if any
        part of it fails, SYNCHRO.S switches back.
      </p>
      <ol className={styles.card} style={{ listStyle: 'none', margin: 0 }}>
        <li className={`${styles.row} ${styles.rowWithIcon}`}>
          <Tick />
          <div>
            <p className={styles.rowName}>Copied {sizeWords(move.progress.total_bytes)}</p>
            <p className={`${styles.rowMeta} ${styles.hidePhone}`}>
              {count(
                move.folders.reduce((n, f) => n + f.files, 0),
                'file',
              )}
            </p>
          </div>
          <span />
        </li>
        <li className={`${styles.row} ${styles.rowWithIcon}`}>
          {checkedAll ? <Tick /> : <span className={styles.spinner} aria-hidden="true" />}
          <div style={{ minWidth: 0 }}>
            <p className={styles.rowName}>
              {move.choice.checksum
                ? 'Checking each file’s contents'
                : 'Checking each file’s count and size'}
            </p>
            {!checkedAll ? (
              <div className={`${styles.bar} ${styles.barSmall}`}>
                <span style={{ width: `${pct}%` }} />
              </div>
            ) : null}
            <p className={styles.rowMeta}>
              {checked.toLocaleString('en-GB')} of {total.toLocaleString('en-GB')} match
              <span className={styles.wide}>
                {p.different
                  ? ` · ${count(p.different, 'file')} different`
                  : ' · none different so far'}
              </span>
            </p>
          </div>
          <span />
        </li>
        {rows.map((r) => (
          <li key={r.n} className={`${styles.row} ${styles.rowWithIcon}`}>
            {r.state === 'done' ? (
              <Tick />
            ) : r.state === 'now' ? (
              <span className={styles.spinner} aria-hidden="true" />
            ) : (
              <span className={styles.numberChip}>{r.n}</span>
            )}
            <div>
              <p className={styles.rowName} data-quiet={r.state === 'next' ? 'true' : undefined}>
                {r.title}
              </p>
              <p className={`${styles.rowMeta} ${styles.hidePhone}`}>{r.meta}</p>
            </div>
            <span />
          </li>
        ))}
      </ol>
      <p className={`${styles.note} ${styles.phoneOnly}`}>
        Nothing switches until every file matches; if any part of the switch fails, SYNCHRO.S
        switches back.
      </p>
    </FlowShell>
  );
}

// ── Done (14i) ────────────────────────────────────────────────────────────────

export function DoneStep({ move, act, done, busy, error }: RunProps) {
  const plan = move.plan;
  const target = plan?.target_label ?? 'the new drive';
  const source = plan?.source_label ?? 'the old drive';
  const [removing, setRemoving] = useState(false);
  const [askBack, setAskBack] = useState(false);
  const checks = move.result.checks ?? [];
  const removed = move.status === 'removed' ? move.result.removed : null;
  return (
    <FlowShell
      step={null}
      promise={move.promise}
      leaveLabel={null}
      onLeave={done}
      phoneTitle="Move to another drive"
      footer={
        <div className={styles.footEnd}>
          <Button size="lg" variant="primary" onClick={done}>
            Back to Settings
          </Button>
        </div>
      }
    >
      <h2 className={styles.title}>Your music now lives on {target}</h2>
      <p className={`${styles.lead} ${styles.hidePhone}`}>
        Everything is working from the new place, and everything that was paused has started again.
      </p>
      {error ? (
        <Notice tone="danger" title="That didn’t go through" role="alert">
          <p>{error}</p>
        </Notice>
      ) : null}
      <div className={styles.card}>
        {checks.map((c) => (
          <div key={c.key} className={`${styles.row} ${styles.rowWithIcon}`}>
            <Tick tone={c.ok ? 'success' : 'warning'} />
            <div style={{ minWidth: 0 }}>
              <p className={styles.rowName}>{c.title}</p>
              {c.detail ? (
                <p className={`${styles.rowMeta} ${c.mono ? styles.mono : ''} ${styles.hidePhone}`}>
                  {c.detail}
                </p>
              ) : null}
            </div>
            <span />
          </div>
        ))}
      </div>
      {removed ? (
        <Notice
          tone="success"
          layout="stacked"
          role="status"
          title={`The old copies are gone from ${source}`}
        >
          <p>
            {count(removed.files, 'file')} deleted, {sizeWords(removed.bytes)} free again.
            {removed.skipped
              ? ` ${count(removed.skipped, 'file')} changed since the check, so they were left where they are.`
              : ''}
          </p>
        </Notice>
      ) : (
        <div className={styles.listBox} style={{ padding: '20px 24px' }}>
          <h3 style={{ fontSize: 18 }}>The old copies are still on {source}</h3>
          <p style={{ margin: '0 0 16px', color: 'var(--ss-text-secondary)', maxWidth: '68ch' }}>
            <span className={styles.wide}>
              {sizeWords(plan?.total_bytes)}, untouched. Keep them until you’ve played a few albums
              from {target}, then remove them to get the space back. SYNCHRO.S reminds you on Home
              in 7 days.
            </span>
            <span className={styles.phoneOnly}>
              {sizeWords(plan?.total_bytes)}, untouched. Remove them once you’ve played some music
              from {target}.
            </span>
          </p>
          {askBack ? (
            <div
              className={styles.confirmInPlace}
              style={{
                borderColor: 'var(--ss-control-border)',
                background: 'var(--ss-surface-card)',
              }}
            >
              <p>
                Switch back to {source}? Anything added on {target} since is copied back first. The
                copy on {target} stays.
              </p>
              <Button size="lg" variant="secondary" onClick={() => setAskBack(false)}>
                Keep {target}
              </Button>
              <Button
                size="lg"
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void act(() => drivesApi.switchBack(move.id)).then(() => setAskBack(false))
                }
              >
                {busy ? 'Switching back…' : 'Switch back'}
              </Button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <Button size="lg" variant="secondary" onClick={() => setRemoving(true)}>
                Remove the old copies…
              </Button>
              <Button size="lg" variant="secondary" onClick={() => setAskBack(true)}>
                <span className={styles.wide}>Switch back to {source}…</span>
                <span className={styles.phoneOnly}>Switch back…</span>
              </Button>
            </div>
          )}
        </div>
      )}
      {removing ? (
        <RemoveOldCopies
          move={move}
          onClose={() => setRemoving(false)}
          onDone={(next) => {
            setRemoving(false);
            void act(() => Promise.resolve(next));
          }}
        />
      ) : null}
    </FlowShell>
  );
}

// ── Failure (14j) ─────────────────────────────────────────────────────────────

export function failureTitle(f: Failure, target: string): string {
  switch (f.kind) {
    case 'drive_away':
      return `The copy stopped: ${target} went away`;
    case 'full':
      return `The copy stopped: ${target} filled up`;
    case 'mismatch':
      return `${count(f.count ?? 0, 'file')} didn’t match`;
    case 'unreadable':
      return 'Couldn’t read some old files';
    case 'refused':
      return 'The switch was refused';
    case 'restart':
      return 'The copy stopped when SYNCHRO.S restarted';
    default:
      return 'The copy stopped';
  }
}

export function FailureView({ move, act, close, busy, error }: RunProps) {
  const f = move.failure as Failure;
  const plan = move.plan;
  const target = plan?.target_label ?? f.target_label ?? 'the new drive';
  const source = plan?.source_label ?? f.source_label ?? 'the old drive';
  const autos = plan?.automations.length ?? 0;
  const restarted = `downloads, imports${autos ? ` and the ${count(autos, 'automation')}` : ''} have started again.`;
  const deleteCopy = () => act(() => drivesApi.stop(move.id));
  const carryOn = () => act(() => drivesApi.resume(move.id));
  let primary: { label: string; run: () => Promise<boolean> } | null = null;
  let secondary: { label: string; run: () => Promise<boolean> } | null = {
    label: 'Delete the half-made copy',
    run: deleteCopy,
  };
  let note: string | null = null;
  if (f.kind === 'drive_away' || f.kind === 'restart' || f.kind === 'write' || f.kind === 'error') {
    primary = {
      label: f.kind === 'drive_away' ? 'Plug it in and carry on' : 'Carry on',
      run: carryOn,
    };
    note = `Carry on checks the drive again, keeps the ${(f.matching_files ?? 0).toLocaleString('en-GB')} files that match and copies the rest.`;
  } else if (f.kind === 'full') {
    primary = { label: 'Carry on', run: carryOn };
    note = `Free some space on ${target} first; carry on keeps what's copied.`;
  } else if (f.kind === 'mismatch') {
    primary = { label: 'Copy them again', run: () => act(() => drivesApi.recopy(move.id)) };
    note = 'Then the check runs again for those files.';
  } else if (f.kind === 'unreadable') {
    primary = {
      label: 'Carry on without them',
      run: () => act(() => drivesApi.skipUnreadable(move.id)),
    };
    secondary = { label: 'Stop and undo', run: deleteCopy };
    note = 'They stay where they are, and Library flags them.';
  } else if (f.kind === 'refused') {
    primary = { label: 'Try the switch again', run: carryOn };
    note = null;
  }
  return (
    <FlowShell
      step={null}
      promise={move.promise}
      leaveLabel="Leave"
      onLeave={close}
      phoneTitle="Move to another drive"
      footer={
        <div className={`${styles.footEnd} ${styles.phoneOnly}`} style={{ width: '100%' }}>
          {primary ? (
            <Button size="lg" variant="primary" disabled={busy} onClick={() => void primary?.run()}>
              {primary.label}
            </Button>
          ) : null}
          {secondary ? (
            <Button
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={() => void secondary?.run()}
            >
              {secondary.label}
            </Button>
          ) : null}
        </div>
      }
    >
      <Notice
        tone="danger"
        layout="stacked"
        role="alert"
        data-failure={f.kind}
        title={<span style={{ fontSize: 22 }}>{failureTitle(f, target)}</span>}
        actions={
          <span className={styles.hidePhone} style={{ display: 'contents' }}>
            {primary ? (
              <Button
                size="lg"
                variant="primary"
                disabled={busy}
                onClick={() => void primary?.run()}
              >
                {primary.label}
              </Button>
            ) : null}
            {secondary ? (
              <Button
                size="lg"
                variant="secondary"
                disabled={busy}
                onClick={() => void secondary?.run()}
              >
                {secondary.label}
              </Button>
            ) : null}
          </span>
        }
      >
        <p>
          {f.kind === 'refused'
            ? f.words.replace(/ So SYNCHRO\.S switched back\..*$/, '')
            : f.words}{' '}
          <strong>Your music is untouched on {source}</strong> and SYNCHRO.S is still using it
          {f.kind === 'refused'
            ? `; SYNCHRO.S switched back and the copy on ${target} is kept.`
            : `; ${restarted}`}
        </p>
        {f.files?.length ? (
          <ul className={styles.failureList}>
            {f.files.slice(0, 12).map((x) => (
              <li key={`${x.role}/${x.rel}`}>
                <code className={styles.mono}>{x.rel}</code>
                {x.size ? ` · ${sizeWords(x.size)}` : ''} · {x.why}
              </li>
            ))}
            {(f.count ?? 0) > 12 ? <li>and {count((f.count ?? 0) - 12, 'more file')}</li> : null}
          </ul>
        ) : null}
        {note ? <p className={styles.note}>{note}</p> : null}
      </Notice>
      {error ? (
        <Notice tone="danger" title="That didn’t go through" role="alert">
          <p>{error}</p>
        </Notice>
      ) : null}
    </FlowShell>
  );
}

// ── Stopped, or switched back ─────────────────────────────────────────────────

export function EndView({ move, close }: RunProps) {
  const plan = move.plan;
  const target = plan?.target_label ?? 'the new drive';
  const source = plan?.source_label ?? 'the old drive';
  const back = move.status === 'switched_back';
  return (
    <FlowShell
      step={null}
      promise={move.promise}
      leaveLabel={null}
      onLeave={close}
      footer={
        <div className={styles.footEnd}>
          <Button size="lg" variant="primary" onClick={close}>
            Close
          </Button>
        </div>
      }
    >
      <h2 className={styles.title}>{back ? `Switched back to ${source}` : 'Nothing was moved'}</h2>
      <p className={styles.lead}>
        {back
          ? `SYNCHRO.S, slskd and your media server read ${source} again, and what was added on ${target} since was copied back. The copy on ${target} is still there; delete it in Finder when you like.`
          : plan
            ? `The half-made copy on ${target} is gone and everything that was paused has started again. Your music is untouched on ${source}.`
            : 'Nothing changed. Your music is where it was.'}
      </p>
    </FlowShell>
  );
}
