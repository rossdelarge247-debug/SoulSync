"""The pieces around radio: the built-in list, Setup check's rows, the trigger
in the block editor and the Assistant's validator, the Wanted payload, the
fingerprint mapping and the tables."""

from __future__ import annotations

import json

import pytest

from core.internet_radio import fingerprint, setup_rows, stations, wanted
from core.setup_check import make_result


def test_the_built_in_list_is_valid_and_sourced():
    data = json.load(open(stations.DATA_FILE, encoding="utf-8"))
    parsed = stations.builtin_stations()
    assert len(parsed) == len(data["stations"]), "every entry parses"
    kinds = {s.kind for s in parsed}
    assert kinds == set(stations.KINDS)
    for s in parsed:
        assert s.note, f"{s.id} says where its addresses came from"
        assert s.streams and all(x.url.startswith(("https://", "http://")) for x in s.streams)
        if s.now_playing:
            assert s.now_playing["type"] in ("somafm", "radioparadise", "kexp", "nts", "radiofrance")
        assert "<" not in s.description, "descriptions are plain text"
    lossless = [s.id for s in parsed if any(x.lossless for x in s.streams)]
    assert "rp-main" in lossless  # Radio Paradise's FLAC stream


def test_a_bad_entry_is_skipped_not_fatal():
    out = stations.parse_builtin({"stations": [
        {"id": "ok-one", "name": "OK", "kind": "world", "streams": [{"url": "https://x.example.com/s"}], "source": "x"},
        {"id": "Bad Id", "name": "Bad", "kind": "world", "streams": [{"url": "https://x.example.com/s"}]},
        {"id": "no-stream", "name": "No", "kind": "world", "streams": [{"url": "javascript:alert(1)"}]},
        {"id": "rb-sneaky", "name": "Sneaky", "kind": "world", "streams": [{"url": "https://x.example.com/s"}]},
    ]})
    assert [s.id for s in out] == ["ok-one"]


def test_streams_order_and_labels():
    st = stations.builtin_station("rp-main")
    assert stations.ordered_streams(st, True)[0].codec == "FLAC"
    assert stations.ordered_streams(st, False)[0].codec == "AAC"
    pub = stations.public_station(st)
    assert pub["streams"][0]["label"] == "FLAC lossless (best offered)"
    assert pub["quality"]["lossless"] is True


def test_setup_rows():
    ok = setup_rows.check_fpcalc(make_result, finder=lambda: "/usr/bin/fpcalc")
    assert ok["id"] == "radio.fpcalc" and ok["status"] == "ok" and ok["category"] == "radio"
    assert setup_rows.check_fpcalc(make_result, finder=lambda: None, key_set=True)["status"] == "warning"
    assert setup_rows.check_fpcalc(make_result, finder=lambda: None, key_set=False)["status"] == "skipped"
    assert setup_rows.check_acoustid(make_result, "", network=True)["status"] == "skipped"
    assert setup_rows.check_acoustid(make_result, "k", network=False)["status"] == "ok"
    assert setup_rows.check_acoustid(make_result, "k", network=True, tester=lambda k: (True, "valid"))["status"] == "ok"
    refused = setup_rows.check_acoustid(make_result, "k", network=True,
                                        tester=lambda k: (False, "Invalid AcoustID API key"))
    assert refused["status"] == "error" and setup_rows.last("radio.acoustid")["status"] == "error"


def test_setup_check_shows_radio_rows_only_while_the_module_is_on(tmp_path):
    from core import setup_check as sc
    cfg = {"soulseek": {"download_path": str(tmp_path), "transfer_path": str(tmp_path)}}

    def get(key, default=None):
        node = cfg
        for part in key.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node
    ctx = sc.SetupCheckContext(get=get, read_mountinfo=None)
    ids = [t.id for t in sc._tasks(ctx, False)[0]]
    assert "radio.fpcalc" in ids and "radio.acoustid" in ids
    cfg["modules"] = {"radio": {"enabled": False}}
    ids = [t.id for t in sc._tasks(ctx, False)[0]]
    assert "radio.fpcalc" not in ids


