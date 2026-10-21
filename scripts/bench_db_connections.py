#!/usr/bin/env python3
"""Time MusicDatabase calls that open a connection each.

Builds a throwaway library with the real schema (MusicDatabase init), fills
it with --tracks tracks, then times:

- track_exists() in a loop (one short query per call),
- the library artists page (get_library_artists, page 1),
- a mixed read/write loop on 4 threads.

Usage: python scripts/bench_db_connections.py [--tracks 5000] [--dir DIR]
The database goes in a temp dir (or --dir) and is deleted afterwards.
"""

import argparse
import os
import shutil
import sqlite3
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _fill(path, n_tracks):
    artists = max(1, n_tracks // 20)
    albums = max(1, n_tracks // 10)
    conn = sqlite3.connect(path)
    conn.executemany(
        "INSERT INTO artists (id, name, server_source) VALUES (?, ?, 'plex')",
        [(f"ar{i}", f"Artist {i:04d}") for i in range(artists)])
    conn.executemany(
        "INSERT INTO albums (id, artist_id, title, server_source) VALUES (?, ?, ?, 'plex')",
        [(f"al{i}", f"ar{i % artists}", f"Album {i:04d}") for i in range(albums)])
    conn.executemany(
        "INSERT INTO tracks (id, album_id, artist_id, title, server_source, file_path) "
        "VALUES (?, ?, ?, ?, 'plex', ?)",
        [(f"t{i}", f"al{i % albums}", f"ar{(i % albums) % artists}", f"Track {i:05d}",
          f"/music/{i}.flac") for i in range(n_tracks)])
    conn.commit()
    conn.close()


def _time(fn, repeat=5):
    runs = []
    for _ in range(repeat):
        start = time.perf_counter()
        fn()
        runs.append(time.perf_counter() - start)
    return statistics.median(runs)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tracks", type=int, default=5000)
    parser.add_argument("--dir", default=None, help="where to put the temp database")
    args = parser.parse_args()

    workdir = tempfile.mkdtemp(prefix="bench-db-", dir=args.dir)
    path = os.path.join(workdir, "bench.db")
    os.environ["DATABASE_PATH"] = path
    try:
        from database.music_database import MusicDatabase
        db = MusicDatabase(path)
        _fill(path, args.tracks)
        n = args.tracks

        def exists_loop():
            for i in range(1000):
                db.track_exists(f"t{(i * 7) % (n * 2)}")  # half hit, half miss

        def artists_page():
            for _ in range(20):
                db.get_library_artists(page=1, limit=50)

        def mixed_threads():
            def work(tid):
                for i in range(250):
                    db.track_exists(f"t{(i * 13 + tid) % n}")
                    db.get_track_by_id(f"t{(i * 17 + tid) % n}")
                    db.get_metadata(f"bench_{tid}")
                    if i % 5 == 0:
                        db.set_metadata(f"bench_{tid}", str(i))
            threads = [threading.Thread(target=work, args=(t,)) for t in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        exists_loop()  # warm up the OS file cache and imports
        t_exists = _time(exists_loop)
        t_page = _time(artists_page)
        t_mixed = _time(mixed_threads, repeat=3)
        print(f"tracks: {n}")
        print(f"track_exists x1000:          {t_exists * 1000:8.1f} ms  ({t_exists * 1e6 / 1000:6.1f} us/call)")
        print(f"get_library_artists x20:     {t_page * 1000:8.1f} ms  ({t_page * 1e3 / 20:6.2f} ms/call)")
        print(f"mixed 4 threads x1050 calls: {t_mixed * 1000:8.1f} ms  ({t_mixed * 1e6 / 4200:6.1f} us/call)")
    finally:
        try:
            from database.music_database import close_pooled_connections
            close_pooled_connections()
        except ImportError:
            pass
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
