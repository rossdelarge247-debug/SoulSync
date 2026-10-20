#!/usr/bin/env python3
"""Build an upgrade-test fixture from a real, released version of SoulSync.

    python tests/fixtures/old_databases/generate.py 3.5.8
    python tests/fixtures/old_databases/generate.py 3.5.8 --source ~/src/soulsync-3.5.8

Writes tests/fixtures/old_databases/<tag>/:

    music.sql      the music database as that release creates it on first boot,
                   plus a few representative rows, as a SQL text dump
    video.sql      the same for the video database (releases from 3.0 on)
    manifest.json  where it came from, and the representative rows, which
                   tests/database/test_upgrade_from_old_releases.py checks survive

How: the tag is fetched (shallow) into a throwaway clone, exported, and that
release's OWN ``database.music_database.MusicDatabase`` (and
``database.video_database.VideoDatabase`` when the release has one) is run on
an empty file in a child interpreter whose import path holds only the release
and this interpreter's site-packages. The current checkout is never imported,
so the schema really is the old release's. Rows are then added with plain
SQL, keeping only the columns that release has, and the files are dumped with
``sqlite3.Connection.iterdump()`` plus the database's ``PRAGMA user_version``
(the video side gates its data migrations on it).

The release's code runs unchanged. Run this with the project's requirements
installed; if an old release imports a package that is no longer installed and
isn't needed to create the schema, name it with ``--stub`` and it is replaced
by an empty module (the stubs are recorded in manifest.json). Releases 1.3 to
3.5.x need none.

The ``app_config`` row the old config manager writes into ``metadata`` is left
out of the dump: it belongs to core/settings.py, not to the schema, and holds
values encrypted with a key that only existed in the throwaway directory.

This is a maintainer tool. It needs git and network access, and nothing in the
test suite runs it.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import types
from datetime import date
from pathlib import Path

REPO_URL = "https://github.com/Nezreka/soulsync"
HERE = Path(__file__).resolve().parent


# ── representative rows ─────────────────────────────────────────────────────
# Each row goes in only when its table exists, with only the columns that
# release has ("needs" names columns without which the row is skipped).
# Explicit ids keep references (album -> artist, track -> playlist) simple.
# Values are shaped like what the app itself writes.

_SPOTIFY_TRACK = {
    "id": "3n3Ppam7vgaVa1iaRUc9Lp",
    "name": "Opening Song",
    "artists": [{"id": "0OdUWJ0sBjDrqHygGUXeCF", "name": "Fixture Artist"}],
    "album": {
        "id": "2noRn2Aes5aoNVsU6iWThc",
        "name": "Fixture Album (Deluxe Edition)",
        "release_date": "2019-05-17",
        "album_type": "album",
        "images": [{"url": "https://i.scdn.co/image/fixture-cover", "height": 640, "width": 640}],
    },
    "duration_ms": 215000,
    "track_number": 1,
    "disc_number": 1,
    "popularity": 42,
    "external_urls": {"spotify": "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"},
}

_SPOTIFY_TRACK_2 = dict(_SPOTIFY_TRACK, id="6rqhFgbbKwnb9MLmUQDhG6", name="Café Été",
                        track_number=2, duration_ms=216000,
                        external_urls={"spotify": "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6"})

MUSIC_ROWS = [
    {"table": "metadata", "key": ["key"],
     "values": {"key": "last_full_refresh", "value": "2026-01-01T12:00:00"}},
    {"table": "profiles", "key": ["id"],
     "values": {"id": 2, "name": "Fixture Listener", "avatar_color": "#22c55e", "is_admin": 0}},
    {"table": "artists", "key": ["id"],
     "values": {"id": "9001", "name": "Fixture Artist", "thumb_url": "/library/metadata/9001/thumb/1700000000",
                # comma-separated on purpose: the legacy genres format a migration rewrites to JSON
                "genres": "Rock, Indie Rock",
                "summary": "Artist row written by the upgrade-test fixture generator.",
                "server_source": "plex", "spotify_artist_id": "0OdUWJ0sBjDrqHygGUXeCF",
                "musicbrainz_id": "f1d1c2a0-0000-4000-8000-000000009001"}},
    {"table": "albums", "key": ["id"],
     "values": {"id": "9101", "artist_id": "9001", "title": "Fixture Album (Deluxe Edition)", "year": 2019,
                "thumb_url": "/library/metadata/9101/thumb/1700000000", "genres": '["Rock", "Indie Rock"]',
                "track_count": 2, "duration": 431000, "server_source": "plex",
                "spotify_album_id": "2noRn2Aes5aoNVsU6iWThc"}},
    {"table": "tracks", "key": ["id"],
     "values": {"id": "9201", "album_id": "9101", "artist_id": "9001", "title": "Opening Song",
                "track_number": 1, "duration": 215000, "bitrate": 1411, "server_source": "plex",
                "file_path": "/music/Fixture Artist/Fixture Album (Deluxe Edition) (2019)/01 - Opening Song.flac",
                "spotify_track_id": "3n3Ppam7vgaVa1iaRUc9Lp"}},
    {"table": "tracks", "key": ["id"],
     "values": {"id": "9202", "album_id": "9101", "artist_id": "9001", "title": "Café Été",
                "track_number": 2, "duration": 216000, "bitrate": 320, "server_source": "plex",
                "file_path": "/music/Fixture Artist/Fixture Album (Deluxe Edition) (2019)/02 - Café Été.mp3"}},
    {"table": "wishlist_tracks", "key": ["spotify_track_id"],
     "values": {"id": 301, "spotify_track_id": _SPOTIFY_TRACK["id"], "spotify_data": json.dumps(_SPOTIFY_TRACK),
                "failure_reason": "No suitable Soulseek results", "retry_count": 2,
                "last_attempted": "2026-01-02 10:00:00", "date_added": "2026-01-01 09:00:00",
                "source_type": "playlist",
                "source_info": json.dumps({"playlist_name": "Fixture Mix", "playlist_id": "37i9dQZF1DXcBWIGoYBM5M"}),
                "profile_id": 1}},
    {"table": "wishlist_tracks", "key": ["spotify_track_id"], "needs": ["profile_id"],
     "values": {"id": 302, "spotify_track_id": _SPOTIFY_TRACK_2["id"], "spotify_data": json.dumps(_SPOTIFY_TRACK_2),
                "failure_reason": "Download failed", "retry_count": 0, "date_added": "2026-01-01 09:05:00",
                "source_type": "manual", "source_info": "{}", "profile_id": 2}},
    {"table": "watchlist_artists", "key": ["artist_name"],
     "values": {"id": 401, "spotify_artist_id": "0OdUWJ0sBjDrqHygGUXeCF", "artist_name": "Fixture Artist",
                "date_added": "2026-01-01 09:00:00", "last_scan_timestamp": "2026-01-03 08:00:00",
                "image_url": "https://i.scdn.co/image/fixture-artist", "include_albums": 1, "include_eps": 1,
                "include_singles": 0, "profile_id": 1}},
    {"table": "similar_artists", "key": ["source_artist_id", "similar_artist_name"],
     "values": {"id": 451, "source_artist_id": "0OdUWJ0sBjDrqHygGUXeCF",
                "similar_artist_spotify_id": "4Z8W4fKeB5YxbusRsdQVPb", "similar_artist_name": "Similar Fixture Band",
                "similarity_rank": 1, "occurrence_count": 3, "profile_id": 1}},
    {"table": "recent_releases", "key": ["album_name"],
     "values": {"id": 471, "watchlist_artist_id": 401, "album_spotify_id": "1fixtureNewAlbum00000",
                "album_name": "Fixture Comeback", "release_date": "2026-01-10",
                "album_cover_url": "https://i.scdn.co/image/fixture-comeback", "track_count": 10, "profile_id": 1}},
    {"table": "discovery_pool", "key": ["track_name", "artist_name"],
     "values": {"id": 461, "spotify_track_id": "7fixtureDiscovery0000", "spotify_album_id": "5fixtureDiscAlbum0000",
                "spotify_artist_id": "4Z8W4fKeB5YxbusRsdQVPb", "source": "spotify",
                "track_name": "Discovered Tune", "artist_name": "Similar Fixture Band",
                "album_name": "Found Sounds", "album_cover_url": "https://i.scdn.co/image/fixture-found",
                "duration_ms": 198000, "popularity": 37, "release_date": "2025-11-01", "is_new_release": 0,
                "track_data_json": json.dumps({"id": "7fixtureDiscovery0000", "name": "Discovered Tune"}),
                "profile_id": 1}},
    {"table": "listenbrainz_playlists", "key": ["playlist_mbid"],
     "values": {"id": 501, "playlist_mbid": "c0ffee00-0000-4000-8000-000000000501",
                "title": "Weekly Jams for fixture", "creator": "troi-bot", "playlist_type": "weekly-jams",
                "track_count": 1, "profile_id": 1}},
    {"table": "listenbrainz_tracks", "key": ["playlist_id", "position"],
     "values": {"id": 511, "playlist_id": 501, "position": 0, "track_name": "Opening Song",
                "artist_name": "Fixture Artist", "album_name": "Fixture Album (Deluxe Edition)",
                "duration_ms": 215000, "recording_mbid": "c0ffee00-0000-4000-8000-000000000511"}},
    {"table": "mirrored_playlists", "key": ["source", "source_playlist_id"],
     "values": {"id": 601, "source": "spotify", "source_playlist_id": "37i9dQZF1DXcBWIGoYBM5M",
                "name": "Fixture Mix", "description": "Mirrored by the fixture generator", "owner": "fixture",
                "image_url": "https://i.scdn.co/image/fixture-mix", "track_count": 2, "profile_id": 1}},
    {"table": "mirrored_playlist_tracks", "key": ["playlist_id", "position"],
     "values": {"id": 611, "playlist_id": 601, "position": 0, "track_name": "Opening Song",
                "artist_name": "Fixture Artist", "album_name": "Fixture Album (Deluxe Edition)",
                "duration_ms": 215000, "source_track_id": _SPOTIFY_TRACK["id"]}},
    # no source_track_id: an upgrade backfills a stable one (#901)
    {"table": "mirrored_playlist_tracks", "key": ["playlist_id", "position"],
     "values": {"id": 612, "playlist_id": 601, "position": 1, "track_name": "Imported From A File",
                "artist_name": "Fixture Artist", "album_name": "Fixture Album (Deluxe Edition)",
                "duration_ms": 201000}},
    {"table": "sync_history", "key": ["batch_id"],
     "values": {"id": 701, "batch_id": "fixture-batch-1", "playlist_id": "37i9dQZF1DXcBWIGoYBM5M",
                "playlist_name": "Fixture Mix", "source": "spotify", "sync_type": "playlist",
                "tracks_json": json.dumps([{"id": _SPOTIFY_TRACK["id"], "name": "Opening Song"}]),
                "total_tracks": 2, "tracks_found": 1, "tracks_downloaded": 1, "tracks_failed": 0,
                "started_at": "2026-01-04 18:00:00", "completed_at": "2026-01-04 18:05:00"}},
]

VIDEO_ROWS = [
    {"table": "root_folders", "key": ["path"],
     "values": {"id": 1, "path": "/media/movies", "content_kind": "movie"}},
    {"table": "movies", "key": ["id"],
     "values": {"id": 1, "server_source": "plex", "server_id": "5001", "tmdb_id": 900001, "imdb_id": "tt9000001",
                "tmdb_match_status": "matched", "title": "Fixture Movie", "year": 2021, "status": "Released",
                "has_file": 1, "path": "/media/movies/Fixture Movie (2021)/Fixture Movie (2021).mkv",
                "details_synced": 1}},
    {"table": "shows", "key": ["id"],
     "values": {"id": 1, "server_source": "plex", "server_id": "6001", "tmdb_id": 900101,
                "tmdb_match_status": "matched", "title": "Fixture Show", "year": 2020,
                "status": "Returning Series", "details_synced": 1}},
    {"table": "seasons", "key": ["id"],
     "values": {"id": 1, "show_id": 1, "server_id": "6011", "season_number": 1, "title": "Season 1"}},
    {"table": "episodes", "key": ["id"],
     "values": {"id": 1, "show_id": 1, "season_id": 1, "server_source": "plex", "server_id": "6012",
                "season_number": 1, "episode_number": 1, "title": "Pilot", "air_date": "2020-03-01",
                "has_file": 1}},
    {"table": "video_watchlist", "key": ["kind", "tmdb_id"],
     "values": {"id": 1, "kind": "show", "tmdb_id": 900101, "title": "Fixture Show", "library_id": 1,
                "source": "tmdb", "state": "follow", "date_added": "2026-07-01 10:00:00"}},
    {"table": "video_wishlist", "key": ["kind", "tmdb_id"],
     "values": {"id": 1, "kind": "movie", "tmdb_id": 900002, "title": "Wished Fixture Movie", "year": 2024,
                "status": "wanted", "source": "tmdb", "date_added": "2026-07-02 10:00:00"}},
    {"table": "video_wishlist", "key": ["kind", "tmdb_id", "season_number", "episode_number"],
     "values": {"id": 2, "kind": "episode", "tmdb_id": 900101, "title": "Fixture Show", "season_number": 1,
                "episode_number": 2, "episode_title": "Second Episode", "air_date": "2020-03-08",
                "status": "wanted", "library_id": 1, "source": "tmdb", "date_added": "2026-07-02 10:05:00"}},
]


# ── child: run the old release's own initialisation ─────────────────────────

class _Stub(types.ModuleType):
    """An empty stand-in for a package an old release imports but the schema
    doesn't need. Any attribute is a permissive dummy class."""

    __path__: list = []

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return type(name, (), {"__init__": lambda self, *a, **k: None,
                               "__call__": lambda self, *a, **k: None,
                               "__getattr__": lambda self, n: None})


