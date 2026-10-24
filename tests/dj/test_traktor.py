"""Export to Traktor (core/dj/traktor.py, the routes in api/dj.py; board 21a).

The key numbering, the Mac paths, the .nml read back with ElementTree, the
export folder's rules, and the routes. The tests marked ``gauntlet`` are the
disaster scenarios: XML injection through track names, an export folder that
escapes through ``..`` or a link, overwriting a file, and another profile's
tracks or playlists."""

from __future__ import annotations

import os
import time
import xml.etree.ElementTree as ET

import pytest
from flask import Flask, g

from core.dj import store, traktor, worker
from core.dj.camelot import parse_key

# ── keys ─────────────────────────────────────────────────────────────────────

# Camelot → (Traktor MUSICAL_KEY VALUE, Open Key): VALUE 0–11 are C…B major,
# 12–23 Cm…Bm (a real collection.nml pairs VALUE 7 with KEY "2d", G major)
KEY_TABLE = {
    "8B": (0, "1d"), "3B": (1, "8d"), "10B": (2, "3d"), "5B": (3, "10d"), "12B": (4, "5d"), "7B": (5, "12d"),
    "2B": (6, "7d"), "9B": (7, "2d"), "4B": (8, "9d"), "11B": (9, "4d"), "6B": (10, "11d"), "1B": (11, "6d"),
    "5A": (12, "10m"), "12A": (13, "5m"), "7A": (14, "12m"), "2A": (15, "7m"), "9A": (16, "2m"), "4A": (17, "9m"),
    "11A": (18, "4m"), "6A": (19, "11m"), "1A": (20, "6m"), "8A": (21, "1m"), "3A": (22, "8m"), "10A": (23, "3m"),
}


def test_every_camelot_key_maps_to_traktors_number_and_open_key():
    assert sorted(v for v, _ in KEY_TABLE.values()) == list(range(24))
    for code, (value, ok) in KEY_TABLE.items():
        assert traktor.traktor_key_value(code) == value, code
        assert traktor.open_key(code) == ok, code


def test_the_mapping_agrees_with_musical_names():
    assert traktor.traktor_key_value("C") == 0
    assert traktor.traktor_key_value("G") == 7  # the real file's VALUE 7 / KEY 2d
    assert traktor.open_key("G") == "2d"
    assert traktor.traktor_key_value("Am") == 21
    assert traktor.traktor_key_value("F#m") == traktor.traktor_key_value("Gbm") == 18
    assert traktor.traktor_key_value("Bbm") == 22
    assert traktor.traktor_key_value("1m") == 21  # Open Key in, too
    assert traktor.traktor_key_value("nonsense") is None and traktor.open_key(None) is None
    # round trip: every value names the key it came from
    for code, (value, _ok) in KEY_TABLE.items():
        key = parse_key(code)
        assert key["pitch"] == value % 12 and key["minor"] == (value >= 12)


def test_only_a_confident_key_is_written():
    assert traktor.confident_key({"key": "8A", "key_source": "tag"}) == "8A"
    assert traktor.confident_key({"key": "8A", "key_source": "analysis", "key_confidence": 0.5}) == "8A"
    assert traktor.confident_key({"key": "8A", "key_source": "analysis", "key_confidence": 0.49}) is None
    assert traktor.confident_key({"key": "8A", "key_source": "analysis", "key_confidence": None}) is None
    assert traktor.confident_key({"key": "8A", "key_source": "tag", "key_uncertain": True}) is None
    assert traktor.confident_key(None) is None


# ── Mac paths ────────────────────────────────────────────────────────────────

def test_locations_in_traktors_dir_notation():
    loc = traktor.nml_location("/Volumes/Music HD/SoulSync/Transfer/Tidewater/Night Ferry EP/01 Night Ferry.flac")
    assert loc == {"VOLUME": "Music HD", "DIR": "/:SoulSync/:Transfer/:Tidewater/:Night Ferry EP/:",
                   "FILE": "01 Night Ferry.flac"}
    assert traktor.primary_key(loc) == "Music HD/:SoulSync/:Transfer/:Tidewater/:Night Ferry EP/:01 Night Ferry.flac"
    home = traktor.nml_location("/Users/ross/SoulSync/music/a.mp3")
    assert home == {"VOLUME": "Macintosh HD", "DIR": "/:Users/:ross/:SoulSync/:music/:", "FILE": "a.mp3"}
    assert traktor.nml_location("/Volumes/Music HD/a.mp3")["DIR"] == "/:"
    assert traktor.nml_location("/Users/ross/:odd/a.mp3") is None
    assert traktor.nml_location("relative/a.mp3") is None


def test_mac_path_setting_is_checked():
    assert traktor.valid_mac_path(" /Users/ross/SoulSync/music/ ") == "/Users/ross/SoulSync/music"
    assert traktor.valid_mac_path("/Volumes/Music HD//SoulSync") == "/Volumes/Music HD/SoulSync"
    for bad in ("", "music", "~/Music", "/Users/../etc", "/a/\x00b", "/a\\b", 5, None, "/" + "a" * 600):
        assert traktor.valid_mac_path(bad) is None, bad


