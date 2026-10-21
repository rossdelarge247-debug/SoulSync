"""every track a library scan writes looks itself up in track_downloads to
backfill the external ids SoulSync knew at download time. the fallback for a
path that isn't stored verbatim is ``file_path LIKE '%/name' OR LIKE
'%\\name'``, a scan of the whole table, once per track: on a heavy
downloader's database that scan was most of the deep scan.

the scan's batch writer now looks a whole batch up at once
(_provenance_by_file_paths): one query for the exact paths, one pass over the
table for the names. it must give exactly the answers the per-path lookup
gives, LIKE's quirks included.
"""

from __future__ import annotations

import pytest

from database.music_database import MusicDatabase


STORED = [
    # (file_path, spotify id) in insertion (= id) order
    ('/music/Artist/Album/01 - Song.flac', 'exact-old'),
    ('/music/Artist/Album/01 - Song.flac', 'exact-new'),          # same path, higher id wins
    ('/downloads/A/B/02 - Other.flac', 'slash'),
    ('C:\\Downloads\\A\\03 - Windows.flac', 'backslash'),
    ('/x/04 - CASE.FLAC', 'case'),
    ('/x/05 - Émile.flac', 'accent-upper'),                       # LIKE folds ASCII only
    ('/y/06 - Twice.flac', 'twice-old'),
    ('D:\\z\\06 - twice.flac', 'twice-new'),
    ('/mixed\\07 - Mixed.flac', 'mixed-backslash-tail'),
    ('/mixed/sub\\08 - Tail.flac', 'tail-after-backslash'),
    ('/w/09 - Wild_card.flac', 'underscore'),
    ('/w/09 - WildXcard.flac', 'underscore-twin'),                # '_' matches any one char
    ('/w/10 - 100%.flac', 'percent'),
    ('/w/10 - 100% done.flac', 'percent-twin'),
    ('/trailing/', 'dir-only'),
    (None, 'no-path'),
    ('no-separator.flac', 'bare'),
    ('/dots/11 - a.b.c.flac', 'dots'),
]

LOOKUPS = [
    '/music/Artist/Album/01 - Song.flac',      # exact, duplicate rows
    '/library/Album/02 - Other.flac',          # basename via '/'
    '/library/03 - Windows.flac',              # basename via '\'
    '/library/04 - case.flac',                 # ASCII case-insensitive
    '/library/05 - émile.flac',                # non-ASCII case differs: no match
    '/library/05 - Émile.flac',
    '/library/06 - TWICE.flac',                # two candidates, highest id
    '/library/07 - Mixed.flac',
    '/library/Tail.flac',
    '/library/08 - Tail.flac',
    '/library/09 - Wild_card.flac',            # wildcard names keep the query
    '/library/10 - 100%.flac',
    '/library/nothing.flac',
    'C:\\lib\\no-separator.flac',              # windows path, basename after '\'
    '/library/11 - a.b.c.flac',
    '/library/',                               # no basename at all
    '/music/Artist/Album/01 - Song.flac',      # asked twice
]


@pytest.fixture()
def db(tmp_path):
    db = MusicDatabase(database_path=str(tmp_path / "prov.db"))
    with db._get_connection() as conn:
        conn.executemany(
            "INSERT INTO track_downloads (file_path, source_service, track_title, status, spotify_track_id) "
            "VALUES (?, 'soulseek', 't', 'completed', ?)", STORED)
        conn.commit()
    return db


@pytest.mark.parametrize('chunk', [1, 3, 500])
def test_the_batch_answers_what_each_lookup_answers(db, monkeypatch, chunk):
    monkeypatch.setattr(MusicDatabase, '_ID_LOOKUP_CHUNK', chunk)
    conn = db._get_connection()
    try:
        cursor = conn.cursor()
        expected = {path: MusicDatabase._provenance_by_file_path(cursor, path) for path in LOOKUPS}
        got = MusicDatabase._provenance_by_file_paths(cursor, LOOKUPS)
    finally:
        conn.close()

    assert got == expected
    picked = {path: (row or {}).get('spotify_track_id') for path, row in got.items()}
    assert picked == {
        '/music/Artist/Album/01 - Song.flac': 'exact-new',
        '/library/Album/02 - Other.flac': 'slash',
        '/library/03 - Windows.flac': 'backslash',
        '/library/04 - case.flac': 'case',
        '/library/05 - émile.flac': None,
        '/library/05 - Émile.flac': 'accent-upper',
        '/library/06 - TWICE.flac': 'twice-new',
        '/library/07 - Mixed.flac': 'mixed-backslash-tail',
        '/library/Tail.flac': None,
        '/library/08 - Tail.flac': 'tail-after-backslash',
        '/library/09 - Wild_card.flac': 'underscore-twin',
        '/library/10 - 100%.flac': 'percent-twin',
        '/library/nothing.flac': None,
        'C:\\lib\\no-separator.flac': None,
        '/library/11 - a.b.c.flac': 'dots',
        '/library/': None,
    }


def test_nothing_to_look_up(db):
    conn = db._get_connection()
    try:
        assert MusicDatabase._provenance_by_file_paths(conn.cursor(), []) == {}
        assert MusicDatabase._provenance_by_file_paths(conn.cursor(), ['', None]) == {}
    finally:
        conn.close()


def test_the_table_is_read_once_for_a_whole_batch(db):
    conn = db._get_connection()
    statements = []
    conn.set_trace_callback(statements.append)
    try:
        paths = [f"/library/Album/{n:02d} - Missing.flac" for n in range(200)] + ['/library/Album/02 - Other.flac']
        got = MusicDatabase._provenance_by_file_paths(conn.cursor(), paths)
    finally:
        conn.close()
    assert got['/library/Album/02 - Other.flac']['spotify_track_id'] == 'slash'
    assert sum(1 for s in statements if 'LIKE' in s) == 0
    assert sum(1 for s in statements if s.startswith('SELECT id, file_path FROM track_downloads')) == 1