def _child(src: str, work: str, stubs: list[str]) -> None:
    sys.path.insert(0, src)
    os.chdir(work)
    for name in stubs:
        for i in range(1, name.count(".") + 2):
            part = ".".join(name.split(".")[:i])
            sys.modules.setdefault(part, _Stub(part))

    records = []
    original_handle = logging.Logger.handle

    def handle(self, record):  # every record, whatever the propagation setup
        records.append(record)
        return original_handle(self, record)

    logging.Logger.handle = handle
    report = {"errors": [], "warnings": [], "video": False}
    try:
        from database.music_database import MusicDatabase
        MusicDatabase(os.path.join(work, "music_library.db"))
        if os.path.exists(os.path.join(src, "database", "video_database.py")):
            from database.video_database import VideoDatabase
            VideoDatabase(os.path.join(work, "video_library.db"))
            report["video"] = True
    finally:
        for r in records:
            line = f"{r.name}: {r.getMessage()}"
            if r.levelno >= logging.ERROR:
                report["errors"].append(line)
            elif r.levelno >= logging.WARNING:
                report["warnings"].append(line)
        Path(work, "_init_report.json").write_text(json.dumps(report, indent=2))


def run_old_init(src: Path, work: Path, stubs: list[str]) -> dict:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(work),
        "DATABASE_PATH": str(work / "music_library.db"),
        "VIDEO_DATABASE_PATH": str(work / "video_library.db"),
        "SOULSYNC_CONFIG_PATH": str(work / "config.json"),
    }
    cmd = [sys.executable, "-I", str(Path(__file__).resolve()), "--child", str(src), str(work),
           "--stub", ",".join(stubs)]
    proc = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True, timeout=600)
    report_path = work / "_init_report.json"
    if proc.returncode != 0 or not report_path.exists():
        sys.stderr.write(proc.stdout[-4000:] + proc.stderr[-8000:])
        raise SystemExit(f"the old release's database initialisation failed (exit {proc.returncode})")
    return json.loads(report_path.read_text())