def test_mac_paths_from_the_setting():
    paths = traktor.MacPaths("/app/Transfer", "/Volumes/Music HD/SoulSync/Transfer")
    assert paths.mac_path_for("/app/Transfer/A/B/01.flac") == ("/Volumes/Music HD/SoulSync/Transfer/A/B/01.flac", None)
    assert paths.mac_path_for("/app/Transfer/../etc/x.flac") == (None, "outside")
    assert paths.mac_path_for("/app/TransferX/a.flac") == (None, "outside")
    assert paths.mac_path_for("/downloads/a.flac") == (None, "outside")
    assert paths.mac_path_for("") == (None, "not_in_library")
    # the same path inside and out (a /Volumes:/Volumes mount)
    assert paths.mac_path_for("/Volumes/Other/a.flac") == ("/Volumes/Other/a.flac", None)
    unset = traktor.MacPaths("/app/Transfer", None)
    assert unset.mac_path_for("/app/Transfer/a.flac") == (None, "no_mac_path")


def test_the_drive_helpers_map_comes_first_and_the_resolver_second():
    host = {"/app/Transfer/a.flac": "/Users/ross/SoulSync/music/a.flac"}
    paths = traktor.MacPaths("/app/Transfer", "/Volumes/Music HD/T", to_host=host.get)
    assert paths.mac_path_for("/app/Transfer/a.flac")[0] == "/Users/ross/SoulSync/music/a.flac"
    assert paths.mac_path_for("/app/Transfer/b.flac")[0] == "/Volumes/Music HD/T/b.flac"
    # a media server's path, found on disk under the library folder
    resolving = traktor.MacPaths("/app/Transfer", "/Volumes/Music HD/T",
                                 resolve=lambda p: "/app/Transfer/x/y.flac" if p == "/plex/x/y.flac" else None)
    assert resolving.mac_path_for("/plex/x/y.flac")[0] == "/Volumes/Music HD/T/x/y.flac"
    assert resolving.mac_path_for("/plex/z.flac") == (None, "outside")
    # the helper's names alone, with no Mac path set: a track they don't
    # place still asks for the setting rather than saying it's outside
    helper_only = traktor.MacPaths("/app/Transfer", None, to_host=host.get)
    assert helper_only.mac_path_for("/app/Transfer/a.flac")[0] == "/Users/ross/SoulSync/music/a.flac"
    assert helper_only.mac_path_for("/app/Transfer/b.flac") == (None, "no_mac_path")


def test_the_export_uses_the_drive_helpers_names():
    from core.drives import host_paths

    assert traktor._load_to_host() is host_paths.to_host


def test_file_names_are_safe():
    assert traktor.safe_filename("Sunday Set") == "Sunday Set.nml"
    assert traktor.safe_filename("../../etc/passwd") == "etc passwd.nml"
    assert traktor.safe_filename("a/b\\c:d*e?f\"g<h>i|j\x00k") == "a b c d e f g h i jk.nml"
    assert traktor.safe_filename("...") == "Traktor export.nml"
    assert traktor.safe_filename("") == "Traktor export.nml"
    assert len(traktor.safe_filename("x" * 500)) == 84
    assert traktor.ascii_filename("Café ☕ Set.nml") == "Cafe  Set.nml"
    assert traktor.ascii_filename("☕.nml") == "Traktor export.nml"


# ── the file ─────────────────────────────────────────────────────────────────

def _track(tid, title, artist="Tidewater", *, key="8A", source="tag", conf=None, bpm=124.0, path=None):
    return {"id": tid, "title": title, "artist_name": artist, "album_title": "Night Ferry EP",
            "duration_ms": 391500, "bitrate": 320, "file_path": path or f"/app/Transfer/{tid}.flac",
            "dj": {"bpm": bpm, "key": key, "key_source": source, "key_confidence": conf,
                   "key_uncertain": bool(source == "analysis" and conf is not None and conf < 0.5)}}


def _plan(tracks, mac="/Volumes/Music HD/SoulSync/Transfer"):
    return traktor.plan([(t, t["title"], t["artist_name"]) for t in tracks], traktor.MacPaths("/app/Transfer", mac))


def test_the_nml_reads_back():
    tracks = [_track("1", "Night Ferry"), _track("2", "Low Tide", key="9B", source="analysis", conf=0.4),
              _track("3", "No key", key=None, bpm=None), _track("1", "Night Ferry")]
    planned = _plan(tracks)
    assert planned["counts"] == {"tracks": 4, "found": 4, "left_out": 0}
    data = traktor.build_nml("Sunday Set", planned["entries"])
    assert data.startswith(b'<?xml version="1.0" encoding="UTF-8" standalone="no" ?>')
    root = ET.fromstring(data)
    assert root.tag == "NML" and root.get("VERSION") == "19"
    assert root.find("HEAD").get("PROGRAM") == "Traktor"
    collection = root.find("COLLECTION")
    entries = collection.findall("ENTRY")
    assert collection.get("ENTRIES") == "3" and len(entries) == 3  # a track twice is one entry
    first = entries[0]
    assert first.get("TITLE") == "Night Ferry" and first.get("ARTIST") == "Tidewater"
    loc = first.find("LOCATION")
    assert (loc.get("VOLUME"), loc.get("DIR"), loc.get("FILE")) == ("Music HD", "/:SoulSync/:Transfer/:", "1.flac")
    assert first.find("ALBUM").get("TITLE") == "Night Ferry EP"
    assert first.find("TEMPO").get("BPM") == "124.000000"
    assert first.find("MUSICAL_KEY").get("VALUE") == "21"
    info = first.find("INFO")
    assert info.get("KEY") == "1m" and info.get("PLAYTIME") == "392" and info.get("BITRATE") == "320000"
    # an uncertain key isn't written; BPM still is
    assert entries[1].find("MUSICAL_KEY") is None and entries[1].find("INFO").get("KEY") is None
    assert entries[1].find("TEMPO") is not None
    assert entries[2].find("TEMPO") is None and entries[2].find("MUSICAL_KEY") is None
    # never cue points or grids
    assert root.find(".//CUE_V2") is None
    node = root.find("PLAYLISTS/NODE")
    assert node.get("TYPE") == "FOLDER" and node.get("NAME") == "$ROOT"
    pl_node = node.find("SUBNODES/NODE")
    assert pl_node.get("TYPE") == "PLAYLIST" and pl_node.get("NAME") == "Sunday Set"
    playlist = pl_node.find("PLAYLIST")
    assert playlist.get("ENTRIES") == "4" and playlist.get("TYPE") == "LIST" and len(playlist.get("UUID")) == 32
    keys = [e.find("PRIMARYKEY").get("KEY") for e in playlist.findall("ENTRY")]
    assert keys[0] == "Music HD/:SoulSync/:Transfer/:1.flac" and keys[0] == keys[3]
    assert {e.find("PRIMARYKEY").get("TYPE") for e in playlist.findall("ENTRY")} == {"TRACK"}


