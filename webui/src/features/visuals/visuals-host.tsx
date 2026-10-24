/**
 * Mounts the Visuals overlay's new pieces into the legacy overlay
 * (`#np-modal-overlay` in index.html, painted by static/media-player-v2.js):
 * two stage canvases (MilkDrop's WebGL one and Classic's 2D one), the panel,
 * the credit and the state cards, plus the MilkDrop group in Player settings.
 * The legacy engine reaches this through `window.SoulSyncVisuals` for the
 * overlay's keys, the header's ‹ › and Escape.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { Button, LabelledSwitch, Select } from '@/components/form';

import type { VisualsSnapshot } from './visuals-controller';
import type { OverlayKey } from './visuals.logic';

import { useVisuals, useVisualsController, VisualsContext } from './use-visuals';
import { fetchSettings, saveOwnFolder, type VisualsSettings } from './visuals-api';
import { VisualsController } from './visuals-controller';
import { PANEL_ID, VisualsPanel } from './visuals-panel';
import { FailureCard, RadioCard, StillCard, VisualsCredit } from './visuals-stage-cards';
import { ownFolderLine } from './visuals.logic';
import styles from './visuals.module.css';

export interface SoulSyncVisualsBridge {
  key(action: OverlayKey): void;
  step(dir: 1 | -1): void;
  panelOpen(): boolean;
  closePanel(): void;
  togglePanel(): void;
  themeChanged(id: string): void;
  snapshot(): VisualsSnapshot;
  controller: VisualsController;
}

declare global {
  interface Window {
    SoulSyncVisuals?: SoulSyncVisualsBridge;
  }
}

function trackArt(): string | null {
  const w = window as Window & {
    SoulSyncPlayer?: {
      state?: () => { track?: { image_url?: string | null } | null };
    };
  };
  try {
    return w.SoulSyncPlayer?.state?.()?.track?.image_url || null;
  } catch {
    return null;
  }
}

/** The header's ‹ name › and the Visuals button, kept in step with the store. */
function HeaderBridge() {
  const s = useVisuals();
  useEffect(() => {
    const name = document.getElementById('np-v2-visuals-theme-name');
    const meta = document.getElementById('np-v2-visuals-theme-meta');
    if (name) name.textContent = s.header.name;
    if (meta) meta.textContent = s.header.meta;
    const btn = document.getElementById('np-v2-visuals-panel-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', s.panelOpen ? 'true' : 'false');
      btn.setAttribute('aria-pressed', s.panelOpen ? 'true' : 'false');
    }
    const overlay = document.getElementById('np-modal-overlay');
    if (overlay) {
      overlay.toggleAttribute('data-visuals-panel', s.panelOpen);
      overlay.toggleAttribute('data-visuals-phone', s.phone);
    }
  }, [s.header, s.panelOpen, s.phone]);
  return null;
}

function OverlayPieces() {
  const s = useVisuals();
  const [art, setArt] = useState<string | null>(null);
  useEffect(() => {
    if (s.open && s.still) setArt(trackArt());
  }, [s.open, s.still]);
  return (
    <>
      <HeaderBridge />
      <StillCard art={art} />
      <div className={styles.stageCards}>
        <RadioCard />
        <FailureCard />
        <VisualsCredit />
      </div>
      <VisualsPanel />
    </>
  );
}

/** Player settings → Visuals: MilkDrop's Blend (and Author on a phone), and
 *  for admins, the folder of your own presets with the line that says what
 *  it read, or what's wrong (18b). */
