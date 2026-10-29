"""Which BPM is shown, and a person's Double BPM / Halve BPM (core/dj/store.py
``set_tempo``, ``POST /api/library/dj/bpm``): the override wins over every
measured value and no later analysis undoes it, the grid follows it (doubled
exactly, halved on the downbeat's beats), only the caller's own library is
touched, and the route is JSON only with a capped body."""

from __future__ import annotations

import json

import pytest
from flask import Flask, g

from core.dj import grid_store, store, worker
from core.dj.grid import GRID_VERSION, phrases_from


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        cur = conn.execute(sql, params)
        rows = cur.fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


@pytest.fixture
def db(tmp_path, monkeypatch):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "bpm.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Tidewater')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Night Ferry EP')")
    for tid, title, owner, enrichment in (("1", "Night Ferry", None, None), ("2", "Low Tide", None, 87.0),
                                          ("3", "Elsewhere", None, None), ("4", "Someone else's", 7, None)):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id, "
                       "bpm) VALUES (?, '10', '1', ?, ?, 300000, ?, ?)",
             (tid, title, f"/music/{tid}.flac", owner, enrichment))
    import core.sample.store as sample_store

    monkeypatch.setattr(sample_store, "get_database", lambda: database)
    return database


def _dj(db, tid, bpm, source="analysis", key="8A"):
    store.save(db, tid, {"bpm": bpm, "bpm_source": source, "musical_key": key, "key_source": "tag",
                         "analyzed_bpm": bpm, "status": "done", "dj_analyzer_version": worker.analyzer_version(),
                         "source_sig": "sig"})


def _result(bpm=87.0, *, bars=16, kind="constant", downbeat=0, sections=(("intro", 0, 8), ("main", 8, 16)),
            first=0.1):
    period = 60.0 / bpm
    n = bars * 4 + downbeat + 1
    beats = [first + i * period * (1 + (0.001 * i / n if kind == "beats" else 0)) for i in range(n)]
    changes = [s[1] for s in sections[1:]]
    return {"version": GRID_VERSION, "status": "done", "kind": kind, "bpm": round(bpm, 2), "period": period,
            "first_beat": first, "first_downbeat": beats[downbeat], "downbeat_index": downbeat,
            "beat_confidence": 0.8, "downbeat_confidence": 0.6, "meter": "4/4", "bars": bars,
            "beats": [round(b, 4) for b in beats] if kind == "beats" else None,
            "phrases": phrases_from(changes, bars), "sections": [[k, a, b, 0.5] for k, a, b in sections],
            "mix_in": [0, 8, 0.6, "intro"], "mix_out": [bars - 8, bars, 0.6, "outro"],
            "analysed_s": 60.0, "truncated": False, "level_db": -9.0}


def _grid(db, tid, **kw):
    grid_store.save_result(db, tid, _result(**kw), source_sig="sig")
    return grid_store.get(db, tid)


def _shown(db, tid):
    return store.lookup(db, [tid])[tid]


# ── which BPM is shown ───────────────────────────────────────────────────────

def test_a_half_time_tag_or_enrichment_takes_the_analysiss_octave_only_with_evidence():
    a = {"bpm": 172.2, "tempo_basis": "backbeat"}
    taken = store.decide(tag_bpm=87, analysis=a)
    assert (taken["bpm"], taken["bpm_source"], taken["analyzed_bpm_basis"]) == (172.2, "analysis", "backbeat")
    enriched = store.decide(enrichment_bpm=70, analysis={"bpm": 140.0, "tempo_basis": "genre"})
    assert (enriched["bpm"], enriched["bpm_source"]) == (140.0, "analysis")
    # the tracker's own fast reading, or the range's, is no evidence: the tag
    # stands (review H1: a boom-bap track tagged 72 that librosa reads at 144)
    for basis in ("kept", "range", None):
        assert store.decide(tag_bpm=72, analysis={"bpm": 143.6, "tempo_basis": basis})["bpm"] == 72.0
    # a tag is never halved, and one that isn't an octave away stands
    assert store.decide(tag_bpm=174, analysis={"bpm": 87.0, "tempo_basis": "kept"})["bpm"] == 174.0
    assert store.decide(tag_bpm=124, analysis={"bpm": 172.0, "tempo_basis": "backbeat"})["bpm_source"] == "tag"
    assert store.decide(tag_bpm=62, analysis={"bpm": 124.0})["bpm_source"] == "tag"  # 124 isn't ambiguous