def test_left_out_tracks_say_why():
    tracks = [_track("1", "In"), _track("2", "Elsewhere", path="/downloads/2.flac")]
    items = [(t, t["title"], t["artist_name"]) for t in tracks] + [(None, "Copper Sky", "Tidewater")]
    planned = traktor.plan(items, traktor.MacPaths("/app/Transfer", "/Users/ross/SoulSync/music"), over=2)
    assert planned["counts"] == {"tracks": 5, "found": 1, "left_out": 4}
    reasons = [(x["title"], x["reason"]) for x in planned["left_out"]]
    assert reasons == [("Elsewhere", "outside"), ("Copper Sky", "not_in_library"), ("", "too_many"),
                       ("", "too_many")]
    assert planned["left_out"][1]["words"] == "isn't a file in your library"


@pytest.mark.gauntlet
def test_track_names_cannot_inject_xml():
    nasty = ('Evil" ARTIST="x"/><PLAYLISTS><NODE NAME="pwn"/></PLAYLISTS><ENTRY TITLE="'
             " & ]]> <!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]> &e; \x00\x01\x1b￾\ud800 ☃\n\ttab")
    artist = "</ENTRY><ENTRY>&amp;"
    path = '/app/Transfer/"><x/>&/01 <&>.flac'
    track = _track("1", nasty, artist, path=path)
    track["album_title"] = "<ALBUM/>"
    planned = _plan([track])
    assert planned["counts"]["found"] == 1
    data = traktor.build_nml(nasty, planned["entries"])
    assert b"<!DOCTYPE" not in data and b"<!ENTITY" not in data.split(b"?>", 1)[0]
    root = ET.fromstring(data)
    # one collection entry, one playlist, nothing smuggled in
    assert len(root.findall("COLLECTION/ENTRY")) == 1
    assert len(root.findall("PLAYLISTS")) == 1 and len(root.findall(".//NODE")) == 2
    entry = root.find("COLLECTION/ENTRY")
    cleaned = traktor.xml_text(nasty)
    assert "\x00" not in cleaned and "\x01" not in cleaned and "￾" not in cleaned and "\ud800" not in cleaned
    assert entry.get("TITLE") == cleaned and entry.get("ARTIST") == artist
    assert entry.find("ALBUM").get("TITLE") == "<ALBUM/>"
    assert entry.find("LOCATION").get("FILE") == "01 <&>.flac"
    assert root.find(".//NODE[@TYPE='PLAYLIST']").get("NAME") == cleaned[:200]
    assert root.find(".//PRIMARYKEY").get("KEY").endswith('/:"><x/:>&/:01 <&>.flac')


# ── the export folder ────────────────────────────────────────────────────────

@pytest.fixture
def folders(tmp_path):
    music = tmp_path / "music"
    exports = music / "Traktor exports"
    exports.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    return {"roots": [str(music)], "music": music, "exports": exports, "outside": outside}


def test_saves_a_new_file_and_leaves_no_temporary(folders):
    path = traktor.save_to_folder(str(folders["exports"]), "Sunday Set.nml", b"<NML/>", roots=folders["roots"])
    assert path == os.path.join(os.path.realpath(folders["exports"]), "Sunday Set.nml")
    assert open(path, "rb").read() == b"<NML/>"
    assert sorted(os.listdir(folders["exports"])) == ["Sunday Set.nml"]


def test_the_folder_states(folders):
    roots = folders["roots"]
    assert traktor.check_export_folder(None, roots) == (None, "unset")
    assert traktor.check_export_folder("relative", roots) == (None, "invalid")
    assert traktor.check_export_folder(str(folders["outside"]), roots) == (None, "outside")
    assert traktor.check_export_folder(str(folders["music"] / "nope"), roots) == (None, "missing")
    assert traktor.check_export_folder(str(folders["exports"]), roots)[1] == "ok"
    # a configured folder that isn't mounted holds nothing
    assert traktor.check_export_folder(str(folders["exports"]), ["/nowhere/at/all"]) == (None, "outside")


