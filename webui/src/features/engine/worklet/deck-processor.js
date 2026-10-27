/**
 * The two decks' players, on the audio thread (auto-mix stage B; HANDOFF,
 * "Dev, auto-mix stage B of 27 October").
 *
 * One AudioWorkletProcessor plays both decks: output 0 is deck A, output 1
 * deck B, each stereo. A deck plays a decoded stretch of a track (a window,
 * GET /api/library/dj/window) along a position map: knots of (context frame,
 * track seconds, rate), so the main thread says where in the track each deck
 * is at every frame, and the decks stay on the beat by construction (the
 * map is worked out from both tracks' beat grids; features/engine/clock.ts).
 *
 * Two ways to follow the map:
 * - "resample": read the source at the map's position for every output
 *   frame (4-point Hermite). A rate change is a speed change: the pitch
 *   moves with it. The planner allows it within 3%.
 * - "stretch": WSOLA (waveform-similarity overlap-add). Grains of about
 *   43 ms, Hann-windowed, overlap by half; each grain is placed where the
 *   map says (its centre on the map), moved by at most 4 ms to where the
 *   source best continues the grain before it. The tempo follows the map,
 *   the pitch doesn't move. At a rate of 1 it gives the source back exactly.
 *   Our own code (MIT, like the rest of SYNCHRO.S); no library.
 *
 * Nothing here allocates per sample; the correlation search runs once a
 * grain (every 21 ms) on a quarter-rate mono copy the main thread made, then
 * on full-rate samples a few lags either side.
 *
 * Messages in (port):
 *   {type: 'load', deck, channels: Float32Array[], mono4: Float32Array,
 *    rate, offset}                 a window: offset is its first sample's
 *                                  place in the track (seconds)
 *   {type: 'map', deck, from, knots: Float64Array [f, p, r, ...], jump}
 *                                  knots from frame `from` on replace the
 *                                  old ones; jump restarts the stretch
 *   {type: 'mode', deck, mode: 'resample' | 'stretch'}
 *   {type: 'stop', deck, at}       silent (after a 128-frame fade) from frame `at`
 *   {type: 'unload', deck}
 *   {type: 'report', every}        how often positions are posted (frames)
 *   {type: 'ping', id}             answered with a pong once all before it is in
 * Messages out:
 *   {type: 'pos', frame, decks: [{p, playing, ended}, ...]}
 *   {type: 'loaded', deck}
 *   {type: 'pong', id}
 */

const scope = /** @type {any} */ (globalThis);
const SR = scope.sampleRate;

/** grain length: about 43 ms */
const GRAIN = SR > 60000 ? 4096 : 2048;
const HOP = GRAIN / 2;
/** how far a grain may move from where the map puts it */
const SEEK = Math.round(0.004 * SR);
/** how much a grain's score drops at the edge of its search: it stays near the map */
const LEAN = 0.08;
/** the main thread's mono copy is a quarter rate */
const DECIM = 4;
/** a start and a stop fade in and out over this many frames */
const FADE = 128;

const WINDOW = new Float32Array(GRAIN);
for (let j = 0; j < GRAIN; j++) WINDOW[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / GRAIN);

class Deck {
  constructor() {
    this.chunk0 = new Float32Array(HOP);
    this.chunk1 = new Float32Array(HOP);
    this.ola0 = new Float32Array(HOP);
    this.ola1 = new Float32Array(HOP);
    this.clear();
  }

  clear() {
    /** @type {Float32Array[] | null} */
    this.channels = null;
    /** @type {Float32Array | null} */
    this.mono4 = null;
    this.rate = SR;
    this.offset = 0;
    this.length = 0;
    /** flat knots: f, p, r */
    this.knots = new Float64Array(0);
    this.cursor = 0;
    this.stopAt = Infinity;
    this.mode = 'resample';
    this.ended = false;
    this.restartStretch();
  }

  restartStretch() {
    this.grainAt = -1;
    this.chunkStart = -1;
    /** @type {number | null} */
    this.prevStart = null;
    /** the next grain starts at full level, as if one had just played (a start, a switch from resample) */
    this.prime = false;
    this.ola0.fill(0);
    this.ola1.fill(0);
  }