def test_the_override_then_the_grid_then_the_tag(db):
    _dj(db, "1", 87.0, source="tag")
    assert _shown(db, "1")["bpm"] == 87.0 and _shown(db, "1")["bpm_source"] == "tag"
    _grid(db, "1", bpm=174.0)
    shown = _shown(db, "1")
    # 300: the measured grid wins over the tag, which is kept for the hover
    assert (shown["bpm"], shown["bpm_source"], shown["bpm_tag"]) == (174.0, "grid", 87.0)
    _sql(db, "UPDATE track_grid SET grid_version = ? WHERE track_id = '1'", (GRID_VERSION - 1,))
    assert _shown(db, "1")["bpm_source"] == "tag"  # an old grid waits for the sweep
    _sql(db, "UPDATE track_grid SET grid_version = ? WHERE track_id = '1'", (GRID_VERSION,))
    store.set_tempo(db, ["1"], "halve", profile_id=1, is_admin=True)
    shown = _shown(db, "1")
    assert (shown["bpm"], shown["bpm_source"], shown["bpm_tag"]) == (87.0, "override", 87.0)


def test_browse_and_mixes_well_with_use_the_bpm_shown(db):
    _dj(db, "1", 87.0)
    _grid(db, "1", bpm=174.0)
    _dj(db, "3", 175.0)
    store.save(db, "2", {"musical_key": "8A", "key_source": "tag"})  # BPM from enrichment only (87)
    page = store.browse(db, bpm_min=170, bpm_max=180)
    assert {t["id"] for t in page["tracks"]} == {"1", "3"}
    assert [t["id"] for t in store.browse(db, sort="bpm")["tracks"]][:2] == ["2", "1"]  # 87 (enrichment), 174
    found = store.mixes_with(db, "3")
    assert [(m["id"], m["bpm_relation"]) for m in found["matches"]] == [("1", "same"), ("2", "half")]


# ── Double BPM / Halve BPM ───────────────────────────────────────────────────

def test_double_doubles_what_is_shown_and_the_grid_exactly(db):
    _dj(db, "1", 87.0)
    before = grid_store.grid_of(_grid(db, "1", bpm=87.0, downbeat=1))
    out = store.set_tempo(db, ["1", "1", "nope"], "double", profile_id=3, is_admin=True)
    assert out == {"changed": {"1": 174.0}, "skipped": {}, "found": 1}
    row = store.get(db, "1")
    assert (row["bpm_override"], row["bpm_override_by"]) == (174.0, 3) and row["bpm"] == 87.0
    after = grid_store.get(db, "1")
    grid = grid_store.grid_of(after)
    assert after["bpm"] == 174.0 and after["bars"] == 32 and after["downbeat_index"] == 2
    for i in range(0, 60, 3):
        assert grid.beat(2 * i) == pytest.approx(before.beat(i), abs=1e-6)
        assert grid.beat(2 * i + 1) == pytest.approx(before.beat(i + 0.5), abs=1e-6)
    for b in range(16):
        assert grid.bar(2 * b) == pytest.approx(before.bar(b), abs=1e-6)
    assert json.loads(after["sections_json"]) == [["intro", 0, 16, 0.5], ["main", 16, 32, 0.5]]
    # a doubled grid's ÷2 keeps the measured beats, the even ones (grid v5's third review, L4)
    assert json.loads(after["mix_json"]) == {"in": [0, 16, 0.6, "intro"], "out": [16, 32, 0.6, "outro"], "half": 0}
    assert json.loads(after["phrases_json"]) == phrases_from([16], 32)
    public = grid_store.public(after, "1")
    assert public["bpm"] == 174.0 and public["sections"][1]["start"] == pytest.approx(before.bar(8), abs=1e-3)


_EXACT = ("bpm", "period", "first_beat", "downbeat_index", "first_downbeat", "bars", "beats_ms", "phrases_json",
          "sections_json", "mix_json", "measured_json")


