"""Fixtures for the Activity tests: a throwaway music database."""

from __future__ import annotations

import pytest


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    return MusicDatabase(database_path=str(tmp_path / "activity.db"))
