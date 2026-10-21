"""Fixtures for the Activity feed tests: a throwaway music database, a row
writer (activity_rows.Rows) and build_feed on a fixed clock."""

from __future__ import annotations

import pytest

from core.activity import feed
from tests.activity.activity_rows import NOW, Rows


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    feed.clear_caches()
    return MusicDatabase(database_path=str(tmp_path / "activity.db"))


@pytest.fixture
def rows(db):
    return Rows(db)


@pytest.fixture
def build(db):
    """build_feed with the fixed clock and no live state unless given."""
    def _build(viewer=None, **kw):
        kw.setdefault("now", NOW)
        kw.setdefault("live_batches", {})
        kw.setdefault("running_automations", {})
        kw.setdefault("range_key", "30d")
        return feed.build_feed(db, viewer or feed.Viewer(profile_id=1, is_admin=True), **kw)
    return _build
