import type { DjInfo } from './dj.api';

import { bpmTitle, bpmWords, keyTitle } from './dj.format';
import styles from './dj.module.css';

/**
 * A track row's BPM and key, for its meta line: "124 BPM · 8A", the key in
 * Camelot notation with its musical name as the title ("A minor (Am), …").
 * `lead` puts " · " in front, to follow the row's other meta. Nothing when
 * neither is known.
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
        <abbr
          title={keyTitle(dj)}
          className={styles.key}
          data-uncertain={dj.key_uncertain ? 'true' : undefined}
        >
          {dj.key}
          {dj.key_uncertain ? '?' : null}
        </abbr>
      ) : null}
    </span>
  );
}
