"""The Visuals overlay's routes (api/visuals.py) and their store
(core/visuals): MilkDrop's index from the build's copy of butterchurn-presets
plus the admin's own folder, one preset by key, favourites per profile and
the own-presets setting."""

from __future__ import annotations

import json
import os
import sqlite3

import pytest
from flask import Flask, g

from core.visuals import favourites as fav
from core.visuals import presets as P


class _Config:
    def __init__(self):
        self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value


class _Db:
    def __init__(self, path):
        self.path = path
        conn = self._get_connection()
        fav.ensure_schema(conn.cursor())
        conn.commit()
        conn.close()

    def _get_connection(self):
        return sqlite3.connect(self.path)


def _bundle(static_dir, names, uncurated=None):
    """The build's copy. ``uncurated`` names the presets outside the curated
    packs; None writes an index from before the mark."""
    out = os.path.join(static_dir, "dist", "visuals", "milkdrop")
    os.makedirs(out, exist_ok=True)
    presets = []
    for name in names:
        key = P.bundled_key(name)
        body = json.dumps({"baseVals": {"zoom": 1}, "shapes": [], "waves": [], "name": name})
        with open(os.path.join(out, key + ".json"), "w", encoding="utf-8") as fh:
            fh.write(body)
        entry = {"key": key, "name": name, "size": len(body)}
        if uncurated is not None:
            entry["curated"] = name not in uncurated
        presets.append(entry)
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"source": "butterchurn-presets", "count": len(presets), "presets": presets}, fh)


MILK = "[preset00]\nfRating=3.0\nzoom=1.01\nper_frame_1=wave_r = 0.5;\n"


@pytest.fixture
def world(tmp_path, monkeypatch):
    P.clear_caches()
    static_dir = tmp_path / "static"
    _bundle(str(static_dir), [
        "Geiss - Eggs",
        "Rovastar - Altars of Madness",
        "_Geiss - Feedback",
        "flexi - mindblob",
        "Flexi - reality tunnel",
        "11",
    ])
    own = tmp_path / "own"
    (own / "packs").mkdir(parents=True)
    (own / "Hapax - Angel Rails.milk").write_text(MILK, encoding="utf-8")
    (own / "packs" / "Orrery - Diffusion Field.MILK").write_text(MILK, encoding="utf-8")
    (own / "notes.txt").write_text("not a preset", encoding="utf-8")
    (own / ".hidden.milk").write_text(MILK, encoding="utf-8")
    (own / "Huge - Too Big.milk").write_bytes(b"x" * (P.OWN_MAX_BYTES + 1))
    outside = tmp_path / "outside.milk"
    outside.write_text("secret", encoding="utf-8")
    try:
        (own / "Sneaky - Link.milk").symlink_to(outside)
        (own / "elsewhere").symlink_to(tmp_path, target_is_directory=True)
    except OSError:
        pass
    config = _Config()
    db = _Db(str(tmp_path / "fav.db"))
    import api.visuals as visuals_api

    visuals_api.configure(get_database_=lambda: db, config_manager_=config,
                          static_dir_=str(static_dir), docker_resolve_path_=lambda p: p)
    state = {"profile": 1, "admin": True}
    monkeypatch.setattr(visuals_api, "is_admin_request", lambda: state["admin"])
    app = Flask(__name__)

    @app.before_request
    def _profile():
        g.profile_id = state["profile"]

    app.register_blueprint(visuals_api.create_blueprint())
    app.config["TESTING"] = True
    client = app.test_client()
    yield {"client": client, "config": config, "state": state, "own": own, "db": db,
           "static": static_dir, "outside": outside, "tmp": tmp_path}
    P.clear_caches()


