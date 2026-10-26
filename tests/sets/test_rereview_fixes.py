"""The second gauntlet review of Sets 1 (HANDOFF, "Dev, Sets 1 of 24 October",
After the second review): each finding's regression test."""

from __future__ import annotations

import threading
import time
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


# ── Low 2: pacing can't tie up workers ───────────────────────────────────────

def _fake_openers(monkeypatch, opened):
    def open_discogs(key):
        opened.append(key)
        return {"found": True, "source": "discogs", "id": key, "title": f"Mix {key}", "lines": []}

    monkeypatch.setitem(sources._OPENERS, "discogs", open_discogs)


@pytest.mark.gauntlet
def test_uncached_opens_count_against_the_profiles_budget(client, cfg, monkeypatch):
    cfg.data["discogs.token"] = "tok"
    opened = []
    _fake_openers(monkeypatch, opened)
    monkeypatch.setitem(sources.PER_PROFILE, "discogs", 2)
    assert sources.open_mix("discogs", "1", profile_id=1)["found"]
    assert sources.open_mix("discogs", "2", profile_id=1)["found"]
    with pytest.raises(sources.SourceBusy) as busy:
        sources.open_mix("discogs", "3", profile_id=1)
    assert busy.value.why == "profile" and opened == ["1", "2"]
    # a cached open costs nothing; another profile has its own budget
    assert sources.open_mix("discogs", "1", profile_id=1)["found"]
    assert sources.open_mix("discogs", "3", profile_id=2)["found"]
    assert opened == ["1", "2", "3"]
    # the route says so with a 429
    res = client.post("/api/sets/famous/open", json={"source": "discogs", "id": "4"})
    assert res.status_code == 429
    assert res.get_json()["limited"] == "discogs" and res.get_json()["why"] == "profile"


def test_searches_and_opens_share_one_budget(cfg, monkeypatch):
    cfg.data["discogs.token"] = "tok"
    _fake_openers(monkeypatch, [])
    monkeypatch.setitem(sources._SEARCHERS, "discogs", lambda q: [])
    monkeypatch.setattr(sources, "_mb_client", type("MB", (), {"search_dj_mixes": lambda self, q, limit=8: []})())
    monkeypatch.setitem(sources.PER_PROFILE, "discogs", 2)
    assert sources.search("fabric", profile_id=1)["sources"]["discogs"]["state"] == "ok"
    assert sources.open_mix("discogs", "1", profile_id=1)["found"]
    with pytest.raises(sources.SourceBusy):
        sources.open_mix("discogs", "2", profile_id=1)
    assert sources.search("fabric 2", profile_id=1)["sources"]["discogs"] == {"state": "limited", "why": "profile"}


@pytest.mark.gauntlet
def test_a_fourth_waiter_is_refused_at_once(monkeypatch):
    """While one request holds a source and MAX_WAITERS wait for it, one
    more doesn't queue (and hold a worker for LOCK_WAIT): it's SourceBusy."""
    monkeypatch.setattr(sources, "LOCK_WAIT", 3.0)
    monkeypatch.setattr(sources, "MIN_INTERVAL", {"mixesdb": 0.0, "discogs": 0.0})
    holder = sources._turn("mixesdb")
    results = []

    def wait_turn():
        try:
            sources._turn("mixesdb").release()
            results.append("got it")
        except sources.SourceDown as exc:
            results.append(type(exc).__name__)

    waiters = [threading.Thread(target=wait_turn) for _ in range(sources.MAX_WAITERS)]
    for t in waiters:
        t.start()
    deadline = time.monotonic() + 2
    while sources._waiting["mixesdb"] < sources.MAX_WAITERS and time.monotonic() < deadline:
        time.sleep(0.01)
    assert sources._waiting["mixesdb"] == sources.MAX_WAITERS
    started = time.monotonic()
    with pytest.raises(sources.SourceBusy) as busy:
        sources._turn("mixesdb")
    assert busy.value.why == "busy" and time.monotonic() - started < 0.5
    holder.release()
    for t in waiters:
        t.join(5)
    assert results == ["got it"] * sources.MAX_WAITERS
    assert sources._waiting["mixesdb"] == 0


def test_a_busy_source_says_so_in_a_search(cfg, monkeypatch):
    cfg.data[sources.SETTING_MIXESDB] = True
    monkeypatch.setattr(sources, "MAX_WAITERS", 0)
    monkeypatch.setattr(sources, "_mb_client", type("MB", (), {"search_dj_mixes": lambda self, q, limit=8: []})())
    found = sources.search("fabric", profile_id=1)
    assert found["sources"]["mixesdb"] == {"state": "limited", "why": "busy"}


@pytest.mark.gauntlet
def test_the_deadline_covers_the_wait_for_headers(monkeypatch):
    """A source that takes its time before the first byte (each wait just
    inside the read timeout) is still held to the whole deadline."""
    seen = []

    class Quick:
        status_code = 200

        def iter_content(self, size):
            yield b"{}"

        def close(self):
            pass

    def slow_headers(url, **kwargs):
        seen.append(kwargs["timeout"])
        time.sleep(0.3)
        return Quick()

    monkeypatch.setattr(sources, "_http_get", slow_headers)
    monkeypatch.setattr(sources, "TOTAL_DEADLINE", 0.2)
    monkeypatch.setattr(sources, "MIN_INTERVAL", {"mixesdb": 0.0, "discogs": 0.0})
    with pytest.raises(sources.SourceDown, match="too long"):
        sources._get_json("mixesdb", sources.MIXESDB_API, {})
    connect, read = seen[0]
    assert connect <= 0.2 and read <= 0.2
