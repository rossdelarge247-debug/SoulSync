"""A database created by an older SoulSync release upgrades to the current schema.

Each directory under ``tests/fixtures/old_databases/`` is a SQL dump of the
databases a real release created on first boot, made by that release's own
code, plus a few representative rows (see ``generate.py`` there). Each dump is
loaded into a temp file and opened by the current code exactly as a boot opens
it (``MusicDatabase(path)`` / ``VideoDatabase(path)``), then compared with a
fresh install made by the current code (one boot each):

* every table, column, index, unique constraint, trigger and view a fresh
  install has exists in the upgraded database, with the same definition;
  leftovers only the old database has are printed, not failed;
* the representative rows survive with their data, legacy rows land on the
  admin profile where a migration added a profile column, and the file passes
  ``integrity_check`` and ``foreign_key_check``;
* initialisation raised nothing and logged nothing at ERROR level.

A genuine upgrade bug is marked ``xfail(strict=True)`` in ``KNOWN_BUGS`` with
the reason, so the suite stays green and a fix turns the case into an XPASS.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import traceback
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from database.music_database import MusicDatabase
from database.video_database import VideoDatabase

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "old_databases"


def _release_key(name: str) -> tuple:
    return tuple(int(part) if part.isdigit() else part for part in name.split("."))


RELEASES = sorted((p.name for p in FIXTURES.iterdir() if (p / "music.sql").exists()), key=_release_key)

# (release, database, check) -> why it fails. check is "schema", "logs",
# "integrity" or "rows:<table>".
KNOWN_BUGS: dict = {}

# Changes a migration makes to existing rows on purpose: (database, table, column) -> why.
_INTENDED_CHANGES = {
    ("music", "similar_artists", "occurrence_count"):
        "_requeue_similar_artists_rematch resets it to 1 once, for a refetch of every artist's similars",
    ("music", "similar_artists", "id"):
        "the pre-2.0 UNIQUE(source_artist_id, similar_artist_name) rebuild in _add_discovery_tables "
        "copies rows without their ids; nothing references similar_artists.id",
}

# Tables of per-profile rows: rows from before the table had a profile_id
# belong to the admin profile.
_ADMIN_PROFILE = 1
_PROFILE_SCOPED = {
    ("music", "wishlist_tracks"), ("music", "watchlist_artists"), ("music", "similar_artists"),
    ("music", "recent_releases"), ("music", "discovery_pool"), ("music", "listenbrainz_playlists"),
    ("music", "mirrored_playlists"), ("video", "video_watchlist"), ("video", "video_wishlist"),
}

_DB_CLASSES = {"music": MusicDatabase, "video": VideoDatabase}


def _manifest(release: str) -> dict:
    return json.loads((FIXTURES / release / "manifest.json").read_text(encoding="utf-8"))


def _known_bug(release: str, database: str, check: str) -> list:
    reason = KNOWN_BUGS.get((release, database, check))
    return [pytest.mark.xfail(strict=True, reason=reason)] if reason else []


def _releases(database: str, check: str) -> list:
    return [pytest.param(release, id=release, marks=_known_bug(release, database, check))
            for release in RELEASES if (FIXTURES / release / f"{database}.sql").exists()]


def _release_tables(database: str) -> list:
    """(release, table) for every table a fixture has representative rows in."""
    params = []
    for release in RELEASES:
        tables = dict.fromkeys(r["table"] for r in _manifest(release)["rows"] if r["db"] == database)
        params += [pytest.param(release, table, id=f"{release}-{table}",
                                marks=_known_bug(release, database, f"rows:{table}")) for table in tables]
    return params


# ── booting a database the way the app does ─────────────────────────────────

class _Collector(logging.Handler):
    """Records from this thread only: a background thread left over from
    another test must not be blamed on this initialisation."""

    def __init__(self):
        super().__init__(logging.DEBUG)
        self.records: list[logging.LogRecord] = []
        self._seen: set[int] = set()
        self._thread = threading.get_ident()

    def emit(self, record):
        if record.thread == self._thread and id(record) not in self._seen:
            self._seen.add(id(record))
            self.records.append(record)


@dataclass
class Boot:
    path: Path
    exception: str | None = None
    errors: list[str] = field(default_factory=list)


def _boot(database: str, path: Path) -> Boot:
    collector = _Collector()
    loggers = [logging.getLogger(), logging.getLogger("soulsync")]
    for lg in loggers:
        lg.addHandler(collector)
    boot = Boot(path)
    try:
        _DB_CLASSES[database](str(path))
    except Exception:
        boot.exception = traceback.format_exc()
    finally:
        for lg in loggers:
            lg.removeHandler(collector)
    boot.errors = [f"{r.levelname} {r.name}: {r.getMessage()}" for r in collector.records if r.levelno >= logging.ERROR]
    return boot


def _load_dump(sql: Path, path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(sql.read_text(encoding="utf-8"))
    finally:
        conn.close()


@pytest.fixture(scope="module")
def booted(tmp_path_factory):
    """``booted(database, release=None)``: that release's dump upgraded by the
    current code, or a fresh install when release is None. Once per module."""
    cache = {}

    def get(database: str, release: str | None = None) -> Boot:
        key = (database, release)
        if key not in cache:
            path = tmp_path_factory.mktemp(f"{database}-{release or 'fresh'}") / f"{database}_library.db"
            if release:
                _load_dump(FIXTURES / release / f"{database}.sql", path)
            cache[key] = _boot(database, path)
        return cache[key]

    return get


@pytest.fixture(scope="module")
def old_schema(tmp_path_factory):
    """``old_schema(database, release)``: the dump's schema before the current
    code touches it."""
    cache = {}

    def get(database: str, release: str) -> Schema:
        if (database, release) not in cache:
            path = tmp_path_factory.mktemp(f"{database}-{release}-as-dumped") / "old.db"
            _load_dump(FIXTURES / release / f"{database}.sql", path)
            cache[(database, release)] = _schema(path)
        return cache[(database, release)]

    return get


def _upgraded(booted, database: str, release: str) -> Boot:
    boot = booted(database, release)
    if boot.exception:
        pytest.fail(f"initialising the {release} {database} database raised\n{boot.exception}")
    return boot


# ── schema snapshot and comparison ──────────────────────────────────────────

@dataclass
class Schema:
    columns: dict      # table -> {column: (type, notnull, default, pk)}
    indexes: dict      # name -> (table, unique, partial, ((column, desc, collation), ...))
    uniques: set       # (table, (column, ...)) for every full unique index or constraint
    triggers: set
    views: set


def _schema(path: Path) -> Schema:
    conn = sqlite3.connect(path)
    try:
        columns, indexes, uniques, triggers, views = {}, {}, set(), set(), set()
        for kind, name in conn.execute("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"):
            if kind == "table":
                # an ALTER TABLE ... DEFAULT NULL column is the same as no default
                columns[name] = {c[1]: (c[2].upper(), c[3], None if c[4] == "NULL" else c[4], c[5])
                                 for c in conn.execute(f'PRAGMA table_info("{name}")')}
            elif kind == "trigger":
                triggers.add(name)
            elif kind == "view":
                views.add(name)
        for table in columns:
            for _seq, index, unique, origin, partial in conn.execute(f'PRAGMA index_list("{table}")'):
                keys = tuple((c[2], c[3], c[4]) for c in conn.execute(f'PRAGMA index_xinfo("{index}")') if c[5])
                if origin == "c":
                    indexes[index] = (table, unique, partial, keys)
                if unique and not partial:
                    uniques.add((table, tuple(k[0] for k in keys)))
        return Schema(columns, indexes, uniques, triggers, views)
    finally:
        conn.close()


def _describe_index(spec) -> str:
    table, unique, partial, keys = spec
    cols = ", ".join(f"{c}{' DESC' if desc else ''}" for c, desc, _coll in keys)
    return f"{'UNIQUE ' if unique else ''}{table}({cols}){' WHERE ...' if partial else ''}"


def _compare(fresh: Schema, upgraded: Schema) -> tuple[list[str], list[str]]:
    """(what keeps the upgraded database from being the current schema,
    leftovers only the upgraded database has)."""
    problems, leftovers = [], []
    for table, cols in sorted(fresh.columns.items()):
        if table not in upgraded.columns:
            problems.append(f"table {table} is missing")
            continue
        for col, spec in cols.items():
            have = upgraded.columns[table].get(col)
            if have is None:
                problems.append(f"column {table}.{col} is missing")
            elif have != spec:
                problems.append(f"column {table}.{col} differs (type, notnull, default, pk): "
                                f"fresh {spec}, upgraded {have}")
        leftovers += [f"column {table}.{c}" for c in upgraded.columns[table] if c not in cols]
    leftovers += [f"table {t}" for t in sorted(set(upgraded.columns) - set(fresh.columns))]

    for name, spec in sorted(fresh.indexes.items()):
        have = upgraded.indexes.get(name)
        if have is None:
            problems.append(f"index {name} on {_describe_index(spec)} is missing")
        elif have != spec:
            problems.append(f"index {name} differs: fresh {_describe_index(spec)}, upgraded {_describe_index(have)}")
    leftovers += [f"index {n} on {_describe_index(s)}" for n, s in sorted(upgraded.indexes.items())
                  if n not in fresh.indexes]

    for table, cols in sorted(fresh.uniques - upgraded.uniques):
        if table in upgraded.columns:
            problems.append(f"unique constraint on {table}({', '.join(cols)}) is missing")
    leftovers += [f"unique constraint on {t}({', '.join(c)})" for t, c in sorted(upgraded.uniques - fresh.uniques)]

    for kind, mine, theirs in (("trigger", fresh.triggers, upgraded.triggers), ("view", fresh.views, upgraded.views)):
        problems += [f"{kind} {n} is missing" for n in sorted(mine - theirs)]
        leftovers += [f"{kind} {n}" for n in sorted(theirs - mine)]
    return problems, leftovers


# ── rows ────────────────────────────────────────────────────────────────────

def _genres(value):
    """genres are stored as JSON now; early releases wrote 'A, B'."""
    if value in (None, ""):
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        parsed = value.split(",")
    return [g.strip() for g in parsed if g and g.strip()]


_NORMALISE = {"genres": _genres}


def _row_problems(database: str, table: str, specs: list, old: Schema, path: Path) -> list[str]:
    problems = []
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        for spec in specs:
            key = spec["key"]
            label = f"{table} row {key}"
            where = " AND ".join(f'"{k}" = ?' for k in key)
            try:
                rows = conn.execute(f'SELECT * FROM "{table}" WHERE {where}', list(key.values())).fetchall()
            except sqlite3.Error as e:
                problems.append(f"{label}: cannot be read ({e})")
                continue
            if len(rows) != 1:
                problems.append(f"{label}: expected 1 row, found {len(rows)}")
                continue
            row = rows[0]
            for col, before in spec["values"].items():
                if col not in row.keys() or (database, table, col) in _INTENDED_CHANGES:
                    continue  # a retired column is listed by the schema test
                norm = _NORMALISE.get(col, lambda v: v)
                if norm(row[col]) != norm(before):
                    problems.append(f"{label}: {col} was {before!r}, now {row[col]!r}")
            if ((database, table) in _PROFILE_SCOPED and "profile_id" not in old.columns.get(table, {})
                    and "profile_id" in row.keys() and row["profile_id"] != _ADMIN_PROFILE):
                problems.append(f"{label}: a legacy row should belong to the admin profile, "
                                f"profile_id is {row['profile_id']!r}")
    finally:
        conn.close()
    return problems


# ── tests ───────────────────────────────────────────────────────────────────

def test_fixtures_present():
    assert RELEASES, f"no fixtures under {FIXTURES}"


@pytest.mark.parametrize("database", ["music", "video"])
def test_fresh_install_logs_no_errors(booted, database):
    """The baseline: an error here is not upgrade-specific."""
    boot = booted(database)
    assert boot.exception is None, f"initialising a fresh {database} database raised\n{boot.exception}"
    assert not boot.errors, f"a fresh {database} database logged errors:\n  " + "\n  ".join(boot.errors)


def _check_schema(booted, database: str, release: str) -> None:
    fresh = booted(database)
    assert fresh.exception is None, f"initialising a fresh {database} database raised\n{fresh.exception}"
    upgraded = _upgraded(booted, database, release)
    problems, leftovers = _compare(_schema(fresh.path), _schema(upgraded.path))
    if leftovers:
        print(f"{release} {database}: {len(leftovers)} leftover(s) a fresh install doesn't have:\n  "
              + "\n  ".join(leftovers))
    assert not problems, (f"the {release} {database} database after upgrade is not the current schema "
                          f"({len(problems)} difference(s)):\n  " + "\n  ".join(problems))


def _check_rows(booted, old_schema, database: str, release: str, table: str) -> None:
    upgraded = _upgraded(booted, database, release)
    specs = [r for r in _manifest(release)["rows"] if r["db"] == database and r["table"] == table]
    problems = _row_problems(database, table, specs, old_schema(database, release), upgraded.path)
    assert not problems, f"{release} {database} data after upgrade:\n  " + "\n  ".join(problems)


def _check_integrity(booted, database: str, release: str) -> None:
    conn = sqlite3.connect(_upgraded(booted, database, release).path)
    try:
        problems = [f"foreign key violation (table, rowid, parent, fk): {tuple(v)}"
                    for v in conn.execute("PRAGMA foreign_key_check")]
        problems += [f"integrity_check: {r[0]}" for r in conn.execute("PRAGMA integrity_check") if r[0] != "ok"]
    finally:
        conn.close()
    assert not problems, f"the {release} {database} database after upgrade:\n  " + "\n  ".join(problems)


def _check_logs(booted, database: str, release: str) -> None:
    boot = _upgraded(booted, database, release)
    assert not boot.errors, f"upgrading the {release} {database} database logged errors:\n  " + "\n  ".join(boot.errors)


@pytest.mark.parametrize("release", _releases("music", "schema"))
def test_music_schema_matches_fresh_install(booted, release):
    _check_schema(booted, "music", release)


@pytest.mark.parametrize(("release", "table"), _release_tables("music"))
def test_music_rows_survive(booted, old_schema, release, table):
    _check_rows(booted, old_schema, "music", release, table)


@pytest.mark.parametrize("release", _releases("music", "integrity"))
def test_music_integrity_after_upgrade(booted, release):
    _check_integrity(booted, "music", release)


@pytest.mark.parametrize("release", _releases("music", "logs"))
def test_music_upgrade_logs_no_errors(booted, release):
    _check_logs(booted, "music", release)


@pytest.mark.parametrize("release", _releases("video", "schema"))
def test_video_schema_matches_fresh_install(booted, release):
    _check_schema(booted, "video", release)


@pytest.mark.parametrize(("release", "table"), _release_tables("video"))
def test_video_rows_survive(booted, old_schema, release, table):
    _check_rows(booted, old_schema, "video", release, table)


@pytest.mark.parametrize("release", _releases("video", "integrity"))
def test_video_integrity_after_upgrade(booted, release):
    _check_integrity(booted, "video", release)


@pytest.mark.parametrize("release", _releases("video", "logs"))
def test_video_upgrade_logs_no_errors(booted, release):
    _check_logs(booted, "video", release)
