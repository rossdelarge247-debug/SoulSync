import { useEffect, useId, useState } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button, FormField, TextInput } from '@/components/form';

import styles from './automations.module.css';

/**
 * Put an automation in a group (or take it out), or rename a group: one text
 * field with the existing groups offered as you type.
 */
export function GroupDialog({
  open,
  title,
  intro,
  initial,
  groups,
  confirmLabel,
  allowEmpty,
  onSave,
  onCancel,
}: {
  open: boolean;
  title: string;
  intro: string;
  initial: string;
  groups: string[];
  confirmLabel: string;
  /** An empty name takes the automation out of its group. */
  allowEmpty: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const listId = useId();
  const inputId = useId();
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  const trimmed = name.trim();
  const blocked = !allowEmpty && !trimmed;
  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      className={styles.dialog}
    >
      <DialogHeader title={title} />
      <DialogBody>
        <div className={styles.dialogStack}>
          <p className={styles.dialogText}>{intro}</p>
          <FormField label="Group name" htmlFor={inputId}>
            <TextInput
              id={inputId}
              value={name}
              list={listId}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !blocked) onSave(trimmed);
              }}
            />
          </FormField>
          <datalist id={listId}>
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          disabled={blocked}
          disabledReason={blocked ? 'Write a name first.' : undefined}
          onClick={() => onSave(trimmed)}
        >
          {allowEmpty && !trimmed && initial ? 'Take it out of the group' : confirmLabel}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
