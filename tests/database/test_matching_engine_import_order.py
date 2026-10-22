"""The database layer's matching engine doesn't depend on import order.

core.matching_engine imports database.music_database on its way in, so the
engine the database built at import time was None whenever
core.matching_engine came first, which is web_server's order. The database
then fell back to its basic similarity ("Tonite" no longer matched "Tonight",
"Song (Live)" matched "Song") and the discovery pool's playlist filter
returned nothing. It's built on first use now.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]


def _engine_type_after(imports: str) -> str:
    code = (
        f"{imports}\n"
        "import database.music_database as m\n"
        "print(type(m._get_matching_engine()).__name__)\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=_ROOT, capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return out.stdout.strip().splitlines()[-1]


def test_matching_engine_first_still_gets_the_engine():
    assert _engine_type_after("import core.matching_engine") == "MusicMatchingEngine"


def test_database_first_gets_the_engine():
    assert _engine_type_after("") == "MusicMatchingEngine"
