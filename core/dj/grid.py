"""The beat grid, downbeats, phrases and sections of one track, for auto-mix
(BACKLOG "Auto-mix: beat-matched transitions in Up next", stage A).

Signal processing only, on numpy and librosa (ISC), both already used by
Sample Studio and the DJ analysis; no model, no new dependency. It runs on the
audio the DJ analysis has already decoded (mono at 22050 Hz, at most the
first 10 minutes), so a track is decoded once.

What comes out (``analyze_audio``), all of it compact enough to keep per track:

* **The beat grid:** the tempo to a hundredth of a BPM and the first beat's
  time. A steady track (nearly every dance track) is a constant grid, the
  first beat plus the period; a track whose tempo drifts (live drums, an old
  record) keeps its beat times instead. With a confidence (0–1).
* **Downbeats:** which beat is the one, assuming four beats a bar, with a
  confidence; ``meter`` says ``not_4_4`` when the accents fall in threes.
* **Phrases:** boundaries every 8 bars counted from each section change (so a
  track with an odd-length section stays on its phrases), each marked 8, 16
  or 32 by how many bars from that change it falls.
* **Sections:** structure analysis on bar-long features (timbre, harmony,
  loudness, kick): a self-similarity matrix's checkerboard novelty finds the
  changes; each part is labelled ``intro``, ``outro``, ``breakdown``,
  ``drop`` or ``main`` from its loudness and kick against the track's main
  level, best effort, with a confidence.
* **Mix regions:** where the incoming track can come in (its intro, while the
  drums are steady) and where the outgoing one can go out (its outro), else a
  stretch of steady drums at a lower level near that end.

Bars are counted from the first downbeat (bar 0). Times are seconds from the
start of the file.

How sure each part is, honestly: the grid is very good on steady 4/4
electronic music and says so with a high confidence; the downbeat is a
heuristic (kick accents, the harmony turning, the timbre changing on the one)
and right on most dance tracks, less often elsewhere; sections are best
effort. Vocals aren't detected (that would take a model): an intro with
chords or a voice in it still counts, with a lower confidence when it holds
harmony. ``tests/dj/test_grid_accuracy.py`` measures it on generated tracks.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: bump when the analysis changes: the sweep redoes every track's grid
#: (2: the sixteenth check, below, for syncopated breaks)
GRID_VERSION = 2

SR = 22050
HOP = 256            # 11.6 ms a frame
N_FFT = 1024
N_MELS = 64
#: shorter than this has no grid worth keeping (a jingle, a skit)
MIN_SECONDS = 20.0
#: frames per STFT chunk: keeps the spectrum's memory small on a long track
CHUNK_FRAMES = 4096

#: a constant grid when the beats sit this close to a straight line (ms)
STEADY_MAD_MS = 9.0
STEADY_DRIFT_MS = 22.0
#: a drifting grid needs the onsets to line up on a tempo at least this well
#: half a minute at a time (the median of the comb's alignment over 30 s
#: windows): noise, pink or brown noise and random clicks measure 0.06-0.13,
#: drifting tracks about 0.6. Over a whole track a drift smears the one
#: tempo away (a 10-minute ramp from 122 to 127 BPM: 0.09), so it's measured
#: in windows
MIN_DRIFT_ALIGNMENT = 0.25
#: the windows that measures over
ALIGN_WINDOW_S = 30.0
#: below this beat confidence there's no grid to mix on
MIN_BEAT_CONFIDENCE = 0.3
#: the flux peaks this long before a beat's attack (measured on generated
#: kicks with an instant attack): it's added back
ONSET_LAG_S = -0.0055

#: an onset in the first moments is cut short by the edge of the audio
EDGE_S = 0.05
#: how much the whole spectrum's attacks count beside the low band's
BROADBAND_WEIGHT = 0.15
#: log(1 + C·magnitude) for the onset flux
COMPRESSION = 10.0

#: the section labels
LABELS = ("intro", "outro", "breakdown", "drop", "main")


# ── the spectrum, in chunks ──────────────────────────────────────────────────

def _features(y) -> Dict[str, Any]:
    """Per-frame log-mel (64 bands), chroma (12) and RMS, from one STFT pass
    done in chunks so a 10-minute track never holds its whole complex
    spectrum."""
    import librosa
    import numpy as np

    from scipy import fft as sfft

    y = np.asarray(y, dtype=np.float32)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    pad = N_FFT // 2
    # one copy of the audio, padded and peak-normalised in place
    ypad = np.zeros(len(y) + 2 * pad, np.float32)
    ypad[pad:pad + len(y)] = y
    if peak > 0:
        ypad *= np.float32(1.0 / peak)
    n_frames = 1 + max(0, (len(ypad) - N_FFT) // HOP)
    window = np.hanning(N_FFT).astype(np.float32)
    mel_fb = librosa.filters.mel(sr=SR, n_fft=N_FFT, n_mels=N_MELS, fmin=30.0, fmax=8000.0)
    chroma_fb = librosa.filters.chroma(sr=SR, n_fft=N_FFT)
    mel = np.empty((N_MELS, n_frames), np.float32)
    chroma = np.empty((12, n_frames), np.float32)
    strides = (ypad.strides[0] * HOP, ypad.strides[0])
    for start in range(0, n_frames, CHUNK_FRAMES):
        count = min(CHUNK_FRAMES, n_frames - start)
        frames = np.lib.stride_tricks.as_strided(ypad[start * HOP:], shape=(count, N_FFT), strides=strides)
        power = np.abs(sfft.rfft(frames * window, axis=1)) ** 2  # float32 in, complex64 out
        mel[:, start:start + count] = mel_fb @ power.T
        chroma[:, start:start + count] = chroma_fb @ power.T
    mel_db = 10.0 * np.log10(np.maximum(mel, 1e-10))
    mel_db = np.maximum(mel_db, mel_db.max() - 80.0)
    # the flux on compressed magnitudes, not decibels: in dB a quiet hat
    # rising out of silence jumps as far as the kick, and the beat is where
    # the loud low attack is
    comp = np.log1p(COMPRESSION * np.sqrt(mel))
    flux = np.maximum(0.0, np.diff(comp, axis=1, prepend=comp[:, :1]))
    freqs = librosa.mel_frequencies(n_mels=N_MELS, fmin=30.0, fmax=8000.0)
    low = freqs < 160.0
    env = flux.mean(axis=0)
    env_low = flux[low].mean(axis=0)
    # the snare and clap's band (their body and crack, under the hats)
    env_mid = flux[(freqs >= 160.0) & (freqs < 2500.0)].mean(axis=0)
    # RMS per frame from the signal itself (dB, peak-normalised)
    rms = np.zeros(n_frames)
    for start in range(0, n_frames, CHUNK_FRAMES):
        count = min(CHUNK_FRAMES, n_frames - start)
        block = ypad[pad + start * HOP:pad + (start + count) * HOP]
        if len(block) < count * HOP:
            block = np.concatenate([block, np.zeros(count * HOP - len(block), np.float32)])
        rms[start:start + count] = np.sqrt(np.mean(np.square(block.reshape(count, HOP)), axis=1))
    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-6))
    env, env_low, env_mid = _detrend(env), _detrend(env_low), _detrend(env_mid)
    # one scale for all, from the whole spectrum's attacks: a track without
    # low attacks (a pad, a voice) keeps a small low-band envelope instead
    # of having its noise blown up to the size of a kick
    scale = float(np.percentile(env, 99)) if env.size else 0.0
    if scale > 0:
        env, env_low, env_mid = env / scale, env_low / scale, env_mid / scale
    return {"mel_db": mel_db, "chroma": chroma, "env": env, "env_low": env_low, "env_mid": env_mid,
            "rms_db": rms_db, "n_frames": n_frames, "duration": len(y) / SR}


def _detrend(env):
    """The flux less its local mean (about half a second), floored at zero."""
    import numpy as np

    width = int(0.5 * SR / HOP) | 1
    kernel = np.ones(width) / width
    local = np.convolve(env, kernel, mode="same")
    return np.maximum(0.0, env - local)


def _t2f(t):
    return t * SR / HOP


def _interp(env, times):
    """The envelope at fractional times (linear between frames)."""
    import numpy as np

    f = np.clip(_t2f(np.asarray(times, dtype=np.float64) + ONSET_LAG_S), 0, len(env) - 1)
    return np.interp(f, np.arange(len(env)), env)


def _peak_near(env, times, radius_s: float):
    """For each time, the envelope's peak within ±radius and where it is
    (parabolic, to a fraction of a frame)."""
    import numpy as np

    times = np.asarray(times, dtype=np.float64)
    r = max(1, int(round(_t2f(radius_s))))
    centre = np.round(_t2f(times + ONSET_LAG_S)).astype(int)
    offsets = np.arange(-r, r + 1)
    idx = np.clip(centre[:, None] + offsets[None, :], 0, len(env) - 1)
    vals = env[idx]
    best = np.argmax(vals, axis=1)
    peak = vals[np.arange(len(times)), best]
    at = idx[np.arange(len(times)), best].astype(np.float64)
    left = env[np.clip(idx[np.arange(len(times)), best] - 1, 0, len(env) - 1)]
    right = env[np.clip(idx[np.arange(len(times)), best] + 1, 0, len(env) - 1)]
    denom = left - 2 * peak + right
    shift = np.where(np.abs(denom) > 1e-9, 0.5 * (left - right) / np.where(denom == 0, 1, denom), 0.0)
    at = at + np.clip(shift, -0.5, 0.5)
    return peak, at * HOP / SR - ONSET_LAG_S


# ── the beat grid ────────────────────────────────────────────────────────────

def _estimate_bpm(env) -> Optional[float]:
    """The tempo the envelope repeats at: its autocorrelation (by FFT, so a
    10-minute track costs a few MB), weighted toward 124 BPM within an
    octave either way, between 60 and 200 BPM. librosa's tempogram would
    hold a window of lags for every frame (over a GB on a long track)."""
    import numpy as np

    x = np.asarray(env, dtype=np.float64)
    n = len(x)
    if n < 64:
        return None
    x = x - x.mean()
    size = 1 << int(2 * n - 1).bit_length()
    spec = np.fft.rfft(x, size)
    ac = np.fft.irfft(spec * np.conj(spec), size)[:n]
    fps = SR / HOP
    lags = np.arange(max(1, int(60 * fps / 200)), min(n - 1, int(60 * fps / 60)) + 1)
    if lags.size < 3:
        return None
    bpm = 60 * fps / lags
    prior = np.exp(-0.5 * (np.log2(bpm / 124.0) / 0.5) ** 2)
    score = ac[lags] * prior
    k = int(np.argmax(score))
    if score[k] <= 0:
        return None
    lag = float(lags[k])
    if 0 < k < len(lags) - 1:
        a, b, c = ac[lags[k] - 1], ac[lags[k]], ac[lags[k] + 1]
        denom = a - 2 * b + c
        if abs(denom) > 1e-12:
            lag += float(np.clip(0.5 * (a - c) / denom, -0.5, 0.5))
    return 60 * fps / lag


def _tempo(env, bpm_hint: Optional[float]) -> Optional[float]:
    """The tempo to look near: the hint (the DJ data's BPM: a tag, enrichment
    or the first analysis) when there is one, else the envelope's own,
    folded into 70–180. The grid search then finds the exact period within
    4% of it."""
    bpm = None
    if bpm_hint:
        try:
            bpm = float(bpm_hint)
        except (TypeError, ValueError):
            bpm = None
    if not bpm or not math.isfinite(bpm) or bpm <= 0:
        bpm = _estimate_bpm(env)
    if not bpm or bpm <= 0:
        return None
    while bpm < 70:
        bpm *= 2
    while bpm >= 180:
        bpm /= 2
    return bpm


def _dp_beats(env, bpm: float):
    import librosa
    import numpy as np

    _, frames = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, bpm=bpm, tightness=200,
                                        trim=False, units="frames")
    return np.asarray(frames, dtype=np.float64) * HOP / SR


def _index_beats(times, period: float):
    """An integer beat number for each tracked beat, counting skipped beats
    (a tracker can jump one where there's no kick)."""
    import numpy as np

    idx = np.zeros(len(times), dtype=np.int64)
    for i in range(1, len(times)):
        idx[i] = idx[i - 1] + max(1, int(round((times[i] - times[i - 1]) / period)))
    return idx


def _hit_rate(env, beats, active) -> float:
    """Of the beats where the track is playing, how many have an onset on
    them (within ±35 ms) at least a quarter the size of the track's big
    ones (a pad's shimmer isn't a beat), times how much louder the beats
    are than the half-beats between them."""
    import numpy as np

    if len(beats) == 0:
        return 0.0
    peaks, _ = _peak_near(env, beats, 0.035)
    off = _interp(env, np.asarray(beats) + 0.5 * float(np.median(np.diff(beats))) if len(beats) > 1 else beats)
    on = peaks[active] if active is not None and active.any() else peaks
    if on.size == 0:
        return 0.0
    big = float(np.median(np.sort(peaks)[-max(1, len(peaks) // 10):]))
    threshold = max(0.08, float(np.percentile(env, 75)), 0.25 * big)
    hits = float(np.mean(on >= threshold))
    # an onset on the beat louder than off it: the grid is on the beat, not between
    contrast = float(np.mean(peaks)) / (float(np.mean(off)) + 1e-6)
    return hits * min(1.0, max(0.0, (contrast - 0.8) / 1.2))


def beat_envelope(feat):
    """What the grid follows: mostly the low band's attacks (the kick), with
    a little of the whole spectrum for tracks without one. The off-beat hats
    and bass of house music would pull a broadband envelope half a beat off."""
    import numpy as np

    env = feat["env_low"] + BROADBAND_WEIGHT * feat["env"]
    top = float(np.percentile(env, 99)) if env.size else 0.0
    return env / top if top > 0 else env


def _onsets(env):
    """The envelope's clear peaks: ``(times, weights)``, at least 100 ms
    apart, each placed to a fraction of a frame."""
    import numpy as np
    from scipy.signal import find_peaks

    threshold = max(0.08, float(np.percentile(env, 85)))
    frames, props = find_peaks(env, height=threshold, distance=max(1, int(_t2f(0.1))))
    if frames.size == 0:
        return np.zeros(0), np.zeros(0)
    left = env[np.maximum(frames - 1, 0)]
    right = env[np.minimum(frames + 1, len(env) - 1)]
    mid = env[frames]
    denom = left - 2 * mid + right
    shift = np.where(np.abs(denom) > 1e-9, 0.5 * (left - right) / np.where(denom == 0, 1, denom), 0.0)
    times = (frames + np.clip(shift, -0.5, 0.5)) * HOP / SR - ONSET_LAG_S
    heights = np.asarray(props["peak_heights"], dtype=np.float64)
    keep = times > EDGE_S  # cut short by the edge: placed late
    return times[keep], heights[keep]


#: the grid's comb: a von Mises bump (κ = 8, about a twentieth of a beat
#: wide) as its first harmonics. A plain phase vector would let the
#: off-beat hats, snares and syncopated kicks of a breakbeat cancel the beat
KAPPA = 8.0
HARMONICS = 6
PHASES = 128


def _alignment(times, weights, periods):
    """For each period, how well the onsets line up on one grid of it (0–1:
    the weighted share of the onsets under the comb's bump at its best
    phase), and that phase (radians)."""
    import numpy as np
    from scipy.special import ive

    h = np.arange(1, HARMONICS + 1)
    a = ive(h, KAPPA) / ive(0, KAPPA)
    phis = np.linspace(0, 2 * np.pi, PHASES, endpoint=False)
    basis = np.exp(-1j * np.outer(h, phis)) * a[:, None]  # (H, phases)
    total = float(weights.sum()) * float(a.sum()) or 1.0
    strength = np.empty(len(periods))
    phase = np.empty(len(periods))
    for start in range(0, len(periods), 64):
        p = periods[start:start + 64, None]
        unit = np.exp(2j * np.pi * times[None, :] / p)  # (P, n)
        z = np.empty((len(p), HARMONICS), dtype=np.complex128)
        power = np.ones_like(unit)
        for k in range(HARMONICS):
            power = power * unit
            z[:, k] = (power * weights[None, :]).sum(axis=1)
        score = np.real(z @ basis)  # (P, phases)
        best = np.argmax(score, axis=1)
        strength[start:start + 64] = np.maximum(0.0, score[np.arange(len(p)), best]) / total
        phase[start:start + 64] = phis[best]
    return strength, phase


def _prior(bpm):
    """How likely a tempo is before listening: centred on 124 BPM, falling
    away over an octave either side (club music sits at 118–130)."""
    import numpy as np

    return np.exp(-0.5 * (np.log2(np.asarray(bpm) / 124.0) / 0.6) ** 2)


def _scan_tempo(times, weights) -> Tuple[Optional[float], float]:
    """The tempo between 70 and 180 BPM whose grid the onsets fit best (a
    0.1% step, weighted by the prior): ``(bpm, strength)``."""
    import numpy as np

    bpms = 70.0 * np.exp(np.arange(0, math.log(180.0 / 70.0), 0.001))
    strength, _ = _alignment(times, weights, 60.0 / bpms)
    score = strength * _prior(bpms)
    k = int(np.argmax(score))
    return (float(bpms[k]), float(strength[k])) if score[k] > 0 else (None, 0.0)


def _steady_grid(times, weights, period0: float):
    """The constant grid that fits the onsets best, searched within ±4% of
    the expected period and then to a millionth of it: ``(period, first
    beat, strength)``."""
    import numpy as np

    coarse = period0 * (1 + np.linspace(-0.04, 0.04, 801))
    strength, _ = _alignment(times, weights, coarse)
    best = float(coarse[int(np.argmax(strength))])
    fine = best * (1 + np.linspace(-2e-4, 2e-4, 401))
    strength, phase = _alignment(times, weights, fine)
    k = int(np.argmax(strength))
    period = float(fine[k])
    first = (phase[k] / (2 * np.pi)) * period
    return period, first % period, float(strength[k])


def _local_alignment(times, weights, period: float) -> float:
    """The median, over 30 s windows (overlapping by half), of how well the
    onsets line up on a constant grid near ``period``: a drifting track is
    steady for half a minute; noise never is."""
    import numpy as np

    if times.size == 0:
        return 0.0
    found = []
    start = 0.0
    end = float(times.max())
    while start <= max(0.0, end - ALIGN_WINDOW_S / 2):
        inside = (times >= start) & (times < start + ALIGN_WINDOW_S)
        if inside.sum() >= 12:
            found.append(_steady_grid(times[inside], weights[inside], period)[2])
        start += ALIGN_WINDOW_S / 2
    return float(np.median(found)) if found else 0.0


def _octave_of(a: float, b: float) -> bool:
    """True when two tempos are the same up to halving or doubling (±4%)."""
    for factor in (0.5, 1.0, 2.0):
        if abs(a * factor - b) / b <= 0.04:
            return True
    return False


def _residuals(times, period: float, first: float):
    """Each onset's distance (s) from the grid line nearest it."""
    import numpy as np

    pos = (times - first) / period
    return (pos - np.round(pos)) * period


def _local_period(a_idx, a_t, at: int, side: int) -> float:
    """The beat period around anchor ``at``, from a line through up to 16
    anchors on one side (−1 before, +1 after)."""
    import numpy as np

    sel = slice(max(0, at - 15), at + 1) if side < 0 else slice(at, at + 16)
    i, t = a_idx[sel], a_t[sel]
    if len(i) < 3:
        return float((a_t[-1] - a_t[0]) / max(1, a_idx[-1] - a_idx[0]))
    return float(np.polyfit(i.astype(np.float64), t, 1)[0])


def _fill_gaps(beats, full, a_idx, a_t) -> None:
    """Beats across a stretch without anchors (a breakdown): a cubic that
    leaves the anchor before at the tempo there and meets the one after at
    its tempo, so a tempo that moved across the gap is followed."""
    import numpy as np

    for k in range(len(a_idx) - 1):
        span = int(a_idx[k + 1] - a_idx[k])
        if span <= 2:
            continue
        p0 = _local_period(a_idx, a_t, k, -1)
        p1 = _local_period(a_idx, a_t, k + 1, +1)
        inside = (full > a_idx[k]) & (full < a_idx[k + 1])
        u = (full[inside] - a_idx[k]) / span
        h00, h10 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u
        h01, h11 = -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
        beats[inside] = h00 * a_t[k] + h10 * span * p0 + h01 * a_t[k + 1] + h11 * span * p1
    np.maximum.accumulate(beats, out=beats)


def _drifting_beats(env, period: float, duration: float):
    import numpy as np

    tracked = _dp_beats(env, 60.0 / period)
    if len(tracked) < 16:
        return None, tracked
    idx = _index_beats(tracked, period)
    peaks, at = _peak_near(env, tracked, 0.06)
    # an anchor is a kick-sized onset: a pad's slow attack peaks late, and an
    # onset in the first frames is cut short by the edge
    strong = (peaks >= max(0.1, 0.5 * float(np.percentile(peaks, 75)))) & (at > EDGE_S)
    a_idx, a_t = idx[strong], at[strong]
    if a_idx.size < 8:
        a_idx, a_t = idx, tracked
    # keep the anchors in order (an onset pulled past its neighbour is dropped)
    ok = np.concatenate([[True], np.diff(a_t) > 0.5 * period * np.diff(a_idx)])
    a_idx, a_t = a_idx[ok], a_t[ok]
    head = float(np.median(np.diff(a_t[:9]) / np.diff(a_idx[:9])))
    tail = float(np.median(np.diff(a_t[-9:]) / np.diff(a_idx[-9:])))
    lo = int(a_idx[0] - math.floor((a_t[0] + 0.02) / head))
    hi = int(a_idx[-1] + math.ceil(max(0.0, duration - a_t[-1]) / tail))
    full = np.arange(lo, hi + 1)
    beats = np.interp(full, a_idx, a_t)
    _fill_gaps(beats, full, a_idx, a_t)
    before, after = full < a_idx[0], full > a_idx[-1]
    beats[before] = a_t[0] + (full[before] - a_idx[0]) * head
    beats[after] = a_t[-1] + (full[after] - a_idx[-1]) * tail
    return beats[(beats >= -0.02) & (beats < duration)], tracked


#: the sixteenth check's weight on the backbeat (a snare on two and four)
#: beside the kicks on the beat, and how much better another sixteenth must
#: score to move the grid there; under AMBIGUOUS_MARGIN the grid's
#: confidence is cut so the planner crossfades (gauntlet L4 of stage A)
BACKBEAT_WEIGHT = 1.5
SHIFT_MARGIN = 1.15
AMBIGUOUS_MARGIN = 1.15
AMBIGUOUS_FACTOR = 0.6
#: a grid the check moved (a break) is kept, for its bars and phrases, but
#: under the planner's bar for beat-matching (0.5) until the check has been
#: proven on real breaks: such a pair crossfades
BREAK_CONFIDENCE = 0.45


def sixteenth_check(feat, beats) -> Tuple[int, float]:
    """Which of the four sixteenths the beat is really on: ``(shift, margin)``,
    the shift in sixteenths (0–3) from ``beats`` and how far its score leads
    the next best (a ratio).

    The comb follows the kick, which is right for four-on-the-floor music
    and wrong for a syncopated break: an Amen-style break puts more kicks on
    the "and"s than on the beat, so the comb locks half a beat or a
    sixteenth off. What says where the beat is in a break is the backbeat:
    a snare on two and four and not on one and three. So each sixteenth's
    beats are scored on the kick there (the low band) and on how much the
    snare's band differs between the beats in turn (the backbeat), each as
    a share of its best sixteenth over a two-beat cycle; hats on every "and"
    and a kick on every beat don't alternate, so they don't sway it."""
    import numpy as np

    beats = np.asarray(beats, dtype=np.float64)
    if len(beats) < 16 or "env_mid" not in feat:
        return 0, float("inf")
    spacing = np.diff(beats)
    spacing = np.append(spacing, spacing[-1])
    radius = float(min(0.035, 0.1 * float(np.median(spacing))))
    low_env, mid_env = feat["env_low"], feat["env_mid"]
    n = len(beats) - len(beats) % 2
    low = np.zeros(8)
    mid = np.zeros(8)
    for k in range(8):
        # sixteenth k of a two-beat cycle: beat (k // 4) of each pair, k % 4 sixteenths on
        at = beats[k // 4:n:2] + (k % 4) * spacing[k // 4:n:2] / 4.0
        low[k] = float(np.mean(_peak_near(low_env, at, radius)[0]))
        mid[k] = float(np.mean(_peak_near(mid_env, at, radius)[0]))
    if low.max() <= 0:
        return 0, float("inf")
    low = low / low.max()
    mid = mid / mid.max() if mid.max() > 0 else mid
    scores = np.array([(low[c] + low[c + 4]) / 2.0 + BACKBEAT_WEIGHT * abs(mid[c + 4] - mid[c])
                       for c in range(4)])
    order = np.argsort(scores)[::-1]
    best, second = int(order[0]), int(order[1])
    if best != 0 and scores[best] < SHIFT_MARGIN * scores[0]:
        best, second = 0, best  # not clearly better: the comb's beat stays
    other = max(float(scores[c]) for c in range(4) if c != best)
    margin = float(scores[best]) / other if other > 0 else float("inf")
    return best, margin


def beat_grid(feat: Dict[str, Any], bpm_hint: Optional[float] = None) -> Dict[str, Any]:
    """The grid: ``{kind: constant | beats | none, bpm, period, first_beat,
    beats (times), confidence}``.

    Steady tracks: the kick-weighted envelope's clear onsets, and the one
    constant period and phase they line up on best (a weighted phase
    vector, searched near the expected tempo). The onsets on the beat then
    say how steady it is: their spread about the grid, and how far a run of
    them bends away from it. A track that bends (a drift) keeps librosa's
    tracked beats instead, each pulled onto its onset."""
    import numpy as np

    env = beat_envelope(feat)
    duration = feat["duration"]
    times, weights = _onsets(env)
    if times.size < 16:
        return {"kind": "none", "reason": "no_beat", "confidence": 0.0}
    # the hint's tempo (folded), unless the onsets fit another tempo far
    # better that isn't the hint's half or double (a wrong tag)
    hinted = _tempo(env, bpm_hint) if bpm_hint else None
    scanned, scan_strength = _scan_tempo(times, weights)
    bpm = hinted or scanned or _tempo(env, None)
    if bpm is None:
        return {"kind": "none", "reason": "no_beat", "confidence": 0.0}
    period, first, strength = _steady_grid(times, weights, 60.0 / bpm)
    if hinted and scanned and scan_strength > 1.5 * strength and not _octave_of(scanned, hinted):
        period, first, strength = _steady_grid(times, weights, 60.0 / scanned)
    res = _residuals(times, period, first)
    # the onsets on the beat (within an eighth of it; a sixteenth or a
    # swung eighth isn't the beat), the louder half of them
    on_beat = (np.abs(res) < 0.125 * period) & (weights >= np.median(weights))
    res_on = res[on_beat]
    mad_ms = 1000 * float(np.median(np.abs(res_on - np.median(res_on)))) if res_on.size else 1e3
    window = min(24, max(4, res_on.size // 6))
    running = (np.convolve(res_on, np.ones(window) / window, mode="valid")
               if res_on.size >= window else res_on)
    drift_ms = 1000 * float(np.max(np.abs(running - np.median(res_on)))) if running.size else 1e3
    rms_frames = feat["rms_db"]
    loud = float(np.percentile(rms_frames, 95))

    def active_mask(beat_times):
        frames = np.clip(np.round(_t2f(beat_times)).astype(int), 0, len(rms_frames) - 1)
        return rms_frames[frames] > loud - 30

    if mad_ms <= STEADY_MAD_MS and drift_ms <= STEADY_DRIFT_MS:
        # centre the grid on the on-beat onsets (the phase vector leans
        # toward the louder ones)
        first = float(first + np.median(res_on))
        shift, margin = sixteenth_check(feat, first + np.arange(0, int((duration - first) / period) + 1) * period)
        if shift:
            # a break: the beat is a sixteenth (or an eighth) from the kicks'
            # line; centred on the onsets found there
            first += shift * period / 4.0
            res = _residuals(times, period, first)
            near = (np.abs(res) < 0.06 * period) & (weights >= np.median(weights))
            if near.any():
                first = float(first + np.median(res[near]))
        first %= period
        if first > period - 0.02:
            first -= period  # a beat right at the start: keep it
        beats = first + np.arange(0, int((duration - first) / period) + 1) * period
        beats = beats[(beats >= -0.02) & (beats < duration)]
        # a break's beats are told by the whole spectrum (its snares), not the kick
        hits = _hit_rate(feat["env"] if shift else env, beats, active_mask(beats))
        steady = max(0.0, min(1.0, 1.0 - max(0.0, mad_ms - 3.0) / 15.0))
        confidence = hits * (0.6 + 0.4 * steady)
        if shift:
            confidence = min(confidence, BREAK_CONFIDENCE)
        if margin < AMBIGUOUS_MARGIN:
            confidence *= AMBIGUOUS_FACTOR  # not sure which sixteenth: crossfade
        return {"kind": "constant", "bpm": round(60.0 / period, 3), "period": period, "first_beat": float(beats[0]),
                "beats": beats, "confidence": round(confidence, 3), "sixteenth": shift,
                "sixteenth_margin": round(min(margin, 99.0), 2),
                "mad_ms": round(mad_ms, 1), "drift_ms": round(drift_ms, 1), "alignment": round(strength, 3)}
    # a drifting tempo: librosa's tracked beats give each onset its beat
    # number; the beats with a clear onset are kept where the onset is, and
    # the rest (a breakdown without a kick) are drawn in a straight line
    # between them, carried on at the ends at the local period
    local = _local_alignment(times, weights, period)
    if local < MIN_DRIFT_ALIGNMENT:
        # no tempo the onsets lean toward, even half a minute at a time
        # (noise, random clicks): a beat tracker would still lay beats on
        # its onsets
        return {"kind": "none", "reason": "no_beat", "confidence": 0.0, "alignment": round(strength, 3),
                "local_alignment": round(local, 3)}
    beats, tracked = _drifting_beats(env, period, duration)
    if beats is None or len(beats) < 16:
        return {"kind": "none", "reason": "no_beat", "confidence": 0.0}
    # scored on the tracked beats as the tracker placed them, before each is
    # pulled onto its onset: pulled beats would score themselves
    tracked = np.asarray(tracked, dtype=np.float64)
    hits = _hit_rate(env, tracked, active_mask(tracked))
    confidence = hits * 0.8
    shift, margin = sixteenth_check(feat, beats)
    if shift:
        gaps = np.append(np.diff(beats), np.diff(beats)[-1])
        beats = beats + shift * gaps / 4.0
        beats = beats[beats < duration]
        confidence = min(_hit_rate(feat["env"], beats, active_mask(beats)) * 0.8, BREAK_CONFIDENCE)
    if margin < AMBIGUOUS_MARGIN:
        confidence *= AMBIGUOUS_FACTOR
    period = float(np.median(np.diff(beats)))
    return {"kind": "beats", "bpm": round(60.0 / period, 3), "period": period, "first_beat": float(beats[0]),
            "beats": beats, "confidence": round(confidence, 3), "sixteenth": shift,
            "sixteenth_margin": round(min(margin, 99.0), 2), "mad_ms": round(mad_ms, 1),
            "drift_ms": round(drift_ms, 1), "alignment": round(strength, 3)}


# ── downbeats ────────────────────────────────────────────────────────────────

def _segment_means(matrix, edges_f):
    """Column means of ``matrix`` between consecutive frame edges."""
    import numpy as np

    n = matrix.shape[1]
    edges = np.clip(np.asarray(edges_f, dtype=np.int64), 0, n)
    csum = np.concatenate([np.zeros((matrix.shape[0], 1)), np.cumsum(matrix, axis=1, dtype=np.float64)], axis=1)
    lo, hi = edges[:-1], np.maximum(edges[1:], edges[:-1] + 1)
    hi = np.minimum(hi, n)
    lo = np.minimum(lo, hi - 1)
    return (csum[:, hi] - csum[:, lo]) / np.maximum(1, hi - lo)


def _z(x):
    import numpy as np

    x = np.asarray(x, dtype=np.float64)
    med = np.median(x)
    mad = np.median(np.abs(x - med)) * 1.4826
    sd = mad if mad > 1e-9 else (x.std() or 1.0)
    return np.clip((x - med) / sd, -4, 4)


def _beat_salience(feat, beats):
    """How much each beat sounds like the one: a stronger kick and attack,
    the harmony turning, the timbre changing (each z-scored)."""
    import numpy as np

    kick, _ = _peak_near(feat["env_low"], beats, 0.03)
    attack, _ = _peak_near(feat["env"], beats, 0.03)
    edges = np.round(_t2f(np.append(beats, beats[-1] + np.median(np.diff(beats))))).astype(int)
    chroma = _segment_means(feat["chroma"], edges)
    norm = np.linalg.norm(chroma, axis=0) + 1e-9
    unit = chroma / norm
    turn = np.concatenate([[0.0], 1.0 - np.sum(unit[:, 1:] * unit[:, :-1], axis=0)])
    mel = _segment_means(feat["mel_db"], edges)
    newness = np.concatenate([[0.0], np.maximum(0.0, mel[:, 1:] - mel[:, :-1]).mean(axis=0)])
    return 1.0 * _z(kick) + 0.7 * _z(attack) + 1.2 * _z(turn) + 0.8 * _z(newness)


def _phase_strength(salience, period: int) -> Tuple[int, float]:
    """``(best phase, separation)``: the phase whose beats stand out most, and
    by how many standard errors over the next best."""
    import numpy as np

    means, vars_, counts = [], [], []
    for p in range(period):
        v = salience[p::period]
        means.append(float(np.mean(v)) if v.size else -1e9)
        vars_.append(float(np.var(v)) if v.size > 1 else 1.0)
        counts.append(max(1, v.size))
    order = np.argsort(means)[::-1]
    a, b = int(order[0]), int(order[1])
    se = math.sqrt(vars_[a] / counts[a] + vars_[b] / counts[b]) or 1e-6
    return a, (means[a] - means[b]) / se


def downbeats(feat, beats) -> Dict[str, Any]:
    """``{phase, confidence, meter}``: beats[phase] is the first downbeat."""
    import numpy as np

    if len(beats) < 16:
        return {"phase": 0, "confidence": 0.0, "meter": "unknown"}
    salience = _beat_salience(feat, np.asarray(beats))
    phase, sep4 = _phase_strength(salience, 4)
    _, sep3 = _phase_strength(salience, 3)
    meter = "4/4"
    if sep3 > 4.0 and sep3 > 1.5 * max(sep4, 0.0):
        meter = "not_4_4"
    confidence = max(0.0, min(1.0, (sep4 - 1.0) / 6.0))
    if meter != "4/4":
        confidence = min(confidence, 0.2)
    return {"phase": int(phase), "confidence": round(confidence, 3), "meter": meter}


# ── bars, novelty, phrases and sections ──────────────────────────────────────

def _bar_features(feat, bar_starts):
    """Per bar: timbre (16 bands), harmony (12), loudness (dB) and kick."""
    import numpy as np

    edges = np.round(_t2f(bar_starts)).astype(int)
    mel = _segment_means(feat["mel_db"], edges)
    timbre = mel.reshape(16, N_MELS // 16, -1).mean(axis=1)
    chroma = _segment_means(feat["chroma"], edges)
    chroma = chroma / (np.linalg.norm(chroma, axis=0) + 1e-9)
    rms = _segment_means(feat["rms_db"][None, :], edges)[0]
    return timbre, chroma, rms


def _kick_per_bar(feat, beats, first: int, n_bars: int):
    import numpy as np

    kick, _ = _peak_near(feat["env_low"], beats, 0.03)
    usable = kick[first:first + n_bars * 4]
    return usable[:n_bars * 4].reshape(n_bars, 4).mean(axis=1)


def _novelty(features, width: int):
    """Foote's checkerboard novelty on the bars' self-similarity: high where
    the ``width`` bars before differ from the ``width`` after."""
    import numpy as np

    x = features / (np.linalg.norm(features, axis=0, keepdims=True) + 1e-9)
    ssm = x.T @ x
    n = ssm.shape[0]
    g = np.exp(-0.5 * (np.linspace(-1.5, 1.5, 2 * width)) ** 2)
    taper = np.outer(g, g)
    sign = np.ones((2 * width, 2 * width))
    sign[:width, width:] = -1
    sign[width:, :width] = -1
    kernel = taper * sign
    padded = np.pad(ssm, width, mode="edge")
    out = np.zeros(n)
    for b in range(n):
        block = padded[b:b + 2 * width, b:b + 2 * width]
        out[b] = float(np.sum(block * kernel))
    return np.maximum(0.0, out)


def _boundaries(novelty, n_bars: int) -> List[Tuple[int, float]]:
    """Section changes: the novelty's clear peaks, at least 4 bars apart.
    Sections run in multiples of four bars, so the line of fours the peaks
    mostly sit on is found first (a track can start on a pickup bar), and a
    peak a bar off it moves onto it when the novelty there is nearly as
    strong. ``[(bar, strength 0-1)]``."""
    import numpy as np

    if n_bars < 12 or not novelty.size or novelty.max() <= 0:
        return []
    nov = novelty / novelty.max()
    floor = max(0.25, float(np.median(nov) + 2.5 * np.median(np.abs(nov - np.median(nov)))))
    peaks = [b for b in range(2, n_bars - 1)
             if nov[b] >= floor and nov[b] == nov[max(0, b - 2):min(n_bars, b + 3)].max()]
    if not peaks:
        return []
    origin = int(np.argmax([sum(nov[b] for b in peaks if (b - o) % 4 == 0) for o in range(4)]))
    found: List[Tuple[int, float]] = []
    for b in peaks:
        if (b - origin) % 4 != 0:
            target = b + (1 if (b - origin) % 4 == 3 else -1 if (b - origin) % 4 == 1 else 0)
            if target != b and 0 < target < n_bars and nov[target] >= 0.6 * nov[b]:
                b = target
        if found and b - found[-1][0] < 4:
            if nov[b] > found[-1][1]:
                found[-1] = (b, float(nov[b]))
            continue
        found.append((b, float(nov[b])))
    return found


def phrases_from(changes: Sequence[int], n_bars: int) -> List[List[int]]:
    """Phrase boundaries: every 8 bars from each section change, and before
    the first change, counted back from it (so a track that opens on a
    pickup bar still has its phrases on the music's). Each is ``[bar,
    level, section]``: level 32, 16 or 8 by how many bars from its change
    it falls; ``section`` 1 where the change itself is. A boundary closer
    than 4 bars to the next change is left out (it isn't a phrase)."""
    anchors = sorted({int(c) for c in changes if 0 < int(c) < n_bars})
    first = anchors[0] if anchors else 0
    out: List[List[int]] = []
    for bar in range(first - 8 * (first // 8), first, 8):
        k = first - bar
        out.append([bar, 32 if k % 32 == 0 else 16 if k % 16 == 0 else 8, 0])
    if not anchors:
        anchors = [0]
    for i, a in enumerate(anchors):
        end = anchors[i + 1] if i + 1 < len(anchors) else n_bars
        for bar in range(a, end, 8):
            k = bar - a
            if k and end - bar < 4 and i + 1 < len(anchors):
                continue
            level = 32 if k % 32 == 0 else 16 if k % 16 == 0 else 8
            out.append([bar, level, 1 if (k == 0 and a in changes) else 0])
    return out


def _label_sections(parts: List[Tuple[int, int]], rms, kick, truncated: bool) -> List[List[Any]]:
    """``[[label, start_bar, end_bar, confidence]]`` for the parts between
    changes, from each part's loudness and kick against the track's main
    level."""
    import numpy as np

    if not parts:
        return []
    level = np.array([float(np.mean(rms[a:b])) for a, b in parts])
    drums = np.array([float(np.mean(kick[a:b])) for a, b in parts])
    weights = np.array([b - a for a, b in parts], dtype=float)
    order = np.argsort(level)
    cum = np.cumsum(weights[order]) / weights.sum()
    main = float(level[order][np.searchsorted(cum, 0.6)])  # the level most of the track sits at or under
    kick_ref = float(np.percentile(kick, 75)) or 1e-6
    has_kick = drums >= 0.45 * kick_ref
    labels = ["main"] * len(parts)
    conf = [0.5] * len(parts)
    n = len(parts)
    total = float(weights.sum())

    def quieter(i: int) -> float:
        return main - level[i]

    # the intro: from the start while the parts sit under the main level, a
    # third of the track at most
    i = 0
    while i < n - 1 and (quieter(i) >= 1.5 or not has_kick[i]):
        if sum(weights[:i + 1]) > total / 3:
            break
        labels[i] = "intro"
        conf[i] = min(1.0, 0.4 + quieter(i) / 8.0)
        i += 1
    intro_end = i
    if not truncated:
        j = n - 1
        while j > intro_end and (quieter(j) >= 1.5 or not has_kick[j]):
            if sum(weights[j:]) > total / 3:
                break
            labels[j] = "outro"
            conf[j] = min(1.0, 0.4 + quieter(j) / 8.0)
            j -= 1
    # breakdowns (no kick, or well under the main level, between louder
    # parts) and the drop after each
    for k in range(1, n - 1):
        if labels[k] != "main":
            continue
        if (not has_kick[k] or quieter(k) >= 4.0) and labels[k + 1] in ("main",):
            labels[k] = "breakdown"
            conf[k] = min(1.0, 0.45 + (0.25 if not has_kick[k] else 0.0) + max(0.0, quieter(k)) / 12.0)
            jump = level[k + 1] - level[k]
            if has_kick[k + 1] and jump >= 2.0:
                labels[k + 1] = "drop"
                conf[k + 1] = min(1.0, 0.4 + jump / 10.0)
    return [[labels[k], int(a), int(b), round(float(conf[k]), 2)] for k, (a, b) in enumerate(parts)]


def _mix_regions(sections: List[List[Any]], kick, n_bars: int, truncated: bool):
    """Where the incoming track can come in and the outgoing go out:
    ``[start_bar, end_bar, confidence, how]`` each, or None. ``how`` is
    ``intro`` / ``outro`` (steady drums there), ``beat_only`` (a lower stretch
    with the kick near that end) or ``edge`` (just the first or last bars)."""
    import numpy as np

    if n_bars < 8:
        return None, None
    kick_ref = float(np.percentile(kick, 75)) or 1e-6
    drums = kick >= 0.45 * kick_ref

    def first_drum_bar(a: int, b: int) -> Optional[int]:
        for bar in range(a, b):
            if drums[bar:min(b, bar + 2)].all():
                return bar
        return None

    mix_in = None
    intro = [s for s in sections if s[0] == "intro"]
    if intro:
        a, b = intro[0][1], intro[-1][2]
        start = first_drum_bar(a, b)
        if start is not None and b - start >= 4:
            steady = float(np.mean(drums[start:b]))
            mix_in = [start, b, round(min(1.0, 0.5 * steady + 0.5 * intro[0][3]), 2), "intro"]
    if mix_in is None:
        start = first_drum_bar(0, min(n_bars, 32))
        if start is not None:
            end = min(n_bars, start + 16)
            mix_in = [start, end, round(0.35 * float(np.mean(drums[start:end])), 2), "beat_only"]
        else:
            mix_in = [0, min(n_bars, 8), 0.1, "edge"]

    mix_out = None
    if not truncated:
        outro = [s for s in sections if s[0] == "outro"]
        if outro:
            a, b = outro[0][1], outro[-1][2]
            end = b
            while end > a and not drums[end - 1]:
                end -= 1
            if end - a >= 4:
                steady = float(np.mean(drums[a:end]))
                mix_out = [a, end, round(min(1.0, 0.5 * steady + 0.5 * outro[0][3]), 2), "outro"]
        if mix_out is None:
            end = n_bars
            while end > n_bars - 32 and end > 0 and not drums[end - 1]:
                end -= 1
            start = max(0, end - 16)
            if end - start >= 4 and drums[start:end].mean() > 0.5:
                mix_out = [start, end, round(0.35 * float(np.mean(drums[start:end])), 2), "beat_only"]
            else:
                mix_out = [max(0, n_bars - 8), n_bars, 0.1, "edge"]
    return mix_in, mix_out


# ── the whole analysis ───────────────────────────────────────────────────────

def analyze_audio(y, sr: int, *, bpm_hint: Optional[float] = None, truncated: bool = False) -> Dict[str, Any]:
    """Everything above for one track's decoded audio (mono). Returns the
    compact form the store keeps (``status`` ``done``, or ``none`` with a
    ``reason``: ``too_short`` or ``no_beat``)."""
    import numpy as np

    y = np.asarray(y, dtype=np.float32)
    if y.size and not np.isfinite(y).all():
        # a damaged frame (NaN or inf samples) is silence, not the whole track
        y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    if sr != SR:
        import librosa

        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    duration = len(y) / SR
    base = {"version": GRID_VERSION, "analysed_s": round(duration, 3), "truncated": bool(truncated),
            "level_db": _level_db(y)}
    if duration < MIN_SECONDS:
        return {**base, "status": "none", "reason": "too_short"}
    feat = _features(y)
    grid = beat_grid(feat, bpm_hint)
    if grid["kind"] == "none" or grid["confidence"] < MIN_BEAT_CONFIDENCE:
        return {**base, "status": "none", "reason": "no_beat", "beat_confidence": grid.get("confidence", 0.0),
                "bpm": grid.get("bpm")}
    beats = np.asarray(grid["beats"])
    down = downbeats(feat, beats)
    first = down["phase"]
    n_bars = (len(beats) - first) // 4
    out = {**base, "status": "done", "kind": grid["kind"], "bpm": round(float(grid["bpm"]), 2),
           "period": float(grid["period"]), "first_beat": round(float(beats[0]), 4),
           "first_downbeat": round(float(beats[first]), 4), "downbeat_index": int(first),
           "beat_confidence": grid["confidence"], "downbeat_confidence": down["confidence"],
           "meter": down["meter"], "bars": int(n_bars),
           "beats": [round(float(b), 4) for b in beats] if grid["kind"] == "beats" else None}
    if n_bars < 8:
        return {**out, "phrases": phrases_from([], n_bars), "sections": [], "mix_in": None, "mix_out": None}
    bar_starts = beats[first:first + (n_bars + 1) * 4:4]
    if len(bar_starts) < n_bars + 1:
        bar_starts = np.append(bar_starts, bar_starts[-1] + 4 * grid["period"])
    timbre, chroma, rms = _bar_features(feat, bar_starts)
    kick = _kick_per_bar(feat, beats, first, n_bars)
    stacked = np.vstack([_zrows(timbre), 1.2 * _zrows(chroma), 2.0 * _z(rms)[None, :], 2.0 * _z(kick)[None, :]])
    novelty = _novelty(stacked, 4) + 0.5 * _novelty(stacked, 8)
    changes = _boundaries(novelty, n_bars)
    change_bars = [b for b, _ in changes]
    parts = list(zip([0] + change_bars, change_bars + [n_bars], strict=True))
    sections = _label_sections(parts, rms, kick, truncated)
    mix_in, mix_out = _mix_regions(sections, kick, n_bars, truncated)
    return {**out, "phrases": phrases_from(change_bars, n_bars), "sections": sections,
            "changes": [[b, round(s, 2)] for b, s in changes], "mix_in": mix_in, "mix_out": mix_out}


def _zrows(m):
    import numpy as np

    mu = m.mean(axis=1, keepdims=True)
    sd = m.std(axis=1, keepdims=True)
    return (m - mu) / np.where(sd > 1e-9, sd, 1.0)


def _level_db(y) -> Optional[float]:
    try:
        from core.sample.energy import loudness_db

        level = loudness_db(y)
    except Exception:  # noqa: BLE001 - no level is fine
        return None
    # never inf or NaN into the row (or the JSON a route answers); a level
    # past full scale only comes from samples that aren't audio
    if level is None or not math.isfinite(float(level)):
        return None
    return round(min(20.0, max(-150.0, float(level))), 2)


# ── reading a stored grid back as times ──────────────────────────────────────

class Grid:
    """A stored grid as times: beat ``i``, bar ``b`` (from the first
    downbeat). A constant grid runs on past the analysed part; a beat list
    carries on at its last period."""

    def __init__(self, *, kind: str, period: float, first_beat: float, downbeat_index: int,
                 beats: Optional[Sequence[float]] = None) -> None:
        self.kind = kind
        self.period = float(period)
        self.first_beat = float(first_beat)
        self.downbeat_index = int(downbeat_index)
        self.beats = list(beats) if beats else None

    def beat(self, i: float) -> float:
        if self.kind == "beats" and self.beats:
            n = len(self.beats)
            k = int(math.floor(i))
            if 0 <= k < n - 1:
                return self.beats[k] + (i - k) * (self.beats[k + 1] - self.beats[k])
            tail = self.beats[-1] - self.beats[-2] if n > 1 else self.period
            head = self.beats[1] - self.beats[0] if n > 1 else self.period
            return self.beats[-1] + (i - (n - 1)) * tail if k >= n - 1 else self.beats[0] + i * head
        return self.first_beat + i * self.period

    def bar(self, b: float) -> float:
        return self.beat(self.downbeat_index + 4 * b)

    def bar_at(self, seconds: float) -> float:
        """The (fractional) bar playing at a time."""
        if self.kind == "beats" and self.beats:
            import bisect

            k = bisect.bisect_right(self.beats, seconds) - 1
            k = max(0, min(len(self.beats) - 2, k))
            span = self.beats[k + 1] - self.beats[k] or self.period
            beat = k + (seconds - self.beats[k]) / span
        else:
            beat = (seconds - self.first_beat) / self.period
        return (beat - self.downbeat_index) / 4.0


__all__ = ["GRID_VERSION", "Grid", "LABELS", "MIN_SECONDS", "analyze_audio", "beat_grid", "downbeats",
           "phrases_from"]
