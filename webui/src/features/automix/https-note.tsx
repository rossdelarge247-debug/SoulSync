/**
 * Settings → Connections points at https (312): Auto mix's decks need a
 * secure page, which only the browser can tell. One card, this browser's
 * answer, and how to get there.
 */
import styles from './automix.module.css';
import { mixSupport } from './support';

export function HttpsNote({ support = mixSupport }: { support?: () => string | null }) {
  const why = support();
  return (
    <section className={styles.httpsNote} data-https-note={why ? 'insecure' : 'secure'}>
      <h4 className={styles.settingsTitle}>Opening SYNCHRO.S on https</h4>
      {why ? (
        <p>
          This browser reaches SYNCHRO.S over plain http from another computer, so Auto mix
          can&apos;t run here: browsers only run its decks on a secure page. Open SYNCHRO.S on https
          (behind a reverse proxy with a certificate, such as Caddy, Traefik or Nginx Proxy
          Manager), or at <code>localhost</code> on the computer it runs on.
        </p>
      ) : (
        <p>
          SYNCHRO.S is on https here, or open on its own computer: Auto mix can run in this browser.
          On another computer, open it on https too.
        </p>
      )}
    </section>
  );
}
