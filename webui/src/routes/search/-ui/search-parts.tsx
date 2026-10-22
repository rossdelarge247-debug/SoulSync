/** Pieces the three Search sections share. */

import { useEffect, useState, type ReactNode } from 'react';

import { AppLink } from '@/routes/activity/-ui/app-link';

import styles from './search-page.module.css';

const PHONE_QUERY = '(max-width: 720px)';

function phoneNow(): boolean {
  try {
    return window.matchMedia?.(PHONE_QUERY).matches === true;
  } catch {
    return false;
  }
}

/**
 * A phone-width screen (board 2n): Everything shows fewer rows per section
 * there so all three sources are within a scroll or two.
 */
export function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(phoneNow);
  useEffect(() => {
    const list = window.matchMedia?.(PHONE_QUERY);
    if (!list) return;
    const sync = () => setPhone(list.matches);
    sync();
    list.addEventListener?.('change', sync);
    return () => list.removeEventListener?.('change', sync);
  }, []);
  return phone;
}

/** Rows a section shows before "Show all": board 2m on wide screens, 2n on phones. */
export function rowLimit(type: string, phone: boolean, phoneEverything: number): number {
  if (type !== 'everything') return 10;
  return phone ? phoneEverything : 3;
}

export function SectionHead({
  id,
  title,
  aside,
}: {
  id: string;
  title: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className={styles.sectionHead}>
      <h2 className={styles.sectionTitle} id={id}>
        {title}
      </h2>
      {aside ? <div className={styles.sectionAside}>{aside}</div> : null}
    </div>
  );
}

/** Cover art or an avatar; the 8% placeholder when there's none or it fails. */
export function Art({ url, round = false }: { url?: string | null; round?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        className={styles.art}
        data-round={round ? 'true' : undefined}
        src={url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return <span className={styles.art} data-round={round ? 'true' : undefined} aria-hidden="true" />;
}

/** A link drawn as a button (Open artist, Open): a real link that moves in-app. */
export function ButtonLink({
  to,
  children,
  variant = 'default',
  label,
}: {
  to: string;
  children: ReactNode;
  variant?: 'default' | 'ghost';
  label?: string;
}) {
  return (
    <AppLink to={to} className={styles.buttonLink} data-variant={variant} aria-label={label}>
      {children}
    </AppLink>
  );
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? word : many}`;
}

/** "Show 20 more" / "Show all 48" footers' count words. */
export function ofLine(shown: number, total: number | string): string {
  return `${shown.toLocaleString('en-GB')} of ${typeof total === 'number' ? total.toLocaleString('en-GB') : total}`;
}

export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