@pytest.mark.parametrize("kind", ("constant", "beats"))
@pytest.mark.parametrize("downbeat", (0, 1, 2, 3))
@pytest.mark.parametrize("changes", ((8, 24), (9, 25), (9, 24)))
def test_halve_then_double_gives_the_measured_grid_back_exactly(db, kind, downbeat, changes):
    # review M2: every rescale is worked out from the grid as measured (kept
    # beside it), never from an earlier rescale, so odd section changes and
    # an odd downbeat come back exactly
    _dj(db, "1", 174.0)
    sections = (("intro", 0, changes[0]), ("main", changes[0], changes[1]), ("outro", changes[1], 32))
    original = _grid(db, "1", bpm=174.0, kind=kind, downbeat=downbeat, bars=32, sections=sections)
    for steps in (("halve", "double"), ("halve", "reset"), ("halve", "halve", "double", "double")):
        for action in steps:
            store.set_tempo(db, ["1"], action, profile_id=1, is_admin=True)
        back = grid_store.get(db, "1")
        assert {k: back[k] for k in _EXACT} == {k: original[k] for k in _EXACT}, steps
        store.set_tempo(db, ["1"], "reset", profile_id=1, is_admin=True)
    half = (store.set_tempo(db, ["1"], "halve", profile_id=1, is_admin=True), grid_store.get(db, "1"))[1]
    assert half["bpm"] == pytest.approx(87.0, abs=0.01) and half["measured_json"]
    # the one stays on a bar line: bar 0's, or bar 1's when the bars pair
    # from there (most section changes on odd bars)
    pair_from = 1 if sum(c % 2 for c in changes) > len(changes) / 2 else 0
    assert half["first_downbeat"] == pytest.approx(grid_store.grid_of(original).bar(pair_from), abs=2e-3)
    if kind == "beats":
        parity = downbeat % 2
        assert grid_store.decode_beats(half["beats_ms"]) == grid_store.decode_beats(original["beats_ms"])[parity::2]


def test_halving_pairs_the_bars_so_section_changes_stay_on_a_bar_line(db):
    _dj(db, "1", 174.0)
    old = grid_store.grid_of(_grid(db, "1", bpm=174.0, bars=33, sections=(("intro", 0, 9), ("main", 9, 33))))
    store.set_tempo(db, ["1"], "halve", profile_id=1, is_admin=True)
    row = grid_store.get(db, "1")
    new = grid_store.grid_of(row)
    assert json.loads(row["sections_json"]) == [["intro", 0, 4, 0.5], ["main", 4, 16, 0.5]]
    assert new.bar(4) == pytest.approx(old.bar(9), abs=1e-6)  # the change at bar 9 is new bar 4's line
    assert row["bars"] == 16


def test_what_cant_be_changed_is_said(db):
    _dj(db, "1", 160.0)
    out = store.set_tempo(db, ["1", "3"], "double", profile_id=1, is_admin=True)
    assert out["skipped"] == {"1": "out_of_range", "3": "no_bpm"} and out["changed"] == {}
    assert store.set_tempo(db, ["1"], "reset", profile_id=1, is_admin=True)["skipped"] == {"1": "not_set"}
    # a track analysis hasn't reached yet doubles what enrichment found, and keeps it
    assert store.set_tempo(db, ["2"], "double", profile_id=1, is_admin=True)["changed"] == {"2": 174.0}
    assert store.pending_ids(db, worker.analyzer_version()) == ["2", "3", "4"]  # still analysed
    with pytest.raises(ValueError):
        store.set_tempo(db, ["1"], "triple", is_admin=True)


def test_reset_puts_the_measured_grid_back_without_a_decode(db):
    # review M4: no requeue, so no gap with no grid (or for ever, analysis off)
    _dj(db, "1", 87.0)
    measured = _grid(db, "1", bpm=87.0, downbeat=1, sections=(("intro", 0, 9), ("main", 9, 16)))
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    assert grid_store.get(db, "1")["bpm"] == pytest.approx(174.0)
    assert store.set_tempo(db, ["1"], "reset", profile_id=1, is_admin=True)["changed"] == {"1": None}
    assert store.get(db, "1")["bpm_override"] is None
    assert _shown(db, "1")["bpm"] == 87.0 and _shown(db, "1")["bpm_source"] == "grid"
    back = grid_store.get(db, "1")
    assert {k: back[k] for k in _EXACT} == {k: measured[k] for k in _EXACT}
    assert back["grid_version"] == GRID_VERSION and "1" not in grid_store.pending_ids(db, worker.analyzer_version())


def test_a_grid_that_isnt_an_octave_of_the_persons_bpm_isnt_mixed_on(db):
    # review L6: the BPM shown is the person's; the planner doesn't beat-match
    # a grid that disagrees with it
    from core.dj import planner

    _dj(db, "1", 87.0)
    _dj(db, "3", 124.0)
    _grid(db, "3", bpm=124.0)
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)  # 174, before any grid
    _grid(db, "1", bpm=120.0)  # a later analysis finds another tempo altogether
    assert _shown(db, "1")["bpm"] == 174.0 and _shown(db, "1")["bpm_source"] == "override"
    found = grid_store.scoped_rows(db, ["1", "3"])
    shaped = grid_store.public_entry(found["1"], "1")
    assert shaped == {"track_id": "1", "analyzed": False, "reason": "bpm_mismatch"}
    out_t = {**shaped, "bpm": found["1"]["bpm"], "title": "Night Ferry"}
    in_t = {**grid_store.public_entry(found["3"], "3"), "bpm": 124.0, "title": "Elsewhere"}
    plan = planner.plan(out_t, in_t)
    assert plan["status"] == "play_on" and plan["fallback"]["code"] == "bpm_mismatch"
    assert "set by hand" in plan["why"]


