#!/usr/bin/env python3
"""Measure the beat grid (core/dj/grid.py) on real audio files you have.

The grid's tests run on generated audio; this runs it on real tracks, the way
the DJ worker does (the same decode: mono at 22050 Hz, the first 10 minutes;
the analysis's BPM as the hint, or the one you give), and prints a row a
track: status, BPM, beat and downbeat confidence, meter, and the hit rate and
tracker agreement the confidence is made of.

With a reference it also says whether the grid is on the beat: give a beat
annotation file (one time in seconds a line, the first column used) or a
constant grid as BPM and the first beat's time. The verdict is ``ON`` (within
35 ms), a fraction of a beat off, or a tempo ratio (``1/2``, ``4/3``, ...).

Nothing is downloaded or written; the audio stays where it is.

Usage:
  python scripts/grid_bench.py FILE [FILE ...]
  python scripts/grid_bench.py --list tracks.csv [--hint analysis|ref|none] [--json out.json]

``tracks.csv`` columns (a header row; only ``path`` is required):
  path, bpm (a tag-like hint, or the reference tempo), first_beat (s),
  beats (an annotation file)

The HANDOFF entry "Dev, beat grids on real audio of 29 October" has the
bench this came from, and its results.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

DECODE_SECONDS = 600.0


def _reference(row, duration):
    import numpy as np

    if row.get("beats"):
        times = []
        with open(row["beats"], encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parts = line.replace(",", " ").split()
                if parts and not parts[0].startswith("#"):
                    try:
                        times.append(float(parts[0]))
                    except ValueError:
                        continue
        return np.asarray(times) if len(times) >= 8 else None
    if row.get("bpm") and row.get("first_beat") not in (None, ""):
        period = 60.0 / float(row["bpm"])
        first = float(row["first_beat"]) % period
        return first + np.arange(0, int((duration - first) / period) + 1) * period
    return None


def _verdict(beats, ref):
    """``(verdict, offset_ms, f_measure)`` of the grid's beats against the reference's."""
    import numpy as np

    if beats is None or ref is None or len(beats) < 4 or len(ref) < 4:
        return "-", None, None
    rp, gp = float(np.median(np.diff(ref))), float(np.median(np.diff(beats)))
    ratio = rp / gp
    for value, label in ((0.5, "1/2"), (2.0, "2x"), (2 / 3, "2/3"), (1.5, "3/2"), (0.75, "3/4"), (4 / 3, "4/3")):
        if abs(ratio - value) / value < 0.03:
            return f"tempo {label}", None, None
    lo, hi = max(beats[0], ref[0]) - 0.1, min(beats[-1], ref[-1]) + 0.1
    g, r = beats[(beats >= lo) & (beats <= hi)], ref[(ref >= lo) & (ref <= hi)]
    idx = np.clip(np.searchsorted(r, g), 1, len(r) - 1)
    near = np.where(np.abs(g - r[idx - 1]) < np.abs(g - r[idx]), r[idx - 1], r[idx])
    offset = 1000 * float(np.median(g - near))
    hits = float(np.mean(np.abs(g - near) <= 0.07))  # at one tempo, the beat F-measure
    if abs(offset) <= 35 and hits > 0.6:
        return "ON", offset, hits
    frac = ((float(np.median(g - near)) / rp) + 0.5) % 1.0 - 0.5
    return f"{frac:+.2f} beat", offset, hits


def _spy(original, captured):
    """``grid.beat_grid`` that keeps its result (the confidence's parts)."""
    def spy(feat, *args, **kwargs):
        captured["grid"] = original(feat, *args, **kwargs)
        return captured["grid"]
    return spy


def run(rows, hint_mode):
    import numpy as np

    from core.dj import grid, store
    from core.sample.analyze import analyze_track
    from core.sample.tempo import file_genres

    out = []
    for row in rows:
        path = row["path"]
        analysis = analyze_track(path, max_seconds=DECODE_SECONDS, keep_audio=True)
        y, rate = analysis.pop("audio")
        if hint_mode == "analysis":
            hint = store.decide(analysis=analysis).get("bpm")
        elif hint_mode == "ref":
            hint = float(row["bpm"]) if row.get("bpm") else None
        else:
            hint = None
        captured: dict = {}
        original = grid.beat_grid
        grid.beat_grid = _spy(original, captured)
        started = time.process_time()
        try:
            result = grid.analyze_audio(y, rate, bpm_hint=hint, genres=file_genres(path),
                                        truncated=len(y) / float(rate) >= DECODE_SECONDS - 0.05)
        finally:
            grid.beat_grid = original
        cpu = time.process_time() - started
        g = captured.get("grid") or {}
        beats = np.asarray(g["beats"]) if g.get("beats") is not None else None
        verdict, offset, f_measure = _verdict(beats, _reference(row, len(y) / float(rate)))
        out.append({"track": os.path.basename(path), "hint": hint, "status": result.get("status"),
                    "reason": result.get("reason"), "bpm": result.get("bpm"),
                    "beat_confidence": result.get("beat_confidence"),
                    "downbeat_confidence": result.get("downbeat_confidence"), "meter": result.get("meter"),
                    "hits": g.get("hits"), "agreement": g.get("agreement"), "unsure_tempo": g.get("unsure_tempo"),
                    "verdict": verdict, "offset_ms": None if offset is None else round(offset, 1),
                    "f": None if f_measure is None else round(f_measure, 2), "grid_cpu_s": round(cpu, 2)})
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", help="audio files (no reference)")
    parser.add_argument("--list", help="a CSV of tracks: path[, bpm, first_beat, beats]")
    parser.add_argument("--hint", choices=("analysis", "ref", "none"), default="analysis",
                        help="the BPM hint: the analysis's (as the worker, untagged), the list's bpm, or none")
    parser.add_argument("--json", help="also write the rows here")
    args = parser.parse_args(argv)
    rows = [{"path": f} for f in args.files]
    if args.list:
        with open(args.list, newline="", encoding="utf-8") as fh:
            rows += [dict(r) for r in csv.DictReader(fh)]
    if not rows:
        parser.error("no tracks")
    found = run(rows, args.hint)
    cols = ("track", "status", "bpm", "beat_confidence", "downbeat_confidence", "meter", "hits", "agreement",
            "verdict", "offset_ms", "grid_cpu_s")
    print("| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for r in found:
        print("| " + " | ".join("" if r[c] is None else str(r[c]) for c in cols) + " |")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(found, fh, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