  get startFrame() {
    return this.knots.length ? this.knots[0] : Infinity;
  }

  /** The track position (seconds) the map gives frame f, or NaN before it starts. */
  positionAt(f) {
    const k = this.knots;
    const n = k.length / 3;
    if (n === 0 || f < k[0]) return NaN;
    let i = this.cursor;
    if (i >= n || k[i * 3] > f) i = 0;
    while (i + 1 < n && k[(i + 1) * 3] <= f) i++;
    this.cursor = i;
    const at = i * 3;
    return k[at + 1] + ((f - k[at]) * k[at + 2]) / SR;
  }

  /** The source index (fractional) for a track position. */
  index(p) {
    return (p - this.offset) * this.rate;
  }

  /** The gain of the start and stop fades at frame f. */
  envelope(f) {
    const start = this.startFrame;
    let g = 1;
    if (f - start < FADE) g = Math.max(0, (f - start) / FADE);
    if (f >= this.stopAt) g *= Math.max(0, 1 - (f - this.stopAt) / FADE);
    return g;
  }

  setMap(from, flat, jump) {
    const old = this.knots;
    let keep = 0;
    while (keep * 3 < old.length && old[keep * 3] < from) keep++;
    const next = new Float64Array(keep * 3 + flat.length);
    next.set(old.subarray(0, keep * 3), 0);
    next.set(flat, keep * 3);
    this.knots = next;
    this.cursor = 0;
    this.ended = false;
    if (jump) this.restartStretch();
  }

  /**
   * Fill this block: frames f0 .. f0 + out0.length - 1.
   * @param {number} f0
   * @param {Float32Array} out0
   * @param {Float32Array} out1
   */
  render(f0, out0, out1) {
    const ch = this.channels;
    if (!ch || this.knots.length === 0) return false;
    const n = out0.length;
    if (f0 + n <= this.startFrame || f0 >= this.stopAt + FADE) return false;
    if (this.mode === 'stretch' && this.rate === SR) return this.renderStretch(f0, out0, out1);
    return this.renderResample(f0, out0, out1);
  }

  renderResample(f0, out0, out1) {
    const ch = /** @type {Float32Array[]} */ (this.channels);
    const left = ch[0];
    const right = ch.length > 1 ? ch[1] : ch[0];
    const len = this.length;
    let any = false;
    for (let i = 0; i < out0.length; i++) {
      const f = f0 + i;
      const p = this.positionAt(f);
      if (p !== p) continue; // not started
      const x = this.index(p);
      if (x < 1 || x >= len - 2) {
        if (x >= len - 2) this.ended = true;
        continue;
      }
      const g = this.envelope(f);
      if (g <= 0) continue;
      const k = x | 0;
      const t = x - k;
      out0[i] = g * hermite(left, k, t);
      out1[i] = g * hermite(right, k, t);
      any = true;
    }
    return any;
  }

  renderStretch(f0, out0, out1) {
    const start = Math.ceil(this.startFrame);
    let any = false;
    for (let i = 0; i < out0.length; i++) {
      const f = f0 + i;
      if (f < start) continue;
      if (this.grainAt < 0) {
        // the first grain starts at full level, as a resampled start does
        // (the 128-frame fade is the only one): the incoming deck's first
        // downbeat isn't softened
        this.grainAt = f;
        this.chunkStart = -1;
        this.prime = true;
      }
      while (this.chunkStart < 0 || f >= this.chunkStart + HOP) this.makeGrain();
      const g = this.envelope(f);
      if (g <= 0) continue;
      const j = f - this.chunkStart;
      out0[i] = g * this.chunk0[j];
      out1[i] = g * this.chunk1[j];
      any = true;
    }
    return any;
  }

