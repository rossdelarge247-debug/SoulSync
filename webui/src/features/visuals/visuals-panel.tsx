/**
 * The Visuals panel (10a, 10b, 10d's SYNCHRO.S grid; the phone sheet 10e):
 * a 520px drawer on the right, inset 16px under the header and above the
 * transport, `#141416`, 14px radius. Title and close, the family row of
 * OptionButtons (SYNCHRO.S / MilkDrop / Classic; AVS isn't built), one
 * family's content, and the foot: MilkDrop's "Every preset" (18a), Auto-cycle,
 * Blend and Quality. On a phone
 * it's a 560px sheet with a grabber; the family and Show rows scroll
 * sideways and Author and Blend live in Player settings.
 */

import { useEffect, useRef } from 'react';

import { LabelledSwitch, OptionButton, Select } from '@/components/form';
import { StatusTag } from '@/components/primitives';

import type { Family } from './visuals.types';

import { BAR_COUNT, drawBars, drawScope, newBarsState, stillBars, stillWave } from './classic';
import { MilkdropBrowser } from './milkdrop-browser';
import { useVisuals, useVisualsController } from './use-visuals';
import { autocycleChoices, autocycleWords } from './visuals.logic';
import styles from './visuals.module.css';
import { FAMILIES, FAMILY_NAMES, QUALITIES, QUALITY_NAMES } from './visuals.types';

export const PANEL_ID = 'ss-visuals-panel';

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function VisualsPanel() {
  const s = useVisuals();
  const c = useVisualsController();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!s.panelOpen) return;
    // focus the panel's selected family when it opens (keyboard users land inside)
    const t = setTimeout(() => {
      ref.current?.querySelector<HTMLElement>('[data-family][data-selected="true"]')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [s.panelOpen]);

  if (!s.panelOpen) return null;
  return (
    <aside
      ref={ref}
      id={PANEL_ID}
      className={styles.panel}
      data-phone={s.phone ? 'true' : undefined}
      aria-label="Visuals"
    >
      {s.phone ? <span className={styles.grabber} aria-hidden="true" /> : null}
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Visuals</h2>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Close the panel (Esc)"
          onClick={() => c.togglePanel(false)}
        >
          <CloseIcon />
        </button>
      </div>
      <div className={styles.familyRow} role="group" aria-label="Family">
        {FAMILIES.map((f) => (
          <OptionButton
            key={f}
            data-family={f}
            selected={s.family === f}
            onClick={() => c.setFamily(f)}
          >
            {FAMILY_NAMES[f]}
          </OptionButton>
        ))}
      </div>
      <div className={styles.panelBody} data-family={s.family}>
        {s.family === 'milkdrop' ? <MilkdropBrowser /> : null}
        {s.family === 'synchros' ? <SynchrosGrid /> : null}
        {s.family === 'classic' ? <ClassicChoices /> : null}
      </div>
      <PanelFoot family={s.family} />
    </aside>
  );
}

