"""Sample Studio — server-side audio analysis (Phase 1).

Decode + onset/chop detection + BPM + waveform peaks for the sampler page.
librosa/soundfile are imported LAZILY inside the functions below so importing
this module (and therefore web_server.py) never pays the numba/JIT import cost
or hard-fails when the optional DSP deps are missing — callers get a clean
ImportError only when they actually try to analyze.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional, Tuple

from utils.logging_config import get_logger

logger = get_logger("sample.analyze")

# Bump when the analysis algorithm changes; the worker skips tracks already
# analyzed at the current version.
# v3: adds the musical key.
# v4: adds energy (core/sample/energy.py), for the library's DJ data.
ANALYZER_VERSION = 4

# Analysis runs at 22050 Hz (librosa's canonical rate): ~4x fewer samples
# through the STFT than 44.1k source audio, with no measurable BPM loss
# (99.4 vs 99.4 on the real 100-BPM spike fixture; <=1.6% on synthetic).
_ANALYSIS_SR = 22050

# soundfile cannot decode these — go straight to ffmpeg for them.
_LOSSY_EXTS = {".mp3", ".m4a", ".aac", ".opus", ".ogg", ".wma"}

# Tuned on the Phase-1 spike fixture (12s @100 BPM, 40 ground-truth onsets):
# precision 0.951 / recall 0.975 vs 0.736 / 0.975 for librosa defaults.
# See ~/workspace/sampler-spike/SPIKE_REPORT.md.
# v2: windows rescaled to the analysis frame rate (hop 512 @22050 Hz =
# 23.2ms/frame vs 11.6ms @44100) to preserve the tuned ~time constants
# (pre_max ~60ms, pre_avg ~350ms, wait ~90ms).
_PEAK_PICK_KWARGS = dict(pre_max=3, post_max=3, pre_avg=15, post_avg=15, delta=0.25, wait=4)


def _load_librosa():
    try:
        import librosa  # noqa: F401
        import librosa as _lr

        return _lr
    except ImportError as exc:
        raise ImportError("librosa is required for sample analysis (pip install librosa)") from exc


def _load_soundfile():
    try:
        import soundfile as sf

        return sf
    except ImportError as exc:
        raise ImportError("soundfile is required for sample analysis (pip install soundfile)") from exc


def ffmpeg_bin() -> str:
    """ffmpeg on PATH, else the copy soulsync downloads into tools/.

    a bare "ffmpeg" only worked where it was on PATH, so on installs that
    rely on tools/ffmpeg every mp3/m4a failed to analyze or draw.
    """
    found = shutil.which("ffmpeg")
    if found:
        return found
    tools_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools")
    for name in ("ffmpeg.exe", "ffmpeg") if os.name == "nt" else ("ffmpeg",):
        cand = os.path.join(tools_dir, name)
        if os.path.isfile(cand):
            return cand
    raise RuntimeError("ffmpeg isn't installed, so mp3/m4a/opus files can't be decoded")


def _decode_via_ffmpeg(file_path: str, target_sr: int = 44100,
                       max_seconds: Optional[float] = None) -> Tuple[Any, int]:
    """Decode any format ffmpeg understands to mono float32 via a wav pipe.

    The timeout is load-bearing: the analysis worker is a single FIFO thread,
    so a hung ffmpeg would wedge analysis for every track behind it. A
    timeout surfaces as a normal worker error (sticky status + Try again).
    """
    sf = _load_soundfile()
    try:
        proc = subprocess.run(
            [ffmpeg_bin(), "-v", "error", "-i", file_path,
             *(["-t", f"{float(max_seconds):g}"] if max_seconds else []),
             "-ac", "1", "-ar", str(target_sr), "-f", "wav", "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=180,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"ffmpeg timed out decoding {file_path}") from exc
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(f"ffmpeg could not decode {file_path}: {proc.stderr.decode(errors='replace')[:300]}")
    data, sr = sf.read(io.BytesIO(proc.stdout), dtype="float32", always_2d=False)
    return data, sr


def decode_mono(file_path: str, max_seconds: Optional[float] = None) -> Tuple[Any, int]:
    """Decode an audio file to mono float32.

    soundfile handles WAV/FLAC/AIFF; anything else (or any soundfile failure)
    falls back to ffmpeg, which is already a SoulSync dependency.
    ``max_seconds`` reads only the start of the file.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"audio file not found: {file_path}")
    sf = _load_soundfile()
    ext = os.path.splitext(file_path)[1].lower()
    if ext in _LOSSY_EXTS:
        return _decode_via_ffmpeg(file_path, max_seconds=max_seconds)
    try:
        frames = -1
        if max_seconds:
            frames = int(float(max_seconds) * sf.info(file_path).samplerate)
        data, sr = sf.read(file_path, dtype="float32", always_2d=True, frames=frames)
    except Exception:
        logger.info("soundfile could not read %s — falling back to ffmpeg", file_path)
        return _decode_via_ffmpeg(file_path, max_seconds=max_seconds)
    mono = data.mean(axis=1).astype("float32")
    return mono, sr


