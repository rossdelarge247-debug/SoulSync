"""The Mix tab's tests: the Stars tests' library (the Sets tests' tracks,
track 20 profile 7's own, track 30 without its file) and their Flask app with
the DJ, Sets and Stars routes."""

from __future__ import annotations

import pytest

from tests.stars.conftest import client, db  # noqa: F401 - fixtures


@pytest.fixture
def sql(db):  # noqa: F811 - the fixture above
    def run(statement, params=()):
        conn = db._get_connection()
        try:
            rows = conn.execute(statement, params).fetchall()
            conn.commit()
            return rows
        finally:
            conn.close()
    return run


def make_set(client, name, ids):  # noqa: F811 - the fixture above
    res = client.post("/api/sets", json={"name": name, "kind": "hand",
                                         "tracks": [{"track_id": i, "state": "owned"} for i in ids]})
    assert res.status_code == 201, res.get_json()
    return res.get_json()["id"]