# ── parent ──────────────────────────────────────────────────────────────────

def fetch_release(tag: str, repo: str, tmp: Path) -> tuple[Path, str]:
    clone, src = tmp / "clone", tmp / "src"
    src.mkdir()
    subprocess.run(["git", "init", "-q", str(clone)], check=True)
    subprocess.run(["git", "-C", str(clone), "fetch", "-q", "--depth=1", repo,
                    f"refs/tags/{tag}:refs/tags/{tag}"], check=True)
    commit = subprocess.run(["git", "-C", str(clone), "rev-parse", f"{tag}^{{commit}}"],
                            check=True, capture_output=True, text=True).stdout.strip()
    archive = tmp / "src.tar"
    subprocess.run(["git", "-C", str(clone), "archive", "-o", str(archive), commit], check=True)
    with tarfile.open(archive) as tar:
        tar.extractall(src, filter="data")
    return src, commit


def _columns(conn, table):
    return {r[1]: r for r in conn.execute(f'PRAGMA table_info("{table}")')}


def insert_rows(db_path: Path, label: str, specs: list[dict]) -> list[dict]:
    """Insert each spec whose table exists; returns what was written."""
    written = []
    conn = sqlite3.connect(db_path)
    try:
        for spec in specs:
            cols = _columns(conn, spec["table"])
            if not cols or any(c not in cols for c in spec.get("needs", [])):
                continue
            values = {k: v for k, v in spec["values"].items() if k in cols}
            missing = [name for name, (_cid, _n, _t, notnull, default, pk) in cols.items()
                       if notnull and default is None and not pk and name not in values]
            if missing:
                raise SystemExit(f"{label}.{spec['table']}: this release requires {missing}; "
                                 "add them to the row in generate.py")
            names = ", ".join(f'"{c}"' for c in values)
            marks = ", ".join("?" for _ in values)
            conn.execute(f'INSERT INTO "{spec["table"]}" ({names}) VALUES ({marks})', list(values.values()))
            written.append({"db": label, "table": spec["table"],
                            "key": {k: values[k] for k in spec["key"]}, "values": values})
        conn.commit()
    finally:
        conn.close()
    return written