  /** The next grain: HOP finished frames from grainAt on, and half a grain to overlap. */
  makeGrain() {
    const ch = /** @type {Float32Array[]} */ (this.channels);
    const left = ch[0];
    const right = ch.length > 1 ? ch[1] : ch[0];
    const at = this.grainAt;
    const p = this.positionAt(at + HOP);
    const len = this.length;
    let start = 0;
    let silent = p !== p;
    if (!silent) {
      const nominal = Math.round(this.index(p) - HOP);
      if (this.prevStart === null && this.prime) {
        // as if a grain had just played up to here: its second half overlaps
        // this one, so a deck switched to stretch mid-play doesn't dip
        this.prime = false;
        for (let j = 0; j < HOP; j++) {
          this.ola0[j] = WINDOW[j + HOP] * at0(left, nominal + j, len);
          this.ola1[j] = WINDOW[j + HOP] * at0(right, nominal + j, len);
        }
        this.prevStart = nominal - HOP;
      }
      start =
        this.prevStart === null
          ? nominal
          : this.bestStart(nominal, this.prevStart + HOP, left, right);
      if (start >= len) {
        silent = true;
        this.ended = true;
      }
    }
    const c0 = this.chunk0;
    const c1 = this.chunk1;
    const o0 = this.ola0;
    const o1 = this.ola1;
    if (silent) {
      for (let j = 0; j < HOP; j++) {
        c0[j] = o0[j];
        c1[j] = o1[j];
        o0[j] = 0;
        o1[j] = 0;
      }
      this.prevStart = null;
    } else {
      const inside = start >= 0 && start + GRAIN <= len;
      for (let j = 0; j < HOP; j++) {
        const a = start + j;
        const b = a + HOP;
        const w0 = WINDOW[j];
        const w1 = WINDOW[j + HOP];
        if (inside) {
          c0[j] = o0[j] + w0 * left[a];
          c1[j] = o1[j] + w0 * right[a];
          o0[j] = w1 * left[b];
          o1[j] = w1 * right[b];
        } else {
          c0[j] = o0[j] + w0 * at0(left, a, len);
          c1[j] = o1[j] + w0 * at0(right, a, len);
          o0[j] = w1 * at0(left, b, len);
          o1[j] = w1 * at0(right, b, len);
        }
      }
      this.prevStart = start;
    }
    this.chunkStart = at;
    this.grainAt = at + HOP;
  }

