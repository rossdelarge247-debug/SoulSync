/**
 * A deck's Play/Pause and CUE (Brief F step 4b), as a Pioneer CDJ's:
 *
 * - **CUE while stopped**, away from the cue point: the cue point moves to
 *   where the deck is (snapped to the beat by whoever keeps it), and it stays
 *   stopped.
 * - **CUE held while stopped at the cue point:** it plays from the cue point
 *   while held; let go, it goes back to the cue point and stops.
 * - **Play while CUE is held:** it keeps playing when CUE is let go.
 * - **CUE while playing:** back to the cue point, stopped.
 * - **Play/Pause** otherwise plays or pauses where it is.
 *
 * Only logic: a `DeckPort` says what the deck is doing and does it (deck A on
 * the player's element, deck B on its deck; dj-mode-store.ts).
 */

export interface DeckPort {
  playing(): boolean;
  /** where the deck is, track seconds (null: not known) */
  position(): number | null;
  /** the cue point, track seconds */
  cue(): number;
  setCue(seconds: number): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
}

/** Within this of the cue point a stopped deck is at it (a CDJ's frame, near enough). */
export const AT_CUE_S = 0.05;

export type CueOutcome = 'set' | 'held' | 'back' | null;

export class DeckTransport {
  /** CUE is down and the deck plays from the cue point */
  private holding = false;
  /** Play was pressed while CUE was held: it plays on */
  private latched = false;

  get held(): boolean {
    return this.holding;
  }

  cueDown(port: DeckPort): CueOutcome {
    if (this.holding) return null;
    if (port.playing()) {
      port.pause();
      port.seek(port.cue());
      return 'back';
    }
    const pos = port.position();
    if (pos !== null && Math.abs(pos - port.cue()) > AT_CUE_S) {
      port.setCue(pos);
      return 'set';
    }
    this.holding = true;
    this.latched = false;
    port.seek(port.cue());
    port.play();
    return 'held';
  }

  /** CUE let go: back to the cue point, stopped, unless Play was pressed meanwhile. */
  cueUp(port: DeckPort): boolean {
    if (!this.holding) return false;
    this.holding = false;
    if (this.latched) {
      this.latched = false;
      return false;
    }
    port.pause();
    port.seek(port.cue());
    return true;
  }

  /** Play/Pause: while CUE is held it latches (plays on); otherwise it toggles. */
  playPress(port: DeckPort): 'latched' | 'play' | 'pause' {
    if (this.holding) {
      this.latched = true;
      return 'latched';
    }
    if (port.playing()) {
      port.pause();
      return 'pause';
    }
    port.play();
    return 'play';
  }

  /** Let go of everything (DJ mode off, a new track on the lane). */
  reset(): void {
    this.holding = false;
    this.latched = false;
  }
}
