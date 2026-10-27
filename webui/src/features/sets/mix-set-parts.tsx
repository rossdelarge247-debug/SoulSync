/**
 * A mix set's page beyond 22c (28e, 28f): the note per track (a third line,
 * typed in place; "Add a note" only on hover and focus). The transition
 * chip at the end of each step line (26i) is auto-mix's own chip, shared
 * with Up next: `features/automix/mix-chip.tsx`.
 */
import { useEffect, useId, useState } from 'react';

import styles from './sets.module.css';

export { TransitionChip } from '@/features/automix/mix-chip';

/** The note's longest (the server keeps 500 characters). */
export const NOTE_MAX = 500;

export function NoteLine({
  note,
  title,
  onSave,
}: {
  note: string | null | undefined;
  title: string;
  onSave: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note ?? '');
  const id = useId();
  useEffect(() => {
    if (!editing) setText(note ?? '');
  }, [note, editing]);
  const done = () => {
    setEditing(false);
    const next = text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
    if (next !== (note ?? '')) onSave(next || null);
  };
  if (editing) {
    return (
      <span className={styles.noteEdit}>
        <label className={styles.srOnly} htmlFor={id}>
          A note for {title}
        </label>
        <input
          id={id}
          className={styles.noteInput}
          value={text}
          maxLength={NOTE_MAX}
          placeholder="mix out at the breakdown"
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onBlur={done}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              done();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setText(note ?? '');
              setEditing(false);
            }
          }}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.note}
      data-empty={note ? undefined : ''}
      aria-label={note ? `Note for ${title}: ${note}. Change it` : `Add a note to ${title}`}
      onClick={() => setEditing(true)}
    >
      {note || 'Add a note'}
    </button>
  );
}