def analyze_track(file_path: str, max_seconds: Optional[float] = None, *,
                  keep_audio: bool = False) -> Dict[str, Any]:
    """Full analysis for one track: BPM, onset times, duration, key, energy.

    Returns {"bpm": float, "onsets": [seconds...], "duration_s": float,
             "key": {"name", "confidence"} | None, "energy": 1-10 | None,
             "truncated": bool, "analyzer_version": int}.

    The audio is decoded straight to mono at the analysis rate (ffmpeg
    resamples as it reads), so memory is about 88 KB a second of audio
    whatever the source format: a 24/96 album track or a long mix no longer
    sits in memory at its own rate. ``max_seconds`` decodes only the start
    (the library's DJ job uses the first 10 minutes); ``truncated`` then says
    the result covers part of the file, and ``duration_s`` and the onsets
    only that part. Sample Studio's own analysis passes no limit, so a track
    opened there is analysed whole.

    ``keep_audio`` adds ``"audio": (samples, rate)``, the decoded mono at the
    analysis rate, so the DJ job finds the beat grid (core/dj/grid.py) from
    the same decode; the caller takes it out before keeping the result.

    Performance: the audio is downsampled to 22050 Hz once, and the onset
    envelope is computed ONCE and shared with beat tracking (beat_track's
    internal onset_strength used to double the STFT cost). Measured on a
    4:34 track: 6.9s -> 0.8s with no BPM loss on real audio.
    """
    librosa = _load_librosa()
    import numpy as np

    mono, sr = decode_mono_at(file_path, _ANALYSIS_SR, max_seconds=max_seconds)
    duration_s = float(len(mono) / sr)
    truncated = bool(max_seconds) and duration_s >= float(max_seconds) - 0.05

    y = (
        librosa.resample(mono, orig_sr=sr, target_sr=_ANALYSIS_SR)
        if sr != _ANALYSIS_SR
        else mono
    )
    onset_envelope = librosa.onset.onset_strength(y=y, sr=_ANALYSIS_SR)
    peak_frames = librosa.util.peak_pick(onset_envelope, **_PEAK_PICK_KWARGS)
    onsets = [
        round(float(t), 3)
        for t in librosa.frames_to_time(peak_frames, sr=_ANALYSIS_SR)
    ]

    tempo_raw, _ = librosa.beat.beat_track(
        onset_envelope=onset_envelope, sr=_ANALYSIS_SR
    )
    bpm = round(float(np.atleast_1d(tempo_raw)[0]), 1)

    from .energy import detect_energy
    from .key import detect_key

    result = {
        "bpm": bpm,
        "onsets": onsets,
        "duration_s": round(duration_s, 3),
        "key": detect_key(y, _ANALYSIS_SR),
        "energy": detect_energy(y, _ANALYSIS_SR, len(onsets)),
        "truncated": truncated,
        "analyzer_version": ANALYZER_VERSION,
    }
    if keep_audio:
        result["audio"] = (y, _ANALYSIS_SR)
    return result


def warm_dsp() -> None:
    """Pay the librosa import + numba JIT cost off the critical path.

    Fire-and-forget from the worker at boot: the first real track then skips
    the cold-start stall (import + JIT can dwarf the DSP itself on slow
    machines). Never raises — a missing librosa must still surface as the
    honest per-track ImportError, not a dead warmup thread.
    """
    try:
        librosa = _load_librosa()
        import numpy as np

        y = np.zeros(_ANALYSIS_SR, dtype=np.float32)
        y[::_ANALYSIS_SR // 10] = 0.5  # 10 Hz clicks: non-degenerate envelope
        env = librosa.onset.onset_strength(y=y, sr=_ANALYSIS_SR)
        librosa.beat.beat_track(onset_envelope=env, sr=_ANALYSIS_SR)
    except Exception:
        logger.debug("DSP warmup skipped", exc_info=True)


def decode_mono_at(file_path: str, sample_rate: int, max_seconds: Optional[float] = None) -> Tuple[Any, int]:
    """Decode to mono float32 at ``sample_rate``, streamed through ffmpeg.

    ffmpeg downmixes and resamples as it reads, so only the low-rate result is
    ever in memory: a 24/96 album track or a two-hour mix costs a few MB here,
    where decode_mono would hold the whole file at its own rate. Without
    ffmpeg, falls back to decode_mono (the file's own rate).
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"audio file not found: {file_path}")
    try:
        ffmpeg_bin()
    except RuntimeError:
        return decode_mono(file_path, max_seconds=max_seconds)
    return _decode_via_ffmpeg(file_path, target_sr=int(sample_rate), max_seconds=max_seconds)


def compute_peaks(file_path: str, buckets: int = 1500, sample_rate: int | None = None) -> Dict[str, Any]:
    """Min/max waveform peaks for the editor canvas.

    Returns {"buckets": n, "duration_s": float, "min": [...], "max": [...]}.
    ~0.1s for a 4-minute track — cheap enough to compute on demand and cache.

    ``sample_rate`` decodes at that rate (decode_mono_at) instead of the
    file's own, for callers that only need a coarse outline, like the
    player's 200-bar waveform.
    """
    import numpy as np

    if buckets < 16 or buckets > 20000:
        raise ValueError(f"buckets must be 16..20000, got {buckets}")
    mono, sr = decode_mono_at(file_path, sample_rate) if sample_rate else decode_mono(file_path)
    duration_s = float(len(mono) / sr)

    # Pad so the samples divide evenly, then one vectorized min/max.
    padded_len = int(np.ceil(len(mono) / buckets) * buckets)
    padded = np.pad(mono, (0, padded_len - len(mono)))
    reshaped = padded.reshape(buckets, -1)
    lo = reshaped.min(axis=1).astype(float).tolist()
    hi = reshaped.max(axis=1).astype(float).tolist()
    return {"buckets": buckets, "duration_s": round(duration_s, 3), "min": lo, "max": hi}


def onsets_list(result: Dict[str, Any]) -> List[float]:
    """Convenience accessor for the onset list in an analyze_track() result."""
    return [float(t) for t in result.get("onsets", [])]
