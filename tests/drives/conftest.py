"""The drives tests build their own watch, job and Flask apps. markers' watch,
api.drives' job and wiring, the helper's token store, the hold and the drive
roots are module globals web_server's real app shares, so every test hands
them back as it found them (the pattern in tests/playback/conftest.py)."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _restore_drives_wiring(monkeypatch):
    import api.drives as drives_api
    from core.drives import helper, holds, markers

    saved_watch = markers.set_watch(None)
    saved_job = drives_api.JOB
    saved_deps = dict(drives_api._deps)
    saved_tokens = helper.TOKENS
    helper.TOKENS = helper.HelperTokens()
    saved_hold = dict(holds._HOLD)
    monkeypatch.delenv("SOULSYNC_DRIVES_ROOTS", raising=False)
    monkeypatch.delenv("SOULSYNC_SLSKD_CONFIG_DIR", raising=False)
    yield
    markers.set_watch(saved_watch)
    drives_api.JOB = saved_job
    drives_api._deps.clear()
    drives_api._deps.update(saved_deps)
    helper.TOKENS = saved_tokens
    holds._HOLD.clear()
    holds._HOLD.update(saved_hold)


# ── a small install on disk: the app's folders, a drive, a library database ──

import os  # noqa: E402
import sqlite3  # noqa: E402


class Database:
    """The library database, as MusicDatabase hands it out."""

    def __init__(self, path):
        self.database_path = path
        conn = self._get_connection()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT,
                                               server_source TEXT DEFAULT 'soulsync', album_id INTEGER);
            CREATE TABLE IF NOT EXISTS albums (id INTEGER PRIMARY KEY, title TEXT);
            CREATE TABLE IF NOT EXISTS library_history (id INTEGER PRIMARY KEY, file_path TEXT);
            CREATE TABLE IF NOT EXISTS automations (id INTEGER PRIMARY KEY, name TEXT, enabled INTEGER,
                                                    action_type TEXT, is_system INTEGER DEFAULT 0);
        """)
        conn.commit()
        conn.close()

    def _get_connection(self):
        conn = sqlite3.connect(self.database_path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn


def write(path, data=b"x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    return path


@pytest.fixture
def install(tmp_path, monkeypatch):
    """The app's three folders on the computer's disk (tmp/app/...), a drive
    (tmp/Volumes/Music HD), a real ConfigManager on a temporary database
    holding the library's tables, and some music."""
    app = tmp_path / "app"
    volumes = tmp_path / "Volumes"
    drive = volumes / "Music HD"
    drive.mkdir(parents=True)
    lib, dl, st = app / "Transfer", app / "downloads", app / "Staging"
    for d in (lib, dl, st):
        d.mkdir(parents=True)
    dbdir = tmp_path / "db"
    dbdir.mkdir()
    db_path = str(dbdir / "music.db")
    monkeypatch.setenv("DATABASE_PATH", db_path)
    monkeypatch.setenv("SOULSYNC_CONFIG_PATH", str(tmp_path / "cfg" / "config.json"))
    monkeypatch.setenv("SOULSYNC_DRIVES_ROOTS", str(volumes))
    db = Database(db_path)
    from core.settings import ConfigManager
    config = ConfigManager(str(tmp_path / "cfg" / "config.json"))
    with config.batch():
        config.set("soulseek.transfer_path", str(lib))
        config.set("soulseek.download_path", str(dl))
        config.set("import.staging_path", str(st))
        config.set("drives.platform", "mac")
    files = {
        "library": ["Saltmarsh/Lantern/01 Tide.flac", "Saltmarsh/Lantern/02 Static Bloom.flac",
                    "Mira Sol/Glass/01 Glass.mp3", "cover.jpg"],
        "downloads": ["incoming/a.flac"],
        "staging": ["Album X/01.flac", "Album X/02.flac"],
    }
    roots = {"library": str(lib), "downloads": str(dl), "staging": str(st)}
    for role, rels in files.items():
        for i, rel in enumerate(rels):
            write(os.path.join(roots[role], rel), os.urandom(1000 + 37 * i))
    conn = db._get_connection()
    for i, rel in enumerate(files["library"][:3], 1):
        conn.execute("INSERT INTO tracks (id, title, file_path) VALUES (?, ?, ?)",
                     (i, rel, os.path.join(str(lib), rel)))
        conn.execute("INSERT INTO library_history (file_path) VALUES (?)", (os.path.join(str(lib), rel),))
    conn.execute("INSERT INTO tracks (id, title, file_path, server_source) VALUES (99, 'elsewhere', "
                 "'/data/music/x.flac', 'plex')")
    conn.execute("INSERT INTO albums (title) VALUES ('Lantern'), ('Glass')")
    conn.execute("INSERT INTO automations (name, enabled, action_type) VALUES "
                 "('Tidy new albums', 1, 'library_cleanup'), ('Say hello', 1, 'notify_only'), "
                 "('Apply quality upgrades', 1, 'apply_quality_upgrades'), ('Off one', 0, 'library_cleanup')")
    conn.commit()
    conn.close()
    return {"tmp": tmp_path, "app": app, "volumes": volumes, "drive": drive, "roots": roots, "db": db,
            "config": config, "files": files}
