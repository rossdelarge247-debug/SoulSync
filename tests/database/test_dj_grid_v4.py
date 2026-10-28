"""Grid v4's upgrade (``_promote_ready_grids``, Ross's report of 28 October):
grids ready to mix at v3 (and rows the sweep wouldn't decode) move to v4
without a decode; a grid that found no beat, one under the ready bar, one
with no confidence stored or not in 4/4 is analysed again; it runs once."""

from __future__ import annotations

import sqlite3

import pytest

from core.dj import grid_store
from core.dj.grid import GRID_VERSION
from core.sample.analyze import ANALYZER_VERSION
import database.music_database as mdb
from database.music_database import MusicDatabase

pytestmark = pytest.mark.gauntlet


def _q(path, sql, params=()):
    conn = sqlite3.connect(str(path))
    try:
        rows = conn.execute(sql, params).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


def _reopen(path) -> MusicDatabase:
    mdb._database_initialized_paths.discard(str(path.resolve()))
    return MusicDatabase(str(path))


GRIDS = [
    # id, status, reason, confidence, meter
    ("1", "done", None, 0.9, "4/4"),       # ready: promoted
    ("2", "done", None, 0.45, "4/4"),      # a break, or a rolling bass read as one: again
    ("3", "done", None, None, "4/4"),      # no confidence stored: again
    ("4", "none", "no_beat", 0.05, None),  # "no steady beat": again
    ("5", "none", "too_short", None, None),
    ("6", "error", "x", None, None),
    ("7", "done", None, 0.8, "not_4_4"),   # not in 4/4: again
    ("8", "done", None, 0.7, None),        # meter not stored is 4/4: promoted
]


def _as_before(path):
    MusicDatabase(str(path))
    _q(path, "INSERT INTO artists (id, name) VALUES ('1', 'A')")
    _q(path, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'B')")
    for tid, status, reason, conf, meter in GRIDS:
        _q(path, "INSERT INTO tracks (id, album_id, artist_id, title, file_path) VALUES (?, '10', '1', 't', ?)",
           (tid, f"/m/{tid}.flac"))
        _q(path, "INSERT INTO track_dj (track_id, status, bpm, dj_analyzer_version, source_sig) "
                 "VALUES (?, 'done', 122.0, ?, 's')", (tid, ANALYZER_VERSION))
        _q(path, "INSERT INTO track_grid (track_id, status, reason, beat_confidence, meter, bpm, grid_version, "
                 "source_sig, analyzed_at) VALUES (?, ?, ?, ?, ?, 122.0, 3, 's', strftime('%s', 'now'))",
           (tid, status, reason, conf, meter))
    _q(path, "DELETE FROM metadata WHERE key = 'dj_grid_v4'")
    _q(path, "DELETE FROM schema_migrations WHERE name = 'dj_grid_v4'")


def test_only_grids_ready_to_mix_skip_the_new_analysis(tmp_path):
    assert GRID_VERSION == 4
    path = tmp_path / "music.db"
    _as_before(path)
    db = _reopen(path)
    grids = dict(_q(path, "SELECT track_id, grid_version FROM track_grid"))
    assert {t for t, v in grids.items() if v == 4} == {"1", "5", "6", "8"}
    assert sorted(grid_store.pending_ids(db, ANALYZER_VERSION)) == ["2", "3", "4", "7"]
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'dj_grid_v4'")


def test_it_runs_once(tmp_path):
    path = tmp_path / "music.db"
    _as_before(path)
    _reopen(path)
    _q(path, "UPDATE track_grid SET grid_version = 3 WHERE track_id = '1'")
    _reopen(path)
    assert _q(path, "SELECT grid_version FROM track_grid WHERE track_id = '1'") == [(3,)]
