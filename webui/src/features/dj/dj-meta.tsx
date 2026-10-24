import type { DjInfo } from './dj.api';

import { bpmTitle, bpmWords, keyTitle } from './dj.format';
import styles from './dj.module.css';
import { KeyChip } from './key-chip';

/**
 * A track row's BPM and key, for its meta line (17e): "124 BPM · 8A", the
 * key in Camelot notation with its text in the wheel's hue (no chip: a chip
 * in every meta line would be noise) and its musical name as the title
 * ("A minor (Am), from the file's tag"). "8B?" stays meta. No energy here:
 * that's Tracks' column. `lead` puts " · " in front, to follow the row's
 * other meta. Nothing when neither is known.
 */
export function DjMeta({ dj, lead = false }: { dj: DjInfo | null | undefined; lead?: boolean }) {
  if (!dj || (!dj.bpm && !dj.key)) return null;
  return (
    <span className={styles.meta} data-dj-meta="">
      {lead ? ' · ' : null}
      {dj.bpm ? (
        <span title={bpmTitle(dj)} className={styles.bpm}>
          {bpmWords(dj.bpm)}
        </span>
      ) : null}
      {dj.bpm && dj.key ? ' · ' : null}
      {dj.key ? (
        <KeyChip code={dj.key} uncertain={dj.key_uncertain} title={keyTitle(dj)} variant="text" />
      ) : null}
    </span>
  );
}
