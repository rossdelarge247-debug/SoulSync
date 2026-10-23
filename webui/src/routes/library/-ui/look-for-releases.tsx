import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';

import { missingConfirmText } from '../-library.missing';
import styles from './library.module.css';
import { Stat, plural } from './parts';

/**
 * "Look for releases you don't have…" (68): one question before a job that
 * spends the metadata services' limits. Not a Safe action (nothing moves or
 * deletes); the 680 dialog the library's other confirms use.
 */
export function LookForReleasesConfirm({
  candidates,
  busy,
  onClose,
  onConfirm,
}: {
  candidates: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogFrame open onOpenChange={(open) => !open && onClose()} className={styles.dialog}>
      <DialogHeader title="Look for releases you don't have?" />
      <DialogBody>
        <div className={styles.dialogBody}>
          <div className={styles.tiles}>
            <Stat label="Artists to look up" value={candidates.toLocaleString()} />
            <Stat label="At most" value="1 a second" />
            <Stat label="Adds to Wanted" value="Nothing" />
          </div>
          <p className={styles.lead}>{missingConfirmText(candidates)}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="lg" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Starting…' : `Look up ${plural(candidates, 'artist')}`}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