@pytest.mark.gauntlet
@pytest.mark.parametrize("action,want", (("double", 174.0), ("reset", 87.0)))
def test_a_change_during_a_grid_save_is_never_lost(db, monkeypatch, action, want):
    # review L5: the person's BPM is read and the grid written in one
    # transaction; a ×2 (or a reset) sent while the sweep saves a grid waits
    # for it and then applies to the grid just saved
    import threading

    _dj(db, "1", 87.0)
    if action == "reset":
        _grid(db, "1", bpm=87.0)
        store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    real = grid_store.follow_override
    seen = {}

    def during_the_save(row, target):
        thread = threading.Thread(target=lambda: seen.update(out=store.set_tempo(db, ["1"], action, profile_id=1, is_admin=True)))
        thread.start()
        thread.join(0.5)
        seen["waited"] = thread.is_alive()  # the change waits for the save's transaction
        seen["thread"] = thread
        return real(row, target)

    monkeypatch.setattr(grid_store, "follow_override", during_the_save)
    grid_store.save_result(db, "1", _result(bpm=87.0), source_sig="sig")
    seen["thread"].join(10)
    monkeypatch.setattr(grid_store, "follow_override", real)
    assert seen["waited"] and seen["out"]["changed"]
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(want, abs=0.01)
    assert _shown(db, "1")["bpm"] == pytest.approx(want, abs=0.01)


@pytest.mark.gauntlet
def test_a_grid_saved_after_a_change_follows_it(db):
    # the other order: the change first, then the sweep's save
    _dj(db, "1", 87.0)
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    grid_store.save_result(db, "1", _result(bpm=87.0), source_sig="sig")
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(174.0) and json.loads(row["measured_json"])["bpm"] == 87.0
    store.set_tempo(db, ["1"], "reset", profile_id=1, is_admin=True)
    assert grid_store.get(db, "1")["bpm"] == pytest.approx(87.0)


@pytest.mark.gauntlet
def test_no_later_analysis_undoes_a_persons_bpm(db, tmp_path):
    from .audio_fixtures import dj_track, write_flac

    path = write_flac(tmp_path / "2.flac", dj_track(174, 9, True, seconds=2))
    store.set_tempo(db, ["2"], "double", profile_id=1, is_admin=True)  # enrichment's 87, doubled before any analysis
    found = {}

    def grid_at_half_time(p, *, audio=None, bpm_hint=None):
        found["hint"] = bpm_hint
        return _result(bpm=87.0)

    analysis = {"bpm": 86.1, "onsets": [], "duration_s": 2.0, "key": {"name": "A minor", "confidence": 0.9},
                "energy": 6, "analyzer_version": worker.analyzer_version(), "truncated": False}
    out = worker.process_track(db, "2", resolve=lambda p: path, analyze=lambda p: dict(analysis),
                               analyze_grid=grid_at_half_time, write_tags=True,
                               library_roots=lambda: [str(tmp_path)])
    assert out == "tagged"
    from core.dj.tags import read_dj_tags

    assert read_dj_tags(path)["bpm"] == 174  # the person's BPM goes into the file, not the measured 86
    shown = _shown(db, "2")
    assert (shown["bpm"], shown["bpm_source"]) == (174.0, "override")
    row = grid_store.get(db, "2")
    assert row["bpm"] == pytest.approx(174.0) and row["bars"] == 32  # the half-time grid was doubled
    # the sweep's top-up (a new grid version) keeps it too
    _sql(db, "UPDATE track_grid SET grid_version = 0")
    worker.process_track(db, "2", resolve=lambda p: path, analyze_grid=grid_at_half_time)
    assert grid_store.get(db, "2")["bpm"] == pytest.approx(174.0)
    assert store.get(db, "2")["bpm_override"] == 174.0


# ── the route ────────────────────────────────────────────────────────────────

@pytest.fixture
def client(db, monkeypatch):
    import api.dj as dj_api
    import core.profile_context as pc
    from core.library_scope import reset_library_scope, set_library_scope

    for tid, bpm in (("1", 87.0), ("3", 172.0), ("4", 86.0)):
        _dj(db, tid, bpm)
    from core.dj import ondemand

    dj_api.configure(get_database_=lambda: db)
    monkeypatch.setattr(dj_api, "_BPM_LIMIT", ondemand.RateLimit(every=0))
    state = {"profile": 2, "admin": False, "scope": "shared"}
    monkeypatch.setattr(pc, "is_admin_request", lambda: state["admin"])
    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        if state["profile"] is not None:
            g.profile_id = state["profile"]
        tokens.append(set_library_scope(state["scope"]))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    app.register_blueprint(dj_api.create_blueprint())
    c = app.test_client()
    c.state = state
    return c


