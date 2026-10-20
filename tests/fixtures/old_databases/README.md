# Old-release database fixtures

Used by `tests/database/test_upgrade_from_old_releases.py`, which loads each
dump, opens it with the current code the way a boot does, and compares the
result with a fresh install.

Each directory is one release:

- `music.sql`: the music database that release creates on first boot, made by
  that release's own `MusicDatabase`, plus a few representative rows. A plain
  `sqlite3` dump with the database's `PRAGMA user_version` on top.
- `video.sql`: the same for the video database (3.0 and later).
- `manifest.json`: the commit it was built from, and the representative rows
  the test checks survive the upgrade.

| Release | Tagged | Why it is here |
|---|---|---|
| 1.3 | Jan 2026 | Earliest release on the current `/app/data` volume layout. Before profiles. |
| 2.0 | Mar 2026 | First release with profiles and mirrored playlists. |
| 3.0.5 | Jul 2026 | Last 3.0.x. 3.0 introduced the video database (schema v41). |
| 3.3.3 | Sep 2026 | Middle of 3.x (video schema v47). |
| 3.5.0 | Oct 2026 | Recent. Video schema v48, the last before per-profile video lists. |

## Adding a release

```sh
python tests/fixtures/old_databases/generate.py 3.6.0
python -m pytest tests/database/test_upgrade_from_old_releases.py
```

The script fetches the tag into a throwaway clone (git and network access
needed), runs that release's own database initialisation on an empty file and
writes the new directory. It runs the old code unchanged; if an old release
imports a package the current requirements no longer install, pass
`--stub <module>` and it is recorded in `manifest.json`. The test suite never
runs the script.

The representative rows are `MUSIC_ROWS` and `VIDEO_ROWS` in `generate.py`.
Each goes in only where its table exists, with only the columns that release
has.

If the new fixture fails a check, the upgrade is broken for users of that
release: fix the migration, or mark the case in `KNOWN_BUGS` in the test with an
exact reason. Leftover tables, columns and indexes that only the old database
has are printed, not failed.
