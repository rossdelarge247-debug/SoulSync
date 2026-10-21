"""Library Maintenance deletes land in the recycle bin, not in oblivion.

Approving "delete" on an orphan file, a redundant single, unwanted content, a
quality/AcoustID/fake-lossless finding, or a lossy conversion's original used
to unlink the file. Now every one of them moves it into <transfer>/.deleted,
recorded in the manifest so the Recycle Bin tab can restore it. Only a user
who explicitly sets library.recycle_deletes off gets a permanent delete.
"""

from __future__ import annotations

import os

import pytest

from core.library.deleted_quarantine import list_entries, restore_entries
from core.repair_worker import (
    RepairWorker,
    _delete_file_if_present,
    _recycle_deletes_enabled,
    _remove_library_file,
)
from database.music_database import MusicDatabase


class _Cfg:
    def __init__(self, **values):
        self._values = {k.replace("__", "."): v for k, v in values.items()}

    def get(self, key, default=None):
        return self._values.get(key, default)


def _song(folder, rel="Artist/Album/song.flac", payload=b"audio" * 20):
    path = os.path.join(folder, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(payload)
    return path


@pytest.mark.parametrize("cfg,expected", [
    (None, True),
    (_Cfg(), True),
    (_Cfg(library__recycle_deletes=True), True),
    (_Cfg(library__recycle_deletes=False), False),
    (_Cfg(library__recycle_deletes="off"), False),
    (_Cfg(library__recycle_deletes=0), False),
])
def test_recycling_is_on_unless_explicitly_turned_off(cfg, expected):
    assert _recycle_deletes_enabled(cfg) is expected


def test_delete_helper_moves_the_file_into_the_recycle_bin(tmp_path):
    transfer = str(tmp_path / "Transfer")
    song = _song(transfer)

    deleted, note = _delete_file_if_present(song, transfer, config_manager=_Cfg(), source="quality-upgrade")

    assert deleted is True and note is None
    assert not os.path.exists(song)
    bin_ = list_entries(transfer)
    assert bin_["count"] == 1
    entry = bin_["entries"][0]
    assert entry["source"] == "quality-upgrade"
    assert entry["original_path"] == song
    # and it really can come back
    assert restore_entries(transfer, [entry["id"]])["restored"] == [entry["id"]]
    assert os.path.isfile(song)


def test_explicit_permanent_choice_still_deletes_for_good(tmp_path):
    transfer = str(tmp_path / "Transfer")
    song = _song(transfer)

    deleted, _ = _delete_file_if_present(song, transfer, config_manager=_Cfg(library__recycle_deletes=False))

    assert deleted is True
    assert not os.path.exists(song)
    assert list_entries(transfer)["count"] == 0


def test_recycle_never_clobbers_an_earlier_deletion(tmp_path):
    transfer = str(tmp_path / "Transfer")
    first = _song(transfer, payload=b"first")
    _remove_library_file(first, transfer, "repair")
    second = _song(transfer, payload=b"second")
    _remove_library_file(second, transfer, "repair")

    entries = list_entries(transfer)["entries"]
    assert len(entries) == 2
    sizes = sorted(e["size"] for e in entries)
    assert sizes == [len(b"first"), len(b"second")]


def test_a_failed_recycle_raises_and_leaves_the_file(tmp_path, monkeypatch):
    import shutil
    transfer = str(tmp_path / "Transfer")
    song = _song(transfer)

    def _boom(*_a, **_k):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(shutil, "move", _boom)
    with pytest.raises(OSError):
        _remove_library_file(song, transfer, "repair")
    assert os.path.isfile(song)


# ── through the real fixers ──────────────────────────────────────────────


def _worker(tmp_path, **cfg):
    db = MusicDatabase(str(tmp_path / "music.db"))
    w = RepairWorker(database=db)
    w.transfer_folder = str(tmp_path / "Transfer")
    os.makedirs(w.transfer_folder, exist_ok=True)
    w._config_manager = _Cfg(**cfg)
    return w, db


def test_orphan_delete_goes_to_the_recycle_bin(tmp_path):
    w, _db = _worker(tmp_path)
    orphan = _song(w.transfer_folder, "Loose/orphan.mp3")

    result = w._fix_orphan_file("file", "1", orphan, {"_fix_action": "delete"})

    assert result["success"] is True
    assert result["action"] == "deleted_file"
    assert result["recycled"] is True
    assert "recycle bin" in result["message"]
    assert not os.path.exists(orphan)
    entries = list_entries(w.transfer_folder)["entries"]
    assert [e["source"] for e in entries] == ["orphan-file"]


def test_orphan_delete_is_permanent_only_when_the_user_chose_that(tmp_path):
    w, _db = _worker(tmp_path, library__recycle_deletes=False)
    orphan = _song(w.transfer_folder, "Loose/orphan.mp3")

    result = w._fix_orphan_file("file", "1", orphan, {"_fix_action": "delete"})

    assert result["action"] == "deleted_file"
    assert result["recycled"] is False
    assert not os.path.exists(orphan)
    assert list_entries(w.transfer_folder)["count"] == 0


def test_unwanted_content_removal_is_restorable(tmp_path):
    w, db = _worker(tmp_path)
    live = _song(w.transfer_folder, "Artist/Live/live.flac")
    conn = db._get_connection()
    conn.execute("INSERT OR IGNORE INTO artists (id, name) VALUES ('ar1', 'A')")
    conn.execute("INSERT INTO albums (id, artist_id, title) VALUES ('al1', 'ar1', 'Live')")
    conn.execute("INSERT INTO tracks (id, artist_id, album_id, title, file_path) VALUES (1, 'ar1', 'al1', 'Live', ?)",
                 (live,))
    conn.commit()
    conn.close()

    result = w._fix_unwanted_content(
        "track", 1, live, {"track": {"id": 1, "file_path": live, "album_id": "al1"}, "type_label": "Live"})

    assert result["success"] is True
    assert not os.path.exists(live)
    entries = list_entries(w.transfer_folder)["entries"]
    assert [e["source"] for e in entries] == ["unwanted-content"]
