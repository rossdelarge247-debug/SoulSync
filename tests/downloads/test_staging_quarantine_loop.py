"""The staging → quarantine loop (Ross's log of 24 November).

'Tribes (Original Mix)' by Monty matched the staged '95. Monte - True
(Original Mix).mp3' at 0.85: the shared "(Original Mix)" lifted the title
score over the 0.80 gate and Monty/Monte the artist. Verification then
quarantined it, Wanted still wanted Tribes, and the next cycle (every ~17 s)
picked the same staged file again: a new quarantine copy each time.

Pinned here, with the real matching engine:
* titles are also compared with mix/version descriptors stripped from both
  sides, so a different core title is a mismatch whatever the suffix;
* a staged file quarantined when tried for a song is never tried for that
  song again (until the file changes), however the scores come out;
* the same file can still be claimed by the song it is.
"""

from __future__ import annotations

import os

import pytest

from core.downloads import staging as ds
from core.matching_engine import MusicMatchingEngine
from tests.downloads.test_downloads_staging import (  # noqa: F401 - reset_state is an autouse fixture
    _FakeConfig,
    _seed_task,
    _Track,
    reset_state,
)


def _deps(tmp_path, files, calls):
    return ds.StagingDeps(
        config_manager=_FakeConfig(str(tmp_path / "Transfer")),
        matching_engine=MusicMatchingEngine(),
        get_staging_file_cache=lambda batch_id: files,
        docker_resolve_path=lambda p: p,
        post_process_matched_download_with_verification=lambda *a, **k: calls.append(a),
    )


@pytest.fixture
def monte(tmp_path):
    path = tmp_path / "staging" / "95. Monte - True (Original Mix).mp3"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"mp3")
    return {"full_path": str(path), "title": "True (Original Mix)", "artist": "Monte"}


@pytest.fixture
def blocks(monkeypatch):
    """quarantine_source_blocks in memory."""
    rows = set()

    class FakeDb:
        def get_quarantine_source_block_files(self, username):
            return {f for u, f in rows if u == username}

        def add_quarantine_source_block(self, username, filename, **_):
            rows.add((username, filename))
            return True

    import database.music_database as mdb
    monkeypatch.setattr(mdb, "MusicDatabase", FakeDb)
    return rows


def test_a_shared_mix_suffix_doesnt_make_two_songs_one(tmp_path, monte, blocks):
    calls = []
    _seed_task("t1", track_info={"spotify_track_id": "sp-tribes"})
    ok = ds.try_staging_match("t1", "b1", _Track(name="Tribes (Original Mix)", artists=["Monty"]),
                              _deps(tmp_path, [monte], calls))
    assert ok is False and calls == []
    assert not (tmp_path / "Transfer").exists() or os.listdir(tmp_path / "Transfer") == []


def test_the_same_file_is_still_claimed_by_the_song_it_is(tmp_path, monte, blocks):
    calls = []
    _seed_task("t1", track_info={"spotify_track_id": "sp-true"})
    ok = ds.try_staging_match("t1", "b1", _Track(name="True (Original Mix)", artists=["Monte"]),
                              _deps(tmp_path, [monte], calls))
    assert ok is True and len(calls) == 1


def test_core_titles():
    normalize = MusicMatchingEngine().normalize_string
    assert ds._core_title("Tribes (Original Mix)", normalize) == normalize("Tribes")
    assert ds._core_title("Carry Your Heart - Radio Edit", normalize) == normalize("Carry Your Heart")
    assert ds._core_title("(Original Mix)", normalize) == ""
    assert ds._core_titles_differ("Tribes (Original Mix)", ["True (Original Mix)"], normalize)
    assert not ds._core_titles_differ("Tribes (Original Mix)", ["Tribes"], normalize)
    assert not ds._core_titles_differ("Tribes", ["Tribes (Extended Mix)"], normalize)


def test_a_quarantined_staged_file_is_never_tried_for_that_song_again(tmp_path, monte, blocks,
                                                                     monkeypatch):
    """Even when the scores would pass (here: the right title, a staged file
    the verification rejected), the second cycle doesn't copy it again."""
    from core.imports import guards

    staged = dict(monte, title="Tribes (Original Mix)", artist="Monty")
    calls = []
    _seed_task("t1", track_info={"spotify_track_id": "sp-tribes"})
    track = _Track(name="Tribes (Original Mix)", artists=["Monty"])
    assert ds.try_staging_match("t1", "b1", track, _deps(tmp_path, [staged], calls)) is True
    context = calls[0][1]
    copied = calls[0][2]
    assert os.path.exists(copied)

    # verification quarantines the copy (what post-processing does)
    monkeypatch.setattr(guards, "_get_config_manager",
                        lambda: type("C", (), {"get": lambda self, k, d=None: str(tmp_path / "dl")})())
    monkeypatch.setattr("core.imports.paths.docker_resolve_path", lambda p: p)
    guards.move_to_quarantine(copied, context, "AcoustID: a different recording",
                              trigger="acoustid_unverified")
    held = os.listdir(tmp_path / "dl" / "ss_quarantine")
    assert len([n for n in held if n.endswith(".quarantined")]) == 1
    # the transfer copy moved into quarantine: nothing is left in Transfer
    assert os.listdir(tmp_path / "Transfer") == []
    assert any(u == "staging:id:sp-tribes" for u, _f in blocks)

    # the next cycles: not tried again, no new quarantine copy
    for cycle in range(3):
        _seed_task(f"t{cycle + 2}", track_info={"spotify_track_id": "sp-tribes"})
        assert ds.try_staging_match(f"t{cycle + 2}", "b1", track,
                                    _deps(tmp_path, [staged], calls)) is False
    assert len(calls) == 1
    assert os.listdir(tmp_path / "Transfer") == []

    # another song can still have the file
    _seed_task("t9", track_info={"spotify_track_id": "sp-other"})
    other = _Track(name="Tribes (Original Mix)", artists=["Monty"])
    assert ds.try_staging_match("t9", "b1", other, _deps(tmp_path, [staged], calls)) is True

    # and a changed file (re-ripped: another size) gets another chance
    with open(staged["full_path"], "ab") as f:
        f.write(b"more")
    _seed_task("t10", track_info={"spotify_track_id": "sp-tribes"})
    assert ds.try_staging_match("t10", "b1", track, _deps(tmp_path, [staged], calls)) is True


