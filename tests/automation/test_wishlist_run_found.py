"""The Wanted search records what each run found (HANDOFF 19).

The run row is written when the search has only started its batches; what
they download arrives later. ``core.automation.run_results`` writes the
counts back onto the run row by its id, whichever of the two halves comes
second.
"""

from __future__ import annotations

import json

import pytest

from core.automation import progress, run_results
from core.wishlist import processing


@pytest.fixture(autouse=True)
def _clean():
    run_results.reset_for_tests()
    progress.progress_states.clear()
    yield
    run_results.reset_for_tests()
    progress.progress_states.clear()


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    return MusicDatabase(database_path=str(tmp_path / "found.db"))


def _automation(db):
    return db.create_automation("Fill Wanted", "schedule", json.dumps({"interval": 6, "unit": "hours"}),
                                "process_wishlist", "{}", profile_id=1)


def _result(db, aid):
    row = db.get_automation_run_history(aid)["history"][0]
    return json.loads(row["result_json"])


class _Lock:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _finalize(db, batch_id, batches, found):
    processing.finalize_auto_wishlist_completion(
        batch_id, {"tracks_added": 0, "total_failed": 0, "errors": 0, "tracks_found": found},
        download_batches=batches, tasks_lock=_Lock(), reset_processing_state=lambda: None,
        add_activity_item=lambda *a: None, automation_engine=None, db_factory=lambda: db)


def test_insert_returns_the_new_rows_id(db):
    aid = _automation(db)
    first = db.insert_automation_run_history(aid, "a", "b", 1, "completed")
    second = db.insert_automation_run_history(aid, "a", "b", 1, "completed")
    assert isinstance(first, int) and second == first + 1


def test_found_is_written_onto_the_run_row_when_the_last_batch_finishes(db):
    aid = _automation(db)
    run_results.begin("run-1", aid, tracks=41, albums=0)
    run_results.set_searched("run-1", tracks=41, albums=3)
    progress.init_progress(aid, "Fill Wanted", "process_wishlist")
    progress.record_history(aid, {"status": "completed"}, db)
    assert _result(db, aid) == {"status": "completed", "searched": {"tracks": 41, "albums": 3}}

    batches = {
        "album-1": {"wishlist_run_id": "run-1", "is_album_download": True, "phase": "complete"},
        "album-2": {"wishlist_run_id": "run-1", "is_album_download": True, "phase": "downloading"},
        "tracks": {"wishlist_run_id": "run-1", "is_album_download": False, "phase": "downloading"},
    }
    _finalize(db, "album-1", batches, found=9)
    assert "found" not in _result(db, aid)          # siblings still running
    batches["album-1"]["phase"] = "complete"
    _finalize(db, "album-2", batches, found=0)      # an album that found nothing
    batches["album-2"]["phase"] = "complete"
    _finalize(db, "tracks", batches, found=3)
    assert _result(db, aid) == {"status": "completed", "searched": {"tracks": 41, "albums": 3},
                                "found": {"tracks": 12, "albums": 1}}


def test_batches_that_finish_before_the_row_is_recorded_still_count(db):
    aid = _automation(db)
    run_results.begin("run-2", aid, tracks=4, albums=0)
    _finalize(db, "b", {"b": {"wishlist_run_id": "run-2", "phase": "complete"}}, found=4)
    progress.record_history(aid, {"status": "completed"}, db)
    assert _result(db, aid)["found"] == {"tracks": 4, "albums": 0}


def test_a_click_on_wanted_without_an_automation_keeps_nothing(db):
    run_results.begin("run-3", None, tracks=4, albums=0)
    run_results.add_batch("run-3", found_tracks=4, is_album=False)
    run_results.finish("run-3", db)
    assert run_results._pending == {}


def test_a_later_search_replaces_one_that_never_got_its_row(db):
    aid = _automation(db)
    run_results.begin("old", aid, tracks=1, albums=0)
    run_results.begin("new", aid, tracks=2, albums=0)
    assert set(run_results._pending) == {"new"}


def test_other_automations_runs_are_left_alone(db):
    aid = _automation(db)
    other = _automation(db)
    run_results.begin("run-4", aid, tracks=5, albums=0)
    progress.record_history(other, {"status": "completed"}, db)
    assert "searched" not in _result(db, other)


def test_a_finished_batch_counts_its_completed_tasks():
    batch = {"queue": ["a", "b", "c", "missing"]}
    tasks = {"a": {"status": "completed"}, "b": {"status": "failed"}, "c": {"status": "completed"}}
    assert run_results.batch_found_tracks(batch, tasks) == 2
    assert run_results.batch_found_tracks({}, tasks) == 0


def test_the_search_registers_its_run_before_the_batches_go_out(monkeypatch):
    """process_wishlist_automatically begins the entry with the automation
    and fills in what it searched once the batches are out."""
    from tests.wishlist.test_automation import _build_runtime
    seen = []
    monkeypatch.setattr(run_results, "begin",
                        lambda run_id, aid, **kw: seen.append(("begin", aid, kw)))
    monkeypatch.setattr(run_results, "set_searched",
                        lambda run_id, **kw: seen.append(("searched", kw)))
    runtime, *_rest = _build_runtime(
        tracks=[{"name": "Album Track", "artists": [{"name": "A"}],
                 "spotify_data": {"album": {"album_type": "album"}}}],
        cycle_value="albums", count=1)
    processing.process_wishlist_automatically(runtime, automation_id=7)
    assert seen[0] == ("begin", 7, {"tracks": 1, "albums": 0})
    assert seen[1][0] == "searched" and seen[1][1]["tracks"] == 1
