"""The fingerprint fallback: Chromaprint (fpcalc) and AcoustID on a short clip.

Uses the AcoustID client the download identifier uses
(``core/acoustid_client.py``) with the same ``acoustid.api_key``. Only tried
when a station's feed and stream titles don't name the track, while track
identification is on, and rate-limited by the hub (one clip per station every
few minutes, one across all stations every 20 seconds).
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

MIN_SCORE = 0.7


def lookup(path: str, client_factory: Optional[Callable[[], Any]] = None) -> Dict[str, Any]:
    """``{"status": "ok", artist, title, release}`` / ``no_match`` / ``error``."""
    if client_factory is None:
        def client_factory():
            from core.acoustid_client import AcoustIDClient
            return AcoustIDClient()
    result = client_factory().lookup_with_status(path) or {}
    status = result.get("status")
    recordings = [r for r in result.get("recordings") or [] if isinstance(r, dict)]
    if status == "ok" and recordings:
        best = max(recordings, key=lambda r: float(r.get("score") or 0))
        if best.get("artist") and best.get("title") and float(best.get("score") or 0) >= MIN_SCORE:
            return {"status": "ok", "artist": str(best["artist"]), "title": str(best["title"]),
                    "release": str(best.get("album") or "")}
        return {"status": "no_match"}
    if status == "no_match":
        return {"status": "no_match"}
    return {"status": "error", "error": str(result.get("error") or "The fingerprint service didn't answer.")}


__all__ = ["lookup", "MIN_SCORE"]