@pytest.mark.gauntlet
def test_an_export_folder_cannot_escape(folders):
    roots = folders["roots"]
    dotdot = str(folders["exports"]) + "/../../outside"
    assert traktor.check_export_folder(dotdot, roots) == (None, "outside")
    link = folders["music"] / "sneaky"
    link.symlink_to(folders["outside"], target_is_directory=True)
    assert traktor.check_export_folder(str(link), roots) == (None, "outside")
    for folder in (dotdot, str(link)):
        with pytest.raises(traktor.ExportFolderError):
            traktor.save_to_folder(folder, "x.nml", b"<NML/>", roots=roots)
    # nor through the file's name
    for name in ("../x.nml", "../../outside/x.nml", "a/b.nml", "x.txt", ".nml", "x\x00.nml", "..nml"):
        with pytest.raises(ValueError):
            traktor.save_to_folder(str(folders["exports"]), name, b"<NML/>", roots=roots)
    assert os.listdir(folders["outside"]) == []
    assert os.listdir(folders["exports"]) == []


@pytest.mark.gauntlet
def test_an_existing_file_is_never_overwritten_without_asking(folders):
    roots = folders["roots"]
    target = folders["exports"] / "Sunday Set.nml"
    target.write_bytes(b"Ross's own file")
    with pytest.raises(FileExistsError):
        traktor.save_to_folder(str(folders["exports"]), "Sunday Set.nml", b"<NML/>", roots=roots)
    assert target.read_bytes() == b"Ross's own file"
    # a link at the name, even a dangling one, isn't followed or replaced
    secret = folders["outside"] / "secret.txt"
    secret.write_bytes(b"keep")
    (folders["exports"] / "Linked.nml").symlink_to(secret)
    (folders["exports"] / "Dangling.nml").symlink_to(folders["outside"] / "nothing.txt")
    for name in ("Linked.nml", "Dangling.nml"):
        with pytest.raises(FileExistsError):
            traktor.save_to_folder(str(folders["exports"]), name, b"<NML/>", roots=roots)
    assert secret.read_bytes() == b"keep" and not (folders["outside"] / "nothing.txt").exists()
    # a folder with the name isn't replaced either, even when asked
    (folders["exports"] / "Folder.nml").mkdir()
    with pytest.raises(FileExistsError):
        traktor.save_to_folder(str(folders["exports"]), "Folder.nml", b"<NML/>", overwrite=True, roots=roots)
    # replacing, once asked, writes the new file and leaves a linked target alone
    traktor.save_to_folder(str(folders["exports"]), "Sunday Set.nml", b"<NML/>", overwrite=True, roots=roots)
    assert target.read_bytes() == b"<NML/>"
    traktor.save_to_folder(str(folders["exports"]), "Linked.nml", b"<NML/>", overwrite=True, roots=roots)
    assert secret.read_bytes() == b"keep" and not os.path.islink(folders["exports"] / "Linked.nml")
    assert not [n for n in os.listdir(folders["exports"]) if n.startswith(".synchros-traktor-")]


def test_without_hard_links_the_exclusive_create_still_refuses(folders, monkeypatch):
    import errno

    def no_links(*_a, **_k):
        raise OSError(errno.EPERM, "no links here")

    monkeypatch.setattr(traktor.os, "link", no_links)
    roots = folders["roots"]
    traktor.save_to_folder(str(folders["exports"]), "A.nml", b"one", roots=roots)
    assert (folders["exports"] / "A.nml").read_bytes() == b"one"
    # the claim refuses a name that's taken, and the written file stays a temporary
    dfd = os.open(folders["exports"], os.O_RDONLY)
    try:
        tmp, fd = traktor._new_temp(dfd)
        os.write(fd, b"two")
        os.close(fd)
        with pytest.raises(FileExistsError):
            traktor._place_new(dfd, tmp, "A.nml")
        os.unlink(tmp, dir_fd=dfd)
    finally:
        os.close(dfd)
    assert (folders["exports"] / "A.nml").read_bytes() == b"one"
    assert sorted(os.listdir(folders["exports"])) == ["A.nml"]


# ── the routes ───────────────────────────────────────────────────────────────

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
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "traktor.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Tidewater')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Night Ferry EP')")
    rows = [("1", "Night Ferry", "/app/Transfer/Tidewater/01 Night Ferry.flac", None, "8A", "tag"),
            ("2", "Low Tide", "/app/Transfer/Tidewater/02 Low Tide.flac", None, "9A", "analysis"),
            ("3", "Elsewhere", "/downloads/03 Elsewhere.flac", None, "8B", "tag"),
            ("4", "Someone else's", "/app/Transfer/other/04.flac", 7, "8A", "tag")]
    for tid, title, path, owner, key, source in rows:
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id) "
                       "VALUES (?, '10', '1', ?, ?, 391000, ?)", (tid, title, path, owner))
        store.save(database, tid, {"bpm": 124.0, "bpm_source": "tag", "musical_key": key, "key_source": source,
                                   "key_confidence": 0.9 if source == "analysis" else None, "status": "done",
                                   "dj_analyzer_version": worker.analyzer_version()})
    return database


class _Config:
    def __init__(self):
        self.data = {traktor.SETTING_MAC_PATH: "/Volumes/Music HD/SoulSync/Transfer"}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value

    def get_active_media_server(self):
        return None


@pytest.fixture
def client(db, tmp_path, monkeypatch):
    import api.dj as dj_api
    import core.profile_context as pc
    import core.settings as settings
    from core.library_scope import reset_library_scope, set_library_scope

    cfg = _Config()
    monkeypatch.setattr(settings, "config_manager", cfg)
    exports = tmp_path / "music" / "Traktor exports"
    exports.mkdir(parents=True)
    monkeypatch.setattr(traktor, "library_root", lambda: "/app/Transfer")
    monkeypatch.setattr(traktor, "export_roots", lambda: [str(tmp_path / "music")])
    dj_api.configure(get_database_=lambda: db)
    state = {"profile": 1, "admin": True, "scope": "shared"}
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
    c.state, c.cfg, c.exports = state, cfg, exports
    return c