function PlayerSettingsGroup() {
  const s = useVisuals();
  const c = useVisualsController();
  const [settings, setSettings] = useState<VisualsSettings | null>(null);
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchSettings().then((st) => {
      if (!live || !st) return;
      setSettings(st);
      setFolder(st.own_presets_dir ?? '');
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (s.phone) void c.ensureIndex();
  }, [s.phone, c]);
  const ownLine = ownFolderLine(settings?.own, settings?.own_presets_dir ?? '');
  return (
    <div className={styles.settingsGroup}>
      <p className="ss-player-section">MilkDrop</p>
      <div className="ss-player-setting">
        <span id="ss-visuals-set-blend">
          Blend between presets
          <small>A 2-second crossfade; off, they cut.</small>
        </span>
        <LabelledSwitch
          aria-labelledby="ss-visuals-set-blend"
          checked={s.blend}
          onCheckedChange={(v) => c.setBlend(v)}
        />
      </div>
      {s.phone ? (
        <div className="ss-player-setting">
          <span id="ss-visuals-set-author">
            Author<small>Which presets MilkDrop’s list shows.</small>
          </span>
          <Select
            aria-labelledby="ss-visuals-set-author"
            value={s.author}
            onChange={(e) => c.setAuthor(e.target.value)}
          >
            <option value="">Any author</option>
            {s.index.authors.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name} ({a.count})
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {settings?.admin ? (
        <div className={styles.ownFolder}>
          <label className={styles.ownLabel} htmlFor="ss-visuals-own-dir">
            Your own presets
            <small>
              A folder of .milk files on the server. They join MilkDrop’s list for everyone on this
              SYNCHRO.S, under Yours.
            </small>
          </label>
          <div className={styles.ownRow}>
            <input
              id="ss-visuals-own-dir"
              className={styles.ownInput}
              value={folder}
              placeholder="/music/milkdrop"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'ss-visuals-own-error' : 'ss-visuals-own-line'}
              onChange={(e) => {
                setFolder(e.target.value);
                setError(null);
              }}
            />
            <Button
              variant="secondary"
              size="lg"
              disabled={saving}
              focusableWhenDisabled
              onClick={async () => {
                setSaving(true);
                setError(null);
                try {
                  const st = await saveOwnFolder(folder.trim());
                  setSettings(st);
                  c.reloadIndex();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save
            </Button>
          </div>
          {error ? (
            <p id="ss-visuals-own-error" className={styles.ownError}>
              {error}
            </p>
          ) : null}
          {ownLine ? (
            <p
              id="ss-visuals-own-line"
              className={styles.ownLine}
              data-tone={ownLine.tone ?? undefined}
              role="status"
            >
              {ownLine.tone ? <span className={styles.ownDot} aria-hidden="true" /> : null}
              <span>{ownLine.words}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SettingsPortal() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('ss-visuals-settings'));
  }, []);
  return target ? createPortal(<PlayerSettingsGroup />, target) : null;
}

function Root({ controller }: { controller: VisualsController }) {
  return (
    <VisualsContext.Provider value={controller}>
      <OverlayPieces />
      <SettingsPortal />
    </VisualsContext.Provider>
  );
}

let mounted: VisualsController | null = null;

export function mountVisualsHost(win: Window = window): VisualsController | null {
  if (mounted) return mounted;
  const doc = win.document;
  const overlay = doc.getElementById('np-modal-overlay');
  const modal = overlay?.querySelector<HTMLElement>('.np-modal');
  if (!overlay || !modal) return null;
  const bg = doc.getElementById('np-v2-bg');
  const gl = doc.createElement('canvas');
  gl.id = 'ss-visuals-milkdrop';
  gl.className = 'ss-visuals-stage';
  gl.setAttribute('aria-hidden', 'true');
  const c2 = doc.createElement('canvas');
  c2.id = 'ss-visuals-classic';
  c2.className = 'ss-visuals-stage';
  c2.setAttribute('aria-hidden', 'true');
  if (bg?.parentNode) {
    bg.after(gl);
    gl.after(c2);
  } else {
    modal.prepend(c2);
    modal.prepend(gl);
  }
  const host = doc.createElement('div');
  host.id = 'ss-visuals-root';
  modal.appendChild(host);

  const controller = new VisualsController({ win });
  controller.attach({ overlay, gl, canvas2d: c2 });
  mounted = controller;

  win.SoulSyncVisuals = {
    key: (a) => controller.key(a),
    step: (d) => controller.step(d),
    panelOpen: () => controller.snapshot().panelOpen,
    closePanel: () => controller.togglePanel(false),
    togglePanel: () => controller.togglePanel(),
    themeChanged: (id) => controller.themeChanged(id),
    snapshot: () => controller.snapshot(),
    controller,
  };

  const panelBtn = doc.getElementById('np-v2-visuals-panel-btn');
  panelBtn?.setAttribute('aria-controls', PANEL_ID);
  panelBtn?.addEventListener('click', () => controller.togglePanel());

  const sync = () => controller.setOpen(!overlay.classList.contains('hidden'));
  new MutationObserver(sync).observe(overlay, {
    attributes: true,
    attributeFilter: ['class'],
  });
  sync();

  createRoot(host).render(<Root controller={controller} />);
  return controller;
}
