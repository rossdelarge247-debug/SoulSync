/**
 * Settings → Connections points at https (312): Auto mix's decks need a
 * secure page, which only the browser can tell. One card, this browser's
 * answer, and how to get there.
 */
import { openDjSettings } from '@/features/dj/dj-settings-link';

import styles from './automix.module.css';
import { mixSupport } from './support';

export function HttpsNote({ support = mixSupport }: { support?: () => string | null }) {
  const why = support();
  // plain http from another computer, or a browser without the decks on https
  const state = !why ? 'secure' : /https/.test(why) ? 'insecure' : 'browser';
  return (
    <section className={styles.httpsNote} data-https-note={state}>
      <h4 className={styles.settingsTitle}>Opening SYNCHRO.S on https</h4>
      {state === 'insecure' ? (
        <p>
          This browser reaches SYNCHRO.S over plain http from another computer, so Auto mix can only
          cut on the phrase or play straight on here: browsers only run its decks, for blends and
          echo outs, on a secure page. Open SYNCHRO.S on https (behind a reverse proxy with a
          certificate, such as Caddy, Traefik or Nginx Proxy Manager), or at <code>localhost</code>{' '}
          on the computer it runs on.
        </p>
      ) : state === 'browser' ? (
        <p>
          SYNCHRO.S is on a secure page here, but this browser can&apos;t run Auto mix&apos;s decks,
          so Auto mix can only cut on the phrase or play straight on in it. A current Chrome, Edge,
          Firefox or Safari can.
        </p>
      ) : (
        <p>
          SYNCHRO.S is on https here, or open on its own computer: Auto mix can run in this browser.
          On another computer, open it on https too.
        </p>
      )}
      <p>
        Between tracks (Off or Auto mix) is chosen in{' '}
        <button
          type="button"
          className={styles.textButton}
          onClick={() => openDjSettings('between')}
        >
          Settings → Library → DJ
        </button>
        .
      </p>
    </section>
  );
}
