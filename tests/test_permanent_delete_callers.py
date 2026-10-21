"""Nothing in the web UI empties the recycle bin or the quarantine on its own.

The purge / clear routes delete files for good and only act on a preview
plan's id. The one client allowed to call them is the shared
preview-then-confirm module (webui/src/features/safe-action/permanent-delete.ts);
the Downloads page and Settings -> Clear quarantine both go through its
dialog. A page that posted straight to a route would get a 409 today, and
this keeps anyone from wiring one back in.
"""

from __future__ import annotations

from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_WEBUI = _ROOT / "webui"
_ROUTES = ("deleted-files/purge", "quarantine/clear")
_ALLOWED = {_WEBUI / "src" / "features" / "safe-action" / "permanent-delete.ts"}


def _client_sources():
    yield _WEBUI / "index.html"
    yield from (_WEBUI / "static").rglob("*.js")
    for path in (_WEBUI / "src").rglob("*"):
        if path.suffix not in (".ts", ".tsx", ".js"):
            continue
        if "__fixtures__" in path.parts or ".test." in path.name:
            continue
        yield path


def test_only_the_shared_flow_calls_the_permanent_delete_routes():
    offenders = []
    for path in _client_sources():
        if path in _ALLOWED or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for route in _ROUTES:
            if route in text:
                offenders.append(f"{path.relative_to(_ROOT)}: {route}")
    assert not offenders, "posts to a permanent-delete route outside the plan flow:\n  " + "\n  ".join(offenders)


def test_settings_clear_quarantine_opens_the_shared_dialog():
    src = (_WEBUI / "static" / "settings.js").read_text(encoding="utf-8")
    start = src.index("async function clearQuarantine()")
    body = src[start:src.index("\n}\n", start)]
    assert "window.openPermanentDelete" in body
    assert "fetch(" not in body
