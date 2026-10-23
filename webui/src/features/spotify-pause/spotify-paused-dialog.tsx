/**
 * "Spotify is paused" (board 12b): only when something a person asked for
 * needs Spotify right now (spotify-gate.ts). 680 on the dialog ground; the
 * description names what waits and that it isn't lost; three tiles (Time
 * left counting down, Whose number, Set off by); a sentence; the footer has
 * the note and the admin's ghost Try again now beside the primary "Wait for
 * it". Members see Wait for it alone.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { DialogBody, DialogFooter, DialogFrame, DialogHeader } from '@/components/dialog';
import { Button } from '@/components/form';

import {
  spotifyGate,
  type SpotifyGateAnswer,
  type SpotifyGateDeps,
  type SpotifyGateRequest,
} from './spotify-gate';
import { canClearSpotifyPause, clearSpotifyPause, type SpotifyPauseStatus } from './spotify-pause';
import styles from './spotify-paused-dialog.module.css';
import { useSpotifyPause } from './use-spotify-pause';

/** What the description adds after the thing that waits. */
export const NOTHING_LOST = 'It starts by itself when the pause ends, if this page stays open.';

export function SpotifyPausedDialog({
  open,
  status,
  description,
  onAnswer,
}: {
  open: boolean;
  status: SpotifyPauseStatus | null;
  description: string;
  onAnswer: (answer: SpotifyGateAnswer) => void;
}) {
  const view = useSpotifyPause(status);
  const admin = canClearSpotifyPause();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waitRef = useRef<HTMLButtonElement>(null);
  const answered = useRef(false);
  const answer = useCallback(
    (a: SpotifyGateAnswer) => {
      if (answered.current) return;
      answered.current = true;
      onAnswer(a);
    },
    [onAnswer],
  );
  // the pause ended while it was open: nothing to wait for
  const over = open && status !== null && view?.kind !== 'paused';
  useEffect(() => {
    if (over) answer('wait');
  }, [over, answer]);

  const tryAgain = async () => {
    setBusy(true);
    setError(null);
    const failed = await clearSpotifyPause();
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    answer('cleared');
  };

  const paused = view?.kind === 'paused' ? view : null;
  return (
    <DialogFrame
      open={open}
      onOpenChange={(next) => {
        if (!next) answer('closed');
      }}
      className={styles.dialog}
      initialFocus={waitRef}
    >
      <DialogHeader
        title="Spotify is paused"
        closeLabel="Close"
        description={`${description} ${NOTHING_LOST}`}
      />
      <DialogBody>
        <div className={styles.tiles}>
          <Tile label="Time left">
            <span className={styles.big} data-testid="spotify-paused-time">
              {paused?.timeLeftExact ?? '0 s'}
            </span>
          </Tile>
          <Tile label="Whose number">
            <span className={styles.big}>{paused?.whose}</span>
          </Tile>
          <Tile label="Set off by">
            <span className={styles.what}>{paused?.setOffBy}</span>
          </Tile>
        </div>
        <p className={styles.sentence}>{paused?.dialogSentence}</p>
      </DialogBody>
      <DialogFooter>
        {admin ? (
          <span className={styles.note} aria-live="polite">
            {error ??
              `Try again now clears SYNCHRO.S’s pause. If Spotify is still limiting, the pause comes back${
                paused && !paused.fromSpotify ? ', longer' : ''
              }.`}
          </span>
        ) : null}
        {admin ? (
          <Button
            size="lg"
            variant="ghost"
            disabled={busy}
            focusableWhenDisabled
            onClick={() => void tryAgain()}
          >
            Try again now
          </Button>
        ) : null}
        <Button ref={waitRef} size="lg" variant="primary" onClick={() => answer('wait')}>
          Wait for it
        </Button>
      </DialogFooter>
    </DialogFrame>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      {children}
    </div>
  );
}

interface Pending {
  id: number;
  request: SpotifyGateRequest;
  resolve: (answer: SpotifyGateAnswer) => void;
}

/**
 * The dialog as a React tree's own opener, so it nests inside a dialog that's
 * already open (the Mirror dialog). `gate(what)` is `spotifyGate` with this
 * tree's dialog; render `dialog` anywhere in the tree.
 */
export function useSpotifyGate(deps: Omit<SpotifyGateDeps, 'open'> = {}): {
  gate: (description: string) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const seq = useRef(0);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const gate = useCallback(
    (description: string) =>
      spotifyGate(description, {
        ...depsRef.current,
        open: (request) =>
          new Promise<SpotifyGateAnswer>((resolve) => {
            seq.current += 1;
            setPending({ id: seq.current, request, resolve });
          }),
      }),
    [],
  );
  const dialog = pending ? (
    <SpotifyPausedDialog
      key={pending.id}
      open
      status={pending.request.status}
      description={pending.request.description}
      onAnswer={(a) => {
        setPending(null);
        pending.resolve(a);
      }}
    />
  ) : null;
  return { gate, dialog };
}
