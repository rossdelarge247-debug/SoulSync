/**
 * Settings → Library → Traktor Pro 3 (21b): a card after "BPM, key and
 * energy". Three rows at 72px on hairlines (`1fr 420px auto`): "Your music on
 * the Mac" (the Mac's name for the library folder, which "Export to
 * Traktor…" builds every path from), "Export folder" (optional; otherwise
 * exports download in the browser) and "Traktor's collection" (said, not
 * read: reading it is stage 2b). Admins change the first two and Save;
 * everyone else reads them.
 *
 * Mounted into the legacy Settings page after `#dj-settings-group`.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Button, TextInput } from '@/components/form';
import { StatusTag } from '@/components/primitives';

import {
  TraktorError,
  getTraktorSettings,
  putTraktorSettings,
  type TraktorSettings,
} from './traktor.api';
import { folderLine } from './traktor.format';
import styles from './traktor.module.css';

function MacTag({ data }: { data: TraktorSettings }) {
  if (data.mac_path_from_helper) return <StatusTag tone="success">Checked</StatusTag>;
  if (data.mac_path) return <StatusTag tone="neutral">Typed in</StatusTag>;
  return <StatusTag tone="warning">Not set</StatusTag>;
}

export function TraktorCard({ load = true }: { load?: boolean }) {
  const macId = useId();
  const folderId = useId();
  const [data, setData] = useState<TraktorSettings | null>(null);
  const [mac, setMac] = useState('');
  const [folder, setFolder] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{
    mac_path?: string;
    export_folder?: string;
    other?: string;
  }>({});
  const [failed, setFailed] = useState(false);

  const take = useCallback((next: TraktorSettings) => {
    setData(next);
    setMac(next.mac_path || next.mac_path_from_helper || '');
    setFolder(next.export_folder || '');
  }, []);

  useEffect(() => {
    if (!load) return;
    let live = true;
    getTraktorSettings()
      .then((next) => live && take(next))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [load, take]);

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setErrors({});
    try {
      take(await putTraktorSettings({ mac_path: mac.trim(), export_folder: folder.trim() }));
      window.showToast?.('Saved the Traktor settings', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : "That didn't save.";
      const field = err instanceof TraktorError ? err.field : undefined;
      setErrors(
        field === 'mac_path' || field === 'export_folder'
          ? { [field]: message }
          : { other: message },
      );
    } finally {
      setSaving(false);
    }
  };

  const edit = Boolean(data?.can_edit);
  const changed =
    data !== null &&
    (mac.trim() !== (data.mac_path || data.mac_path_from_helper || '') ||
      folder.trim() !== (data.export_folder || ''));
  const lib = data?.library_folder || '/app/Transfer';
  const folderState = data?.export_folder_state ?? 'unset';

  return (
    <section className={styles.card} aria-labelledby={`${macId}-title`} data-traktor-card="">
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle} id={`${macId}-title`}>
          Traktor Pro 3
        </h3>
        <p className={styles.cardSub}>
          Send playlists to Traktor as a file it imports. SYNCHRO.S only reads Traktor&apos;s files.
        </p>
      </div>
      {failed ? (
        <div className={`${styles.row} ${styles.rowWide}`}>
          <span className={styles.rowLine}>
            SYNCHRO.S couldn&apos;t read these settings just now.
          </span>
        </div>
      ) : null}
      <div className={styles.row}>
        <span className={styles.rowText}>
          <label className={styles.rowName} htmlFor={edit ? macId : undefined}>
            Your music on the Mac
          </label>
          <span className={styles.rowLine}>
            Where the Mac keeps what SYNCHRO.S calls <span className={styles.mono}>{lib}</span>.{' '}
            {data?.mac_path_from_helper
              ? 'Filled in by the drive helper.'
              : 'Type it as the Mac names it, like /Volumes/Music HD/SoulSync/Transfer.'}
          </span>
        </span>
        {edit ? (
          <span className={styles.field}>
            <TextInput
              id={macId}
              className={styles.mono}
              value={mac}
              placeholder="/Users/you/SoulSync/music"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={errors.mac_path ? true : undefined}
              aria-describedby={errors.mac_path ? `${macId}-error` : undefined}
              onChange={(event) => setMac(event.target.value)}
            />
            {errors.mac_path ? (
              <span id={`${macId}-error`} className={styles.fieldError}>
                {errors.mac_path}
              </span>
            ) : null}
          </span>
        ) : (
          <span className={`${styles.value} ${mac ? styles.mono : styles.valueQuiet}`}>
            {mac || 'Not set yet'}
          </span>
        )}
        <span className={styles.rowEnd}>{data ? <MacTag data={data} /> : null}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowText}>
          <label className={styles.rowName} htmlFor={edit ? folderId : undefined}>
            Export folder
          </label>
          <span className={styles.rowLine}>
            {folderLine(folderState)}
            {data?.export_folder_on_mac && folderState === 'ok' ? (
              <>
                {' '}
                On the Mac: <span className={styles.mono}>{data.export_folder_on_mac}</span>
              </>
            ) : null}
          </span>
        </span>
        {edit ? (
          <span className={styles.field}>
            <TextInput
              id={folderId}
              className={folder ? styles.mono : undefined}
              value={folder}
              placeholder="Downloads, through the browser"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={errors.export_folder ? true : undefined}
              aria-describedby={errors.export_folder ? `${folderId}-error` : undefined}
              onChange={(event) => setFolder(event.target.value)}
            />
            {errors.export_folder ? (
              <span id={`${folderId}-error`} className={styles.fieldError}>
                {errors.export_folder}
              </span>
            ) : null}
          </span>
        ) : (
          <span className={`${styles.value} ${folder ? styles.mono : styles.valueQuiet}`}>
            {folder || 'Downloads, through the browser'}
          </span>
        )}
        <span className={styles.rowEnd}>
          {folderState === 'ok' ? <StatusTag tone="success">Ready</StatusTag> : null}
          {folderState !== 'ok' && folderState !== 'unset' ? (
            <StatusTag tone="warning">Can&apos;t use it</StatusTag>
          ) : null}
        </span>
      </div>
      <div className={`${styles.row} ${styles.rowWide}`}>
        <span className={styles.rowText}>
          <span className={styles.rowName}>Traktor&apos;s collection</span>
          <span className={styles.rowLine}>
            {data?.collection ?? 'collection.nml in Documents/Native Instruments/Traktor 3.x'}.
            SYNCHRO.S doesn&apos;t read it yet: bringing Traktor&apos;s cue points, grids and
            ratings in comes next.
          </span>
        </span>
        <span className={styles.rowEnd} />
      </div>
      {edit ? (
        <div className={styles.cardFoot}>
          {errors.other ? <span className={styles.fieldError}>{errors.other}</span> : null}
          <Button
            size="lg"
            variant="secondary"
            disabled={saving || !changed}
            disabledReason={!changed && !saving ? 'Nothing changed yet' : undefined}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Puts the card after Settings → Library's "BPM, key and energy". It asks
 *  for its settings only once it's on screen. */
export function mountTraktorCard(root: ParentNode = document): boolean {
  const group = root.querySelector<HTMLElement>('#dj-settings-group');
  if (!group?.parentElement || root.querySelector('[data-traktor-card-host]')) return false;
  const host = document.createElement('div');
  host.setAttribute('data-traktor-card-host', '');
  group.parentElement.insertBefore(host, group.nextSibling);
  const reactRoot = createRoot(host);
  const show = () => reactRoot.render(<TraktorCard />);
  if (typeof IntersectionObserver === 'function') {
    reactRoot.render(<TraktorCard load={false} />);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        show();
      }
    });
    io.observe(host);
  } else {
    show();
  }
  return true;
}
