"""The artist page joins per-album data (quality against the target) onto a
discography card by the library row the ownership check matched, so every
owned completion result names that row: ``library_album_id``. Missing
releases name none.

Hermetic: temp DB, no network (the cards carry track counts and ids the
library already holds).
"""

from __future__ import annotations

import pytest

from core.metadata.completion import check_album_completion, check_single_completion
from database.music_database import MusicDatabase


@pytest.fixture()
def library(tmp_path):
    db = MusicDatabase(str(tmp_path / 'm.db'))
    with db._get_connection() as conn:
        conn.execute("INSERT INTO artists (id, name, server_source) VALUES ('AR1', 'Pale Harbour', 'test')")
        conn.execute(
            "INSERT INTO albums (id, artist_id, title, year, track_count, server_source) "
            "VALUES ('AL1', 'AR1', 'Night Ferry', 2023, 3, 'test')")
        conn.execute(
            "INSERT INTO albums (id, artist_id, title, year, track_count, server_source) "
            "VALUES ('AL2', 'AR1', 'Harbour Light', 2022, 2, 'test')")
        conn.execute(
            "INSERT INTO albums (id, artist_id, title, year, track_count, server_source) "
            "VALUES ('AL3', 'AR1', 'Slack Water', 2020, 1, 'test')")
        tracks = [('N0', 'AL1', 'Night One'), ('N1', 'AL1', 'Night Two'), ('N2', 'AL1', 'Night Three'),
                  ('H0', 'AL2', 'Light One'), ('H1', 'AL2', 'Light Two'),
                  ('S0', 'AL3', 'Slack Water')]
        for i, (tid, album, title) in enumerate(tracks):
            conn.execute(
                "INSERT INTO tracks (id, album_id, artist_id, title, track_number, file_path, server_source) "
                "VALUES (?, ?, 'AR1', ?, ?, ?, 'test')",
                (tid, album, title, i + 1, f'/m/{tid}.flac'))
        conn.commit()
    candidates = db.get_candidate_albums_for_artist('Pale Harbour', server_source='test')
    assert len(candidates) == 3
    return db, candidates


def test_an_owned_album_names_its_library_row(library):
    db, candidates = library
    card = {'id': 'SP-NF', 'name': 'Night Ferry', 'total_tracks': 3, 'album_type': 'album', 'year': 2023}
    r = check_album_completion(db, card, 'Pale Harbour', source_override='spotify',
                               candidate_albums=candidates)
    assert r['status'] == 'completed'
    assert r['library_album_id'] == 'AL1'


def test_a_missing_album_names_no_row(library):
    db, candidates = library
    card = {'id': 'SP-TW', 'name': 'Tidewater', 'total_tracks': 12, 'album_type': 'album', 'year': 2026}
    r = check_album_completion(db, card, 'Pale Harbour', source_override='spotify',
                               candidate_albums=candidates)
    assert r['status'] == 'missing'
    assert r.get('library_album_id') is None


def test_an_owned_ep_names_its_library_row(library):
    db, candidates = library
    ep = {'id': 'SP-HL', 'name': 'Harbour Light', 'total_tracks': 2, 'album_type': 'ep', 'year': 2022}
    r = check_single_completion(db, ep, 'Pale Harbour', source_override='spotify',
                                candidate_albums=candidates)
    assert r['status'] == 'completed'
    assert r['library_album_id'] == 'AL2'


def test_an_owned_single_names_its_library_row(library):
    db, candidates = library
    candidate_tracks = db.get_candidate_tracks_for_albums([a.id for a in candidates])
    single = {'id': 'SP-SW', 'name': 'Slack Water', 'total_tracks': 1, 'album_type': 'single', 'year': 2020}
    r = check_single_completion(db, single, 'Pale Harbour', source_override='spotify',
                                candidate_albums=candidates, candidate_tracks=candidate_tracks)
    assert r['status'] == 'completed'
    assert r['library_album_id'] == 'AL3'


def test_a_missing_single_names_no_row(library):
    db, candidates = library
    single = {'id': 'SP-X', 'name': 'Low Light', 'total_tracks': 1, 'album_type': 'single', 'year': 2021}
    r = check_single_completion(db, single, 'Pale Harbour', source_override='spotify',
                                candidate_albums=candidates)
    assert r['status'] == 'missing'
    assert r['library_album_id'] is None