def _post(client, **body):
    return client.post("/api/library/dj/bpm", json=body)


def test_double_and_halve_through_the_route(client, db):
    client.state["admin"] = True
    res = _post(client, track_ids=["1", "3"], action="double")
    body = res.get_json()
    assert res.status_code == 200 and body["success"]
    assert body["changed"] == {"1": 174.0} and body["skipped"] == {"3": "out_of_range"}
    assert body["tracks"]["1"]["bpm"] == 174.0 and body["tracks"]["1"]["bpm_source"] == "override"
    assert res.headers["Cache-Control"] == "no-store"
    assert _post(client, track_ids=["1"], action="halve").get_json()["changed"] == {"1": 87.0}
    assert _post(client, track_ids=["1"], action="reset").get_json()["changed"] == {"1": None}


@pytest.mark.gauntlet
def test_a_member_changes_only_their_own_librarys_tracks(client, db):
    # review L3: the override is per track, for everyone: a shared track's is
    # an admin's to set; a member sets their own library's
    res = _post(client, track_ids=["1"], action="double")
    assert res.status_code == 403 and res.get_json()["code"] == "shared"
    assert "admin" in res.get_json()["error"] and store.get(db, "1")["bpm_override"] is None
    assert _post(client, track_ids=["4"], action="double").status_code == 404  # not in their scope at all
    # profile 7 on its own library changes track 4 and can't reach the shared ones
    client.state.update(profile=7, scope=7)
    assert _post(client, track_ids=["1"], action="reset").status_code == 404
    assert _post(client, track_ids=["4"], action="double").get_json()["changed"] == {"4": 172.0}
    # an admin changes a shared track
    client.state.update(profile=1, scope="shared", admin=True)
    assert _post(client, track_ids=["1"], action="double").get_json()["changed"] == {"1": 174.0}
    # a mixed batch (everything in scope): a member's own is changed, a shared one said
    from core.library_scope import reset_library_scope, set_library_scope

    token = set_library_scope(None)
    try:
        out = store.set_tempo(db, ["1", "4"], "halve", profile_id=7, is_admin=False)
        assert out["changed"] == {"4": 86.0} and out["skipped"] == {"1": "shared"}
        assert store.set_tempo(db, ["4"], "reset", profile_id=2, is_admin=False)["skipped"] == {"4": "not_yours"}
    finally:
        reset_library_scope(token)


@pytest.mark.gauntlet
def test_the_route_allows_one_change_a_second(client, monkeypatch):
    # review L4, as /analyse
    import api.dj as dj_api
    from core.dj import ondemand

    client.state["admin"] = True
    monkeypatch.setattr(dj_api, "_BPM_LIMIT", ondemand.RateLimit(every=1.0))
    assert _post(client, track_ids=["1"], action="double").status_code == 200
    res = _post(client, track_ids=["1"], action="halve")
    assert res.status_code == 429 and res.headers["Retry-After"] == "1"
    assert res.get_json()["code"] == "rate_limited"


@pytest.mark.gauntlet
def test_the_route_takes_json_only_with_a_capped_body(client, monkeypatch):
    form = client.post("/api/library/dj/bpm", data={"track_ids": "1", "action": "double"})
    assert form.status_code == 400
    plain = client.post("/api/library/dj/bpm", data=json.dumps({"track_ids": ["1"], "action": "double"}),
                        content_type="text/plain")
    assert plain.status_code == 400
    big = client.post("/api/library/dj/bpm", data=b'{"track_ids": ["' + b"1" * 70000 + b'"], "action": "double"}',
                      content_type="application/json")
    assert big.status_code == 413
    assert _post(client, track_ids=["1"], action="triple").status_code == 400
    assert _post(client, track_ids="1", action="double").status_code == 400
    assert _post(client, track_ids=[], action="double").status_code == 400
    assert _post(client, track_ids=[str(i) for i in range(501)], action="double").status_code == 400
    assert _post(client, track_ids=[True], action="double").status_code == 404
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert _post(client, track_ids=["1"], action="double").status_code == 401


