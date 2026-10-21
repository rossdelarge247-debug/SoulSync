"""Duplicate cleaner: preview first, act only on a confirmed plan, never remove
the last copy (#1210 — "the duplicate cleaner deleted the only copy").
"""

from __future__ import annotations

import builtins
import os
import threading

import pytest

import core.library.duplicate_cleaner as dc
from core.library.action_plans import PLAN_UNKNOWN, plan_store
from core.library.deleted_quarantine import list_entries
from core.library.duplicate_keep import keeper_problem


class _Cfg:
    def __init__(self, transfer):
        self.transfer = transfer

    def get(self, key, default=None):
        if key == 'soulseek.transfer_path':
            return self.transfer
        return default


@pytest.fixture
def cleaner(tmp_path, monkeypatch):
    state = {"status": "idle"}
    dc.init(state, threading.Lock(), lambda p: p, None)
    monkeypatch.setattr(dc, 'config_manager', _Cfg(str(tmp_path)))
    monkeypatch.setattr(dc, 'get_database', lambda: None)
    monkeypatch.setattr(dc, 'add_activity_item', lambda *a, **k: None)
    plan_store.clear()
    yield state, str(tmp_path)
    plan_store.clear()


def _write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(payload)
    return path


def _album(transfer, n_dupes=2):
    """n_dupes songs that each exist as FLAC (keep) + MP3 (duplicate)."""
    album = os.path.join(transfer, 'Artist', 'Album')
    pairs = []
    for i in range(n_dupes):
        flac = _write(os.path.join(album, f'{i:02d} song.flac'), b'flac' * 100)
        mp3 = _write(os.path.join(album, f'{i:02d} song.mp3'), b'mp3' * 10)
        pairs.append((flac, mp3))
    return album, pairs


def _snapshot(root):
    return sorted(os.path.relpath(os.path.join(d, f), root)
                  for d, _dirs, files in os.walk(root) for f in files)


# ── plan mode ────────────────────────────────────────────────────────────


def test_a_plain_run_is_a_preview_that_touches_nothing(cleaner):
    state, transfer = cleaner
    _album_dir, pairs = _album(transfer, n_dupes=3)
    before = _snapshot(transfer)

    dc._run_duplicate_cleaner()

    assert _snapshot(transfer) == before          # not one file moved
    assert state['status'] == 'finished'
    assert state['mode'] == 'plan'
    assert state['deleted'] == 0
    assert state['duplicates_found'] == 3
    plan = state['plan']
    assert plan['total'] == 3
    assert plan['counts'] == {'recycle': 3}
    assert plan['total_bytes'] == 3 * len(b'mp3' * 10)
    assert state['plan_id'] == plan['plan_id']
    sample = {item['path']: item for item in plan['sample']}
    for flac, mp3 in pairs:
        assert sample[mp3]['keep'] == flac
        assert 'lower-quality duplicate of' in sample[mp3]['reason']
    assert list_entries(transfer)['count'] == 0


def test_confirming_the_plan_moves_exactly_the_previewed_files(cleaner):
    state, transfer = cleaner
    album, pairs = _album(transfer, n_dupes=2)
    dc._run_duplicate_cleaner()
    plan_id = state['plan_id']

    # a new duplicate appears after the preview: the user never saw it
    late = _write(os.path.join(album, 'late.mp3'), b'late')
    _write(os.path.join(album, 'late.flac'), b'flac' * 50)

    dc._run_duplicate_cleaner(plan_id)

    assert state['mode'] == 'apply'
    assert state['deleted'] == 2
    for flac, mp3 in pairs:
        assert os.path.isfile(flac)
        assert not os.path.exists(mp3)
    assert os.path.isfile(late)                    # not in the plan, untouched
    bin_ = list_entries(transfer)
    assert bin_['count'] == 2                      # recycle bin, restorable
    assert {e['source'] for e in bin_['entries']} == {'duplicate-cleaner'}


def test_a_plan_cannot_be_used_twice(cleaner):
    state, transfer = cleaner
    _album(transfer, n_dupes=1)
    dc._run_duplicate_cleaner()
    plan_id = state['plan_id']
    dc._run_duplicate_cleaner(plan_id)
    assert state['deleted'] == 1

    dc._run_duplicate_cleaner(plan_id)
    assert state['status'] == 'error'
    assert state['error_code'] == PLAN_UNKNOWN


def test_acting_with_an_unknown_plan_is_refused_and_moves_nothing(cleaner):
    state, transfer = cleaner
    _album(transfer, n_dupes=2)
    before = _snapshot(transfer)

    dc._run_duplicate_cleaner('not-a-real-plan')

    assert state['status'] == 'error'
    assert state['error_code'] == PLAN_UNKNOWN
    assert 'Preview again' in state['error_message']
    assert _snapshot(transfer) == before


