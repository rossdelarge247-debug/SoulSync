/**
 * The confirm for turning on "Keep lossy output only — delete the lossless
 * source after conversion" (Settings → Quality → Post-Download Conversion, a
 * quality profile's option).
 *
 * Turning it on is what lets SoulSync delete lossless originals, so it asks
 * first, in the shared preview-then-confirm dialog with the danger button, and
 * says plainly what happens to new downloads and to files already in the
 * library. The Settings page is legacy markup, so it asks through
 * `window.confirmLossyDeleteOriginal`, which the host below registers once.
 * Turning it off needs no confirm.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SafeActionDialog } from './safe-action-dialog';
import styles from './safe-action.module.css';

export interface LossyDeleteOriginalOptions {
  /** The profile's lossy codec: mp3, opus or aac. */
  codec?: string | null;
  /** Its bitrate in kbps. */
  bitrate?: string | number | null;
}

const CODEC_NAMES: Record<string, string> = {
  mp3: 'MP3',
  opus: 'Opus',
  aac: 'AAC',
};

/** "MP3 320 kbps", from the codec and bitrate on screen. */
export function lossyCopyName({ codec, bitrate }: LossyDeleteOriginalOptions): string {
  const name = CODEC_NAMES[String(codec || 'mp3').toLowerCase()] ?? String(codec).toUpperCase();
  return bitrate ? `${name} ${bitrate} kbps` : name;
}

export const LOSSY_DELETE_TITLE = 'Delete the lossless files after converting?';
export const LOSSY_DELETE_CONFIRM = 'Delete originals after converting';

/** The words, apart from the dialog, so the fallback can say the same. */
export function lossyDeleteOriginalCopy(options: LossyDeleteOriginalOptions) {
  const copy = lossyCopyName(options);
  return {
    lead:
      `This can't be undone. With this on, SoulSync keeps only the ${copy} copy of each lossless ` +
      'file it converts for this profile, and deletes the lossless original.',
    points: [
      'New downloads: the original is deleted for good as soon as its copy is checked (it plays, and lasts ' +
        'as long as the original). Each one deleted is listed in Activity.',
      "Files already in your library: the Lossy Converter's Convert shows the list of originals first, and " +
        'they go to the recycle bin, or are deleted for good when recycling is off.',
      'Lossless quality cannot be made again from a lossy copy. To get it back you would download the ' +
        'music again.',
    ],
  };
}

/** One confirm for the Settings page, asked with `window.confirmLossyDeleteOriginal`. */
export function LossyDeleteOriginalHost() {
  const [request, setRequest] = useState<{
    options: LossyDeleteOriginalOptions;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback(
    (options: LossyDeleteOriginalOptions = {}) =>
      new Promise<boolean>((resolve) => {
        // a second ask replaces the first, which counts as a no
        pending.current?.(false);
        pending.current = resolve;
        setRequest({ options, resolve });
      }),
    [],
  );

  useEffect(() => {
    const previous = window.confirmLossyDeleteOriginal;
    window.confirmLossyDeleteOriginal = ask;
    return () => {
      window.confirmLossyDeleteOriginal = previous;
    };
  }, [ask]);

  const answer = (ok: boolean) => {
    request?.resolve(ok);
    pending.current = null;
    setRequest(null);
  };

  const copy = lossyDeleteOriginalCopy(request?.options ?? {});

  return (
    <SafeActionDialog
      open={request !== null}
      onClose={() => answer(false)}
      phase={{ kind: 'review' }}
      title={LOSSY_DELETE_TITLE}
      lead={
        <>
          <span>{copy.lead}</span>
          <ul className={styles.points}>
            {copy.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </>
      }
      confirmLabel={LOSSY_DELETE_CONFIRM}
      confirmTone="danger"
      onConfirm={() => answer(true)}
    />
  );
}

const HOST_ID = 'lossy-delete-original-root';

/** Mount the host once, so Settings can ask before turning the option on. */
export function mountLossyDeleteOriginalHost(): void {
  if (typeof document === 'undefined' || document.getElementById(HOST_ID)) return;
  const el = document.createElement('div');
  el.id = HOST_ID;
  document.body.appendChild(el);
  createRoot(el).render(<LossyDeleteOriginalHost />);
}