# ── names ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name,author,title", [
    ("Geiss - Eggs", "Geiss", "Eggs"),
    ("_Geiss - Feedback", "Geiss", "Feedback"),
    ("Eo.S. + Phat - cubetrace - v2", "Eo.S. + Phat", "cubetrace - v2"),
    ("$$$ Royal - Mashup (160)", "$$$ Royal", "Mashup (160)"),
    ("11", None, "11"),
    ("No dash here", None, "No dash here"),
    (" - leading dash", None, "- leading dash"),
])
def test_names_split_into_author_and_title(name, author, title):
    assert P.split_name(name) == (author, title)


def test_the_key_matches_the_build_script():
    # webui/scripts/milkdrop-presets.mjs: md- + sha1(name)[:16]
    assert P.bundled_key("Geiss - Eggs") == "md-a2d4673ae1656827"
    assert P.own_key("packs/Orrery - Diffusion Field.MILK").startswith("own-")


# ── the index ───────────────────────────────────────────────────────────────

def test_the_index_lists_bundled_presets_a_to_z_with_authors(world):
    body = world["client"].get("/api/visuals/presets?family=milkdrop").get_json()
    assert body["success"] is True
    assert body["family"] == "milkdrop"
    assert body["total"] == body["count"] == 6
    names = [p["name"] for p in body["presets"]]
    assert names == sorted(names, key=str.casefold)
    eggs = next(p for p in body["presets"] if p["name"] == "Eggs")
    assert eggs["author"] == "Geiss" and eggs["source"] == "bundled" and eggs["size"] > 0
    assert eggs["key"] == P.bundled_key("Geiss - Eggs")
    assert next(p for p in body["presets"] if p["name"] == "11")["author"] is None
    authors = {a["key"]: a for a in body["authors"]}
    # case-folded together, the capitalised spelling shown on a tie
    assert authors["flexi"]["count"] == 2 and authors["flexi"]["name"] == "Flexi"
    assert authors["geiss"]["count"] == 2
    assert body["own"] == {"configured": False, "count": 0, "problem": None, "truncated": False,
                           "too_big": 0, "read_at": None}
    # an index built before the curated mark counts every preset as curated
    assert body["set"] == "curated" and body["curated"] == 6 and body["uncurated"] == 0
    assert body["kept"] == []


def test_search_matches_names_and_authors_and_the_author_filter(world):
    c = world["client"]
    by_author = c.get("/api/visuals/presets?q=geiss").get_json()
    assert sorted(p["name"] for p in by_author["presets"]) == ["Eggs", "Feedback"]
    assert by_author["total"] == 6 and by_author["count"] == 2
    two_terms = c.get("/api/visuals/presets?q=flexi tunnel").get_json()
    assert [p["name"] for p in two_terms["presets"]] == ["reality tunnel"]
    flexi = c.get("/api/visuals/presets?author=FLEXI").get_json()
    assert flexi["count"] == 2


def test_another_family_has_no_list(world):
    r = world["client"].get("/api/visuals/presets?family=avs")
    assert r.status_code == 400 and r.get_json()["error"] == "bad_family"


def test_no_build_means_no_bundled_presets(world, tmp_path):
    import api.visuals as visuals_api

    visuals_api._static_dir = str(tmp_path / "nothing")
    body = world["client"].get("/api/visuals/presets").get_json()
    assert body["total"] == 0 and body["presets"] == []


def test_your_own_presets_join_the_list(world):
    world["config"].data["visuals.own_presets_dir"] = str(world["own"])
    body = world["client"].get("/api/visuals/presets").get_json()
    own = [p for p in body["presets"] if p["source"] == "own"]
    assert sorted((p["author"], p["name"]) for p in own) == [
        ("Hapax", "Angel Rails"), ("Orrery", "Diffusion Field")]
    # not listed: a .txt, a hidden file, one over the cap, a link out of the folder
    assert all(p["name"] not in ("Too Big", "Link", "notes") for p in body["presets"])
    assert body["own"]["configured"] is True and body["own"]["count"] == 2
    assert body["total"] == 8