# ── last-copy protection ─────────────────────────────────────────────────


def test_keeper_deleted_after_preview_means_the_duplicate_is_kept(cleaner):
    state, transfer = cleaner
    _album_dir, [(flac, mp3)] = _album(transfer, n_dupes=1)
    dc._run_duplicate_cleaner()
    os.remove(flac)                                 # the "best" copy vanished

    dc._run_duplicate_cleaner(state['plan_id'])

    assert os.path.isfile(mp3)                     # the only copy left survives
    assert state['deleted'] == 0
    assert state['refused'] == 1
    assert state['refused_items'][0]['reason'] == 'the copy being kept is missing'
    assert list_entries(transfer)['count'] == 0


def test_an_empty_keeper_is_not_trusted(cleaner):
    state, transfer = cleaner
    _album_dir, [(flac, mp3)] = _album(transfer, n_dupes=1)
    dc._run_duplicate_cleaner()
    open(flac, 'wb').close()                        # truncated to 0 bytes

    dc._run_duplicate_cleaner(state['plan_id'])

    assert os.path.isfile(mp3)
    assert state['refused'] == 1
    assert 'empty' in state['refused_items'][0]['reason']


def test_a_keeper_that_is_a_link_to_the_duplicate_is_refused(cleaner):
    """song.flac is a symlink to song.mp3: 'removing the mp3 duplicate' would
    leave the kept flac dangling — the only real copy gone."""
    state, transfer = cleaner
    album = os.path.join(transfer, 'Artist', 'Album')
    real = _write(os.path.join(album, 'song.mp3'), b'only real audio')
    link = os.path.join(album, 'song.flac')
    os.symlink(real, link)

    dc._run_duplicate_cleaner(confirm=True)

    assert os.path.isfile(real)
    assert state['deleted'] == 0
    assert state['refused'] == 1
    assert 'same file' in state['refused_items'][0]['reason']


def test_a_file_changed_since_the_preview_is_skipped(cleaner):
    state, transfer = cleaner
    _album_dir, [(_flac, mp3)] = _album(transfer, n_dupes=1)
    dc._run_duplicate_cleaner()
    _write(mp3, b're-downloaded, different now' * 10)

    dc._run_duplicate_cleaner(state['plan_id'])

    assert os.path.isfile(mp3)
    assert state['deleted'] == 0
    assert state['skipped'] == 1


def test_keeper_problem_reports_an_unreadable_file(tmp_path, monkeypatch):
    path = _write(str(tmp_path / 'keep.flac'), b'audio')
    real_open = builtins.open

    def _denied(file, *a, **k):
        if os.fspath(file) == path:
            raise PermissionError(13, 'Permission denied')
        return real_open(file, *a, **k)

    monkeypatch.setattr(builtins, 'open', _denied)
    assert 'cannot be read' in keeper_problem(path)


def test_keeper_problem_accepts_a_healthy_file(tmp_path):
    assert keeper_problem(_write(str(tmp_path / 'keep.flac'), b'audio')) is None
    assert keeper_problem(None) == 'no copy to keep was found'


# ── the Library Maintenance "Keep Best" fixer gets the same rule ─────────


def _repair_worker(tmp_path):
    from core.repair_worker import RepairWorker
    from database.music_database import MusicDatabase
    db = MusicDatabase(str(tmp_path / "music.db"))
    with db._get_connection() as conn:
        conn.execute("INSERT INTO artists (id, name, server_source) VALUES (1, 'A', 'test')")
        conn.execute("INSERT INTO albums (id, title, artist_id, server_source) VALUES (1, 'Alb', 1, 'test')")
        conn.commit()
    w = RepairWorker(database=db)
    w._config_manager = None
    w.transfer_folder = str(tmp_path / "Transfer")
    return db, w


def _insert_track(db, tid, path):
    with db._get_connection() as conn:
        conn.execute("INSERT INTO tracks (id, title, file_path, artist_id, album_id, server_source) "
                     "VALUES (?, 'Song', ?, 1, 1, 'test')", (tid, path))
        conn.commit()


def test_keep_best_refuses_when_the_kept_copy_is_an_empty_file(tmp_path):
    db, w = _repair_worker(tmp_path)
    keep = tmp_path / "keep.flac"
    keep.write_bytes(b"")                          # exists, but holds nothing
    dupe = tmp_path / "dupe.mp3"
    dupe.write_bytes(b"the only real audio")
    _insert_track(db, 1, str(keep))
    _insert_track(db, 2, str(dupe))

    res = w._fix_duplicates('track', '1', str(keep), {'tracks': [
        {'id': 1, 'file_path': str(keep)}, {'id': 2, 'file_path': str(dupe)}], '_fix_action': '1'})

    assert res['success'] is False
    assert 'empty' in res['error']
    assert dupe.exists()
    with db._get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0] == 2
