"""Nothing in the web UI empties a recycle bin or the quarantine on its own.

The purge / clear routes delete files for good and only act on a preview
plan's id. The one client allowed to call them is the shared
preview-then-confirm module (webui/src/features/safe-action/permanent-delete.ts);
the Downloads page, the video Review pane, the audiobook bin and Settings ->
Clear quarantine all go through its dialog. A page that posted straight to a
route would get a 409 today, and this keeps anyone from wiring one back in.
The same holds for Video Library Maintenance's bulk fix and its own module.
"""

from __future__ import annotations

from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_WEBUI = _ROOT / "webui"
_ROUTES = ("deleted-files/purge", "quarantine/clear", "video/downloads/recycle/purge",
           "audiobooks/library/recycle/purge")
_ALLOWED = {_WEBUI / "src" / "features" / "safe-action" / "permanent-delete.ts"}
_VIDEO_FIX_ROUTE = "repair/findings/bulk-fix"
_VIDEO_FIX_ALLOWED = {_WEBUI / "src" / "features" / "safe-action" / "video-repair-fix.ts",
                      # the music Tools page's own bulk-fix client (/api/repair/...)
                      _WEBUI / "src" / "routes" / "tools" / "-tools.api.ts"}


def _client_sources():
    yield _WEBUI / "index.html"
    for path in (_WEBUI / "static").rglob("*.js"):
        if "dist" not in path.relative_to(_WEBUI / "static").parts:   # the build of src/
            yield path
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


def test_the_audiobook_bin_is_never_emptied_by_a_bare_delete():
    api = (_WEBUI / "src" / "routes" / "audiobooks" / "-audiobooks.api.ts").read_text(encoding="utf-8")
    assert "audiobookClient.delete('audiobooks/library/recycle" not in api
    assert "audiobookClient.delete(`audiobooks/library/recycle" not in api


def test_only_the_shared_flows_post_a_bulk_fix():
    offenders = []
    for path in _client_sources():
        if path in _VIDEO_FIX_ALLOWED or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if _VIDEO_FIX_ROUTE in text:
            offenders.append(str(path.relative_to(_ROOT)))
    assert not offenders, "posts a bulk fix outside the plan flows:\n  " + "\n  ".join(offenders)


def test_the_video_tools_page_opens_the_shared_dialog_for_approve_selected():
    src = (_WEBUI / "static" / "video" / "video-repair.js").read_text(encoding="utf-8")
    start = src.index("data-video-repair-bulk') === 'fix'")
    body = src[start:src.index("} else {", start)]
    assert "window.openVideoRepairBulkFix" in body
    assert "jsend(" not in body


def test_settings_asks_before_turning_on_delete_original():
    src = (_WEBUI / "static" / "settings.js").read_text(encoding="utf-8")
    assert "settingsPage.addEventListener('change', confirmLossyDeleteOriginalChange, true)" in src
    start = src.index("async function confirmLossyDeleteOriginalChange(event)")
    body = src[start:src.index("\n}\n", start)]
    assert "'lossy-copy-delete-original'" in body
    assert "window.confirmLossyDeleteOriginal" in body
    assert "event.stopImmediatePropagation()" in body and "box.checked = false" in body
    main = (_WEBUI / "src" / "app" / "main.tsx").read_text(encoding="utf-8")
    assert "mountLossyDeleteOriginalHost()" in main and "mountVideoRepairFixHost()" in main
