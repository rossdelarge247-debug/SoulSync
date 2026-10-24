/**
 * "Export to Traktor…" (21a): one confirm for all three doors (a playlist's
 * "…", Tracks' selection bar, the Mixes well with panel's foot). Not a Safe
 * action, nothing moves: the 680 frame on the dialog ground, three tiles
 * (Tracks, Found on your Mac, Left out), the path as the Mac sees it shown
 * once with where it came from, why anything was left out (a warning box),
 * where the file goes and how to import it in Traktor's own words, then
 * Cancel and "Export 23 tracks".
 */
import { useCallback, useEffect, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';
import { Notice, Skeleton } from '@/components/primitives';

import { openTraktorSettings } from './traktor-settings-link';
import {
  TraktorError,
  downloadTraktor,
  previewTraktor,
  saveTraktor,
  type TraktorPreview,
  type TraktorSource,
} from './traktor.api';
import { exportLabel, exportTitle, leftOutLines } from './traktor.format';
import styles from './traktor.module.css';

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.tile}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Strong({ children }: { children: string }) {
  return <strong className={styles.strong}>{children}</strong>;
}

export function TraktorExportDialog({
  from,
  name = null,
  onClose,
}: {
  from: TraktorSource;
  /** what the set is called, for the title ("Sunday Set"); a selection has none */
  name?: string | null;
  onClose: () => void;
}) {
  // no query client needed: the doors include a playlist modal and a panel
  // mounted outside the router
  const [data, setData] = useState<TraktorPreview | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const key = JSON.stringify(from);
  const load = useCallback(() => {
    let live = true;
    setLoadError(null);
    setData(undefined);
    previewTraktor(JSON.parse(key) as TraktorSource)
      .then((next) => live && setData(next))
      .catch(
        (err: unknown) =>
          live && setLoadError(err instanceof Error ? err.message : 'Try again in a moment.'),
      );
    return () => {
      live = false;
    };
  }, [key]);
  useEffect(() => load(), [load]);
  const [busy, setBusy] = useState(false);
  const [exists, setExists] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = from.source === 'tracks' ? from.track_ids.length : null;
  const title = exportTitle(
    name ?? (from.source === 'tracks' ? null : (data?.name ?? null)),
    count,
  );
  const toFolder = Boolean(data?.folder.can_save);

  const download = async () => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      await downloadTraktor(from, data.filename);
      onClose();
      window.showToast?.(
        `Saved ${data.filename} to your Downloads. In Traktor: File → Import Playlist…`,
        'success',
      );
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "The file wasn't made.");
    }
  };

  const save = async (overwrite: boolean) => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveTraktor(from, overwrite);
      onClose();
      window.showToast?.(
        `Saved ${saved.filename} in ${data.folder.shown ?? saved.folder}. In Traktor: File → Import Playlist…`,
        'success',
      );
    } catch (err) {
      setBusy(false);
      if (err instanceof TraktorError && err.exists) setExists(data.filename);
      else setError(err instanceof Error ? err.message : "The file wasn't saved.");
    }
  };

  const lines = data ? leftOutLines(data, data.can_edit) : [];
  const found = data?.counts.found ?? 0;

  return (
    <DialogFrame open onOpenChange={(next) => (next ? null : onClose())} className={styles.dialog}>
      <DialogHeader
        title={title}
        closeLabel="Close"
        description="A playlist file Traktor imports. Nothing in Traktor changes until you import it."
      />
      <DialogBody>
        <div className={styles.body} data-traktor-export="">
          {loadError ? (
            <Notice
              tone="danger"
              role="alert"
              title="Couldn't look at these tracks"
              actions={
                <Button size="lg" variant="secondary" onClick={() => load()}>
                  Try again
                </Button>
              }
            >
              {loadError}
            </Notice>
          ) : null}
          <div className={styles.tiles} aria-busy={!data && !loadError}>
            {data ? (
              <>
                <Tile label="Tracks" value={data.counts.tracks.toLocaleString()} />
                <Tile label="Found on your Mac" value={found.toLocaleString()} />
                <Tile label="Left out" value={data.counts.left_out.toLocaleString()} />
              </>
            ) : loadError ? null : (
              [0, 1, 2].map((i) => <Skeleton key={i} className={styles.tileSkeleton} />)
            )}
          </div>
          {data?.example_path ? (
            <div className={styles.pathBlock}>
              <span className={styles.pathLabel}>Paths as your Mac sees them</span>
              <code className={styles.path} data-example-path="">
                {data.example_path}
              </code>
              <span className={styles.pathFrom}>
                From Settings → Traktor&apos;s &ldquo;Your music on the Mac&rdquo;.{' '}
                {data.can_edit ? (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => {
                      onClose();
                      openTraktorSettings();
                    }}
                  >
                    Change…
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}
          {lines.length ? (
            <div className={styles.leftOut} data-left-out="">
              <span className={styles.dot} aria-hidden="true" />
              <div>
                {lines.map((line, i) => (
                  <p key={i}>
                    {i === 0 ? <Strong>Left out:</Strong> : null}
                    {i === 0 ? ' ' : null}
                    {line}
                  </p>
                ))}
                {data?.reasons.no_mac_path && data.can_edit ? (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => {
                      onClose();
                      openTraktorSettings();
                    }}
                  >
                    Open Settings → Library → Traktor Pro 3
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {data && found ? (
            <p className={styles.how}>
              {toFolder ? (
                <>
                  Saves <Strong>{data.filename}</Strong> to{' '}
                  <Strong>{data.folder.shown ?? 'the export folder'}</Strong>.
                </>
              ) : (
                <>
                  Saves <Strong>{data.filename}</Strong> to your Downloads.
                </>
              )}{' '}
              In Traktor: <Strong>File → Import Playlist…</Strong> (or right-click Playlists →
              Import Playlist). The BPM{data.keys ? ' and key go' : ' goes'} in the file; Traktor
              keeps any it already has.
            </p>
          ) : null}
          {exists ? (
            <Notice
              tone="warning"
              role="alert"
              title={`${exists} is already in the export folder`}
              actions={
                <>
                  <Button
                    size="lg"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void save(true)}
                  >
                    Replace it
                  </Button>
                  <Button size="lg" variant="ghost" disabled={busy} onClick={() => void download()}>
                    Download instead
                  </Button>
                </>
              }
            >
              Replace it with this export, or download this one through the browser instead.
            </Notice>
          ) : null}
          {error ? (
            <Notice tone="danger" role="alert" title="That didn't go through">
              {error}
            </Notice>
          ) : null}
        </div>
      </DialogBody>
      <DialogFooter note="Traktor Pro 3's playlist format (.nml)">
        <Button size="lg" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {toFolder ? (
          <Button size="lg" variant="secondary" disabled={busy} onClick={() => void download()}>
            Download instead
          </Button>
        ) : null}
        <Button
          size="lg"
          variant="primary"
          disabled={busy || !data || !found || Boolean(exists)}
          disabledReason={
            data && !found
              ? 'Nothing here can go to Traktor yet.'
              : exists
                ? 'Choose Replace it or Download instead.'
                : undefined
          }
          onClick={() => void (toFolder ? save(false) : download())}
        >
          {busy ? 'Exporting…' : exportLabel(found)}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
