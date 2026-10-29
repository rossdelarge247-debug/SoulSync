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
harmony. ``tests/dj/test_grid_accuracy.py`` measures it on generated tracks,
``scripts/grid_bench.py`` on real ones (local files: HANDOFF, 29 October).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: bump when the analysis changes: the sweep redoes every track's grid
#: (2: the sixteenth check, below, for syncopated breaks; 3: the tempo's
#: octave, ``_octave`` below: drum and bass is 174, not 87. Grids at 100-140
#: BPM can't change, and are promoted without a decode by
#: database/music_database.py ``_promote_settled_tempos``; 4: a kick on every
#: beat keeps the grid on it, and the beat's confidence is counted where the
#: drums play (Ross's report of 28 October). Grids ready to mix at 3 are
#: promoted undecoded by ``_promote_ready_grids``; 5: measured on real
#: tracks (29 October): the confidence is the hit rate with an independent
#: tracker's agreement, the hint is a prior, the downbeat follows the kick.
#: Every grid is found again: nothing at 4 is promoted)
GRID_VERSION = 5

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
#: below this a grid (saved from MIN_BEAT_CONFIDENCE up) isn't trusted for
#: beat-matching: the planner echoes out or cuts instead
BEAT_CONFIDENT = 0.5


def beatmatch_problem(confidence: Any, meter: Any) -> Optional[str]:
    """Why a found grid can't be beat-matched, or None: ``low_confidence``
    (the beat isn't steady enough) or ``not_4_4`` (any meter but 4/4, a
    meter not worked out included; a grid without one is read as 4/4). The
    one rule the planner, "ready to mix" and its count all follow (the
    Brief A review's M1)."""
    try:
        conf = float(confidence or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    if conf < BEAT_CONFIDENT:
        return "low_confidence"
    if (meter or "4/4") != "4/4":
        return "not_4_4"
    return None
#: the flux peaks this long before a beat's attack (measured on generated
#: kicks with an instant attack): it's added back
ONSET_LAG_S = -0.0055

#: an onset in the first moments is cut short by the edge of the audio
EDGE_S = 0.05
#: how much the whole spectrum's attacks count beside the low band's
BROADBAND_WEIGHT = 0.15
#: log(1 + C·magnitude) for the onset flux
COMPRESSION = 10.0
#: the flux's scale is at least this (its 99th percentile, detrended, on
#: peak-normalised audio): real tracks measure 0.13 (an orchestra) to 1.09, a
#: sine or chord pad 0.0001-0.0034 (HANDOFF, grid v5's review)
FLUX_FLOOR = 0.05
#: the beat envelope's 99th percentile is taken as at least this, on the
#: unscaled flux (real tracks 0.45-4.4; a sine pad with a tremolo 0.018)
BEAT_ENV_FLOOR = 0.25
#: the hats' band starts here (Hz)
HIGH_HZ = 4000.0

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
    # the hats' and cymbals' band: where the drums play (``_drum_frames``)
    env_high = flux[freqs >= HIGH_HZ].mean(axis=0)
    # a snare's crack (1-5 kHz): the backbeat that says drum and bass
    # (``fast_backbeat``)
    env_crack = flux[(freqs >= 1000.0) & (freqs < 5000.0)].mean(axis=0)
    # RMS per frame from the signal itself (dB, peak-normalised)
    rms = np.zeros(n_frames)
    for start in range(0, n_frames, CHUNK_FRAMES):
        count = min(CHUNK_FRAMES, n_frames - start)
        block = ypad[pad + start * HOP:pad + (start + count) * HOP]
        if len(block) < count * HOP:
            block = np.concatenate([block, np.zeros(count * HOP - len(block), np.float32)])
        rms[start:start + count] = np.sqrt(np.mean(np.square(block.reshape(count, HOP)), axis=1))
    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-6))
    env, env_low, env_mid, env_high = _detrend(env), _detrend(env_low), _detrend(env_mid), _detrend(env_high)
    env_crack = _detrend(env_crack)
    # one scale for all, from the whole spectrum's attacks: a track without
    # low attacks (a pad, a voice) keeps a small low-band envelope instead
    # of having its noise blown up to the size of a kick
    # never under FLUX_FLOOR: a sustained tone's flux is noise, and scaled up
    # to its own 99th percentile it read as onsets (a sine pad was "ready")
    scale = max(float(np.percentile(env, 99)) if env.size else 0.0, FLUX_FLOOR)
    env, env_low, env_mid, env_high = env / scale, env_low / scale, env_mid / scale, env_high / scale
    return {"mel_db": mel_db, "chroma": chroma, "env": env, "env_low": env_low, "env_mid": env_mid, "env_high": env_high,
            "env_crack": env_crack / scale, "flux_scale": scale,
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
    folded into 70–200 (the tempo rule's bands, core/sample/tempo.py: a
    hardcore or gabber tag at 180–200 is kept, not halved). The grid search
    then finds the exact period within 4% of it."""
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
    while bpm >= 200:
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


#: the drums play in at least this share of a track's playing beats for its
#: hit rate to count in full (fewer: a beat only now and then)
DRUM_SHARE = 0.4


def _drum_beats(env, beats, active):
    """``(hit, use)`` per beat: an onset on it at least a quarter the size of
    the track's big ones (a pad's shimmer isn't a beat), and whether the
    drums play there: the bars with a drum-sized onset anywhere on their
    sixteenths, on the grid or off it, where the track is playing."""
    import numpy as np

    peaks, _ = _peak_near(env, beats, 0.035)
    big = float(np.median(np.sort(peaks)[-max(1, len(peaks) // 10):]))
    threshold = max(0.08, float(np.percentile(env, 75)), 0.25 * big)
    hit = peaks >= threshold
    playing = (np.ones(len(beats), dtype=bool) if active is None or not np.any(active)
               else np.asarray(active, dtype=bool))
    drums = hit.copy()
    whole = len(beats) // 4 * 4
    if whole:
        gap = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.0
        anywhere = hit.copy()
        for k in (1, 2, 3):
            anywhere |= _peak_near(env, beats + k * gap / 4.0, 0.035)[0] >= threshold
        drums[:whole] = np.repeat(anywhere[:whole].reshape(-1, 4).any(axis=1), 4)
    return hit, playing & drums


def _hit_rate(env, beats, active) -> float:
    """Of the beats where the drums play (``_drum_beats``), how many have an
    onset on them. A drumless intro, a breakdown or a vocal break isn't a
    beat the grid missed (Ross's report of 28 October), but a bar whose
    onsets all fall between the grid's beats is (the gauntlet review's L3).
    A track whose drums play in under DRUM_SHARE of it counts for less.

    No longer multiplied by how much louder the beats are than the
    half-beats between them (real audio of 29 October: techno with an
    off-beat bass as loud as its kick measured 0.97 there, so a grid on the
    beat scored 0.12). Which beat the grid is on is told by ``_agreement``,
    an independent tracker, instead."""
    import numpy as np

    beats = np.asarray(beats, dtype=np.float64)
    if len(beats) == 0:
        return 0.0
    hit, use = _drum_beats(env, beats, active)
    if not use.any():
        return 0.0
    playing = (np.ones(len(beats), dtype=bool) if active is None or not np.any(active)
               else np.asarray(active, dtype=bool))
    share = float(use.sum()) / float(playing.sum())
    return float(np.mean(hit[use])) * min(1.0, share / DRUM_SHARE)


#: an independent tracker's beat agrees with the grid's within this (s), or a
#: twelfth of a beat at fast tempos. At 50 ms (an eighth) grids an eighth of
#: a beat early still agreed (grid v5's review); real grids on the beat sit
#: within 16 ms of the reference
AGREE_TOLERANCE_S = 0.035
AGREE_TOLERANCE_BEATS = 12.0
#: the bands the tracker follows, one at a time (Hz): the low band (the kick,
#: and a bass) and the drums' attack above it (a kick's click, a clap, a
#: snare, the hats' low edge). The agreement is their mean: on generated
#: house a bass louder than the kick pulled the low band's tracker onto the
#: bass, and off-beat hats pulled the upper one half a beat off; on real
#: tracks both bands mostly agreed, and where one didn't the other did
#: (HANDOFF, 29 October)
AGREE_BANDS = ((30.0, 500.0), (500.0, 4000.0))
#: it runs in windows of this many beats (at fixed times) where the drums
#: play, each on its own: a long bass-only intro can't lock it before the
#: kick comes in
AGREE_WINDOW = 32
#: the beat's confidence: this share from the hit rate, the rest from the
#: agreement. Under one half, so a grid no tracker agrees with stays under
#: the bar for beat-matching however many onsets it hits (HANDOFF)
HIT_WEIGHT = 0.45


def _band_onsets(feat, band):
    """librosa's onset strength of the mel bands in ``band`` (Hz; None: all),
    kept in ``feat``."""
    import librosa
    import numpy as np

    key = ("onset_strength", band)
    if key not in feat:
        freqs = librosa.mel_frequencies(n_mels=N_MELS, fmin=30.0, fmax=8000.0)
        rows = np.ones(N_MELS, dtype=bool) if band is None else (freqs >= band[0]) & (freqs < band[1])
        # center=False: the spectrum's frames are centred already (librosa
        # would shift its envelope another 46 ms late)
        feat[key] = librosa.onset.onset_strength(S=np.asarray(feat["mel_db"])[rows], sr=SR, hop_length=HOP,
                                                 center=False)
    return feat[key]


def _band_agreement(onset, beats, period: float, use, tolerance: Optional[float] = None) -> Optional[float]:
    import librosa
    import numpy as np

    if tolerance is None:
        tolerance = min(AGREE_TOLERANCE_S, period / AGREE_TOLERANCE_BEATS)
    span = AGREE_WINDOW * period
    agreed = counted = 0
    # windows at fixed times, not at the grid's beats (a tracker started on
    # a beat of the grid it's checking leans towards it), overlapping by
    # half; only the middle half of each is counted (a tracker settles in)
    for t0 in np.arange(-span / 4, max(float(beats[-1]) - span / 2, 0.0) + 1e-9, span / 2):
        inside = (beats >= t0 + span / 4) & (beats < t0 + 3 * span / 4)
        if inside.sum() < 4 or use[inside].mean() < 0.5:
            continue
        lo_f = max(0, int(_t2f(t0)))
        hi_f = min(len(onset), int(_t2f(t0 + span)) + 1)
        _, tracked = librosa.beat.beat_track(onset_envelope=onset[lo_f:hi_f], sr=SR, hop_length=HOP,
                                             bpm=60.0 / period, tightness=400, trim=False, units="time")
        tracked = np.asarray(tracked, dtype=np.float64) + lo_f * HOP / SR
        tracked = tracked[(tracked >= t0 + span / 4) & (tracked < t0 + 3 * span / 4)]
        if len(tracked) < 4:
            continue
        idx = np.clip(np.searchsorted(beats, tracked), 1, len(beats) - 1)
        near = np.minimum(np.abs(tracked - beats[idx - 1]), np.abs(tracked - beats[idx]))
        agreed += int(np.sum(near <= tolerance))
        counted += len(near)
    return agreed / counted if counted else None


def _agreement(feat, beats, period: float, active=None, broadband: bool = False) -> float:
    return _agreement_bands(feat, beats, period, active, broadband)[0]


def _agreement_bands(feat, beats, period: float, active=None, broadband: bool = False):
    """How many of an independent tracker's beats fall on the grid's (0-1):
    librosa's dynamic-programming beat tracker (another method than the
    grid's comb on its kick-weighted envelope), held to the grid's tempo so
    only its phase is free, run afresh in each window of ``AGREE_WINDOW``
    beats where the drums play, on each of ``AGREE_BANDS``. A break's
    (``broadband``) follows the whole spectrum: its kicks are off the beat,
    its snares on two and four. It isn't proof of the phase: where the
    tracker itself takes an off-beat bass or the off-beat hats, it agrees
    with a grid half a beat off (Action, demucs_test: 0.8-0.95; grid v5's
    review). Grids shifted by 1/8-7/8 of a beat from the reference passed
    ``AGREE_READY`` and ``AGREE_ATTACK_MIN`` on 3 of 259 (the public and
    Ross's bench) and 8 of 483 (Groove's train split), the reference grids
    on 24 of 37 and 54 of 69 (grid v5's second review, HANDOFF)."""
    import numpy as np

    beats = np.asarray(beats, dtype=np.float64)
    if len(beats) < 8 or "mel_db" not in feat:
        return 0.0, 0.0
    _, use = _drum_beats(beat_envelope(feat), beats, active)
    bands = (None,) if broadband else AGREE_BANDS
    found = [_band_agreement(_band_onsets(feat, band), beats, period, use) for band in bands]
    # ``(mean, the attack band's)``: the last band is the drums' attack
    # (500-4000 Hz; a break's whole spectrum), see AGREE_ATTACK_MIN
    attack = found[-1]
    found = [f for f in found if f is not None]
    if not found:
        return 0.0, 0.0
    return float(np.mean(found)), float(attack if attack is not None else np.mean(found))


#: the agreement counts in full only where the beats have onsets on at least
#: this share of them: a tracker held to a tempo lays its beats evenly where
#: there are no onsets to place them, so it "agrees" with any even grid over
#: a pad (0.60 on a generated one, with hits at 0.26)
AGREE_FULL_HITS = 0.5


def _confidence(hits: float, agree: float) -> float:
    agree = agree * min(1.0, hits / AGREE_FULL_HITS)
    return HIT_WEIGHT * hits + (1.0 - HIT_WEIGHT) * agree


def beat_envelope(feat):
    """What the grid follows: mostly the low band's attacks (the kick), with
    a little of the whole spectrum for tracks without one. The off-beat hats
    and bass of house music would pull a broadband envelope half a beat off."""
    import numpy as np

    env = feat["env_low"] + BROADBAND_WEIGHT * feat["env"]
    # never scaled up from under BEAT_ENV_FLOOR (on the flux before
    # ``_features`` scaled it): a pad's low band stays too small to read as
    # onsets
    floor = BEAT_ENV_FLOOR / float(feat.get("flux_scale") or 1.0)
    top = max(float(np.percentile(env, 99)) if env.size else 0.0, floor)
    return env / top


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


def _octave(feat, times, weights, bpm: float, *, hinted: bool) -> float:
    """The tempo in its octave (core/sample/tempo.py): a slow reading (70-100)
    is doubled when the backbeat falls on every other beat of the double
    (drum and bass's snare on two and four of 174), and, for the grid's own
    scan, when it's under 78 (dubstep's 70 is 140). A hint (the DJ data's
    BPM) has already been through that rule or is a tag, so only the
    backbeat can double it; a fast reading is never halved here."""
    import numpy as np

    from core.sample import tempo

    if not tempo.is_slow(bpm):
        return bpm
    chosen, why = tempo.choose(bpm, use_range=not hinted)
    if why != "kept":
        return chosen
    period, first, _ = _steady_grid(times, weights, 60.0 / (2 * bpm))
    duration = float(np.max(times)) if times.size else 0.0
    fast = first + np.arange(0, int(max(0.0, duration - first) / period) + 1) * period
    evidence = tempo.backbeat(feat["env_mid"], SR / HOP, fast)
    return tempo.choose(bpm, evidence=evidence, use_range=not hinted)[0]


def _fast_backbeat(feat, beats) -> bool:
    """A grid at 140-200 BPM whose snare falls on every other beat (drum and
    bass, a break at its own tempo): half its beats are snares, so they're
    told by the whole spectrum as well as the kick. Never true at 100-140,
    so those grids score as they always have."""
    import numpy as np

    from core.sample import tempo

    beats = np.asarray(beats, dtype=np.float64)
    if beats.size < tempo.MIN_BEATS or not tempo.is_fast(60.0 / float(np.median(np.diff(beats)))):
        return False
    return tempo.backbeat(feat["env_mid"], SR / HOP, beats)["vote"] == "fast"


def _octave_of(a: float, b: float) -> bool:
    """True when two tempos are the same up to halving or doubling (±4%)."""
    for factor in (0.5, 1.0, 2.0):
        if abs(a * factor - b) / b <= 0.04:
            return True
    return False


#: the related tempos a tempo is tested against (a wrong tag or analysis is
#: off by these as often as by an octave: 4/3 and 2/3 on the bench of 29
#: October)
RELATED = (1.5, 2.0 / 3.0, 4.0 / 3.0, 0.75)
#: a related tempo the onsets line up on this much better (a ratio of the
#: comb's strength) replaces the hint's. Real hints wrong by 4/3 or 2/3 were
#: led by the true tempo 1.85-3.0 times; hip hop with sixteenth hats lines up
#: on 4/3 of its true tempo 1.35 times as well (three sixteenths apart)
RELATED_LEAD = 1.5
#: within this ratio of a related tempo's strength, the tempo isn't sure: the
#: grid stays under the bar for beat-matching. Revisited in grid v5's review
#: round (L7): on the bench it holds 5 right grids and 6 wrong ones, and no
#: other ratio separates them (right grids at 0.92-1.43 of a related tempo's
#: strength, wrong ones at 0.95-1.91); the agreement can't settle a tie either
#: (grids at 4/3 or 3/2 of the true tempo agree at 0.9 or more on 7 of 37
#: and 6 of 69). Kept
TEMPO_TIE = 1.08
TEMPO_UNSURE_CONFIDENCE = 0.45
#: a slow hint in this band (BPM) is doubled when the grid's own scan reads
#: its double and the backbeat is at the double (drum and bass's 164-178
#: halved). Without the backbeat the scan alone doubled nearly every steady
#: groove at 82-89 with eighth-note hats (Groove, grid v5's review). A drum
#: and bass tag (or enrichment's genre) doubles it whatever the backbeat:
#: Andy C's Heartbeat Loud is tagged 87 and "Drum And Bass"
DNB_HALF = (82.0, 89.0)
#: a grid this fast (BPM) or more, whose half is a tempo, needs evidence it's
#: fast (``_octave_unsure``) to be beat-matched
OCTAVE_FAST = 150.0
OCTAVE_UNSURE_CONFIDENCE = 0.45


def _strength_at(times, weights, bpm: float) -> float:
    """The comb's best strength within ±4% of ``bpm``, searched more coarsely
    than ``_steady_grid`` (a comparison between tempos, not the grid): about
    a sixth of its cost."""
    import numpy as np

    period0 = 60.0 / bpm
    coarse = period0 * (1 + np.linspace(-0.04, 0.04, 161))
    strength, _ = _alignment(times, weights, coarse)
    best = float(coarse[int(np.argmax(strength))])
    fine = best * (1 + np.linspace(-5e-4, 5e-4, 41))
    return float(np.max(_alignment(times, weights, fine)[0]))


def _related(bpm: float):
    return [bpm * r for r in RELATED if 70.0 <= bpm * r < 200.0]


def _fast_vote(feat, times, weights, bpm: float) -> bool:
    """Drum and bass by its drums (``drum_and_bass_beats``) on a grid laid
    at ``bpm``. (core/sample/tempo.py ``backbeat``'s "fast" vote said "slow"
    on real drum and bass: grid v5's second review.)"""
    import numpy as np

    period, first, _ = _steady_grid(times, weights, 60.0 / bpm)
    duration = float(np.max(times)) if times.size else 0.0
    beats = first + np.arange(0, int(max(0.0, duration - first) / period) + 1) * period
    return drum_and_bass_beats(feat, beats)


#: drum and bass by its drums (``drum_and_bass_beats``): the snare's crack on
#: two and four of the fast bar, against the beat opposite the kick, at
#: least this share of the loudest beat; and a kick half a beat after that
#: beat (the two-step's second kick, on the "and" of three) at least this
#: share of the main one. Measured (grid v5's second review) at the fast
#: octave of the bench's grids: Heartbeat Loud 0.46 and 0.79; Red Eclipse
#: track 9 (150) 0.68 and 0.68; none of 45 grooves at 70-100 read at double
#: (Groove train, the public set) has both (the backbeat at most 0.49, a
#: hip hop groove whose second kick is 0.18; the second kick up to 0.97 on
#: a rock groove whose backbeat is 0.20). Only one real drum-and-bass track
#: was at hand: a genre tag or a person's ×2 remains the surer evidence
DNB_BACKBEAT = 0.35
DNB_TWO_STEP = 0.5


def drum_and_bass_parts(feat, fast_beats):
    """``(backbeat, two_step)`` at a fast grid (see ``DNB_BACKBEAT``), the
    medians over 16-beat windows, or None when the track is too short. Per
    window: the beat where the kick (the low band) is loudest, ``k``; the
    backbeat is the snare's crack (1-5 kHz) on the beats either side of it
    (``k+1``, ``k+3``: two and four) less the crack on the beat opposite
    (``k+2``), as a share of the loudest; the two-step is the low band half
    a beat after ``k+2`` against the kick. Anchored on the kick because a real
    kick has a crack of its own, which hid drum and bass's backbeat from
    core/sample/tempo.py ``backbeat`` (Heartbeat Loud read "slow"). A groove
    at half the tempo read at double has its snare opposite the kick, hats
    beside it: a negative backbeat."""
    import numpy as np

    beats = np.asarray(fast_beats, dtype=np.float64)
    beats = beats[beats >= 0]
    if beats.size < 32 or "env_crack" not in feat:
        return None
    period = float(np.median(np.diff(beats)))
    radius = min(0.03, 0.12 * period)
    low = _peak_near(feat["env_low"], beats, radius)[0]
    after = _peak_near(feat["env_low"], beats + period / 2.0, radius)[0]
    crack = _peak_near(feat["env_crack"], beats, radius)[0]
    backbeats, steps = [], []
    for start in range(0, beats.size - 15, 8):
        lw = low[start:start + 16].reshape(-1, 4).mean(axis=0)
        aw = after[start:start + 16].reshape(-1, 4).mean(axis=0)
        cw = crack[start:start + 16].reshape(-1, 4).mean(axis=0)
        if not (cw.max() > 0 and lw.max() > 0):
            continue
        k = int(np.argmax(lw))
        cw = cw / cw.max()
        backbeats.append(min(cw[(k + 1) % 4], cw[(k + 3) % 4]) - cw[(k + 2) % 4])
        steps.append(aw[(k + 2) % 4] / lw[k])
    if not backbeats:
        return None
    return float(np.median(backbeats)), float(np.median(steps))


def drum_and_bass_beats(feat, fast_beats) -> bool:
    """Whether a fast grid's drums are drum and bass's (``DNB_BACKBEAT``)."""
    parts = drum_and_bass_parts(feat, fast_beats)
    return bool(parts) and parts[0] >= DNB_BACKBEAT and parts[1] >= DNB_TWO_STEP


def _family_at(families, bpm: Optional[float]) -> Optional[str]:
    """The genre family that decides at ``bpm``: the one the genres name, or
    when they name fast and others, fast for a fast reading (liquid drum and
    bass is often tagged Soul too: grid v5's second review); else None."""
    families = set(families or ())
    if len(families) == 1:
        return next(iter(families))
    if "fast" in families and bpm and bpm >= OCTAVE_FAST:
        return "fast"
    return None


def _genre_octave(bpm: float, family: Optional[str], fast_drums=None) -> float:
    """A slow genre (hip hop, reggae, chillout …) reads a fast tempo at half,
    unless the drums are drum and bass's at it (``fast_drums(bpm)``: ambient
    jungle at 170 isn't 85; grid v5's second review, L-c); that grid is then
    held, its genre and its drums disagreeing (``_octave_unsure``)."""
    if family == "slow" and bpm >= OCTAVE_FAST and bpm / 2.0 >= 60.0:
        if fast_drums is not None and fast_drums(bpm):
            return bpm
        return bpm / 2.0
    return bpm


def _pick_tempo(feat, env, times, weights, bpm_hint, genres=None) -> Optional[float]:
    """The tempo to lay the grid at. The hint (the DJ data's BPM: a tag,
    enrichment or the analysis) is a prior, not a fence: its related tempos
    (``RELATED``) and the grid's own scan are tested against it, and one the
    onsets line up on ``RELATED_LEAD`` times better replaces it (a hint at
    4/3 of the true tempo used to confine the grid to ±4% of itself, and
    find no beat). A fast tempo found so (``OCTAVE_FAST`` or more) is held
    under the bar unless something says it's fast (``_octave_unsure``):
    halving it instead put an Amen break at 170 at 85.

    The octave: a slow hint (70-100) is doubled when the genre is fast
    (drum and bass, hardcore: ``_family_at``), or when it's in ``DNB_HALF``,
    the grid's own scan reads its double and the drums are drum and bass's
    there (``drum_and_bass_beats``); else only the backbeat doubles it
    (``_octave``). A slow genre reads a fast tempo at half, whichever path
    found it, unless the drums are drum and bass's (``_genre_octave``)."""
    from core.sample import tempo

    families = tempo.genre_families(genres)
    hinted = _tempo(env, bpm_hint) if bpm_hint else None
    scanned, scan_strength = _scan_tempo(times, weights)

    def fast_drums(bpm):
        return _fast_vote(feat, times, weights, bpm)

    def settle(bpm):
        return _genre_octave(bpm, _family_at(families, bpm), fast_drums)

    if not hinted:
        bpm = scanned or _tempo(env, None)
        return settle(_octave(feat, times, weights, bpm, hinted=False)) if bpm else None
    if tempo.is_slow(hinted):
        family = _family_at(families, 2 * hinted)
        if family != "slow":
            doubled_by_scan = (DNB_HALF[0] <= hinted < DNB_HALF[1] and scanned
                               and abs(scanned - 2 * hinted) / (2 * hinted) <= 0.04
                               and fast_drums(2 * hinted))
            if family == "fast" or doubled_by_scan:
                hinted = 2 * hinted
            elif family in (None, "half"):
                hinted = _octave(feat, times, weights, hinted, hinted=True)
    base = _strength_at(times, weights, hinted)
    best, best_strength = hinted, base
    for other in _related(hinted):
        found = _strength_at(times, weights, other)
        if found > best_strength:
            best, best_strength = other, found
    if scanned and not _octave_of(scanned, hinted) and scan_strength > best_strength:
        best, best_strength = _octave(feat, times, weights, scanned, hinted=False), scan_strength
    return settle(best if best_strength >= RELATED_LEAD * base else hinted)


def _octave_unsure(feat, beats, bpm: float, family: Optional[str], hint: Optional[float] = None,
                   evidence: Optional[float] = None) -> bool:
    """Which octave is the beat isn't sure enough to beat-match on: a grid at
    ``OCTAVE_FAST`` or more whose half is a plausible tempo, or one at double
    or half the hint as given (a tag, enrichment or the analysis said the
    other octave), with no evidence either way. Evidence: a genre (drum and
    bass, hardcore, jazz: ``core/sample/tempo.py``); a tag's or enrichment's
    BPM at the grid's own octave (``evidence``; grid v5's second review); for
    a fast grid, drum and bass's drums (``drum_and_bass_beats``), which
    outweigh a tag or hint at half (drum and bass is often tagged 87); and
    a slow grid (70-100) whose double has them is held. A slow
    genre on a fast grid kept fast by its drums is held (they disagree).
    Doubled grooves at 70-100 read 140-200 confidently on Groove (grid v5's
    review)."""
    import numpy as np

    if family == "slow" and bpm >= OCTAVE_FAST:
        return True  # kept fast against its genre by its drums (``_genre_octave``)
    if family is not None and family != "free":
        return False  # a genre has decided the octave (``_pick_tempo``)
    # (jazz, ``free``, doesn't: acid jazz, jazz funk and nu jazz are grooves
    # at 80-100 that read at double as easily; grid v5's third review)
    fast = bpm >= OCTAVE_FAST and bpm / 2.0 >= 70.0
    if fast and drum_and_bass_beats(feat, np.asarray(beats, dtype=np.float64)):
        return False  # drum and bass's drums, whatever a tag at half says (87 for 174)
    for given, conflict_only in ((evidence, False), (hint, True)):
        if not given:
            continue
        try:
            ratio = bpm / float(given)
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if abs(ratio - 2.0) / 2.0 <= 0.04 or abs(ratio - 0.5) / 0.5 <= 0.04:
            return True
        if not conflict_only and abs(ratio - 1.0) <= 0.04:
            return False  # the tag or enrichment says this octave
    if 70.0 <= bpm < 100.0 and not fast:
        # a slow grid whose double has drum and bass's drums is a fast track
        # read at half (grid v5's third review, M2); nothing else that tells
        # a half-read fast track from a slow groove was found on the bench
        beats = np.asarray(beats, dtype=np.float64)
        if beats.size >= 16:
            doubled = np.sort(np.concatenate([beats, beats[:-1] + np.diff(beats) / 2.0]))
            return drum_and_bass_beats(feat, doubled)
    return fast


def _tempo_unsure(times, weights, period: float) -> bool:
    """A related tempo the onsets fit nearly as well (within ``TEMPO_TIE``):
    which one is the beat isn't sure enough to beat-match on."""
    bpm = 60.0 / period
    strength = _strength_at(times, weights, bpm)
    return any(_strength_at(times, weights, other) * TEMPO_TIE >= strength for other in _related(bpm))


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
#: confidence is cut so the planner won't beat-match (gauntlet L4 of stage A)
BACKBEAT_WEIGHT = 1.5
SHIFT_MARGIN = 1.15
AMBIGUOUS_MARGIN = 1.15
AMBIGUOUS_FACTOR = 0.6
#: a grid the check moved by a sixteenth (not an eighth) is kept, for its
#: bars and phrases, but under the planner's bar for beat-matching (0.5): on
#: real tracks such a move was right once in four, while a move by an eighth
#: was right five times in six and isn't capped (grid v5)
BREAK_CONFIDENCE = 0.45


#: four on the floor: in the bars where the drums play, the quietest beat's
#: low-band onset is at least this share of the loudest's (the median bar).
#: A break or drum and bass leaves a beat of every bar without a kick (0.00
#: on every generated one); generated house with a rolling bass as loud as
#: its kick measures 0.19 to 0.65. Left as it is in grid v5: on real tracks
#: it can't be tightened (real four-on-the-floor house measured 0.13-0.58, a
#: waltz, ragtime and drum-and-bass stems 0.06-0.35). Since v5 it decides
#: whether the sixteenth check's doubt (x0.6) is skipped, whether a move
#: counts as a break's (``broken``) and whether a rival line with the
#: backbeat moves the grid; no hold depends on it (HANDOFF, 29 October)
FLOOR_EVENNESS = 0.12


def _low_line(feat, beats) -> Tuple[float, float]:
    """The low band's onsets on ``beats``, as a line: ``(evenness, strength)``.
    Evenness is the median bar's quietest beat against its loudest, over the
    bars where the drums play; strength the median onset there."""
    import numpy as np

    beats = np.asarray(beats, dtype=np.float64)
    if len(beats) < 16 or "env_low" not in feat:
        return 0.0, 0.0
    radius = float(min(0.035, 0.1 * float(np.median(np.diff(beats)))))
    on = _peak_near(feat["env_low"], beats, radius)[0]
    bars = on[:len(on) // 4 * 4].reshape(-1, 4)
    loudest = bars.max(axis=1)
    top = float(np.percentile(loudest, 90))
    if top <= 0:
        return 0.0, 0.0
    drumming = loudest >= 0.3 * top
    if int(drumming.sum()) < 4:
        return 0.0, 0.0
    evenness = float(np.median(bars[drumming].min(axis=1) / loudest[drumming]))
    return evenness, float(np.median(bars[drumming]))


def four_on_the_floor(feat, beats) -> bool:
    """A kick on every beat of the bar where the drums play (house, techno),
    not a break's kick on some beats only: the low band's onset on each beat,
    the quietest of each bar's four against its loudest. Drum and bass with
    a bass on every beat isn't (its snare on every other beat says so:
    ``_fast_backbeat``; gauntlet review L4)."""
    if _low_line(feat, beats)[0] < FLOOR_EVENNESS:
        return False
    return not _fast_backbeat(feat, beats)


#: the backbeat (a clap or snare on two and four) is on these beats when the
#: snare band's onsets on every other beat differ from the rest by this share
BACKBEAT_SHARE = 0.5
#: another sixteenth's low-band line this strong (against the beat's) and as
#: even is a rival: a bass on the off-beat, or a rolling one, as regular and
#: as loud as the kick, so the low band alone can't say which is the beat. A
#: weaker one is taken for the bass (dance music's kick leads the low band;
#: a bass much louder than the kick can still fool it: HANDOFF, the review)
RIVAL_STRENGTH = 0.9



def backbeat_share(feat, beats) -> float:
    """How much the snare band's onsets on every other beat differ from the
    rest (0 to 1): a clap or snare on two and four, on these beats."""
    import numpy as np

    beats = np.asarray(beats, dtype=np.float64)
    if len(beats) < 16 or "env_mid" not in feat:
        return 0.0
    radius = float(min(0.035, 0.1 * float(np.median(np.diff(beats)))))
    mid = _peak_near(feat["env_mid"], beats, radius)[0]
    n = len(mid) // 2 * 2
    a, b = float(np.mean(mid[0:n:2])), float(np.mean(mid[1:n:2]))
    top = max(a, b)
    return abs(a - b) / top if top > 0 else 0.0


def _phase_lines(feat, beats, period: float) -> Dict[int, Tuple[float, float, float]]:
    """For each sixteenth offset from ``beats`` (0-3): its low-band line's
    evenness and strength, and the backbeat share there."""
    import numpy as np

    out = {}
    for c in range(4):
        at = np.asarray(beats, dtype=np.float64) + c * period / 4.0
        even, strength = _low_line(feat, at)
        out[c] = (even, strength, backbeat_share(feat, at))
    return out


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


#: where the drums play: the hats' band busy over two bars against its loud
#: parts. A track whose drums play in under DRUM_FRAMES_MIN of it, or nearly
#: all of it, is taken whole
DRUM_FRAMES_LEVEL = 0.25
DRUM_FRAMES_MIN = 0.15
DRUM_FRAMES_MAX = 0.9
#: a grid the independent tracker agrees with less than this is held under
#: the bar for beat-matching, however many onsets it hits (grid v5's review:
#: with every beat hit, 0.09 of agreement was "ready")
AGREE_READY = 0.5
#: and one the drums' attack band (500-4000 Hz) disagrees with outright
#: (under this) is held too, whatever the low band says (grid v5's second
#: review, M-a: an off-beat bass as loud as the kick, 1.0 in the low band
#: and 0.0 in the attack band, sat exactly on AGREE_READY, ready half a beat
#: off). Not the low band's: a loud bass takes the low band's tracker off a
#: right grid (house with a rolling or off-beat bass: 0.0 and 0.99), and a
#: bass has little attack up there. On the bench (the reference grids and
#: their perturbations) it held 5 wrong grids (half or 3/4 the tempo, one
#: shifted 6/8) and one right grid that wasn't ready anyway (safari_x30)
AGREE_ATTACK_MIN = 0.1


def _drum_frames(feat):
    """Per frame, whether the drums play there (the hats' band busy), or None
    when that's the whole track or too little of it to say: a long intro of
    bass and chords alone put the comb on the bass (grid v5's review)."""
    import numpy as np

    high = feat.get("env_high")
    if high is None or len(high) < 64:
        return None
    width = int(4.0 * SR / HOP) | 1
    busy = np.convolve(high, np.ones(width) / width, mode="same")
    top = float(np.percentile(busy, 90))
    if top <= 0:
        return None
    mask = busy >= DRUM_FRAMES_LEVEL * top
    share = float(mask.mean())
    return mask if DRUM_FRAMES_MIN <= share <= DRUM_FRAMES_MAX else None


def beat_grid(feat: Dict[str, Any], bpm_hint: Optional[float] = None, genres=None,
              tempo_evidence: Optional[float] = None) -> Dict[str, Any]:
    """The grid: ``{kind: constant | beats | none, bpm, period, first_beat,
    beats (times), confidence}``.

    Steady tracks: the kick-weighted envelope's clear onsets, and the one
    constant period and phase they line up on best (a weighted phase
    vector, searched near the expected tempo). The onsets on the beat then
    say how steady it is: their spread about the grid, and how far a run of
    them bends away from it. A track that bends (a drift) keeps librosa's
    tracked beats instead, each pulled onto its onset."""
    import numpy as np

    from core.sample import tempo

    env = beat_envelope(feat)
    duration = feat["duration"]
    times, weights = _onsets(env)
    drums = _drum_frames(feat)
    if drums is not None and times.size:
        # the tempo and the phase from where the drums play
        keep = drums[np.clip(np.round(_t2f(times)).astype(int), 0, len(drums) - 1)]
        if int(keep.sum()) >= 16:
            times, weights = times[keep], weights[keep]
    if times.size < 16:
        return {"kind": "none", "reason": "no_beat", "confidence": 0.0}
    families = tempo.genre_families(genres)
    bpm = _pick_tempo(feat, env, times, weights, bpm_hint, genres)
    if bpm is None:
        return {"kind": "none", "reason": "no_beat", "confidence": 0.0}
    period, first, strength = _steady_grid(times, weights, 60.0 / bpm)

    def spread(at: float):
        res = _residuals(times, period, at)
        # the onsets on the beat (within an eighth of it; a sixteenth or a
        # swung eighth isn't the beat), the louder half of them
        on_beat = (np.abs(res) < 0.125 * period) & (weights >= np.median(weights))
        res_on = res[on_beat]
        mad = 1000 * float(np.median(np.abs(res_on - np.median(res_on)))) if res_on.size else 1e3
        window = min(24, max(4, res_on.size // 6))
        running = (np.convolve(res_on, np.ones(window) / window, mode="valid")
                   if res_on.size >= window else res_on)
        drift = 1000 * float(np.max(np.abs(running - np.median(res_on)))) if running.size else 1e3
        return res_on, mad, drift

    res_on, mad_ms, drift_ms = spread(first)
    if not (mad_ms <= STEADY_MAD_MS and drift_ms <= STEADY_DRIFT_MS):
        # the comb can settle between a kick and a rolling bass as loud on
        # the sixteenths after it: the onsets a sixteenth away may line up
        # (Ross's report of 28 October); the sixteenth check then says which
        # of them is the beat
        for k in (1, 2, 3):
            at = first + k * period / 4.0
            tried = spread(at)
            if tried[1] <= STEADY_MAD_MS and tried[2] <= STEADY_DRIFT_MS and tried[1] < mad_ms:
                first, (res_on, mad_ms, drift_ms) = at, tried
    rms_frames = feat["rms_db"]
    loud = float(np.percentile(rms_frames, 95))

    def active_mask(beat_times):
        frames = np.clip(np.round(_t2f(beat_times)).astype(int), 0, len(rms_frames) - 1)
        playing = rms_frames[frames] > loud - 30
        if drums is not None:
            playing &= drums[np.clip(frames, 0, len(drums) - 1)]
        return playing

    def held(confidence, agree, agree_attack, beat_times, period_now):
        """The caps every grid goes through: no tracker agreeing (or the
        attack band's disagreeing outright), a related tempo as good, an octave
        nothing says is fast. Also the confidence without the octave's cap,
        what a person's ×2 or ÷2 releases (``octave_confidence``)."""
        unsure_tempo = _tempo_unsure(times, weights, period_now)
        bpm_now = 60.0 / period_now
        unsure_octave = _octave_unsure(feat, beat_times, bpm_now, _family_at(families, bpm_now), bpm_hint,
                                       tempo_evidence)
        if agree < AGREE_READY or agree_attack < AGREE_ATTACK_MIN:
            confidence = min(confidence, BEAT_CONFIDENT - 0.05)
        # what a person's choice of this octave leaves: the agreement's hold
        # stays, the octave's and the related tempo's go (grid v5's third
        # review: they're the questions the person has answered)
        free = confidence
        if unsure_tempo:
            confidence = min(confidence, TEMPO_UNSURE_CONFIDENCE)
        if unsure_octave:
            confidence = min(confidence, OCTAVE_UNSURE_CONFIDENCE)
        return confidence, unsure_tempo, unsure_octave, free

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
        # four on the floor (Ross's report of 28 October, and the gauntlet
        # review's H2 and M1): a kick on every beat, here or moved here by the
        # check, is the beat, not a break's. A bass on the off-beat (or a
        # rolling one) as regular and as loud as the kick (a rival line) with
        # the backbeat on it is the kick's line: the grid moves there. Every
        # other doubt about the phase is the agreement's (below): the rules
        # that held a grid whose beat didn't sound like a kick, or whose low
        # band was busy, held most real tracks and moved two the wrong way
        # (HANDOFF, 29 October)
        floor = four_on_the_floor(feat, beats)
        backed = False
        if floor:
            lines = _phase_lines(feat, beats, period)
            even0, strength0, backbeat0 = lines[0]
            rivals = [c for c in (1, 2, 3) if lines[c][0] >= FLOOR_EVENNESS
                      and lines[c][1] >= RIVAL_STRENGTH * max(strength0, 1e-9)]
            backed = backbeat0 >= BACKBEAT_SHARE
            if rivals and not backed:
                best = max(rivals, key=lambda c: lines[c][2])
                if lines[best][2] >= BACKBEAT_SHARE:
                    beats = beats + best * period / 4.0
                    beats = beats[(beats >= -0.02) & (beats < duration)]
                    backed = True
        broken = bool(shift) and not floor
        # a break's beats are told by the whole spectrum (its snares), not the kick
        hits = _hit_rate(feat["env"] if broken else env, beats, active_mask(beats))
        if not broken and _fast_backbeat(feat, beats):
            # drum and bass: every other beat is a snare, not a kick
            hits = max(hits, _hit_rate(feat["env"], beats, active_mask(beats)))
        agree, agree_attack = _agreement_bands(feat, beats, period, active_mask(beats), broadband=broken)
        steady = max(0.0, min(1.0, 1.0 - max(0.0, mad_ms - 3.0) / 15.0))
        confidence = _confidence(hits, agree) * (0.6 + 0.4 * steady)
        if broken and shift % 2:
            # moved a sixteenth (not an eighth): right on 1 real track in 4
            confidence = min(confidence, BREAK_CONFIDENCE)
        elif margin < AMBIGUOUS_MARGIN and not floor:
            # not sure which sixteenth, and no kick on every beat to say
            confidence *= AMBIGUOUS_FACTOR
        confidence, unsure_tempo, unsure_octave, free = held(confidence, agree, agree_attack, beats, period)
        return {"kind": "constant", "bpm": round(60.0 / period, 3), "period": period, "first_beat": float(beats[0]),
                "beats": beats, "confidence": round(confidence, 3), "sixteenth": shift,
                "sixteenth_margin": round(min(margin, 99.0), 2), "four_on_the_floor": floor,
                "backbeat": backed, "hits": round(hits, 3), "agreement": round(agree, 3),
                "unsure_tempo": unsure_tempo, "unsure_octave": unsure_octave, "free_confidence": round(free, 3),
                "agreement_attack": round(agree_attack, 3),
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
    if _fast_backbeat(feat, tracked):
        hits = max(hits, _hit_rate(feat["env"], tracked, active_mask(tracked)))
    shift, margin = sixteenth_check(feat, beats)
    if shift:
        gaps = np.append(np.diff(beats), np.diff(beats)[-1])
        beats = beats + shift * gaps / 4.0
        beats = beats[beats < duration]
        hits = _hit_rate(feat["env"], beats, active_mask(beats))
    period = float(np.median(np.diff(beats)))
    # the agreement is measured on the drifting beats themselves; each
    # window's tracker holds to their median tempo (a drift is slow)
    agree, agree_attack = _agreement_bands(feat, beats, period, active_mask(beats), broadband=bool(shift))
    confidence = _confidence(hits, agree) * 0.8
    if shift % 2:
        confidence = min(confidence, BREAK_CONFIDENCE)
    if margin < AMBIGUOUS_MARGIN:
        confidence *= AMBIGUOUS_FACTOR
    confidence, unsure_tempo, unsure_octave, free = held(confidence, agree, agree_attack, beats, period)
    return {"kind": "beats", "bpm": round(60.0 / period, 3), "period": period, "first_beat": float(beats[0]),
            "beats": beats, "confidence": round(confidence, 3), "sixteenth": shift,
            "sixteenth_margin": round(min(margin, 99.0), 2), "hits": round(hits, 3), "agreement": round(agree, 3),
            "unsure_tempo": unsure_tempo, "unsure_octave": unsure_octave, "free_confidence": round(free, 3),
            "agreement_attack": round(agree_attack, 3), "mad_ms": round(mad_ms, 1),
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


def _beat_parts(feat, beats):
    """Per beat, z-scored: the kick (the low band's attack), the whole
    spectrum's attack, the harmony turning and the timbre changing."""
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
    return _z(kick), _z(attack), _z(turn), _z(newness)


#: the one is where the kick is strongest, with the harmony turning as a
#: lesser vote. The whole spectrum's attack and the timbre's change used to
#: count as much, and on real dance tracks they follow the clap on two and
#: four: that salience agreed with an independent downbeat tracker on 12 of
#: 39 tracks (chance), the kick with half the harmony on 26 (HANDOFF, 29
#: October)
DOWNBEAT_TURN_WEIGHT = 0.5
#: the downbeat's confidence: over windows of this many beats (8 bars), how
#: many put the strongest beat on the same one, and how clearly
DOWNBEAT_WINDOW = 32
DOWNBEAT_WINDOW_LEAD = 0.5
#: the one's lead over the next beat across the whole track (standard
#: errors); under it the downbeat stays "unsure" (under 0.3)
DOWNBEAT_MIN_SEPARATION = 1.5


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


def _window_agreement(salience, phase: int) -> float:
    """How steadily 8-bar windows (overlapping by half) put the strongest
    beat of the bar on ``phase``, each window weighed by how clearly it says
    so (its lead over its second-best beat, against the salience's spread:
    full at ``DOWNBEAT_WINDOW_LEAD``); 0 is chance, 1 every window clearly
    agreeing. Repeating a weak lead isn't evidence (grid v5's review: 11 of
    12 wrong downbeats scored 0.3 or more)."""
    import numpy as np

    salience = np.asarray(salience, dtype=np.float64)
    n = len(salience)
    spread = float(np.std(salience)) or 1.0
    weights = []
    step = DOWNBEAT_WINDOW // 2
    for start in range(0, max(1, n - DOWNBEAT_WINDOW + 1), step):
        part = salience[start:start + DOWNBEAT_WINDOW]
        if len(part) < 8:
            continue
        means = np.array([float(np.mean(part[(p - start) % 4::4])) for p in range(4)])
        order = np.argsort(means)[::-1]
        lead = (means[order[0]] - means[order[1]]) / spread
        weights.append(min(1.0, lead / DOWNBEAT_WINDOW_LEAD) * (1.0 if int(order[0]) == phase else -1.0 / 3.0))
    if not weights:
        return 0.0
    # a few windows say little: two agreeing windows aren't eight
    return max(0.0, float(np.mean(weights))) * min(1.0, len(weights) / 4.0)


def downbeats(feat, beats) -> Dict[str, Any]:
    """``{phase, confidence, meter}``: beats[phase] is the first downbeat.
    The confidence is how steadily the kick (and the harmony) put the one
    there, bar after bar; it only says whether the bars and phrases can be
    trusted, never whether two tracks can be beat-matched."""
    import numpy as np

    if len(beats) < 16:
        return {"phase": 0, "confidence": 0.0, "meter": "unknown"}
    beats = np.asarray(beats)
    kick, attack, turn, newness = _beat_parts(feat, beats)
    salience = kick + DOWNBEAT_TURN_WEIGHT * turn
    phase, _ = _phase_strength(salience, 4)
    # threes against fours on everything that marks a bar (unchanged)
    accents = 1.0 * kick + 0.7 * attack + 1.2 * turn + 0.8 * newness
    _, sep4 = _phase_strength(accents, 4)
    _, sep3 = _phase_strength(accents, 3)
    meter = "4/4"
    if sep3 > 4.0 and sep3 > 1.5 * max(sep4, 0.0):
        meter = "not_4_4"
    confidence = _window_agreement(salience, phase)
    if _phase_strength(salience, 4)[1] < DOWNBEAT_MIN_SEPARATION:
        confidence = min(confidence, 0.29)
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

def analyze_audio(y, sr: int, *, bpm_hint: Optional[float] = None, truncated: bool = False,
                  on_step=None, genres=None, tempo_evidence: Optional[float] = None) -> Dict[str, Any]:
    """Everything above for one track's decoded audio (mono). Returns the
    compact form the store keeps (``status`` ``done``, or ``none`` with a
    ``reason``: ``too_short`` or ``no_beat``). ``on_step`` is told
    ``phrases`` when the beats are found and the bars' sections are next
    (the DJ job's progress, core/dj/progress.py). ``genres``: the file's or
    enrichment's; ``tempo_evidence``: a tag's or enrichment's BPM (not the
    analysis's), which settles the octave it's at."""
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
    grid = beat_grid(feat, bpm_hint, genres, tempo_evidence)
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
    out["half_parity"] = half_parity(feat, beats)
    out["octave_confidence"] = octave_confidences(feat, grid, beats, first, out["half_parity"])
    if n_bars < 8:
        return {**out, "phrases": phrases_from([], n_bars), "sections": [], "mix_in": None, "mix_out": None}
    if on_step is not None:
        on_step("phrases")
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


def octave_confidences(feat, grid: Dict[str, Any], beats, downbeat_index: int, half: Optional[int]) -> Dict[str, float]:
    """The grid's confidence at each octave a person can choose (×2, ÷2, or
    this one), as if they had chosen it: what Double BPM, Halve BPM or "BPM
    is right" gives the grid they leave (core/dj/grid_store.py
    ``follow_override``), so one press releases a grid held for its octave,
    without a decode (grid v5's second review). Each octave is scored on its
    own beats: its hits (at ×2 the snares count too) and the independent
    tracker's agreement, with the agreement's holds, times the grid's
    steadiness. Nothing tied to the measured octave is carried over: not the
    octave's hold, not the related-tempo tie (the person has answered both),
    which kept a real Amen break at 85 held at 0.40 after its ×2 (grid v5's
    third review). ``{"1": c, "2": c, "0.5": c}``; ÷2 keeps the beats halving
    keeps."""
    import numpy as np

    out = {"1": round(float(grid.get("free_confidence", grid.get("confidence", 0.0))), 3)}
    beats = np.asarray(beats, dtype=np.float64)
    if beats.size < 16:
        return out
    if grid.get("kind") == "beats":
        steadiness = 0.8
    else:
        mad = float(grid.get("mad_ms") or 0.0)
        steadiness = 0.6 + 0.4 * max(0.0, min(1.0, 1.0 - max(0.0, mad - 3.0) / 15.0))
    rms = feat["rms_db"]
    loud = float(np.percentile(rms, 95))
    drums = _drum_frames(feat)

    def active(b):
        frames = np.clip(np.round(_t2f(b)).astype(int), 0, len(rms) - 1)
        playing = rms[frames] > loud - 30
        if drums is not None:
            playing &= drums[np.clip(frames, 0, len(drums) - 1)]
        return playing

    gaps = np.diff(beats)
    doubled = np.sort(np.concatenate([beats, beats[:-1] + gaps / 2.0]))
    parity = half if half in (0, 1) else downbeat_index % 2
    for key, b in (("2", doubled), ("0.5", beats[parity::2])):
        if b.size < 16:
            continue
        period = float(np.median(np.diff(b)))
        if not 40.0 <= 60.0 / period <= 240.0:
            continue
        mask = active(b)
        hits = max(_hit_rate(beat_envelope(feat), b, mask), _hit_rate(feat["env"], b, mask))
        agree, agree_attack = _agreement_bands(feat, b, period, mask)
        conf = _confidence(hits, agree) * steadiness
        if agree < AGREE_READY or agree_attack < AGREE_ATTACK_MIN:
            conf = min(conf, BEAT_CONFIDENT - 0.05)
        out[key] = round(float(conf), 3)
    return out


#: halving keeps the beats of the parity that's louder (the whole
#: spectrum's flux) in at least this share of 16-beat windows; nearer an
#: even split, those the downbeat is on
HALF_PARITY_SHARE = 0.6


def half_parity(feat, beats) -> Optional[int]:
    """Which beats (0: the even ones from the first, 1: the odd) to keep when
    this grid is halved (core/dj/grid_store.py ``rescale``), or None to keep
    the downbeat's. A grid at twice the tempo has the track's beats (kick or
    snare) on one parity and the hats between on the other; the downbeat
    alone chose wrong on a Groove hip hop track read at 134 (grid v5's review,
    L6). On the review bench's grids at twice the reference tempo, the louder
    parity was the reference's beats on 90 of 106 (HANDOFF)."""
    import numpy as np

    beats = np.asarray(beats, dtype=np.float64)
    peaks = _peak_near(feat["env"], beats, 0.03)[0]
    even = []
    for s in range(0, len(peaks) - 15, 16):
        w = peaks[s:s + 16]
        a, b = float(np.mean(w[0::2])), float(np.mean(w[1::2]))
        if max(a, b) > 0:
            even.append(a > b)
    if not even:
        return None
    share = float(np.mean(even))
    if share >= HALF_PARITY_SHARE:
        return 0
    if share <= 1.0 - HALF_PARITY_SHARE:
        return 1
    return None


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


__all__ = ["BEAT_CONFIDENT", "GRID_VERSION", "Grid", "beatmatch_problem", "LABELS", "MIN_SECONDS", "analyze_audio", "beat_grid", "downbeats",
           "phrases_from"]
