/**
 * Whether Web Audio is really playing (Design's 252, 26f: "a locked phone
 * can stop the mix halfway. SYNCHRO.S crossfades if that happens").
 *
 * Three signs, any of which says the mix can't be trusted to carry on:
 * - the AudioContext's `statechange`: `suspended`, Safari's `interrupted`
 *   (a call, Siri, the screen locking on iOS), `closed`;
 * - the page hidden (`visibilitychange`, `pagehide`): on a phone that's
 *   usually the lock, and the suspension follows; on a computer a hidden tab
 *   keeps playing, so it only counts on a phone;
 * - a clock that stopped: `currentTime` not moving with the wall clock while
 *   the state says `running` (a stall some browsers never report).
 *
 * The engine schedules a whole transition ahead in the audio graph, so a
 * throttled background tab's timers don't matter; a suspended context does,
 * because nothing at all is heard until it resumes. LifecycleWatch only
 * reports; executor.ts decides (it cancels a countdown, and finishes a mix
 * that was cut off with a short crossfade once sound is back).
 */

export type InterruptReason = 'suspended' | 'interrupted' | 'closed' | 'hidden' | 'stalled';

export interface ContextLike {
  readonly state: string;
  readonly currentTime: number;
  addEventListener(type: 'statechange', fn: () => void): void;
  removeEventListener(type: 'statechange', fn: () => void): void;
}

export interface DocumentLike {
  readonly visibilityState: string;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface LifecycleEnv {
  context: ContextLike;
  doc?: DocumentLike | null;
  win?: {
    addEventListener(t: string, f: () => void): void;
    removeEventListener(t: string, f: () => void): void;
  } | null;
  /** wall clock, milliseconds */
  now?: () => number;
  /** hidden counts as an interruption (a phone) */
  phone?: boolean;
  /** start the clock check's timer (tests drive `check()` themselves) */
  timers?: boolean;
}

export interface LifecycleEvent {
  kind: 'interrupted' | 'resumed';
  reason: InterruptReason;
  /** wall-clock milliseconds it was interrupted for (on resumed) */
  forMs?: number;
}

/** The clock check: every 250 ms, a stall over 750 ms counts. */
const CHECK_MS = 250;
const STALL_MS = 750;

/** A phone, where a hidden page is about to be suspended. */
export function looksLikePhone(
  nav: { maxTouchPoints?: number; userAgent?: string } | null | undefined,
): boolean {
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  if (/iPhone|iPod|Android.+Mobile/i.test(ua)) return true;
  // iPadOS says it's a Mac; touch gives it away
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export class LifecycleWatch {
  private readonly env: LifecycleEnv;
  private readonly listener: (e: LifecycleEvent) => void;
  private reason: InterruptReason | null = null;
  private since = 0;
  private lastCtx = 0;
  private lastWall = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onState = () => this.evaluate();
  private readonly onVisibility = () => this.evaluate();

  constructor(env: LifecycleEnv, listener: (e: LifecycleEvent) => void) {
    this.env = env;
    this.listener = listener;
  }

  private now(): number {
    return this.env.now ? this.env.now() : performance.now();
  }

  start(): void {
    this.env.context.addEventListener('statechange', this.onState);
    this.env.doc?.addEventListener('visibilitychange', this.onVisibility);
    this.env.win?.addEventListener('pagehide', this.onVisibility);
    this.env.win?.addEventListener('pageshow', this.onVisibility);
    this.lastCtx = this.env.context.currentTime;
    this.lastWall = this.now();
    if (this.env.timers !== false) this.timer = setInterval(() => this.check(), CHECK_MS);
    this.evaluate();
  }

  stop(): void {
    this.env.context.removeEventListener('statechange', this.onState);
    this.env.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.env.win?.removeEventListener('pagehide', this.onVisibility);
    this.env.win?.removeEventListener('pageshow', this.onVisibility);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What's wrong now, or null when Web Audio is playing. */
  get interrupted(): InterruptReason | null {
    return this.reason;
  }

  private paused = false;

  /**
   * The listener paused (auto-mix's Pause pauses both decks by suspending
   * the context): a suspended context, or a phone's hidden page, isn't an
   * interruption then, since nothing is playing to be cut off. Resuming
   * looks again.
   */
  setPaused(on: boolean): void {
    this.paused = on;
    this.evaluate();
  }

  /** The clock check (on a timer; tests call it). */
  check(): void {
    const ctxNow = this.env.context.currentTime;
    const wall = this.now();
    const ctxMoved = (ctxNow - this.lastCtx) * 1000;
    const wallMoved = wall - this.lastWall;
    if (
      this.env.context.state === 'running' &&
      wallMoved >= STALL_MS &&
      ctxMoved < wallMoved * 0.25
    ) {
      this.set('stalled');
      this.lastWall = wall;
      this.lastCtx = ctxNow;
      return;
    }
    if (ctxMoved > 0 || this.env.context.state !== 'running') {
      this.lastWall = wall;
      this.lastCtx = ctxNow;
      if (this.reason === 'stalled' && ctxMoved > 0) this.evaluate(true);
    }
  }

  private evaluate(clockMoved = false): void {
    const state = this.env.context.state;
    let reason: InterruptReason | null = null;
    if (state === 'closed') reason = 'closed';
    else if (state === 'interrupted') reason = 'interrupted';
    else if (this.paused) reason = null;
    else if (state === 'suspended') reason = 'suspended';
    else if (this.env.phone && this.env.doc?.visibilityState === 'hidden') reason = 'hidden';
    else if (this.reason === 'stalled' && !clockMoved) reason = 'stalled';
    this.set(reason);
  }

  private set(reason: InterruptReason | null): void {
    if (reason === this.reason) return;
    const was = this.reason;
    this.reason = reason;
    if (reason) {
      if (!was) this.since = this.now();
      this.listener({ kind: 'interrupted', reason });
    } else if (was) {
      this.listener({ kind: 'resumed', reason: was, forMs: this.now() - this.since });
    }
  }
}