def _export(client, **body):
    return client.post("/api/library/dj/traktor/export", json=body)


def test_preview_then_download(client):
    res = _export(client, action="preview", source="tracks", track_ids=["1", "2", "3", "999"])
    body = res.get_json()
    assert res.status_code == 200 and body["success"] is True
    assert body["counts"] == {"tracks": 4, "found": 2, "left_out": 2}
    assert body["example_path"] == "/Volumes/Music HD/SoulSync/Transfer/Tidewater/01 Night Ferry.flac"
    assert body["mac_path"] == "/Volumes/Music HD/SoulSync/Transfer"
    assert body["reasons"] == {"outside": 1, "not_in_library": 1}
    assert body["keys"] == 2 and body["filename"] == time.strftime("SYNCHRO.S tracks %Y-%m-%d.nml")
    assert body["folder"]["state"] == "unset" and body["folder"]["can_save"] is False
    assert body["can_edit"] is True

    res = _export(client, action="download", source="tracks", track_ids=["1", "2", "3"], name="Sunday Set")
    assert res.status_code == 200
    assert res.headers["Content-Disposition"] == (
        "attachment; filename=\"Sunday Set.nml\"; filename*=UTF-8''Sunday%20Set.nml")
    assert res.headers["X-Content-Type-Options"] == "nosniff"
    root = ET.fromstring(res.data)
    assert [e.get("TITLE") for e in root.findall("COLLECTION/ENTRY")] == ["Night Ferry", "Low Tide"]
    assert root.find(".//NODE[@TYPE='PLAYLIST']").get("NAME") == "Sunday Set"


def test_a_name_with_odd_characters_downloads_with_a_safe_name(client):
    res = _export(client, action="download", source="tracks", track_ids=["1"], name='../Café "set"\r\nX-Evil: 1')
    disposition = res.headers["Content-Disposition"]
    assert "\r" not in disposition and "\n" not in disposition and "/" not in disposition.split("filename*")[0]
    assert disposition.startswith('attachment; filename="Cafe set X-Evil 1.nml"')
    assert "filename*=UTF-8''Caf%C3%A9%20set%20X-Evil%201.nml" in disposition


def test_without_a_mac_path_everything_is_left_out_and_said(client):
    client.cfg.data[traktor.SETTING_MAC_PATH] = ""
    body = _export(client, action="preview", source="tracks", track_ids=["1", "2"]).get_json()
    assert body["counts"]["found"] == 0 and body["reasons"] == {"no_mac_path": 2} and body["mac_path"] is None
    assert _export(client, action="download", source="tracks", track_ids=["1"]).status_code == 409


def test_the_input_is_checked(client):
    assert _export(client, action="preview", source="tracks", track_ids=[str(i) for i in range(1001)]).status_code == 400
    assert _export(client, action="preview", source="tracks", track_ids="1").status_code == 400
    assert _export(client, action="preview", source="tracks", track_ids=[]).status_code == 400
    assert _export(client, action="preview", source="files").status_code == 400
    assert _export(client, action="delete", source="tracks", track_ids=["1"]).status_code == 400
    assert _export(client, action="preview", source="playlist", playlist_id="x").status_code == 400
    assert _export(client, action="preview", source="playlist", playlist_id=True).status_code == 400
    assert _export(client, action="preview", source="mixes").status_code == 400
    big = client.post("/api/library/dj/traktor/export", data=b"{" + b" " * (70 * 1024) + b"}",
                      content_type="application/json")
    assert big.status_code == 413
    assert client.post("/api/library/dj/traktor/export", data="nope", content_type="text/plain").status_code == 400


def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert _export(client, action="preview", source="tracks", track_ids=["1"]).status_code == 401
    assert client.get("/api/library/dj/traktor/settings").status_code == 401


def test_mixes_well_with_exports_the_seed_first(client):
    body = _export(client, action="preview", source="mixes", track_id="1").get_json()
    # the seed (8A) and Low Tide (9A); Elsewhere (8B) mixes but is outside; the other profile's isn't there
    assert body["name"] == "Mixes with Night Ferry"
    assert body["counts"] == {"tracks": 3, "found": 2, "left_out": 1}
    assert _export(client, action="preview", source="mixes", track_id="404").status_code == 404


def _playlist(db, owner, name, rows):
    _sql(db, "INSERT INTO mirrored_playlists (source, source_playlist_id, name, profile_id) VALUES (?, ?, ?, ?)",
         ("soulsync", f"pl-{name}", name, owner))
    pid = _sql(db, "SELECT id FROM mirrored_playlists WHERE name = ?", (name,))[0][0]
    for pos, (title, artist) in enumerate(rows, 1):
        _sql(db, "INSERT INTO mirrored_playlist_tracks (playlist_id, position, track_name, artist_name) "
                 "VALUES (?, ?, ?, ?)", (pid, pos, title, artist))
    return pid


