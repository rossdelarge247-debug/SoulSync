import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';

import { MISSING_CONFIRM_TEXT, aboutHowLong } from '../-library.missing';
import styles from './library.module.css';
import { Stat } from './parts';

/**
 * "Look for releases you don't have…" (68, 15e): one question before a job
 * that spends the metadata services' limits. Not a Safe action (nothing moves
 * or deletes); the 680 dialog the library's other confirms use. The title
 * asks; the tiles are the facts to decide on (how many, about how long at one
 * a second, nothing added to Wanted); the rate and its reason are in the
 * sentence; "Start looking".
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
      <DialogHeader
        title="Look for releases you don't have?"
        description="For the library artists SYNCHRO.S knows no releases for yet."
      />
      <DialogBody>
        <div className={styles.dialogBody}>
          <div className={styles.tiles}>
            <Stat label="Artists to look up" value={candidates.toLocaleString()} />
            <Stat label="About how long" value={aboutHowLong(candidates)} />
            <Stat label="Adds to Wanted" value="Nothing" />
          </div>
          <p className={styles.lead}>{MISSING_CONFIRM_TEXT}</p>
        </div>
      </DialogBody>
      <DialogFooter note="It runs in the background; Activity shows it, with Stop.">
        <Button size="lg" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="lg" variant="primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Starting…' : 'Start looking'}
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}