def write_dump(db_path: Path, out: Path, header: list[str]) -> None:
    conn = sqlite3.connect(db_path)
    try:
        if _columns(conn, "metadata"):
            conn.execute("DELETE FROM metadata WHERE key = 'app_config'")
            conn.commit()
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        # iterdump (before Python 3.13) also emits INSERTs for a virtual
        # table's rows (albums_fts), which fail on load: the table isn't usable
        # until the schema is reread, and its shadow tables already hold the data
        virtual = tuple(f'INSERT INTO "{name}" VALUES(' for (name,) in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'"))
        lines = [f"-- {h}" for h in header]
        lines.append(f"PRAGMA user_version={int(version)};")
        lines.extend(s for s in conn.iterdump() if not (virtual and s.startswith(virtual)))
    finally:
        conn.close()
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("tag", help="release tag, e.g. 3.5.8")
    parser.add_argument("--source", help="an existing export/checkout of the tag (skips the fetch)")
    parser.add_argument("--repo", default=REPO_URL)
    parser.add_argument("--out", default=str(HERE), help="fixtures directory (default: next to this script)")
    parser.add_argument("--stub", action="append", default=[],
                        help="module to replace with an empty stub when the old code imports it (repeatable)")
    parser.add_argument("--allow-init-errors", action="store_true",
                        help="write the fixture even if the old release logged errors while creating its schema")
    args = parser.parse_args(argv)

    with tempfile.TemporaryDirectory(prefix="soulsync-fixture-") as tmp_name:
        tmp = Path(tmp_name)
        if args.source:
            src = Path(args.source).resolve()
            commit = "unknown"
            if (src / ".git").exists():
                commit = subprocess.run(["git", "-C", str(src), "rev-parse", "HEAD"],
                                        capture_output=True, text=True).stdout.strip() or commit
        else:
            src, commit = fetch_release(args.tag, args.repo, tmp)
        work = tmp / "work"
        work.mkdir()

        report = run_old_init(src, work, args.stub)
        if report["errors"] and not args.allow_init_errors:
            raise SystemExit("the old release logged errors while creating its schema:\n  "
                             + "\n  ".join(report["errors"]))

        out = Path(args.out) / args.tag
        out.mkdir(parents=True, exist_ok=True)
        rows = insert_rows(work / "music_library.db", "music", MUSIC_ROWS)
        header = [f"SoulSync {args.tag} ({commit}) {{db}} database as that release creates it,",
                  "plus the representative rows listed in manifest.json.",
                  f"Regenerate with: python tests/fixtures/old_databases/generate.py {args.tag}"]
        write_dump(work / "music_library.db", out / "music.sql", [h.format(db="music") for h in header])
        if report["video"]:
            rows += insert_rows(work / "video_library.db", "video", VIDEO_ROWS)
            write_dump(work / "video_library.db", out / "video.sql", [h.format(db="video") for h in header])
        elif (out / "video.sql").exists():
            (out / "video.sql").unlink()

        manifest = {
            "release": args.tag,
            "commit": commit,
            "generated": date.today().isoformat(),
            "stubbed_modules": args.stub,
            "init_warnings": report["warnings"],
            "rows": rows,
        }
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {out} ({len(rows)} representative rows, video={'yes' if report['video'] else 'no'})")
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        _child(sys.argv[2], sys.argv[3], [s for s in sys.argv[5].split(",") if s])
        sys.exit(0)
    sys.exit(main())