def test_a_playlist_matches_the_library_by_title_and_artist(client, db):
    pid = _playlist(db, 1, "Sunday Set", [("night ferry", "TIDEWATER"), ("Copper Sky", "Tidewater"),
                                          ("Low Tide", "Tidewater")])
    body = _export(client, action="preview", source="playlist", playlist_id=pid).get_json()
    assert body["name"] == "Sunday Set" and body["filename"] == "Sunday Set.nml"
    assert body["counts"] == {"tracks": 3, "found": 2, "left_out": 1}
    assert body["left_out"] == [{"title": "Copper Sky", "artist": "Tidewater", "reason": "not_in_library",
                                 "words": "isn't a file in your library"}]
    root = ET.fromstring(_export(client, action="download", source="playlist", playlist_id=pid).data)
    assert [e.get("TITLE") for e in root.findall("COLLECTION/ENTRY")] == ["Night Ferry", "Low Tide"]


@pytest.mark.gauntlet
def test_exports_stay_in_the_callers_library(client, db):
    # profile 7's own library holds track 4; the shared library is everyone else's
    client.state.update(profile=2, admin=False)
    body = _export(client, action="preview", source="tracks", track_ids=["1", "4"]).get_json()
    assert body["counts"] == {"tracks": 2, "found": 1, "left_out": 1}
    root = ET.fromstring(_export(client, action="download", source="tracks", track_ids=["4"] * 3 + ["1"]).data)
    assert [e.get("TITLE") for e in root.findall("COLLECTION/ENTRY")] == ["Night Ferry"]
    assert _export(client, action="preview", source="mixes", track_id="4").status_code == 404
    # a playlist only matches what the caller's library holds
    mine = _playlist(db, 2, "Mine", [("Someone else's", "Tidewater"), ("Night Ferry", "Tidewater")])
    body = _export(client, action="preview", source="playlist", playlist_id=mine).get_json()
    assert body["counts"] == {"tracks": 2, "found": 1, "left_out": 1}
    # someone else's playlist reads as missing for a member
    theirs = _playlist(db, 3, "Theirs", [("Night Ferry", "Tidewater")])
    assert _export(client, action="preview", source="playlist", playlist_id=theirs).status_code == 404
    assert _export(client, action="download", source="playlist", playlist_id=theirs).status_code == 404
    # profile 7 on its own library sees track 4 and not the shared ones
    client.state.update(profile=7, scope=7)
    root = ET.fromstring(_export(client, action="download", source="tracks", track_ids=["1", "4"]).data)
    assert [e.get("TITLE") for e in root.findall("COLLECTION/ENTRY")] == ["Someone else's"]


def test_settings_are_admin_only_to_change(client):
    body = client.get("/api/library/dj/traktor/settings").get_json()
    assert body["mac_path"] == "/Volumes/Music HD/SoulSync/Transfer" and body["can_edit"] is True
    assert body["library_folder"] == "/app/Transfer" and body["export_folder_state"] == "unset"
    assert body["collection"].startswith("collection.nml")
    client.state["admin"] = False
    assert client.get("/api/library/dj/traktor/settings").get_json()["can_edit"] is False
    res = client.put("/api/library/dj/traktor/settings", json={"mac_path": "/Users/x"})
    assert res.status_code == 403
    assert client.cfg.data[traktor.SETTING_MAC_PATH] == "/Volumes/Music HD/SoulSync/Transfer"


def test_settings_are_checked_and_saved(client, tmp_path):
    put = lambda **b: client.put("/api/library/dj/traktor/settings", json=b)  # noqa: E731
    assert put(mac_path="music").status_code == 400
    assert put(mac_path="/Users/../etc").status_code == 400
    res = put(mac_path=" /Users/ross/SoulSync/music/ ")
    assert res.status_code == 200 and res.get_json()["mac_path"] == "/Users/ross/SoulSync/music"
    assert client.cfg.data[traktor.SETTING_MAC_PATH] == "/Users/ross/SoulSync/music"
    assert put(export_folder=str(tmp_path)).get_json()["field"] == "export_folder"
    assert put(export_folder=str(tmp_path / "music" / "nope")).status_code == 400
    res = put(export_folder=str(client.exports))
    body = res.get_json()
    assert res.status_code == 200 and body["export_folder_state"] == "ok"
    assert body["export_folder"] == str(client.exports)
    assert put(export_folder="").get_json()["export_folder_state"] == "unset"
    assert put(mac_path="").get_json()["mac_path"] == ""
    assert client.put("/api/library/dj/traktor/settings", data="x", content_type="text/plain").status_code == 400


def test_save_into_the_export_folder(client):
    client.cfg.data[traktor.SETTING_EXPORT_FOLDER] = str(client.exports)
    body = _export(client, action="preview", source="tracks", track_ids=["1"]).get_json()
    assert body["folder"]["can_save"] is True and body["folder"]["state"] == "ok"
    res = _export(client, action="save", source="tracks", track_ids=["1"], name="Sunday Set")
    assert res.status_code == 200 and res.get_json()["filename"] == "Sunday Set.nml"
    saved = client.exports / "Sunday Set.nml"
    first = saved.read_bytes()
    assert ET.fromstring(first).find("COLLECTION").get("ENTRIES") == "1"
    again = _export(client, action="save", source="tracks", track_ids=["1", "2"], name="Sunday Set")
    assert again.status_code == 409 and again.get_json()["exists"] is True
    assert saved.read_bytes() == first
    replaced = _export(client, action="save", source="tracks", track_ids=["1", "2"], name="Sunday Set",
                       overwrite=True)
    assert replaced.status_code == 200
    assert ET.fromstring(saved.read_bytes()).find("COLLECTION").get("ENTRIES") == "2"
    # members download; only admins write into the folder
    client.state["admin"] = False
    assert _export(client, action="preview", source="tracks", track_ids=["1"]).get_json()["folder"]["can_save"] is False
    assert _export(client, action="save", source="tracks", track_ids=["1"], name="Other").status_code == 403
    assert not (client.exports / "Other.nml").exists()


