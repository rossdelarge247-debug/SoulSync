"""The second gauntlet review of Sets 1 (HANDOFF, "Dev, Sets 1 of 24 October",
After the second review): each finding's regression test."""

from __future__ import annotations

import threading
from contextlib import closing

import pytest

from core.sets import sources, store


@pytest.fixture(autouse=True)
def _fresh_sources():
    sources.clear_cache()
    sources.reset_limits()
    yield
    sources.clear_cache()
    sources.reset_limits()


def _sql(db, sql, params=()):
    with closing(db._get_connection()) as conn:
        conn.execute(sql, params)
        conn.commit()


def _rows(*ids):
    return [{"track_id": i} for i in ids]


def _revision(db, set_id):
    with closing(db._get_connection()) as conn:
        return conn.execute("SELECT revision, name FROM dj_sets WHERE id = ?", (set_id,)).fetchone()


# ── Low 1: the revision check and the write are one step ─────────────────────

@pytest.mark.gauntlet
def test_a_late_save_cannot_slip_in_between_the_check_and_the_write(client, db, monkeypatch):
    """Revision 1 reads the set (revision 0) and is about to write when
    revision 2 lands. With a read, a check and a separate write, 1 would
    pass its check and overwrite 2; as one conditional UPDATE it's refused."""
    made = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2")}).get_json()
    set_id = made["id"]
    real_own = store._own

    def own_then_newer_lands(conn, profile_id, sid):
        row = real_own(conn, profile_id, sid)
        _sql(db, "UPDATE dj_sets SET revision = 2, name = 'Newer' WHERE id = ?", (set_id,))
        return row

    monkeypatch.setattr(store, "_own", own_then_newer_lands)
    with pytest.raises(store.StaleRevision) as refused:
        store.update_set(db, 1, set_id, {"name": "Older", "revision": 1})
    assert refused.value.current == 2
    monkeypatch.setattr(store, "_own", real_own)
    assert tuple(_revision(db, set_id)) == (2, "Newer")


@pytest.mark.gauntlet
def test_two_saves_at_once_only_one_with_a_revision_wins(client, db):
    """Many threads send the same revision at once: exactly one is applied."""
    set_id = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2")}).get_json()["id"]
    outcomes = []
    lock = threading.Lock()
    start = threading.Barrier(6)

    def save(i):
        start.wait()
        try:
            store.update_set(db, 1, set_id, {"name": f"Window {i}", "revision": 1})
            result = "saved"
        except store.StaleRevision:
            result = "stale"
        except Exception as exc:  # noqa: BLE001 - "database is locked" would be a failure too
            result = f"error: {exc}"
        with lock:
            outcomes.append(result)

    threads = [threading.Thread(target=save, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(outcomes) == ["saved"] + ["stale"] * 5
    assert _revision(db, set_id)[0] == 1


def test_a_save_without_a_revision_counts_on_from_the_stored_one(client, db):
    set_id = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2")}).get_json()["id"]
    _sql(db, "UPDATE dj_sets SET revision = 7 WHERE id = ?", (set_id,))
    assert store.update_set(db, 1, set_id, {"name": "Renamed"})["revision"] == 8
    # a name-only save keeps the rows; a rows-only save keeps the name
    assert store.update_set(db, 1, set_id, {"tracks": _rows("3", "2"), "revision": 9})["tracks_changed"]
    saved = store.get_set(db, 1, set_id)
    assert saved["name"] == "Renamed" and [r["track_id"] for r in saved["rows"]] == ["3", "2"]


def test_a_save_that_fails_changes_nothing(client, db):
    set_id = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2")}).get_json()["id"]
    res = client.put(f"/api/sets/{set_id}", json={"name": "Gone", "tracks": [{"title": "  "}], "revision": 1})
    assert res.status_code == 400
    assert tuple(_revision(db, set_id)) == (0, "Sunday")


# ── Low 3: a crafted revision can't lock a set ───────────────────────────────

@pytest.mark.gauntlet
@pytest.mark.parametrize("bad", [-1, 2 ** 53 + 1, 10 ** 30, 10_001, "5", 1.5, True, [], {}])
def test_a_revision_out_of_range_is_refused(client, db, bad):
    set_id = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2")}).get_json()["id"]
    res = client.put(f"/api/sets/{set_id}", json={"name": "Locked", "revision": bad})
    assert res.status_code == 400
    assert tuple(_revision(db, set_id)) == (0, "Sunday")
    # and the set still saves normally afterwards
    assert client.put(f"/api/sets/{set_id}", json={"name": "Fine", "revision": 1}).get_json()["revision"] == 1


def test_a_revision_up_to_the_step_is_taken(client, db):
    set_id = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2")}).get_json()["id"]
    assert client.put(f"/api/sets/{set_id}", json={"name": "A", "revision": 10_000}).get_json()["revision"] == 10_000
    assert client.put(f"/api/sets/{set_id}", json={"name": "B", "revision": 20_000}).get_json()["revision"] == 20_000
    assert client.put(f"/api/sets/{set_id}", json={"name": "C", "revision": 30_001}).status_code == 400
    _sql(db, "UPDATE dj_sets SET revision = ? WHERE id = ?", (2 ** 53, set_id))
    res = client.put(f"/api/sets/{set_id}", json={"name": "D", "revision": 2 ** 53 + 1})
    assert res.status_code == 400
