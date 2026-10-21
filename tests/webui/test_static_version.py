"""Per-file content-hash versions for /static URLs (core/webui/static_version.py)."""

from __future__ import annotations

import os

import pytest
from flask import Flask, render_template_string, url_for

from core.webui import static_version
from core.webui.static_version import StaticVersioner


@pytest.fixture
def static_dir(tmp_path):
    (tmp_path / "core.js").write_text("console.log('one');")
    (tmp_path / "style.css").write_text("body { color: red; }")
    (tmp_path / "vendor").mkdir()
    (tmp_path / "vendor" / "lib.js").write_text("lib")
    return tmp_path


@pytest.fixture
def digests(monkeypatch):
    """Count how often a file is actually read and hashed."""
    calls = []
    real = static_version._file_digest

    def counting(path):
        calls.append(os.path.basename(path))
        return real(path)

    monkeypatch.setattr(static_version, "_file_digest", counting)
    return calls


def test_version_is_a_content_hash_per_file(static_dir):
    versioner = StaticVersioner(static_dir, fallback="boot")

    core = versioner.version("core.js")
    style = versioner.version("style.css")

    assert len(core) == 12 and int(core, 16) >= 0
    assert core != style
    assert versioner.version("vendor/lib.js") not in (core, style)
    # same bytes, same version, whatever the file is called or when it was written
    (static_dir / "copy.js").write_text("console.log('one');")
    os.utime(static_dir / "copy.js", (1, 1))
    assert versioner.version("copy.js") == core


def test_each_file_is_hashed_once_per_process(static_dir, digests):
    versioner = StaticVersioner(static_dir, fallback="boot")

    first = [versioner.version("core.js") for _ in range(50)]
    versioner.version("style.css")

    assert set(first) == {first[0]}
    assert digests == ["core.js", "style.css"]


def test_an_upgrade_gives_changed_files_new_versions_and_keeps_the_rest(static_dir):
    before = StaticVersioner(static_dir, fallback="boot-1")
    old_core, old_style = before.version("core.js"), before.version("style.css")

    (static_dir / "core.js").write_text("console.log('two');")
    after = StaticVersioner(static_dir, fallback="boot-2")  # the restarted process

    assert after.version("core.js") != old_core
    assert after.version("style.css") == old_style


def test_production_mode_does_not_restat_on_every_url(static_dir, digests, monkeypatch):
    versioner = StaticVersioner(static_dir, fallback="boot")
    old = versioner.version("core.js")
    (static_dir / "core.js").write_text("console.log('edited while running');")

    def no_lookup(*_args, **_kwargs):
        raise AssertionError("looked the file up again for a cached version")

    monkeypatch.setattr(static_version, "safe_join", no_lookup)
    assert versioner.version("core.js") == old
    assert digests == ["core.js"]


def test_watch_mode_picks_up_edits(static_dir):
    versioner = StaticVersioner(static_dir, fallback="boot", watch=True)
    old = versioner.version("core.js")

    (static_dir / "core.js").write_text("console.log('edited while running');")
    stat = (static_dir / "core.js").stat()
    os.utime(static_dir / "core.js", ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))

    assert versioner.version("core.js") != old


@pytest.mark.parametrize("filename", ["missing.js", "../outside.js", "/etc/passwd"])
def test_unreadable_or_outside_files_get_the_fallback(static_dir, filename):
    (static_dir.parent / "outside.js").write_text("nope")
    versioner = StaticVersioner(static_dir, fallback="boot")
    assert versioner.version(filename) == "boot"


def test_url_for_static_gets_the_file_version(static_dir):
    app = Flask(__name__, static_folder=str(static_dir), static_url_path="/static")
    versioner = StaticVersioner(app.static_folder, fallback="boot")
    app.url_defaults(versioner.url_defaults)

    @app.route("/page")
    def page():
        return "page"

    with app.test_request_context():
        assert url_for("static", filename="core.js") == f"/static/core.js?v={versioner.version('core.js')}"
        # an explicit v wins, and other endpoints are untouched
        assert url_for("static", filename="core.js", v="pinned") == "/static/core.js?v=pinned"
        assert url_for("page") == "/page"
        html = render_template_string("<script src=\"{{ url_for('static', filename='vendor/lib.js') }}\"></script>")
        assert f"/static/vendor/lib.js?v={versioner.version('vendor/lib.js')}" in html