@pytest.mark.gauntlet
def test_a_stored_export_folder_that_now_escapes_is_refused(client, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    # set while it was fine, then swapped for a link that leads out
    client.cfg.data[traktor.SETTING_EXPORT_FOLDER] = str(client.exports)
    os.rmdir(client.exports)
    os.symlink(outside, client.exports, target_is_directory=True)
    res = _export(client, action="save", source="tracks", track_ids=["1"], name="Sunday Set")
    assert res.status_code == 409 and res.get_json()["folder_state"] == "outside"
    assert os.listdir(outside) == []


# ── the independent review's findings (gauntlet review of 32fa2c75) ───────────

def _offroot(n, prefix="/plex"):
    return [(_track(str(i), f"T{i}", path=f"{prefix}/{i}.flac"), f"T{i}", "A") for i in range(n)]


@pytest.mark.gauntlet
def test_looking_paths_up_on_disk_is_bounded_per_export():
    traktor.clear_resolve_misses()
    calls = []

    def resolve(p):
        calls.append(p)
        return None

    paths = traktor.MacPaths("/app/Transfer", "/Volumes/Music HD/T", resolve=resolve, resolve_budget=50)
    planned = traktor.plan(_offroot(1000), paths)
    assert len(calls) == 50
    reasons = {}
    for left in planned["left_out"]:
        reasons[left["reason"]] = reasons.get(left["reason"], 0) + 1
    assert reasons == {"outside": 50, "lookup_limit": 950}
    assert traktor.REASON_WORDS["lookup_limit"].startswith("wasn't looked for on disk")
    # a miss is remembered: the same paths again don't ask again
    again = traktor.MacPaths("/app/Transfer", "/Volumes/Music HD/T", resolve=resolve, resolve_budget=50)
    traktor.plan(_offroot(50), again)
    assert len(calls) == 50
    traktor.clear_resolve_misses()


@pytest.mark.gauntlet
def test_the_lookups_stop_after_their_time_too():
    traktor.clear_resolve_misses()
    now = [0.0]
    calls = []

    def resolve(p):
        calls.append(p)
        now[0] += 1.0  # each lookup takes a second
        return None

    paths = traktor.MacPaths("/app/Transfer", "/Volumes/M", resolve=resolve, resolve_budget=1000,
                             resolve_seconds=5.0, clock=lambda: now[0])
    traktor.plan(_offroot(100, "/slow"), paths)
    assert len(calls) <= 6
    traktor.clear_resolve_misses()


@pytest.mark.gauntlet
def test_no_lookups_when_nothing_could_place_the_result():
    traktor.clear_resolve_misses()
    calls = []
    paths = traktor.MacPaths("/app/Transfer", None, resolve=lambda p: calls.append(p),
                             same_path_mounts=False)
    planned = traktor.plan(_offroot(200, "/none"), paths)
    assert calls == [] and {x["reason"] for x in planned["left_out"]} == {"no_mac_path"}
    # with /Volumes or /Users mounted the same inside and out, looking up can help
    helps = traktor.MacPaths("/app/Transfer", None, resolve=lambda p: "/Volumes/M/x.flac",
                             same_path_mounts=True)
    assert helps.mac_path_for("/plex/1.flac") == ("/Volumes/M/x.flac", None)


@pytest.mark.gauntlet
def test_a_preview_asks_the_resolver_at_most_the_budget(client, db, monkeypatch):
    import core.sample.worker as sample_worker

    traktor.clear_resolve_misses()
    calls = []
    monkeypatch.setattr(sample_worker, "resolve_track_file", lambda p: calls.append(p))
    for i in range(300):
        _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path) VALUES (?, '10', '1', ?, ?)",
             (f"p{i}", f"Plex {i}", f"/plex/{i}.flac"))
    body = _export(client, action="preview", source="tracks", track_ids=[f"p{i}" for i in range(300)]).get_json()
    assert len(calls) == traktor.RESOLVE_BUDGET
    assert body["reasons"] == {"outside": traktor.RESOLVE_BUDGET, "lookup_limit": 300 - traktor.RESOLVE_BUDGET}
    traktor.clear_resolve_misses()


@pytest.mark.gauntlet
def test_a_folder_swapped_after_the_check_is_never_written_into(folders, monkeypatch):
    roots = folders["roots"]
    real_check = traktor._check_folder

    def swap_to_link(folder, r=None):
        result = real_check(folder, r)
        os.rename(folders["exports"], folders["music"] / "moved")
        os.symlink(folders["outside"], folders["exports"], target_is_directory=True)
        return result

    monkeypatch.setattr(traktor, "_check_folder", swap_to_link)
    with pytest.raises(traktor.ExportFolderError):
        traktor.save_to_folder(str(folders["exports"]), "x.nml", b"<NML/>", roots=roots)
    assert os.listdir(folders["outside"]) == []
    os.unlink(folders["exports"])
    os.rename(folders["music"] / "moved", folders["exports"])

    def swap_to_another_folder(folder, r=None):
        result = real_check(folder, r)
        os.rename(folders["exports"], folders["music"] / "moved")
        os.mkdir(folders["exports"])
        return result

    monkeypatch.setattr(traktor, "_check_folder", swap_to_another_folder)
    with pytest.raises(traktor.ExportFolderError):
        traktor.save_to_folder(str(folders["exports"]), "x.nml", b"<NML/>", roots=roots)
    assert os.listdir(folders["exports"]) == [] and os.listdir(folders["music"] / "moved") == []