# ── the curated set (HANDOFF 101) ───────────────────────────────────────────

@pytest.fixture
def curated_world(world):
    P.clear_caches()
    _bundle(str(world["static"]), [
        "Geiss - Eggs",
        "Rovastar - Altars of Madness",
        "_Geiss - Feedback",
        "flexi - mindblob",
        "Flexi - reality tunnel",
        "11",
    ], uncurated={"flexi - mindblob", "11"})
    world["config"].data["visuals.own_presets_dir"] = str(world["own"])
    return world


def test_the_curated_packs_and_your_own_are_listed_by_default(curated_world):
    body = curated_world["client"].get("/api/visuals/presets").get_json()
    assert body["set"] == "curated"
    bundled = [p for p in body["presets"] if p["source"] == "bundled"]
    assert sorted(p["name"] for p in bundled) == ["Altars of Madness", "Eggs", "Feedback", "reality tunnel"]
    assert all(p["curated"] is True for p in bundled)
    assert len([p for p in body["presets"] if p["source"] == "own"]) == 2
    assert body["total"] == body["count"] == 6
    assert body["bundled"] == 6 and body["curated"] == 4 and body["uncurated"] == 2
    # authors follow what's listed
    assert {a["key"]: a["count"] for a in body["authors"]}["flexi"] == 1


def test_every_preset_adds_the_rest(curated_world):
    c = curated_world["client"]
    body = c.get("/api/visuals/presets?set=all").get_json()
    assert body["set"] == "all" and body["total"] == 8 and body["kept"] == []
    assert next(p for p in body["presets"] if p["name"] == "mindblob")["curated"] is False
    assert c.get("/api/visuals/presets?set=curated").get_json()["total"] == 6


def test_an_unknown_set_is_refused(curated_world):
    r = curated_world["client"].get("/api/visuals/presets?set=everything")
    assert r.status_code == 400 and r.get_json()["error"] == "bad_set"


def test_favourites_and_recent_keep_presets_the_curated_set_leaves_out(curated_world):
    c = curated_world["client"]
    blob = P.bundled_key("flexi - mindblob")
    eleven = P.bundled_key("11")
    c.put(f"/api/visuals/favourites/milkdrop/{blob}")
    body = c.get("/api/visuals/presets").get_json()
    assert [p["key"] for p in body["kept"]] == [blob]
    assert blob not in {p["key"] for p in body["presets"]}
    # Recent's keys, named by the browser; junk and curated keys are ignored
    eggs = P.bundled_key("Geiss - Eggs")
    body = c.get(f"/api/visuals/presets?keep={eleven},{eggs},../etc,own-0000000000000000").get_json()
    assert sorted(p["key"] for p in body["kept"]) == sorted([blob, eleven])
    # another profile's stars aren't this one's
    curated_world["state"]["profile"] = 2
    assert c.get("/api/visuals/presets").get_json()["kept"] == []


def test_a_missing_folder_says_so(world):
    world["config"].data["visuals.own_presets_dir"] = str(world["tmp"] / "gone")
    body = world["client"].get("/api/visuals/presets").get_json()
    assert body["own"]["problem"] == "missing" and body["own"]["count"] == 0
    assert body["total"] == 6


def test_profile_required(world):
    world["state"]["profile"] = None
    c = world["client"]
    assert c.get("/api/visuals/presets").status_code == 401
    assert c.get("/api/visuals/presets/" + P.bundled_key("Geiss - Eggs")).status_code == 401
    assert c.get("/api/visuals/favourites").status_code == 401
    assert c.get("/api/visuals/settings").status_code == 401


# ── one preset ──────────────────────────────────────────────────────────────