def test_the_trigger_is_in_the_block_editor_and_passes_the_assistants_validator():
    from core.ai import drafts
    from core.automation.blocks import blocks_for_scope, block_category
    blocks = blocks_for_scope("music")
    trig = next(t for t in blocks["triggers"] if t["type"] == "radio_track_heard")
    assert trig["label"] == "A track I don't have played on a favourite station"
    assert trig["module"] == "radio" and trig["category"] == "Radio" == block_category("radio_track_heard")
    assert "Radio" in blocks["category_order"]
    assert not any(t["type"] == "radio_track_heard" for t in blocks_for_scope("video")["triggers"])
    raw = {"name": "Radio finds", "trigger_type": "radio_track_heard",
           "trigger_config": {"conditions": [{"field": "station", "operator": "contains", "value": "NTS"}]},
           "action_type": "notify_only", "action_config": {}, "then_actions": []}
    draft, notes = drafts.clean_draft(raw, blocks, is_admin=False)
    assert not any("radio" in n.lower() for n in notes), notes
    assert draft["trigger_type"] == "radio_track_heard"
    assert draft["trigger_config"]["conditions"][0]["field"] == "station"


def test_wanted_payload_from_a_metadata_match_and_by_name():
    class T:
        id, name, artists, album, image_url = "dz1", "Harbour Light", ["Pale Harbour"], "Lantern", None
        duration_ms, release_date, album_type, total_tracks, explicit, external_urls = 276000, "2024", "album", 11, False, {}
    assert wanted.pick_match([T()], "pale harbour", "Harbour Light") is not None
    assert wanted.pick_match([T()], "Someone Else", "Harbour Light") is None
    p = wanted.build_payload("Pale Harbour", "Harbour Light", match=T())
    assert p["track"]["id"] == "dz1" and p["album"]["name"] == "Lantern"
    p = wanted.build_payload("Tidewater", "Night Ferry")
    assert p["track"]["id"] == wanted.synthetic_id("tidewater", "Night  Ferry")
    assert p["album"]["album_type"] == "single"


def test_the_adder_goes_through_searchs_add():
    seen = {}

    def add_track(runtime, **kw):
        seen.update(kw, runtime=runtime)
        return {"success": True, "message": "Added"}, 200
    add = wanted.make_adder(search_tracks=lambda q, n: [], runtime_for=lambda pid: f"runtime-{pid}", add_track=add_track)
    assert add(3, {"artist": "Tidewater", "title": "Night Ferry", "station_id": "kexp", "auto": True})["ok"]
    assert seen["runtime"] == "runtime-3" and seen["quality_profile_id"] is None
    assert seen["source_context"]["source_page"] == "Radio" and seen["source_context"]["radio_auto_add"] is True
    assert add(3, {"artist": "", "title": "x"})["ok"] is False


@pytest.mark.parametrize("result,expected", [
    ({"status": "ok", "recordings": [{"artist": "A", "title": "B", "score": 0.4},
                                     {"artist": "C", "title": "D", "score": 0.93}]}, ("ok", "C")),
    ({"status": "ok", "recordings": [{"artist": "A", "title": "B", "score": 0.3}]}, ("no_match", None)),
    ({"status": "no_match", "recordings": []}, ("no_match", None)),
    ({"status": "error", "error": "rate limited"}, ("error", None)),
])
def test_fingerprint_mapping(result, expected):
    class C:
        def lookup_with_status(self, path):
            return result
    out = fingerprint.lookup("/tmp/x.mp3", client_factory=C)
    assert out["status"] == expected[0] and out.get("artist") == expected[1]


def test_the_migration_makes_radios_tables(module_db):
    with module_db._get_connection() as conn:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"radio_favourites", "radio_links", "radio_heard", "radio_auto_add", "radio_auto_added",
            "radio_activity", "radio_shows"} <= names
