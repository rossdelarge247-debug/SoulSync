"""update_mirrored_track_extra_data merges keys into a mirrored track's JSON.

it used to read the JSON, merge in Python and write it back with nothing
holding the row in between, so two writers merging different keys at once
(a discovery worker and a sync's library-membership stamp, say) both read the
old JSON and the later write dropped the earlier one's keys. the merge now
runs under BEGIN IMMEDIATE.

update_mirrored_tracks_extra_data is its batch form, for loops that stamp a
whole playlist: it must return and write exactly what looping the single call
does.
"""

from __future__ import annotations

import json
import logging
import threading
from types import SimpleNamespace

import pytest

import database.music_database as mdb
from database.music_database import MusicDatabase


def _mirror(db, count=6):
    pid = db.mirror_playlist(
        source="youtube", source_playlist_id="h1", name="Mirror",
        tracks=[{"track_name": f"T{n}", "artist_name": "A", "source_track_id": f"s{n}"} for n in range(count)],
        profile_id=1,
    )
    return pid, [t["id"] for t in db.get_mirrored_playlist_tracks(pid)]


def _set_raw(db, track_id, raw):
    with db._get_connection() as conn:
        conn.execute("UPDATE mirrored_playlist_tracks SET extra_data = ? WHERE id = ?", (raw, track_id))
        conn.commit()


def _state(db, pid):
    with db._get_connection() as conn:
        rows = [tuple(r) for r in conn.execute(
            "SELECT id, extra_data FROM mirrored_playlist_tracks WHERE playlist_id = ? ORDER BY id", (pid,))]
        tiles = conn.execute("SELECT cover_tiles FROM mirrored_playlists WHERE id = ?", (pid,)).fetchone()[0]
    return rows, tiles


def _scenario(db):
    """rows in every shape the merge meets, and the updates to apply"""
    pid, ids = _mirror(db)
    _set_raw(db, ids[0], json.dumps({"discovered": False, "keep": 1}))
    _set_raw(db, ids[1], "not json at all")          # replaced by the update
    _set_raw(db, ids[2], json.dumps([1, 2, 3]))       # not an object: the merge fails
    db.backfill_missing_mirrored_covers(1)            # cached tiles a match must drop
    cover = {"discovered": True, "matched_data": {"image_url": "http://a/cover.jpg"}}
    updates = [
        (ids[0], {"in_library": True, "library_track_id": "lt-1"}),
        (ids[1], {"in_library": False}),
        (ids[2], {"in_library": True}),
        (ids[3], cover),
        (999_999, {"in_library": True}),              # no such row
        (ids[0], {"keep": 2, "library_track_id": None}),  # repeat: merges into the first merge
        (ids[4], {}),
        (ids[5], {"nested": {"a": 1}}),
        (ids[5], {"nested": {"b": 2}}),               # top-level replace, not a deep merge
    ]
    return pid, updates


@pytest.mark.parametrize('chunk', [1, 2, 500])
def test_the_batch_returns_and_writes_what_the_loop_does(tmp_path, monkeypatch, chunk, caplog):
    monkeypatch.setattr(MusicDatabase, '_EXTRA_DATA_WRITE_BATCH', chunk)
    loop_db = MusicDatabase(str(tmp_path / "loop.db"))
    batch_db = MusicDatabase(str(tmp_path / "batch.db"))
    loop_pid, updates = _scenario(loop_db)
    batch_pid, batch_updates = _scenario(batch_db)
    assert updates == batch_updates

    def errors():
        return [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]

    caplog.clear()
    with caplog.at_level(logging.ERROR):
        expected = [loop_db.update_mirrored_track_extra_data(tid, data) for tid, data in updates]
    loop_errors = errors()
    caplog.clear()
    with caplog.at_level(logging.ERROR):
        got = batch_db.update_mirrored_tracks_extra_data(updates)

    assert got == expected == [True, True, False, True, False, True, True, True, True]
    assert _state(batch_db, batch_pid) == _state(loop_db, loop_pid)
    assert errors() == loop_errors == ["Error updating mirrored track extra_data: 'list' object has no attribute 'update'"]
    rows, tiles = _state(batch_db, batch_pid)
    assert json.loads(rows[0][1]) == {"discovered": False, "keep": 2, "in_library": True, "library_track_id": None}
    assert json.loads(rows[5][1]) == {"nested": {"b": 2}}
    assert tiles is None


def test_empty_input():
    db = MusicDatabase.__new__(MusicDatabase)  # never touches a database
    assert db.update_mirrored_tracks_extra_data([]) == []


def test_one_connection_for_the_whole_batch(tmp_path, monkeypatch):
    db = MusicDatabase(str(tmp_path / "m.db"))
    pid, ids = _mirror(db, count=40)
    opened = []
    real = MusicDatabase._get_connection
    monkeypatch.setattr(MusicDatabase, '_get_connection', lambda self: opened.append(1) or real(self))
    assert db.update_mirrored_tracks_extra_data([(i, {"in_library": True}) for i in ids]) == [True] * 40
    assert len(opened) == 1