def test_a_bundled_preset_by_key_is_cached_by_the_browser(world):
    r = world["client"].get("/api/visuals/presets/" + P.bundled_key("Geiss - Eggs"))
    assert r.status_code == 200
    assert r.mimetype == "application/json"
    assert r.get_json()["name"] == "Geiss - Eggs"
    assert "max-age=" in r.headers["Cache-Control"]
    assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_an_own_preset_by_key_is_its_milk_text(world):
    world["config"].data["visuals.own_presets_dir"] = str(world["own"])
    key = P.own_key("Hapax - Angel Rails.milk")
    r = world["client"].get("/api/visuals/presets/" + key)
    assert r.status_code == 200
    assert r.mimetype == "text/plain"
    assert r.headers["X-Preset-Format"] == "milk"
    assert r.get_data(as_text=True) == MILK
    nested = world["client"].get("/api/visuals/presets/" + P.own_key("packs/Orrery - Diffusion Field.MILK"))
    assert nested.status_code == 200


@pytest.mark.parametrize("key", [
    "md-0000000000000000",            # well formed, not in the build
    "own-0000000000000000",           # well formed, not in the folder
    "../../etc/passwd",
    "md-..%2F..%2Findex",
    "own-" + "a" * 15,
    "index",
])
def test_unknown_or_malformed_keys_are_not_found(world, key):
    world["config"].data["visuals.own_presets_dir"] = str(world["own"])
    r = world["client"].get("/api/visuals/presets/" + key)
    assert r.status_code == 404


def test_files_outside_the_folder_or_over_the_cap_are_never_read(world):
    folder = str(world["own"])
    world["config"].data["visuals.own_presets_dir"] = folder
    for rel in ("Sneaky - Link.milk", "Huge - Too Big.milk", "notes.txt", "../outside.milk",
                "elsewhere/outside.milk", ".hidden.milk"):
        assert P.read_own(folder, P.own_key(rel)) is None
        assert world["client"].get("/api/visuals/presets/" + P.own_key(rel)).status_code == 404


def test_a_file_swapped_for_a_link_after_listing_is_refused(world):
    folder = str(world["own"])
    key = P.own_key("Hapax - Angel Rails.milk")
    assert P.read_own(folder, key) == MILK
    target = world["own"] / "Hapax - Angel Rails.milk"
    target.unlink()
    try:
        target.symlink_to(world["outside"])
    except OSError:
        pytest.skip("no symlinks here")
    # the cached listing still names it; the read checks again
    assert P.read_own(folder, key) is None


def test_the_listing_counts_what_was_too_big_and_when_it_read(world):
    listing = P.own_listing(str(world["own"]), fresh=True)
    assert listing.too_big == 1
    summary = listing.summary()
    assert summary["count"] == 2 and summary["too_big"] == 1 and summary["problem"] is None
    assert isinstance(summary["read_at"], int) and summary["read_at"] > 0