@pytest.mark.gauntlet
def test_a_reset_after_the_tag_was_written_really_goes_back_to_the_measured_bpm(db, tmp_path):
    # review N2: with "Write BPM and key into files" on, a doubled track's
    # file gets the person's 174; after "Use the measured BPM" the next
    # analysis must not read that tag back as the file's own
    from core.dj.tags import read_dj_tags, write_dj_tags

    from .audio_fixtures import dj_track, write_flac

    path = write_flac(tmp_path / "2.flac", dj_track(174, 9, True, seconds=2))
    hints = []

    def grid(p, *, audio=None, bpm_hint=None):
        hints.append(bpm_hint)
        return _result(bpm=87.0)

    analysis = {"bpm": 86.1, "onsets": [], "duration_s": 2.0, "key": {"name": "A minor", "confidence": 0.9},
                "energy": 6, "analyzer_version": worker.analyzer_version(), "truncated": False,
                "tempo_basis": "kept"}

    def analyse_again():
        _sql(db, "UPDATE track_dj SET dj_analyzer_version = 0 WHERE track_id = '2'")
        return worker.process_track(db, "2", resolve=lambda p: path, analyze=lambda p: dict(analysis),
                                    analyze_grid=grid, write_tags=True, library_roots=lambda: [str(tmp_path)])

    store.set_tempo(db, ["2"], "double", profile_id=1, is_admin=True)  # enrichment's 87 -> 174
    assert analyse_again() == "tagged"
    assert read_dj_tags(path)["bpm"] == 174 and store.get(db, "2")["bpm_tag_written"] == 174.0
    store.set_tempo(db, ["2"], "reset", profile_id=1, is_admin=True)
    assert _shown(db, "2")["bpm"] == pytest.approx(87.0)
    # the next whole analysis (a new version, a changed file) reads the file again
    analyse_again()
    row = store.get(db, "2")
    assert row["bpm"] != 174.0 and row["bpm_source"] != "tag"
    assert hints[-1] != 174.0  # the grid looked near the measured tempo
    assert _shown(db, "2")["bpm"] == pytest.approx(87.0) and _shown(db, "2")["bpm_source"] == "grid"
    # a BPM someone else puts in the file afterwards is the file's own again
    write_dj_tags(path, bpm=140, key_name=None, overwrite=True)
    analyse_again()
    assert (store.get(db, "2")["bpm"], store.get(db, "2")["bpm_source"]) == (140.0, "tag")


def test_set_tempo_says_who_is_asking(db):
    # review N4: no default that makes a caller an admin
    with pytest.raises(TypeError):
        store.set_tempo(db, ["1"], "double", profile_id=1)


def test_sample_studios_row_keeps_the_tempos_basis(db):
    # review N1: the DJ data reusing Sample Studio's analysis keeps the evidence
    from core.sample import store as sample_store

    sample_store.save_analysis("1", {"bpm": 172.2, "onsets": [], "duration_s": 60.0, "energy": 7,
                                     "key": {"name": "A minor", "confidence": 0.9}, "tempo_basis": "backbeat",
                                     "analyzer_version": worker.analyzer_version()}, source_sig="sig")
    row = worker._reuse_sample_analysis("1", "sig", worker.analyzer_version())
    assert row["tempo_basis"] == "backbeat"
    assert store.decide(enrichment_bpm=87.0, analysis=row)["bpm"] == 172.2


def test_a_grid_held_under_the_bar_doesnt_set_the_bpm_shown(db):
    # grid v5's review (H2): a held grid may be at the wrong octave (hip hop
    # at 85 read at 170), so the DJ data's BPM stands until one is ready
    _dj(db, "1", 87.0, source="tag")
    grid_store.save_result(db, "1", {**_result(bpm=174.0), "beat_confidence": 0.45}, source_sig="sig")
    assert (_shown(db, "1")["bpm"], _shown(db, "1")["bpm_source"]) == (87.0, "tag")
    _sql(db, "UPDATE track_grid SET beat_confidence = 0.5 WHERE track_id = '1'")
    assert (_shown(db, "1")["bpm"], _shown(db, "1")["bpm_source"]) == (174.0, "grid")


