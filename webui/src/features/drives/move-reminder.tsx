/**
 * Home's reminder a week after a move (14i): an info Notice with the same two
 * buttons Done has, for admins (the status route sends it only to them).
 */

import { Button } from '@/components/form';
import { Notice } from '@/components/primitives';

import type { Reminder } from './drives.api';

import { sizeWords } from './drives.format';
import { openDriveMove } from './move-flow';

export function MoveReminder({ reminder }: { reminder: Reminder }) {
  return (
    <Notice
      tone="info"
      layout="stacked"
      role="note"
      data-move-reminder=""
      title={`The old copies of your music are still on ${reminder.source_label}`}
      actions={
        <>
          <Button size="lg" variant="secondary" onClick={() => openDriveMove()}>
            Remove the old copies…
          </Button>
          <Button size="lg" variant="secondary" onClick={() => openDriveMove()}>
            Switch back to {reminder.source_label}…
          </Button>
        </>
      }
    >
      <p>
        {sizeWords(reminder.bytes)} a week after the move to {reminder.target_label}. If your music
        plays fine from {reminder.target_label}, remove them to get the space back.
      </p>
    </Notice>
  );
}