def test_an_empty_or_unreadable_folder_says_which(world, tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    assert P.own_listing(str(empty), fresh=True).summary()["count"] == 0
    assert P.own_listing(str(empty), fresh=True).problem is None
    assert P.own_listing(str(tmp_path / "gone"), fresh=True).problem == "missing"
    if os.geteuid() != 0:  # root reads anything
        locked = tmp_path / "locked"
        locked.mkdir()
        os.chmod(locked, 0)
        try:
            assert P.own_listing(str(locked), fresh=True).problem == "unreadable"
        finally:
            os.chmod(locked, 0o755)


def test_the_own_listing_is_capped(world, monkeypatch):
    monkeypatch.setattr(P, "OWN_MAX_FILES", 1)
    listing = P.own_listing(str(world["own"]), fresh=True)
    assert len(listing.entries) == 1 and listing.truncated is True


# ── favourites ──────────────────────────────────────────────────────────────

def test_favourites_are_per_profile(world):
    c = world["client"]
    eggs = P.bundled_key("Geiss - Eggs")
    altars = P.bundled_key("Rovastar - Altars of Madness")
    assert c.get("/api/visuals/favourites?family=milkdrop").get_json()["keys"] == []
    r = c.put(f"/api/visuals/favourites/milkdrop/{eggs}")
    assert r.status_code == 200 and r.get_json()["favourite"] is True
    assert c.put(f"/api/visuals/favourites/milkdrop/{eggs}").get_json()["favourite"] is True  # twice is fine
    c.put(f"/api/visuals/favourites/milkdrop/{altars}")
    keys = c.get("/api/visuals/favourites").get_json()["keys"]
    assert set(keys) == {eggs, altars} and len(keys) == 2
    world["state"]["profile"] = 2
    assert c.get("/api/visuals/favourites").get_json()["keys"] == []
    world["state"]["profile"] = 1
    r = c.delete(f"/api/visuals/favourites/milkdrop/{eggs}")
    assert r.get_json()["favourite"] is False
    assert c.get("/api/visuals/favourites").get_json()["keys"] == [altars]


def test_favourites_refuse_bad_families_and_keys(world):
    c = world["client"]
    assert c.put("/api/visuals/favourites/avs/" + P.bundled_key("Geiss - Eggs")).status_code == 400
    r = c.put("/api/visuals/favourites/milkdrop/not-a-key")
    assert r.status_code == 400 and r.get_json()["error"] == "bad_key"
    assert c.get("/api/visuals/favourites?family=classic").status_code == 400


def test_favourites_are_capped(world, monkeypatch):
    monkeypatch.setattr(fav, "MAX_PER_FAMILY", 1)
    c = world["client"]
    c.put("/api/visuals/favourites/milkdrop/" + P.bundled_key("Geiss - Eggs"))
    r = c.put("/api/visuals/favourites/milkdrop/" + P.bundled_key("11"))
    assert r.status_code == 409 and r.get_json()["error"] == "too_many"


def test_the_music_database_has_the_favourites_table(tmp_path):
    from database.music_database import MusicDatabase

    db = MusicDatabase(str(tmp_path / "music.db"))
    conn = db._get_connection()
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(visual_favourites)").fetchall()]
    finally:
        conn.close()
    assert cols == ["profile_id", "family", "preset_key", "created_at"]


# ── the setting ─────────────────────────────────────────────────────────────

def test_admins_choose_the_folder_and_members_only_see_the_count(world):
    c = world["client"]
    body = c.get("/api/visuals/settings").get_json()
    assert body["admin"] is True and body["own_presets_dir"] == "" and body["own"]["configured"] is False
    r = c.put("/api/visuals/settings", json={"own_presets_dir": str(world["own"])})
    assert r.status_code == 200
    assert r.get_json()["own"]["count"] == 2
    # the settings line says what it read and what it left out (18b)
    assert r.get_json()["own"]["too_big"] == 1 and r.get_json()["own"]["read_at"]
    assert world["config"].data["visuals.own_presets_dir"] == str(world["own"])
    world["state"]["admin"] = False
    member = c.get("/api/visuals/settings").get_json()
    assert "own_presets_dir" not in member and member["own"]["count"] == 2
    assert c.put("/api/visuals/settings", json={"own_presets_dir": ""}).status_code == 403


@pytest.mark.parametrize("value,error", [
    ("relative/path", "bad_path"),
    ("/no/such/folder/anywhere", "missing"),
])
def test_the_folder_is_checked_before_it_is_saved(world, value, error):
    r = world["client"].put("/api/visuals/settings", json={"own_presets_dir": value})
    assert r.status_code == 400 and r.get_json()["error"] == error
    assert "visuals.own_presets_dir" not in world["config"].data


def test_an_empty_folder_turns_your_own_presets_off(world):
    c = world["client"]
    c.put("/api/visuals/settings", json={"own_presets_dir": str(world["own"])})
    r = c.put("/api/visuals/settings", json={"own_presets_dir": ""})
    assert r.status_code == 200 and r.get_json()["own"]["configured"] is False
    assert c.put("/api/visuals/settings", json={}).status_code == 400
