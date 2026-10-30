/**
 * Data's controls (30a's pill: Hex · Decimal, Bits, Texture, Colour) on the
 * stage above the transport, shown and hidden with the chrome, and the same
 * in the panel's Data body; and Classic's "Data underneath" switches (30d).
 * The drawing is a canvas (aria-hidden), so the readout's lines 1 and 2 are
 * also in the pill as text for a screen reader.
 */

import { LabelledSwitch, OptionButton, Select } from '@/components/form';

import type { DataColour } from './data-viz';

import { DATA_COLOUR_NAMES, DATA_COLOURS } from './data-viz';
import { useVisuals, useVisualsController } from './use-visuals';
import styles from './visuals.module.css';

export function DataSettings({ idPrefix, compact }: { idPrefix: string; compact?: boolean }) {
  const s = useVisuals();
  const c = useVisualsController();
  const d = s.data;
  return (
    <div className={compact ? styles.dataPillRow : styles.dataSettings}>
      <div className={styles.dataNumbers} role="group" aria-label="Sample values">
        <OptionButton selected={d.numbers === 'hex'} onClick={() => c.setData({ numbers: 'hex' })}>
          Hex
        </OptionButton>
        <OptionButton selected={d.numbers === 'dec'} onClick={() => c.setData({ numbers: 'dec' })}>
          Decimal
        </OptionButton>
      </div>
      <div className={styles.dataSetting}>
        <span id={`${idPrefix}-bits`}>Bits</span>
        <LabelledSwitch
          aria-labelledby={`${idPrefix}-bits`}
          checked={d.bits}
          onCheckedChange={(v) => c.setData({ bits: v })}
        />
      </div>
      <div className={styles.dataSetting}>
        <span id={`${idPrefix}-texture`}>Texture</span>
        <LabelledSwitch
          aria-labelledby={`${idPrefix}-texture`}
          checked={d.texture}
          onCheckedChange={(v) => c.setData({ texture: v })}
        />
      </div>
      <div className={styles.dataSetting}>
        <span id={`${idPrefix}-colour`}>Colour</span>
        <Select
          size="lg"
          aria-labelledby={`${idPrefix}-colour`}
          value={d.colour}
          onChange={(e) => c.setData({ colour: e.target.value as DataColour })}
        >
          {DATA_COLOURS.map((k) => (
            <option key={k} value={k}>
              {DATA_COLOUR_NAMES[k]}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/** The pill above the transport while Data is the visual (30a). */
export function DataPill() {
  const s = useVisuals();
  // on a phone the controls are in the Visuals sheet (30c draws no pill on the stage)
  if (!s.open || s.engine !== 'data' || s.panelOpen || s.phone) return null;
  return (
    <div className={styles.dataPill} role="group" aria-label="Data" data-visuals-data-pill>
      {s.dataSummary ? <p className={styles.srOnly}>{s.dataSummary}</p> : null}
      <DataSettings idPrefix="ss-data-pill" compact />
    </div>
  );
}

/** The panel's Data body (10a's picker). */
export function DataChoices() {
  return (
    <div className={styles.classic}>
      <p className={styles.familyNote}>
        The samples the browser decoded, as numbers and bits: the newest from each channel, sixty
        times a second, and the file’s format from the library. Drawn by SYNCHRO.S.
      </p>
      <DataSettings idPrefix="ss-data-panel" />
    </div>
  );
}

/** "Data underneath" in each of Classic's two (30d), off by default. */
export function DataUnderneath({ mode }: { mode: 'bars' | 'scope' }) {
  const s = useVisuals();
  const c = useVisualsController();
  const on = mode === 'bars' ? s.data.underBars : s.data.underScope;
  const id = `ss-visuals-under-${mode}`;
  return (
    <div className={styles.classicSetting}>
      <span id={id}>Data underneath</span>
      <LabelledSwitch
        aria-labelledby={id}
        checked={on}
        onCheckedChange={(v) => c.setData(mode === 'bars' ? { underBars: v } : { underScope: v })}
      />
    </div>
  );
}
