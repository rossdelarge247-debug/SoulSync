/**
 * The Monitor block (3b, 37g's centre under the echo; 441, 37r) and the DJ
 * outputs panel (Player settings → Playback → DJ outputs, and "Outputs…").
 *
 * The block: a headphone icon, the device line ("Scarlett 2i2 · speakers on
 * Built-in Output"), Outputs…, Cue mix (cue only ↔ what the speakers hear,
 * with its words) and Cue volume. Not drawn with one output (unless split
 * cue is on); amber while the headphones are lost.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import type { DjMixSession } from './dj-mix-session';
import type { DjOutputs } from './dj-outputs-host';

import styles from './dj-mixer.module.css';
import { cueMixWords, cueVolumeWords, monitorLine, monitorShown } from './dj-outputs';

function useOutputs(outputs: DjOutputs) {
  return useSyncExternalStore(outputs.subscribe, outputs.snapshot, outputs.snapshot);
}

export function MonitorBlock({
  session,
  outputs,
  addCloser,
}: {
  session: DjMixSession;
  outputs: DjOutputs;
  /** the overlay's Esc closes the dialog first (the store's) */
  addCloser?: (close: () => void) => () => void;
}) {
  const o = useOutputs(outputs);
  const v = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const [open, setOpen] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    return addCloser?.(() => {
      setOpen(false);
      back.current?.focus();
    });
  }, [open, addCloser]);
  if (!monitorShown(o.state)) return null;
  const cued = (['A', 'B'] as const).filter((d) => v.decks[d].phones);
  const cuedWords =
    cued.length === 2 ? 'A and B' : cued.length ? `${cued[0]} alone` : 'nothing cued';
  const mix = v.monitor.mix;
  const vol = v.monitor.volume;
  return (
    <div
      className={styles.monitor}
      data-dj-monitor=""
      data-state={o.state.case}
      role="group"
      aria-label="Monitor"
    >
      <div className={styles.monitorHead}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.icon}>
          <path
            d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
        <span className={styles.monitorLine}>{monitorLine(o.state)}</span>
        <button
          ref={back}
          type="button"
          className={styles.linkBtn}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          Outputs…
        </button>
      </div>
      <div className={styles.monitorRow}>
        <label className={styles.monitorControl}>
          <span className={styles.controlLabel}>Cue mix</span>
          <input
            type="range"
            className={styles.range}
            min={0}
            max={100}
            step={5}
            value={mix}
            aria-label="Cue mix"
            aria-valuetext={cueMixWords(mix, cuedWords)}
            onChange={(e) => session.setMonitor(Number(e.target.value), vol)}
          />
          <output className={styles.value} aria-hidden="true">
            {cueMixWords(mix, cuedWords)}
          </output>
        </label>
        <label className={styles.monitorControl}>
          <span className={styles.controlLabel}>Cue volume</span>
          <input
            type="range"
            className={styles.range}
            min={-24}
            max={6}
            step={1}
            value={vol}
            aria-label="Cue volume"
            aria-valuetext={cueVolumeWords(vol)}
            onChange={(e) => session.setMonitor(mix, Number(e.target.value))}
          />
          <output className={styles.value} aria-hidden="true">
            {cueVolumeWords(vol)}
          </output>
        </label>
      </div>
      {open ? (
        <OutputsDialog
          outputs={outputs}
          onClose={() => {
            setOpen(false);
            back.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function OutputsDialog({ outputs, onClose }: { outputs: DjOutputs; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const title = useId();
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('select, input, button')?.focus();
  }, []);
  return (
    <div className={styles.browseScrim} data-dj-outputs-dialog="">
      <div
        ref={ref}
        className={styles.outputsDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        data-open=""
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className={styles.browseHead}>
          <h2 id={title} className={styles.browseTitle}>
            DJ outputs
          </h2>
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <OutputsPanel outputs={outputs} />
      </div>
    </div>
  );
}

/**
 * The DJ outputs (37r): the speakers (the player's own output, changed with
 * its Output button), the headphones (a device, or none), and split cue.
 * Player settings → Playback → DJ outputs and the Monitor's "Outputs…".
 */
export function OutputsPanel({ outputs }: { outputs: DjOutputs }) {
  const o = useOutputs(outputs);
  const id = useId();
  const st = o.state;
  const others = o.devices.filter((d) => d.id !== st.speakers.id);
  const chosen = o.prefs.none ? '' : (st.headphones?.id ?? '');
  useEffect(() => {
    void outputs.refresh();
  }, [outputs]);
  return (
    <div className={styles.outputs} data-dj-outputs="">
      <p className={styles.outputsRow}>
        <span className={styles.outputsLabel}>Speakers</span>
        <span className={styles.outputsValue} data-tone={st.speakers.connected ? 'ok' : 'warn'}>
          {st.speakers.connected ? st.speakers.label : `${st.speakers.label} isn’t connected`}
        </span>
      </p>
      <p className={styles.outputsNote}>
        The player’s own output: change it with the player’s Output button. Nothing about the player
        changes when DJ mode is off.
      </p>
      <label className={styles.outputsRow} htmlFor={`${id}-phones`}>
        <span className={styles.outputsLabel}>Headphones</span>
        <select
          id={`${id}-phones`}
          className={styles.outputsSelect}
          value={chosen}
          disabled={Boolean(st.why)}
          onChange={(e) => {
            const d = o.devices.find((x) => x.id === e.target.value) ?? null;
            outputs.setHeadphones(d);
          }}
        >
          <option value="">None</option>
          {others.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
          {st.case === 'phonesLost' && st.headphones ? (
            <option value={st.headphones.id}>{st.headphones.label} (not connected)</option>
          ) : null}
        </select>
      </label>
      <p className={styles.outputsNote}>
        {st.why ??
          (o.unnamed
            ? 'The browser hides the outputs’ names until it’s allowed the microphone; they’re numbered here.'
            : 'By default the newest output that isn’t the speakers; remembered by name and found again when plugged in.')}
      </p>
      <label className={styles.outputsRow}>
        <span className={styles.outputsLabel}>Split cue</span>
        <input
          type="checkbox"
          checked={o.prefs.split}
          disabled={st.case === 'two'}
          onChange={(e) => outputs.setSplit(e.target.checked)}
        />
      </label>
      <p className={styles.outputsNote}>
        With one output: the cue in the left ear, the speakers in the right, mono each. Off unless
        you ask, because it changes what the room hears.
      </p>
    </div>
  );
}
