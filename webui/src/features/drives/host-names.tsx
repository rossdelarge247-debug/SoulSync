/**
 * The one line under a list of folders when SYNCHRO.S doesn't know the
 * computer's names for them (125): it shows the container's paths, and
 * offers the drives helper's `--names` run as a one-use Terminal command,
 * copied with one click. Mac and Linux only (Windows has no helper yet).
 */

import { useState } from 'react';

import type { Platform } from './drives.api';

import { drivesApi } from './drives.api';
import styles from './drives.module.css';
import { copyText } from './move-shell';

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'copied' }
  | { kind: 'shown'; command: string }
  | { kind: 'error'; message: string };

export function computerWord(platform: Platform | null | undefined): string {
  return platform === 'mac' ? 'Mac' : 'computer';
}

export function HostNamesLine({
  platform,
  className,
}: {
  platform: Platform | null | undefined;
  className?: string;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const computer = computerWord(platform);

  const get = async () => {
    setState({ kind: 'busy' });
    try {
      const made = await drivesApi.namesCommand();
      setState(
        (await copyText(made.command))
          ? { kind: 'copied' }
          : { kind: 'shown', command: made.command },
      );
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'That didn’t go through.',
      });
    }
  };

  return (
    <p className={`${styles.namesLine} ${className ?? ''}`} data-host-names="">
      {state.kind === 'copied' ? (
        <span role="status">
          Copied. Paste it into Terminal on your {computer}; the {computer}’s names show here within
          a minute.
        </span>
      ) : state.kind === 'shown' ? (
        <span>
          Paste this into Terminal on your {computer}:{' '}
          <code className={styles.namesCode}>{state.command}</code>
        </span>
      ) : (
        <span>
          {state.kind === 'error' ? <span role="alert">{state.message} </span> : null}
          Paths as SYNCHRO.S sees them. To show your {computer}’s names,{' '}
          <button
            type="button"
            className={styles.link}
            disabled={state.kind === 'busy'}
            onClick={() => void get()}
          >
            {state.kind === 'busy' ? 'copying…' : 'copy the command'}
          </button>{' '}
          for Terminal: it runs <code className={styles.namesCode}>drives-helper.sh --names</code>.
        </span>
      )}
    </p>
  );
}
