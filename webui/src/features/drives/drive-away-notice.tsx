/**
 * "Your library's drive isn't connected" (14k, 14t): a warning, not a
 * danger (nothing is wrong with the music). It replaces the content of the
 * pages that read the library and sits in Home's alert band, for everyone;
 * members get the same words without Check again. The meta line says when
 * the drive was last seen and that SYNCHRO.S looks every 30 seconds.
 *
 * When only Downloads' or Staging's drive is away, Home says that instead
 * ("Your downloads drive isn't connected · downloads wait for it").
 */

import { Button } from '@/components/form';
import { Notice } from '@/components/primitives';

import type { DriveStatus, Role } from './drives.api';

import { lastSeenLine } from './drives.format';
import styles from './drives.module.css';

export interface DriveAwayNoticeProps {
  status: DriveStatus;
  /** Home's band also names Downloads' or Staging's drive when only that one is away. */
  where?: 'page' | 'home';
  checking?: boolean;
  onCheckAgain?: () => void;
}

const OTHER_TITLES: Record<Exclude<Role, 'library'>, string> = {
  downloads: 'Your downloads drive isn’t connected',
  staging: 'Your import folder’s drive isn’t connected',
};

/** Which folder the Notice speaks for, or null when every drive is here. */
export function awayRole(status: DriveStatus | null, where: 'page' | 'home'): Role | null {
  if (!status) return null;
  if (status.library_away) return 'library';
  if (where === 'home') return status.away.find((r) => r !== 'library') ?? null;
  return null;
}

export function DriveAwayNotice({
  status,
  where = 'page',
  checking = false,
  onCheckAgain,
}: DriveAwayNoticeProps) {
  const role = awayRole(status, where);
  if (!role) return null;
  const folder = status.folders[role];
  const drive = folder?.drive || 'the drive';
  const meta = lastSeenLine(folder?.last_seen ?? null, status.interval);
  const metaShort = lastSeenLine(folder?.last_seen ?? null, status.interval, { short: true });
  const canCheck = status.can_check && onCheckAgain;
  const title = role === 'library' ? 'Your library’s drive isn’t connected' : OTHER_TITLES[role];
  return (
    <Notice
      className={styles.awayNotice}
      data-drive-away={role}
      data-where={where}
      tone="warning"
      layout="stacked"
      role="status"
      title={title}
      actions={
        <>
          {canCheck ? (
            <Button
              size="lg"
              variant="secondary"
              disabled={checking}
              focusableWhenDisabled
              onClick={onCheckAgain}
            >
              {checking ? 'Looking…' : 'Check again'}
            </Button>
          ) : null}
          <span className={styles.awayMeta}>
            <span className={styles.wide}>{meta}</span>
            <span className={styles.phone}>{metaShort}</span>
          </span>
        </>
      }
    >
      {role === 'library' ? (
        <p>
          <span className={styles.wide}>
            SYNCHRO.S can’t see {drive}, where your library lives. Plug it in and everything carries
            on by itself. Meanwhile nothing is marked missing or cleaned up, and downloads and
            imports wait for it.
          </span>
          <span className={styles.phone}>
            SYNCHRO.S can’t see {drive}. Plug it in and everything carries on; nothing is marked
            missing meanwhile.
          </span>
        </p>
      ) : (
        <p>
          SYNCHRO.S can’t see {drive}.{' '}
          {role === 'downloads' ? 'Downloads wait for it.' : 'Imports wait for it.'} Plug it in and
          they carry on by themselves.
        </p>
      )}
    </Notice>
  );
}