def test_a_batch_that_cannot_start_merges_row_by_row(tmp_path, monkeypatch):
    loop_db = MusicDatabase(str(tmp_path / "loop.db"))
    batch_db = MusicDatabase(str(tmp_path / "batch.db"))
    loop_pid, updates = _scenario(loop_db)
    batch_pid, _ = _scenario(batch_db)
    expected = [loop_db.update_mirrored_track_extra_data(tid, data) for tid, data in updates]

    real = MusicDatabase._savepoint
    state = {'killed': False}

    def kills_the_first_transaction(self, cursor, name):
        if not state['killed'] and name == 'extra_data':
            state['killed'] = True
            cursor.execute("ROLLBACK")
            raise RuntimeError("disk I/O error")
        return real(self, cursor, name)

    monkeypatch.setattr(MusicDatabase, '_savepoint', kills_the_first_transaction)
    assert batch_db.update_mirrored_tracks_extra_data(updates) == expected
    assert state['killed']
    assert _state(batch_db, batch_pid) == _state(loop_db, loop_pid)


# ── two writers, different keys, same row ───────────────────────────────────

class _ReadThenWait:
    """json stand-in for the merge: the thread named 'first' pauses right
    after it has read the row's JSON, until the second writer has read it
    too or a second has passed. without a lock across read and write, the
    second writer reads the same old JSON and one merge is lost."""

    def __init__(self):
        self.first_has_read = threading.Event()
        self.second_has_read = threading.Event()

    def loads(self, raw):
        value = json.loads(raw)
        name = threading.current_thread().name
        if name == 'first':
            self.first_has_read.set()
            self.second_has_read.wait(timeout=1.0)
        elif name == 'second':
            self.second_has_read.set()
        return value

    dumps = staticmethod(json.dumps)
    JSONDecodeError = json.JSONDecodeError


@pytest.mark.parametrize('first_writer', ['single', 'batch'])
def test_two_writers_merging_different_keys_both_keep_them(tmp_path, monkeypatch, first_writer):
    db = MusicDatabase(str(tmp_path / "race.db"))
    _pid, ids = _mirror(db, count=1)
    row = ids[0]
    _set_raw(db, row, json.dumps({"discovered": True}))
    hook = _ReadThenWait()
    monkeypatch.setattr(mdb, 'json', SimpleNamespace(loads=hook.loads, dumps=hook.dumps,
                                                     JSONDecodeError=hook.JSONDecodeError))
    results = {}

    def first():
        if first_writer == 'batch':
            results['first'] = db.update_mirrored_tracks_extra_data([(row, {"in_library": True})])[0]
        else:
            results['first'] = db.update_mirrored_track_extra_data(row, {"in_library": True})

    def second():
        results['second'] = db.update_mirrored_track_extra_data(row, {"manual_match": True})

    a = threading.Thread(target=first, name='first')
    a.start()
    assert hook.first_has_read.wait(timeout=10)
    b = threading.Thread(target=second, name='second')
    b.start()
    a.join(timeout=60)
    b.join(timeout=60)

    assert results == {'first': True, 'second': True}
    with db._get_connection() as conn:
        merged = json.loads(conn.execute("SELECT extra_data FROM mirrored_playlist_tracks WHERE id = ?",
                                         (row,)).fetchone()[0])
    assert merged == {"discovered": True, "in_library": True, "manual_match": True}


# ── the sync's library-membership stamp ─────────────────────────────────────

def test_the_sync_stamps_a_whole_playlist_in_one_connection(tmp_path, monkeypatch):
    from core.discovery.sync import _record_library_membership
    db = MusicDatabase(str(tmp_path / "m.db"))
    _pid, ids = _mirror(db, count=30)
    monkeypatch.setattr(mdb, 'get_database', lambda: db)
    opened = []
    real = MusicDatabase._get_connection
    monkeypatch.setattr(MusicDatabase, '_get_connection', lambda self: opened.append(1) or real(self))

    tracks_json = [{'db_track_id': i} for i in ids]
    details = [{'index': n, 'status': 'found' if n % 2 == 0 else 'not_found', 'matched_track': {'id': f"lib{n}"}}
               for n in range(len(ids))]
    _record_library_membership(tracks_json, details)

    assert len(opened) == 1
    stamped = {t['id']: json.loads(t['extra_data']) for t in db.get_mirrored_playlist_tracks(_pid)}
    assert stamped[ids[0]]['in_library'] is True and stamped[ids[0]]['library_track_id'] == 'lib0'
    assert stamped[ids[1]]['in_library'] is False and stamped[ids[1]]['library_track_id'] is None
    assert len({s['library_checked_at'] for s in stamped.values()}) == 1