# ── files that can never be audio ──────────────────────────────────────────
# The looping file itself was 0 bytes (mtime 2012), in a staging folder of
# ~1,400 files copied off a Mac over SMB: empty files and "._" resource forks.


def _staged(tmp_path, name, data):
    path = tmp_path / "staging" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"full_path": str(path), "title": "True (Original Mix)", "artist": "Monte"}


@pytest.mark.parametrize("name, data", [
    ("95. Monte - True (Original Mix).mp3", b""),                         # empty
    ("._95. Monte - True (Original Mix).mp3", b"\x00\x05\x16\x07" + b"\0" * 4092),
    ("95. Monte - True (Original Mix) copy.mp3", b"\x00\x05\x16\x07" + b"\0" * 60),
])
def test_a_file_that_cant_be_audio_is_never_a_match(tmp_path, blocks, name, data):
    """Even for the song its tags name: nothing copied to Transfer, nothing
    for verification to quarantine, every cycle."""
    calls = []
    staged = _staged(tmp_path, name, data)
    track = _Track(name="True (Original Mix)", artists=["Monte"])
    for cycle in range(3):
        _seed_task(f"t{cycle}", track_info={"spotify_track_id": "sp-true"})
        assert ds.try_staging_match(f"t{cycle}", "b1", track, _deps(tmp_path, [staged], calls)) is False
    assert calls == []
    assert not (tmp_path / "Transfer").exists() or os.listdir(tmp_path / "Transfer") == []


def test_a_missing_staged_file_is_never_a_match(tmp_path, blocks):
    calls = []
    staged = {"full_path": str(tmp_path / "staging" / "gone.mp3"),
              "title": "True (Original Mix)", "artist": "Monte"}
    _seed_task("t1", track_info={"spotify_track_id": "sp-true"})
    assert ds.try_staging_match("t1", "b1", _Track(name="True (Original Mix)", artists=["Monte"]),
                                _deps(tmp_path, [staged], calls)) is False
    assert calls == []


def test_a_real_file_next_to_them_is_still_taken(tmp_path, blocks):
    calls = []
    empty = _staged(tmp_path, "95. Monte - True (Original Mix).mp3", b"")
    fork = _staged(tmp_path, "._95. Monte - True (Original Mix).mp3", b"\x00\x05\x16\x07" + b"\0" * 60)
    real = _staged(tmp_path, "True.mp3", b"ID3" + b"\0" * 64)
    _seed_task("t1", track_info={"spotify_track_id": "sp-true"})
    assert ds.try_staging_match("t1", "b1", _Track(name="True (Original Mix)", artists=["Monte"]),
                                _deps(tmp_path, [empty, fork, real], calls)) is True
    assert len(calls) == 1


def test_the_staging_scan_leaves_them_out(tmp_path, monkeypatch):
    """No tag read and no candidate for an empty file or a "._" fork."""
    import web_server

    (tmp_path / "a.mp3").write_bytes(b"ID3" + b"\0" * 64)
    (tmp_path / "empty.mp3").write_bytes(b"")
    (tmp_path / "._a.mp3").write_bytes(b"\x00\x05\x16\x07" + b"\0" * 60)
    monkeypatch.setattr(web_server, "get_staging_path", lambda: str(tmp_path))
    monkeypatch.setattr(web_server, "_get_album_bundle_staging_path", lambda batch_id: None)
    web_server._staging_tag_cache.clear()
    read = []

    def fake_read(full_path, rel_path):
        read.append(os.path.basename(full_path))
        return {"title": "A", "artist": "B", "albumartist": "", "album": ""}

    monkeypatch.setattr(web_server, "_read_staging_file_metadata", fake_read)
    files = web_server._get_staging_file_cache("b1")
    assert [os.path.basename(f["full_path"]) for f in files] == ["a.mp3"]
    assert read == ["a.mp3"]
    web_server._staging_tag_cache.clear()


def test_core_titles_read_release_style_stems():
    normalize = MusicMatchingEngine().normalize_string
    assert not ds._core_titles_differ("Reincarnated", ["Kendrick Lamar - GNX - 03 - Reincarnated"],
                                      normalize)
    assert ds._core_titles_differ("Tribes (Original Mix)", ["95. Monte - True (Original Mix)"],
                                  normalize)