@pytest.mark.parametrize("kind", ["constant", "beats"])
def test_halving_keeps_the_louder_parity_the_analysis_found(db, kind):
    # grid v5's review (L6): halving on the downbeat's beats kept a Groove hip
    # hop track's hats when its downbeat was a beat off; the analysis keeps
    # which parity is louder (``half_parity``) and halving takes it
    _dj(db, "1", 174.0)
    original = _grid(db, "1", bpm=174.0, kind=kind, downbeat=0, bars=32,
                     sections=(("intro", 0, 8), ("main", 8, 32)))
    grid_store.save_result(db, "1", {**_result(bpm=174.0, kind=kind, downbeat=0, bars=32,
                                               sections=(("intro", 0, 8), ("main", 8, 32))), "half_parity": 1},
                           source_sig="sig")
    store.set_tempo(db, ["1"], "halve", profile_id=1, is_admin=True)
    half = grid_store.get(db, "1")
    period = float(original["period"])
    assert half["first_beat"] == pytest.approx(float(original["first_beat"]) + period, abs=2e-3)
    if kind == "beats":
        assert grid_store.decode_beats(half["beats_ms"]) == grid_store.decode_beats(original["beats_ms"])[1::2]
    # and back: doubling works from the measured grid, the parity kept with it
    store.set_tempo(db, ["1"], "reset", profile_id=1, is_admin=True)
    assert json.loads(grid_store.get(db, "1")["mix_json"])["half"] == 1


# ── grid v5's second review: a person's octave releases the octave's hold ───

def _held_for_octave(bpm=87.0, octave=None):
    octave = octave or {"1": 0.74, "2": 0.71, "0.5": 0.45}
    return {**_result(bpm=bpm, bars=32, sections=(("intro", 0, 8), ("main", 8, 32))), "beat_confidence": 0.45,
            "octave_confidence": octave}


def test_one_double_releases_a_grid_held_for_its_octave(db):
    # untagged drum and bass read 87 (or held at 174): its ×2 moved the grid
    # but left it held, and the planner and Analyse go by the confidence
    _dj(db, "1", 87.0, source="tag")
    grid_store.save_result(db, "1", _held_for_octave(87.0), source_sig="sig")
    assert grid_store.get(db, "1")["beat_confidence"] == 0.45
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(174.0, abs=0.01) and row["beat_confidence"] == pytest.approx(0.71)
    assert _shown(db, "1")["bpm"] == 174.0
    # reset: the measured grid and its measured confidence come back
    store.set_tempo(db, ["1"], "reset", profile_id=1, is_admin=True)
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(87.0, abs=0.01) and row["beat_confidence"] == 0.45
    # halve then double back to the measured tempo: a person's BPM at the
    # measured octave settles it as well
    store.set_tempo(db, ["1"], "halve", profile_id=1, is_admin=True)
    assert grid_store.get(db, "1")["beat_confidence"] == pytest.approx(0.45)
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(87.0, abs=0.01) and row["beat_confidence"] == pytest.approx(0.74)


def test_a_new_analysis_under_a_persons_bpm_takes_the_chosen_octaves_confidence(db):
    _dj(db, "1", 87.0, source="tag")
    grid_store.save_result(db, "1", _held_for_octave(87.0), source_sig="sig")
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    grid_store.save_result(db, "1", _held_for_octave(87.0, {"1": 0.7, "2": 0.66}), source_sig="sig")
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(174.0, abs=0.01) and row["beat_confidence"] == pytest.approx(0.66)


def test_an_older_grid_without_octave_confidences_keeps_its_confidence(db):
    _dj(db, "1", 87.0, source="tag")
    grid_store.save_result(db, "1", {**_result(bpm=87.0), "beat_confidence": 0.45}, source_sig="sig")
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    assert grid_store.get(db, "1")["beat_confidence"] == 0.45


def test_a_grid_held_only_for_its_octave_shows_its_bpm_unless_the_dj_datas_is_an_octave_of_it(db):
    # the second review: untagged drum and bass held at 174 showed the
    # analysis's 117.5, whose ×2 (235) nobody wants
    _dj(db, "1", 117.5)
    grid_store.save_result(db, "1", _held_for_octave(174.0, {"1": 0.74, "0.5": 0.45}), source_sig="sig")
    assert (_shown(db, "1")["bpm"], _shown(db, "1")["bpm_source"]) == (174.0, "grid")
    # at an octave of the DJ data's BPM, that one shows: a ×2 or ÷2 from it
    # lands on the octave a person chooses
    _dj(db, "2", 87.0, source="tag")
    grid_store.save_result(db, "2", _held_for_octave(174.0, {"1": 0.74, "0.5": 0.45}), source_sig="sig")
    assert (_shown(db, "2")["bpm"], _shown(db, "2")["bpm_source"]) == (87.0, "tag")
    # held for anything else (no tracker agreeing): never shown
    _dj(db, "3", 117.5)
    grid_store.save_result(db, "3", _held_for_octave(174.0, {"1": 0.45}), source_sig="sig")
    assert _shown(db, "3")["bpm"] == 117.5


# ── grid v5's third review: "BPM is right", and every octave-tied cap ────────