def test_the_file_gets_the_usual_mode(folders, monkeypatch):
    import errno
    import stat as st

    monkeypatch.setattr(traktor, "_umask", lambda: 0o022)
    path = traktor.save_to_folder(str(folders["exports"]), "Linked.nml", b"<NML/>", roots=folders["roots"])
    assert st.S_IMODE(os.stat(path).st_mode) == 0o644

    def no_links(*_a, **_k):
        raise OSError(errno.EPERM, "no links here")

    monkeypatch.setattr(traktor.os, "link", no_links)
    path = traktor.save_to_folder(str(folders["exports"]), "Claimed.nml", b"<NML/>", roots=folders["roots"])
    assert st.S_IMODE(os.stat(path).st_mode) == 0o644


@pytest.mark.gauntlet
def test_old_temporary_files_are_swept_and_none_are_left(folders):
    import time as _time

    old = folders["exports"] / ".synchros-traktor-deadbeef.tmp"
    old.write_bytes(b"left by a save that died")
    two_hours_ago = _time.time() - 7200
    os.utime(old, (two_hours_ago, two_hours_ago))
    fresh = folders["exports"] / ".synchros-traktor-inflight.tmp"
    fresh.write_bytes(b"another save, right now")
    mine = folders["exports"] / "notes.tmp"
    mine.write_bytes(b"not ours")
    os.utime(mine, (two_hours_ago, two_hours_ago))
    traktor.save_to_folder(str(folders["exports"]), "A.nml", b"<NML/>", roots=folders["roots"])
    assert sorted(os.listdir(folders["exports"])) == [".synchros-traktor-inflight.tmp", "A.nml", "notes.tmp"]


@pytest.mark.gauntlet
def test_without_links_a_failure_leaves_neither_the_claim_nor_the_temporary(folders, monkeypatch):
    import errno

    def no_links(*_a, **_k):
        raise OSError(errno.EPERM, "no links here")

    real_replace = os.replace

    def failing_replace(src, dst, **kw):
        if str(dst) == "B.nml":
            raise OSError(errno.EIO, "the disk went away")
        return real_replace(src, dst, **kw)

    monkeypatch.setattr(traktor.os, "link", no_links)
    monkeypatch.setattr(traktor.os, "replace", failing_replace)
    with pytest.raises(OSError):
        traktor.save_to_folder(str(folders["exports"]), "B.nml", b"<NML/>", roots=folders["roots"])
    assert os.listdir(folders["exports"]) == []


def test_members_see_whether_things_are_set_not_where(client):
    client.cfg.data[traktor.SETTING_EXPORT_FOLDER] = str(client.exports)
    admin = client.get("/api/library/dj/traktor/settings").get_json()
    assert admin["library_folder"] == "/app/Transfer" and admin["export_folder"] == str(client.exports)
    client.state["admin"] = False
    member = client.get("/api/library/dj/traktor/settings").get_json()
    for field in ("mac_path", "mac_path_from_helper", "library_folder", "export_folder", "export_folder_on_mac"):
        assert field not in member, field
    assert member["mac_path_set"] is True and member["export_folder_state"] == "ok"
    assert member["can_edit"] is False
    preview = _export(client, action="preview", source="tracks", track_ids=["1"]).get_json()
    assert "mac_path" not in preview and "library_folder" not in preview
    assert preview["folder"] == {"state": "ok", "shown": None, "can_save": False}
    # their own track's path, as the Mac sees it, stays
    assert preview["example_path"] == "/Volumes/Music HD/SoulSync/Transfer/Tidewater/01 Night Ferry.flac"


def test_a_chunked_body_is_capped_too(client):
    import io

    big = b'{"action": "preview", "source": "tracks", "track_ids": [' + b'"1",' * 30000 + b'"1"]}'
    res = client.post("/api/library/dj/traktor/export", input_stream=io.BytesIO(big),
                      headers={"Transfer-Encoding": "chunked", "Content-Type": "application/json"},
                      environ_overrides={"wsgi.input_terminated": True})  # what a server sets for chunked
    assert res.status_code == 413
    put = client.put("/api/library/dj/traktor/settings", input_stream=io.BytesIO(b'{"mac_path": "' + b"a" * 70000 + b'"}'),
                     headers={"Transfer-Encoding": "chunked", "Content-Type": "application/json"},
                     environ_overrides={"wsgi.input_terminated": True})
    assert put.status_code == 413


def test_file_names_drop_format_characters_and_never_take_traktors_own():
    assert traktor.safe_filename("Sunday\u202eSet") == "SundaySet.nml"
    assert traktor.safe_filename("evil\u202elmn.exe") == "evillmn.exe.nml"
    assert traktor.safe_filename("a\u200bb\u2066c\ufeffd") == "abcd.nml"
    assert traktor.safe_filename("collection") == "collection (playlist).nml"
    assert traktor.safe_filename("Collection") == "Collection (playlist).nml"
    assert traktor.safe_filename("collection.nml") != "collection.nml"


def test_a_bpm_filter_of_nan_is_ignored(client):
    for raw in ("nan", "NaN", "-nan", "inf"):
        body = client.get(f"/api/library/dj/browse?bpm_min={raw}&bpm_max=130").get_json()
        assert body["bpm_min"] is None and body["bpm_max"] == 130
