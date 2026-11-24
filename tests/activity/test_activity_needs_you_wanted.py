"""Needs you, Wanted journey (step 1): quarantine counted in songs, and the
songs Wanted couldn't find.

* One item for the whole quarantine, for admins, counted in songs (attempts at
  the same intended target are one song), with the files in its detail and a
  link to Downloads → Review → Quarantine. A listdir decides whether it's there
  (the badge polls that); only the item reads sidecars, through the index.
* One item for the viewer's Wanted songs searched for three times or more,
  linking to Wanted's Not found filter.
"""

from __future__ import annotations

import json

import pytest

from core.activity import feed
from tests.activity.activity_rows import NOW


@pytest.fixture
def qdir(tmp_path, monkeypatch):
    folder = tmp_path / "ss_quarantine"
    folder.mkdir()
    monkeypatch.setattr(feed, "_quarantine_dir", lambda: str(folder))
    return folder


def _held(folder, stem, artist="Pale Harbour", track="Harbour Light"):
    (folder / f"{stem}.flac.quarantined").write_bytes(b"x")
    (folder / f"{stem}.json").write_text(json.dumps(
        {"expected_artist": artist, "expected_track": track, "trigger": "acoustid_unverified"}))


def test_quarantine_is_one_item_in_songs_linking_to_review(build, qdir):
    _held(qdir, "20261020_120000_a")
    _held(qdir, "20261020_130000_b")  # another try at the same song
    _held(qdir, "20261019_090000_c", artist="Saltmarsh", track="Static Bloom")
    page = build()
    item = next(i for i in page["needs_you"] if i["id"] == "quarantine:review")
    assert item["title"] == "2 songs are waiting for your decision"
    assert item["detail"].startswith("3 downloads were held back because they might be the wrong")
    assert item["link"] == "/active-downloads?review=quarantine"
    assert item["kind"] == "download" and item["status"] == "warning"
    assert item["ref"] == {"quarantine": 3, "songs": 2}
    assert page["counts"]["needs_you"] == 1


def test_one_song_reads_in_the_singular(build, qdir):
    _held(qdir, "20261020_120000_a")
    item = next(i for i in build()["needs_you"] if i["id"] == "quarantine:review")
    assert item["title"] == "1 song is waiting for your decision"
    assert item["detail"].startswith("1 download was held back")


def test_quarantine_is_admins_only_and_absent_when_empty(build, qdir):
    assert all(i["id"] != "quarantine:review" for i in build()["needs_you"])
    _held(qdir, "20261020_120000_a")
    member = feed.Viewer(profile_id=1, is_admin=False)
    assert all(i["id"] != "quarantine:review" for i in build(member)["needs_you"])


def test_the_badge_counts_quarantine_without_reading_a_sidecar(db, qdir, monkeypatch):
    _held(qdir, "20261020_120000_a")
    import core.imports.quarantine_index as index
    monkeypatch.setattr(index, "_read_record", lambda *a: pytest.fail("read a sidecar"))
    status = feed.build_status(db, feed.Viewer(profile_id=1, is_admin=True), now=NOW,
                               live_batches={}, running_automations={})
    assert status["needs_you_count"] == 1


def test_songs_not_found_are_one_item_for_their_profile(build, rows, qdir):
    rows.wishlist("t1", retry_count=3)
    rows.wishlist("t2", retry_count=5)
    rows.wishlist("t3", retry_count=2)
    rows.wishlist("t4", retry_count=4, profile_id=2)
    item = next(i for i in build()["needs_you"] if i["id"] == "wanted:not-found")
    assert item["title"] == "2 songs couldn’t be found"
    # browse=songs: a stored Sources choice doesn't hide the list it opens
    assert item["link"] == "/wanted?filter=not-found&browse=songs"
    assert item["ref"] == {"not_found": 2}
    other = build(feed.Viewer(profile_id=2, is_admin=False))["needs_you"]
    assert [i["title"] for i in other if i["id"] == "wanted:not-found"] == [
        "1 song couldn’t be found"]


def test_not_found_leaves_out_what_the_page_shows_as_moving_or_held(build, rows, qdir,
                                                                    monkeypatch):
    """The same songs Wanted's Not found chip counts: a song at three tries
    that's downloading now is Downloading, one with an attempt in quarantine
    is Needs your decision."""
    rows.wishlist("lost", retry_count=4)
    rows.wishlist("moving", retry_count=4)
    rows.wishlist("held", retry_count=5)
    monkeypatch.setattr(feed, "_live_tasks", lambda: {
        "sid:moving": {"status": "downloading", "task_id": "t", "batch_id": ""}})
    (qdir / "20261020_120000_h.flac.quarantined").write_bytes(b"x")
    (qdir / "20261020_120000_h.json").write_text(json.dumps(
        {"expected_artist": "A", "expected_track": "B",
         "context": {"track_info": {"spotify_track_id": "held"}}}))
    page = build()
    item = next(i for i in page["needs_you"] if i["id"] == "wanted:not-found")
    assert item["title"] == "1 song couldn’t be found"
    assert item["ref"] == {"not_found": 1}


def test_no_item_when_every_song_at_three_tries_is_moving(build, rows, qdir, monkeypatch):
    rows.wishlist("moving", retry_count=4)
    monkeypatch.setattr(feed, "_live_tasks", lambda: {
        "sid:moving": {"status": "searching", "task_id": "t", "batch_id": ""}})
    assert all(i["id"] != "wanted:not-found" for i in build()["needs_you"])