def test_bpm_is_right_releases_a_grid_held_for_its_octave_in_one_press(db):
    # M1: shown 174 (the DJ data said 117.5), ×2 out of range: before, only
    # ÷2 then ×2 released it
    _dj(db, "1", 117.5)
    grid_store.save_result(db, "1", _held_for_octave(174.0, {"1": 0.91, "0.5": 0.45}), source_sig="sig")
    shown = _shown(db, "1")
    assert (shown["bpm"], shown["bpm_unsure"]) == (174.0, True)
    out = store.set_tempo(db, ["1"], "confirm", profile_id=1, is_admin=True)
    assert out["changed"] == {"1": 174.0}
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(174.0, abs=0.01) and row["beat_confidence"] == pytest.approx(0.91)
    shown = _shown(db, "1")
    assert (shown["bpm"], shown["bpm_source"], shown["bpm_unsure"]) == (174.0, "override", False)
    # and "Use the measured BPM" puts the hold back
    store.set_tempo(db, ["1"], "reset", profile_id=1, is_admin=True)
    assert grid_store.get(db, "1")["beat_confidence"] == 0.45 and _shown(db, "1")["bpm_unsure"]


def test_bpm_is_right_at_the_other_octave_shown_takes_that_octave(db):
    # the DJ data's 87 shows (an octave of the held 174): "BPM is right" there
    # settles the grid at 87
    _dj(db, "1", 87.0, source="tag")
    grid_store.save_result(db, "1", _held_for_octave(174.0, {"1": 0.91, "0.5": 0.62}), source_sig="sig")
    assert _shown(db, "1")["bpm"] == 87.0
    store.set_tempo(db, ["1"], "confirm", profile_id=1, is_admin=True)
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(87.0, abs=0.01) and row["beat_confidence"] == pytest.approx(0.62)


def test_a_ready_grid_or_one_held_for_its_beats_isnt_unsure(db):
    _dj(db, "1", 87.0)
    _grid(db, "1", bpm=87.0)
    assert _shown(db, "1")["bpm_unsure"] is False
    _dj(db, "2", 117.5)
    grid_store.save_result(db, "2", _held_for_octave(174.0, {"1": 0.45}), source_sig="sig")
    assert _shown(db, "2")["bpm_unsure"] is False


def test_bpm_is_right_through_the_route(client, db):
    client.state["admin"] = True
    res = _post(client, track_ids=["1"], action="confirm")
    assert res.status_code == 200 and res.get_json()["changed"] == {"1": 87.0}
    bad = _post(client, track_ids=["1"], action="pin")
    assert bad.status_code == 400 and "confirm" in bad.get_json()["error"]


def test_a_broken_mix_json_never_breaks_the_bpm_shown(db):
    # L3: json_extract on text that isn't JSON raises in SQLite
    _dj(db, "1", 117.5)
    grid_store.save_result(db, "1", _held_for_octave(174.0), source_sig="sig")
    _sql(db, "UPDATE track_grid SET mix_json = 'not json' WHERE track_id = '1'")
    assert _shown(db, "1")["bpm"] == 117.5


def test_a_rescaled_grid_keeps_each_octaves_confidence_and_after_a_double_its_halving_beats(db):
    # L4
    _dj(db, "1", 87.0, source="tag")
    grid_store.save_result(db, "1", {**_held_for_octave(87.0), "half_parity": 1}, source_sig="sig")
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    mix = json.loads(grid_store.get(db, "1")["mix_json"])
    assert mix["octave"] == {"1": 0.74, "2": 0.71, "0.5": 0.45} and mix["half"] == 0
    store.set_tempo(db, ["1"], "reset", profile_id=1, is_admin=True)
    store.set_tempo(db, ["1"], "halve", profile_id=1, is_admin=True)
    assert "half" not in json.loads(grid_store.get(db, "1")["mix_json"])


def test_a_grid_held_at_half_whose_double_is_ready_shows_its_bpm_so_one_double_fixes_it(db):
    # a real Amen at 170 read at 85 under an analysis's 117.5 showed 117.5:
    # its ×2 was 235, and no press reached 170 (grid v5's third review)
    _dj(db, "1", 117.5)
    grid_store.save_result(db, "1", _held_for_octave(85.0, {"1": 0.45, "2": 0.8, "0.5": 0.45}), source_sig="sig")
    assert _shown(db, "1")["bpm"] == 85.0 and _shown(db, "1")["bpm_unsure"] is False
    store.set_tempo(db, ["1"], "double", profile_id=1, is_admin=True)
    row = grid_store.get(db, "1")
    assert row["bpm"] == pytest.approx(170.0, abs=0.01) and row["beat_confidence"] == pytest.approx(0.8)
