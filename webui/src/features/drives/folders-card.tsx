/**
 * Settings → Library → Folders (14a): the card's head with its one secondary
 * "Move to another drive…", the three folders at 72px (`1fr 300px 120px
 * auto`: what each holds and who reads it; the folder in mono over the
 * drive it's on, as the computer names it when SYNCHRO.S knows (125: the
 * drives helper's host hint), else the container's path with one line
 * offering the helper's `--names`; the size; Change…), and the drive line under a
 * hairline (free space as a 640px 4px bar, "Getting full" past 90%, danger
 * past 98%, and "Your music folders take 93.2 GB of it." under the bar: the
 * one fact SYNCHRO.S knows, in place of 14a's fill rate, 124).
 *
 * Mounted into the legacy Settings page (`#folders-music-panel`) in place of
 * the three path fields, which stay in the page (hidden) because the page's
 * save reads them: Change… writes the field and lets the page save it, as
 * Unlock did. Change… says it doesn't move anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import { StatusTag } from '@/components/primitives';

import type { FolderRow, FoldersPayload, Role } from './drives.api';

import { drivesApi } from './drives.api';
import { shownPath, sizeWords, wantsNames } from './drives.format';
import styles from './drives.module.css';
import { HostNamesLine } from './host-names';
import { openDriveMove } from './move-flow';

/** Bytes the music folders take on the library's drive (124), or null while
 *  one of them is still being measured. A folder inside another counted one
 *  (downloads kept in the library) isn't counted twice. */
export function musicBytesOn(data: Pick<FoldersPayload, 'folders' | 'drive'>): number | null {
  const on = data.folders.filter((r) => r.drive === data.drive.label);
  if (!on.length || on.some((r) => r.bytes === null)) return null;
  const inside = (a: string, b: string) => a !== b && a.startsWith(b.endsWith('/') ? b : `${b}/`);
  return on
    .filter((r) => !on.some((o) => inside(r.path, o.path)))
    .reduce((sum, r) => sum + (r.bytes ?? 0), 0);
}

export const LEGACY_INPUTS: Record<Role, string> = {
  library: 'transfer-path',
  downloads: 'download-path',
  staging: 'staging-path',
};

function MoveIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function FoldersCard({ load = true }: { load?: boolean }) {
  const [data, setData] = useState<FoldersPayload | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [changing, setChanging] = useState<FolderRow | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await drivesApi.folders());
    } catch (e) {
      if ((e as { status?: number }).status === 403) setForbidden(true);
    }
  }, []);

  useEffect(() => {
    if (!load) return;
    void refresh();
    // sizes are measured in the background the first time: ask once more
    const t = setTimeout(() => void refresh(), 4000);
    return () => clearTimeout(t);
  }, [load, refresh]);

  // back from Terminal (the helper's --names): read the names again, only
  // while the card offers the command
  const needNames = Boolean(data && wantsNames(data.folders, data.platform));
  useEffect(() => {
    if (!load || !needNames) return;
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load, needNames, refresh]);

  if (forbidden) return null;
  const drive = data?.drive;
  const music = data ? musicBytesOn(data) : null;
  return (
    <section
      className={styles.foldersCard}
      aria-labelledby="drives-folders-title"
      data-folders-card=""
    >
      <div className={styles.cardHead}>
        <div>
          <h3 className={styles.cardTitle} id="drives-folders-title">
            Folders
          </h3>
          <p className={styles.cardSub}>
            Where SYNCHRO.S keeps your music, and the files on their way in.
          </p>
        </div>
        <Button size="lg" variant="secondary" onClick={() => openDriveMove()}>
          <MoveIcon />
          Move to another drive…
        </Button>
      </div>
      {(data?.folders ?? []).map((row) => (
        <div key={row.role} className={styles.folderRow} data-role={row.role}>
          <div>
            <p className={styles.folderName}>{row.label}</p>
            <p className={styles.folderHolds}>{row.holds}</p>
          </div>
          <div>
            <p className={styles.folderPath}>{shownPath(row)}</p>
            <p className={styles.folderDrive}>
              on {row.host_path && row.volume ? row.volume : row.drive}
            </p>
          </div>
          <span className={styles.folderSize}>
            {row.bytes === null ? 'Measuring…' : sizeWords(row.bytes)}
          </span>
          <Button size="lg" variant="secondary" onClick={() => setChanging(row)}>
            Change…
          </Button>
        </div>
      ))}
      {data && needNames ? (
        <HostNamesLine platform={data.platform} className={styles.namesUnderRows} />
      ) : null}
      {drive && drive.total ? (
        <div className={styles.driveLine}>
          <div className={styles.driveHead}>
            <span className={styles.driveName}>{drive.label}</span>
            <span className={styles.driveFree}>
              {sizeWords(drive.free)} free of {sizeWords(drive.total)}
            </span>
            {drive.tone ? (
              <StatusTag tone={drive.tone}>
                {drive.tone === 'danger' ? 'Almost full' : 'Getting full'}
              </StatusTag>
            ) : null}
          </div>
          <div
            className={styles.bar}
            data-tone={drive.tone ?? undefined}
            role="meter"
            aria-label={`${drive.label} used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={drive.percent ?? 0}
          >
            <span style={{ width: `${Math.min(100, drive.percent ?? 0)}%` }} />
          </div>
          {music !== null ? (
            <p className={styles.driveMusic}>Your music folders take {sizeWords(music)} of it.</p>
          ) : null}
        </div>
      ) : null}
      {changing ? (
        <ChangeFolderDialog
          row={changing}
          onClose={() => setChanging(null)}
          onSaved={() => {
            setChanging(null);
            setTimeout(() => void refresh(), 2500);
          }}
        />
      ) : null}
    </section>
  );
}

/** Change…: points a setting at files that are already somewhere else. */
export function ChangeFolderDialog({
  row,
  onClose,
  onSaved,
}: {
  row: FolderRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const input =
    typeof document !== 'undefined'
      ? (document.getElementById(LEGACY_INPUTS[row.role]) as HTMLInputElement | null)
      : null;
  const [value, setValue] = useState(input?.value || row.path);
  const field = useRef<HTMLInputElement>(null);
  const save = () => {
    const target = document.getElementById(LEGACY_INPUTS[row.role]) as HTMLInputElement | null;
    if (target) {
      target.value = value.trim();
      // the Settings page saves its fields two seconds after an input event
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    onSaved();
  };
  return (
    <DialogFrame open onOpenChange={(next) => !next && onClose()} initialFocus={field}>
      <DialogHeader title={`Change the ${row.label} folder`} closeLabel="Close" />
      <DialogBody>
        <div className={styles.dialogField}>
          <label className={styles.dialogLabel} htmlFor="drives-change-folder">
            The folder SYNCHRO.S reads, as it sees it
          </label>
          <input
            id="drives-change-folder"
            ref={field}
            className={styles.dialogInput}
            value={value}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <p className={styles.dialogText}>
          This doesn’t move anything. To move your music, use{' '}
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              onClose();
              openDriveMove();
            }}
          >
            Move to another drive…
          </button>
        </p>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={!value.trim() || value.trim() === row.path}
          onClick={save}
        >
          Save
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

/**
 * Puts the card at the top of Settings → Library → Folders → Music and hides
 * the three legacy path fields it replaces. The card asks for its numbers
 * only once it's on screen.
 */
export function mountFoldersCard(root: ParentNode = document): boolean {
  const panel = root.querySelector<HTMLElement>('#folders-music-panel');
  if (!panel || panel.querySelector('[data-folders-card-host]')) return false;
  const host = document.createElement('div');
  host.setAttribute('data-folders-card-host', '');
  const context = panel.querySelector('.stg-media-context');
  if (context?.nextSibling) panel.insertBefore(host, context.nextSibling);
  else panel.prepend(host);
  for (const id of Object.values(LEGACY_INPUTS)) {
    const group = root.querySelector(`#${id}`)?.closest<HTMLElement>('.form-group');
    if (group) group.hidden = true;
  }
  const reactRoot = createRoot(host);
  const show = () => reactRoot.render(<FoldersCard />);
  if (typeof IntersectionObserver === 'function') {
    reactRoot.render(<FoldersCard load={false} />);
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