  /**
   * Where between nominal ± SEEK the source best continues `target` (the
   * previous grain's natural continuation): first on the quarter-rate mono
   * copy, then on full-rate samples within a few lags of the best. The
   * score is the normalised correlation, less a little for each lag away
   * from the map's own place (LEAN at the edge), so a grain only moves for a
   * clearly better match and the beat stays where the map puts it; over
   * silence it doesn't move at all.
   */
  bestStart(nominal, target, left, right) {
    const m = this.mono4;
    const len = this.length;
    if (!m || target < 0 || target + HOP > len) return nominal;
    const span = HOP / DECIM;
    const t4 = Math.round(target / DECIM);
    const n4 = nominal / DECIM;
    let lo4 = Math.ceil((nominal - SEEK) / DECIM);
    let hi4 = Math.floor((nominal + SEEK) / DECIM);
    if (lo4 < 0) lo4 = 0;
    if (hi4 + span > m.length) hi4 = m.length - span;
    if (t4 + span > m.length || hi4 < lo4) return nominal;
    let refEnergy = 0;
    for (let j = 0; j < span; j++) refEnergy += m[t4 + j] * m[t4 + j];
    if (refEnergy < 1e-9) return nominal;
    let best4 = Math.round(n4);
    let bestScore = -Infinity;
    let energy = 0;
    for (let j = 0; j < span; j++) energy += m[lo4 + j] * m[lo4 + j];
    for (let c = lo4; c <= hi4; c++) {
      if (c > lo4) {
        const out = m[c - 1];
        const inn = m[c + span - 1];
        energy += inn * inn - out * out;
      }
      let dot = 0;
      for (let j = 0; j < span; j++) dot += m[c + j] * m[t4 + j];
      const score =
        dot / Math.sqrt((energy > 1e-12 ? energy : 1e-12) * refEnergy) -
        (LEAN * Math.abs(c - n4) * DECIM) / SEEK;
      if (score > bestScore) {
        bestScore = score;
        best4 = c;
      }
    }
    let from = best4 * DECIM - DECIM;
    let to = best4 * DECIM + DECIM;
    if (from < nominal - SEEK) from = nominal - SEEK;
    if (to > nominal + SEEK) to = nominal + SEEK;
    if (from < 0) from = 0;
    if (to + HOP > len) to = len - HOP;
    let best = Math.min(Math.max(best4 * DECIM, from), to);
    let ref = 0;
    for (let j = 0; j < HOP; j += 2) {
      const r = left[target + j] + right[target + j];
      ref += r * r;
    }
    if (ref < 1e-9) return nominal;
    bestScore = -Infinity;
    for (let a = from; a <= to; a++) {
      let dot = 0;
      let e = 0;
      for (let j = 0; j < HOP; j += 2) {
        const v = left[a + j] + right[a + j];
        dot += v * (left[target + j] + right[target + j]);
        e += v * v;
      }
      const score =
        dot / Math.sqrt((e > 1e-12 ? e : 1e-12) * ref) - (LEAN * Math.abs(a - nominal)) / SEEK;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return best;
  }
}

/** 4-point, 3rd-order Hermite between x[k] and x[k + 1]. */
function hermite(x, k, t) {
  const y0 = x[k - 1];
  const y1 = x[k];
  const y2 = x[k + 1];
  const y3 = x[k + 2];
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + y1;
}

function at0(x, i, len) {
  return i >= 0 && i < len ? x[i] : 0;
}

class DecksProcessor extends scope.AudioWorkletProcessor {
  constructor() {
    super();
    this.decks = [new Deck(), new Deck()];
    this.reportEvery = 4096;
    this.sinceReport = 0;
    this.port.onmessage = (/** @type {MessageEvent} */ e) => this.receive(e.data);
  }

  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'report') {
      this.reportEvery = Math.max(128, msg.every | 0);
      return;
    }
    if (msg.type === 'ping') {
      // messages arrive in order: everything sent before this is in place
      this.port.postMessage({ type: 'pong', id: msg.id });
      return;
    }
    const deck = this.decks[msg.deck];
    if (!deck) return;
    switch (msg.type) {
      case 'load':
        deck.clear();
        deck.channels = msg.channels;
        deck.mono4 = msg.mono4 || null;
        deck.rate = msg.rate || SR;
        deck.offset = msg.offset || 0;
        deck.length = msg.channels && msg.channels[0] ? msg.channels[0].length : 0;
        this.port.postMessage({ type: 'loaded', deck: msg.deck });
        break;
      case 'map':
        deck.setMap(msg.from, msg.knots, Boolean(msg.jump));
        break;
      case 'mode':
        if (msg.mode !== deck.mode) {
          deck.mode = msg.mode === 'stretch' ? 'stretch' : 'resample';
          deck.restartStretch();
          deck.prime = scope.currentFrame >= deck.startFrame + FADE;
        }
        break;
      case 'stop':
        deck.stopAt = typeof msg.at === 'number' ? msg.at : Infinity;
        break;
      case 'unload':
        deck.clear();
        break;
      default:
        break;
    }
  }

  process(_inputs, outputs) {
    const f0 = scope.currentFrame;
    for (let d = 0; d < 2; d++) {
      const out = outputs[d];
      if (!out || out.length === 0) continue;
      this.decks[d].render(f0, out[0], out.length > 1 ? out[1] : out[0]);
    }
    this.sinceReport += outputs[0] && outputs[0][0] ? outputs[0][0].length : 128;
    if (this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0;
      const frame = f0 + 128;
      this.port.postMessage({
        type: 'pos',
        frame,
        decks: this.decks.map((d) => {
          const p = d.positionAt(frame);
          return {
            p: p === p ? p : null,
            playing: d.channels !== null && p === p && frame < d.stopAt && !d.ended,
            ended: d.ended,
          };
        }),
      });
    }
    return true;
  }
}

scope.registerProcessor('soulsync-decks', DecksProcessor);
