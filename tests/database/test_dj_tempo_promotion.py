"""The tempo-octave fix's upgrade (``_promote_settled_tempos``): DJ data and
grids the new rule can't change (read at 100–140 BPM, an error, too long,
too short) move to the new versions without a decode; the ones it can
change (70–100, 140–200) wait for the sweep; it runs once; and a person's
BPM column arrives on an install that had DJ data before it."""

from __future__ import annotations

import sqlite3

import pytest

from core.dj import grid_store, store
from core.dj.grid import GRID_VERSION
from core.sample.analyze import ANALYZER_VERSION
import database.music_database as mdb
from database.music_database import MusicDatabase

pytestmark = pytest.mark.gauntlet


def _reopen(path) -> MusicDatabase:
    """Open as SYNCHRO.S does at its next start (the schema steps run again)."""
    mdb._database_initialized_paths.discard(str(path.resolve()))
    return MusicDatabase(str(path))


def _q(path, sql, params=()):
    conn = sqlite3.connect(str(path))
    try:
        rows = conn.execute(sql, params).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


def _as_before_the_fix(path):
    """A library analysed by the previous release (analyzer 4, grid 2)."""
    MusicDatabase(str(path))
    dj = [("1", "done", 124.0), ("2", "done", 87.0), ("3", "done", 172.0), ("4", "done", 100.0),
          ("5", "done", 139.9), ("6", "error", None), ("7", "skipped", None), ("8", "unreachable", None),
          ("9", "done", None), ("10", "analyzing", 120.0), ("11", "done", 70.0)]
    for tid, status, bpm in dj:
        _q(path, "INSERT INTO track_dj (track_id, status, analyzed_bpm, bpm, dj_analyzer_version) "
                 "VALUES (?, ?, ?, ?, 4)", (tid, status, bpm, bpm))
    grids = [("1", "done", 124.0, None), ("2", "done", 87.0, None), ("3", "done", 172.0, None),
             ("4", "none", 110.0, "no_beat"), ("5", "none", None, "too_short"), ("6", "none", None, "no_beat"),
             ("7", "error", None, "x"), ("8", "skipped", None, "too long"), ("9", "none", 95.0, "no_beat")]
    for tid, status, bpm, reason in grids:
        _q(path, "INSERT INTO track_grid (track_id, status, bpm, reason, grid_version) VALUES (?, ?, ?, ?, 2)",
           (tid, status, bpm, reason))
    _q(path, "INSERT INTO track_dj (track_id, status, analyzed_bpm, dj_analyzer_version) VALUES ('12', 'done', 124, 3)")
    _q(path, "DELETE FROM metadata WHERE key = 'dj_tempo_octave_v5'")
    _q(path, "DELETE FROM schema_migrations WHERE name = 'dj_tempo_octave_v5'")


def test_only_what_the_rule_can_change_is_analysed_again(tmp_path):
    path = tmp_path / "music.db"
    _as_before_the_fix(path)
    _reopen(path)
    assert (ANALYZER_VERSION, GRID_VERSION) == (5, 3)
    dj = dict(_q(path, "SELECT track_id, dj_analyzer_version FROM track_dj"))
    assert {t for t, v in dj.items() if v == 5} == {"1", "4", "5", "6", "7", "9"}
    assert {t for t, v in dj.items() if v != 5} == {"2", "3", "8", "10", "11", "12"}
    grids = dict(_q(path, "SELECT track_id, grid_version FROM track_grid"))
    assert {t for t, v in grids.items() if v == 3} == {"1", "4", "5", "7", "8"}
    assert {t for t, v in grids.items() if v != 3} == {"2", "3", "6", "9"}
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'dj_tempo_octave_v5'")


def test_it_runs_once(tmp_path):
    path = tmp_path / "music.db"
    _as_before_the_fix(path)
    _reopen(path)
    # rows a later sweep left at v4 (say a downgrade, then this release again) aren't touched again
    _q(path, "UPDATE track_dj SET dj_analyzer_version = 4 WHERE track_id = '1'")
    _reopen(path)
    assert _q(path, "SELECT dj_analyzer_version FROM track_dj WHERE track_id = '1'") == [(4,)]


def test_the_sweep_sees_only_the_ambiguous_tracks(tmp_path):
    path = tmp_path / "music.db"
    db = MusicDatabase(str(path))
    _q(path, "INSERT INTO artists (id, name) VALUES ('1', 'A')")
    _q(path, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'B')")
    for tid in ("1", "2"):
        _q(path, "INSERT INTO tracks (id, album_id, artist_id, title, file_path) VALUES (?, '10', '1', 't', ?)",
           (tid, f"/m/{tid}.flac"))
    _q(path, "INSERT INTO track_dj (track_id, status, analyzed_bpm, dj_analyzer_version, source_sig) "
             "VALUES ('1', 'done', 124.0, 4, 's'), ('2', 'done', 86.1, 4, 's')")
    _q(path, "INSERT INTO track_grid (track_id, status, bpm, grid_version, source_sig) "
             "VALUES ('1', 'done', 124.0, 2, 's'), ('2', 'done', 86.0, 2, 's')")
    _q(path, "DELETE FROM metadata WHERE key = 'dj_tempo_octave_v5'")
    db = _reopen(path)
    assert store.pending_ids(db, ANALYZER_VERSION) == ["2"]
    assert grid_store.pending_ids(db, ANALYZER_VERSION) == []  # 2's grid comes with its analysis
    assert store.counts(db, ANALYZER_VERSION)["pending"] == 1


def test_an_install_with_dj_data_gets_the_bpm_override_columns(tmp_path):
    path = tmp_path / "music.db"
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE track_dj (track_id TEXT PRIMARY KEY, bpm REAL, status TEXT, "
                 "dj_analyzer_version INTEGER)")
    conn.execute("INSERT INTO track_dj VALUES ('1', 174.0, 'done', 4)")
    conn.commit()
    conn.close()
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"]
    columns = {r[1] for r in _q(path, "PRAGMA table_info(track_dj)")}
    assert {"bpm_override", "bpm_override_at", "bpm_override_by"} <= columns
    assert _q(path, "SELECT bpm, bpm_override FROM track_dj WHERE track_id = '1'") == [(174.0, None)]
