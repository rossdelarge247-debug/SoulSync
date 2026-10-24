import type { CSSProperties } from 'react';

import styles from './dj.module.css';
import { keyHue } from './key-colour';

/**
 * A Camelot key in the wheel's colour (HANDOFF 151). `chip` (where key is a
 * column, a select or the panel): a 6px chip, the hue at 16% with light text
 * in the same hue. `text` (a meta line elsewhere): the text alone takes the
 * hue, at 600. An uncertain key keeps no colour: "8B?" in meta, either way.
 * The title names the key in words and where it came from.
 */
export function KeyChip({
  code,
  uncertain = false,
  title,
  variant = 'chip',
  className,
}: {
  code: string;
  uncertain?: boolean;
  title?: string;
  variant?: 'chip' | 'text';
  className?: string;
}) {
  const hue = uncertain ? null : keyHue(code);
  const style = hue === null ? undefined : ({ '--dj-key-h': hue } as CSSProperties);
  return (
    <abbr
      title={title || undefined}
      className={[variant === 'chip' ? styles.keyChip : styles.keyText, className]
        .filter(Boolean)
        .join(' ')}
      style={style}
      data-key-hue={hue ?? undefined}
      data-uncertain={uncertain ? 'true' : undefined}
    >
      {code}
      {uncertain ? '?' : null}
    </abbr>
  );
}
