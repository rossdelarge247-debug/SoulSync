/**
 * Library → Albums and Artists while the library's drive isn't connected
 * (14k): the page's title, a line saying what was there when the drive was
 * last seen, and the warning Notice in place of the grid. Never an empty
 * grid. The counts come from the library's database, which doesn't need the
 * drive.
 */

import { useInfiniteQuery } from '@tanstack/react-query';

import { DriveAwayNotice } from '@/features/drives/drive-away-notice';
import { useDriveStatus } from '@/features/drives/drive-status';
import { useProfile } from '@/platform/shell/route-controllers';

import { releasesInfiniteQueryOptions } from '../-library.api';
import styles from './library.module.css';

const DEFAULT_QUERY = { show: '', genre: '', q: '', sort: '' };

export function LibraryDriveAway({ view }: { view: 'albums' | 'artists' }) {
  const { status, checking, checkNow } = useDriveStatus();
  const { profileId } = useProfile();
  const releases = useInfiniteQuery({
    ...releasesInfiniteQueryOptions(profileId, DEFAULT_QUERY),
    retry: false,
  });
  if (!status) return null;
  const totals = releases.data?.pages[0]?.totals;
  const drive = status.folders.library?.drive ?? 'the drive';
  const n = totals ? (view === 'albums' ? totals.library : totals.artists) : null;
  const what = view === 'albums' ? 'album' : 'artist';
  return (
    <div className={styles.page} data-drive-away-page={view}>
      <header className={styles.header}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{view === 'albums' ? 'Albums' : 'Artists'}</h1>
          <p className={styles.subtitle}>
            {n !== null && n !== undefined
              ? `${n.toLocaleString('en-GB')} ${n === 1 ? what : `${what}s`} when ${drive} was last seen`
              : `As they were when ${drive} was last seen`}
          </p>
        </div>
      </header>
      <DriveAwayNotice status={status} checking={checking} onCheckAgain={() => void checkNow()} />
    </div>
  );
}