function SynchrosGrid() {
  const s = useVisuals();
  const c = useVisualsController();
  const ac = autocycleWords(s.autocycle);
  return (
    <div className={styles.synchros}>
      <p className={styles.familyNote}>
        {s.themes.length} visuals · drawn by SYNCHRO.S
        {ac ? ` · auto-cycle ${ac}` : ''}
      </p>
      <div className={styles.tiles} role="group" aria-label="SYNCHRO.S visuals">
        {s.themes.map((t) => (
          <button
            key={t.id}
            type="button"
            className={styles.tile}
            aria-pressed={s.theme === t.id}
            title={t.blurb}
            onClick={() => c.pickTheme(t.id)}
          >
            <span
              className={`${styles.tileStill} npv2-theme-swatch theme-${t.id}`}
              aria-hidden="true"
            />
            <span className={styles.tileName}>{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ClassicStill({ mode }: { mode: 'bars' | 'scope' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (mode === 'bars') {
      const st = newBarsState(BAR_COUNT);
      const lv = stillBars(11);
      st.levels = lv;
      st.peaks = lv.map((v) => Math.min(1, v + 0.08));
      st.hold = lv.map(() => 0);
      st.speed = lv.map(() => 0);
      drawBars(ctx, st, { x: 24, y: 20, w: w - 48, h: h - 32 }, { peaks: false, scale: 0.6 });
    } else {
      drawScope(ctx, stillWave(48), { x: 24, y: 16, w: w - 48, h: h - 32 }, 'lines', 0.8);
    }
  }, [mode]);
  return (
    <canvas ref={ref} width={460} height={240} className={styles.classicStill} aria-hidden="true" />
  );
}

function ClassicChoices() {
  const s = useVisuals();
  const c = useVisualsController();
  return (
    <div className={styles.classic}>
      <p className={styles.familyNote}>
        Winamp’s own two, drawn by SYNCHRO.S at the screen’s size: the 19-bar spectrum with falling
        peaks, and the oscilloscope.
      </p>
      <div className={styles.classicTiles}>
        {(['bars', 'scope'] as const).map((mode) => {
          const on = s.classicMode === mode;
          return (
            <div key={mode} className={styles.classicCol}>
              <button
                type="button"
                className={styles.classicTile}
                aria-pressed={on}
                onClick={() => c.setClassicMode(mode)}
              >
                <ClassicStill mode={mode} />
                <span className={styles.classicTileFoot}>
                  <span>{mode === 'bars' ? 'Bars' : 'Scope'}</span>
                  {on ? (
                    <StatusTag tone="info" live>
                      Playing
                    </StatusTag>
                  ) : null}
                </span>
              </button>
              {mode === 'bars' ? (
                <div className={styles.classicSetting}>
                  <span id="ss-visuals-peaks">Falling peaks</span>
                  <LabelledSwitch
                    aria-labelledby="ss-visuals-peaks"
                    checked={s.classicPeaks}
                    onCheckedChange={(v) => c.setClassicPeaks(v)}
                  />
                </div>
              ) : (
                <div className={styles.classicSetting}>
                  <span id="ss-visuals-drawn">Drawn as</span>
                  <Select
                    size="lg"
                    aria-labelledby="ss-visuals-drawn"
                    value={s.scopeDraw}
                    onChange={(e) => c.setScopeDraw(e.target.value as 'lines' | 'dots' | 'solid')}
                  >
                    <option value="lines">Lines</option>
                    <option value="dots">Dots</option>
                    <option value="solid">Solid</option>
                  </Select>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FootRow({
  label,
  meta,
  id,
  children,
}: {
  label: string;
  meta: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.footRow}>
      <div className={styles.footText}>
        <span id={id} className={styles.footLabel}>
          {label}
        </span>
        <span id={`${id}-meta`} className={styles.footMeta}>
          {meta}
        </span>
      </div>
      <div className={styles.footControl}>{children}</div>
    </div>
  );
}

function PanelFoot({ family }: { family: Family }) {
  const s = useVisuals();
  const c = useVisualsController();
  if (family === 'milkdrop' && (!s.webgl2 || s.engineError)) return null;
  const classic = family === 'classic';
  const more = s.index.uncurated ?? 0;
  const everyRow =
    family === 'milkdrop' && s.index.status === 'ready' && (more > 0 || s.everyPreset);
  return (
    <div className={styles.foot}>
      {everyRow ? (
        <FootRow
          id="ss-visuals-every"
          label="Every preset"
          meta={`Adds ${more.toLocaleString('en-GB')} more, uncurated: some names are crude, some won’t load.`}
        >
          <LabelledSwitch
            aria-labelledby="ss-visuals-every"
            aria-describedby="ss-visuals-every-meta"
            checked={s.everyPreset}
            onCheckedChange={(v) => c.setEveryPreset(v)}
          />
        </FootRow>
      ) : null}
      <FootRow
        id="ss-visuals-autocycle"
        label="Auto-cycle"
        meta={
          classic
            ? 'Doesn’t apply to Classic: there are two'
            : family === 'milkdrop'
              ? 'Moves to the next preset by itself'
              : 'Moves to the next visual by itself'
        }
      >
        <Select
          size="lg"
          aria-labelledby="ss-visuals-autocycle"
          aria-describedby="ss-visuals-autocycle-meta"
          aria-disabled={classic || undefined}
          data-disabled-neutral={classic ? 'true' : undefined}
          className={styles.footSelect}
          value={s.autocycle}
          onChange={(e) => {
            if (!classic) c.setAutocycle(e.target.value as never);
          }}
          onMouseDown={(e) => {
            if (classic) e.preventDefault();
          }}
          onKeyDown={(e) => {
            if (classic && e.key !== 'Tab') e.preventDefault();
          }}
        >
          {autocycleChoices(s.autocycle).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </FootRow>
      {family === 'milkdrop' && !s.phone ? (
        <FootRow
          id="ss-visuals-blend"
          label="Blend between presets"
          meta="A 2-second crossfade; off, they cut"
        >
          <LabelledSwitch
            aria-labelledby="ss-visuals-blend"
            aria-describedby="ss-visuals-blend-meta"
            checked={s.blend}
            onCheckedChange={(v) => c.setBlend(v)}
          />
        </FootRow>
      ) : null}
      {family === 'milkdrop' ? (
        <FootRow
          id="ss-visuals-quality"
          label="Quality"
          meta={s.phone ? 'Lower it to spare the battery' : 'Lower it if the picture stutters'}
        >
          <div className={styles.qualityRow} role="group" aria-labelledby="ss-visuals-quality">
            {QUALITIES.map((q) => (
              <OptionButton key={q} selected={s.quality === q} onClick={() => c.setQuality(q)}>
                {QUALITY_NAMES[q]}
              </OptionButton>
            ))}
          </div>
        </FootRow>
      ) : null}
      {classic ? (
        <FootRow id="ss-visuals-quality" label="Quality" meta="Classic always draws at full size">
          <span className={styles.footValue}>Full</span>
        </FootRow>
      ) : null}
    </div>
  );
}
