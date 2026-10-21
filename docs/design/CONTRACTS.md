# Contracts: the data screens can rely on

What the API gives each screen today, and what would have to be built. Design within this. If a screen needs something new, ask in `HANDOFF.md`.

## Built

### Setup check: `GET /api/setup/check`

Admin only. `?scope=local` runs only the fast local checks (folders, folder layout, running user). The full run can take up to about 25 seconds, because it calls slskd and the media server.

```json
{
  "summary": {"ok": 7, "warning": 1, "error": 1, "skipped": 0},
  "checks": [
    {"id": "media_server.library_path", "title": "Media server sees the music library folder",
     "status": "error", "detail": "One sentence saying what's wrong.",
     "fix": "What to do, with `compose lines` in backticks.", "category": "media_server"}
  ],
  "scope": "all", "ran_at": 1792570000.0, "duration_ms": 4100
}
```

`status` is one of `ok`, `warning`, `error` (shown as "Problem") or `skipped`.

### Modules: `GET /api/modules`, `PUT /api/modules/<name>`

Each module has `name`, `display_name`, `description`, `enabled`, `default_enabled`, `restart_required`, `restart_reason` and `pages`. To change one, `PUT {"enabled": false}` (admin only). While a module is off, its routes answer `409 module_disabled`.

### Preview, then confirm (plans)

Every tool that moves or deletes files first returns a plan:

```json
{
  "plan_id": "…", "tool": "duplicate_cleaner",
  "total": 214, "counts": {"recycle": 214}, "by_reason": {"…": 214},
  "total_bytes": 3435973836, "sample": [{"path": "…", "action": "recycle", "reason": "…", "keep": "…", "size": 123}],
  "truncated": true, "created_at": 1792570000.0, "expires_at": 1792570900.0,
  "expires_in_seconds": 900, "meta": {}
}
```

Item actions include `recycle` (duplicate cleaner) and `move_to_staging` (Deep Scan). The action runs only when sent that `plan_id` while it's fresh: plans last 15 minutes and work once. Refusals are `409` with a code (`plan_required`, `plan_unknown`, `plan_expired`, `plan_wrong_tool`) and a sentence to show the user. Deep Scan also reports when it would move more than 25% of the library; a guarded move needs `confirm_large_move: true`.

Plan routes that exist today:

- **Duplicate cleaner:** `POST /api/duplicate-cleaner/preview`, then `/api/duplicate-cleaner/start` with `{plan_id}`; `GET /api/duplicate-cleaner/plan` pages the full list.
- **Deep Scan:** `POST /api/database/deep-scan/preview`, which also returns `staging_path` and `max_move_percent` (25). `GET /api/database/deep-scan/plan` pages the full list without using the plan up.
- **Repair fixes:** `POST /api/repair/findings/bulk-fix-preview`, then `/api/repair/findings/bulk-fix-start` with `{plan_id}`. Both take a whole type, or a selection as `ids` plus `fix_actions` (finding type → action). Each preview item has a plain sentence ("Moves the file to the recycle bin") and an `effect_kind`. The preview also returns `recycle_deletes`, so copy can say "recycle bin" or "deleted permanently" correctly.
- **Recycle bin and quarantine (permanent):** `POST /api/deleted-files/purge-preview` (`{all}` or `{ids}`) and `POST /api/quarantine/clear-preview` return the count, total size, oldest and newest dates and a sample. `/api/deleted-files/purge` and `/api/quarantine/clear` only accept `{plan_id}`.

### Wanted page

Two read-only routes, scoped to the current profile and open to every profile, like the wishlist and watchlist routes beside them.

**What Wanted found: `GET /api/wishlist/found?days=7`.** `days` is 1 to 30. Tracks Wanted downloaded in that window, newest first, each once:

```json
{
  "success": true, "days": 7, "count": 1,
  "items": [
    {"id": "4uLU6hMCjMI75M1A2tKUQC", "title": "Static Bloom", "artist": "Saltmarsh", "album": "Lantern",
     "quality": "FLAC 24/96", "image": "https://…", "found_at": "2026-10-21T14:02:00Z", "reason": "download_complete"}
  ]
}
```

`reason` is `download_complete` or `atomic_published`. The title, artist, album, quality and art come from the library history entry for the downloaded file; a profile sees a find when that entry lists the profile or lists none.

**Followed-artist numbers: `GET /api/watchlist/artists/summary`.** One entry per followed artist, matched to `/api/watchlist/artists` by `id`:

```json
{
  "success": true, "new_release_days": 7,
  "artists": [
    {"id": 12, "library_releases": 9,
     "latest_release": {"album_name": "Tidewater", "release_date": "2026-10-03"},
     "last_found": {"album_name": "Tidewater", "found_at": "2026-10-19T06:00:00Z", "added_to_wanted": true},
     "new_release": true}
  ]
}
```

- `library_releases` counts the library's albums, EPs and singles under the artist's name, on the active media server when one is set.
- `latest_release` (or `null`) is the newest row of the per-artist release cache.
- `last_found` (or `null`) is the newest release a followed-artist check found, from the check history. `added_to_wanted` is false when the release was found but not added.
- `new_release` is true when something was found in the last `new_release_days` days.

There's no total of an artist's releases: SoulSync doesn't store discographies.

**Also read by the page, unchanged:**

- `/api/wishlist/tracks?category=albums|singles`, `/api/wishlist/stats` and `/api/wishlist/cycle`;
- `/api/watchlist/artists`, `/api/watchlist/count`, `/api/watchlist/scan/status` and `/api/watchlist/global-config`;
- `/api/automations` and `/api/automations/master`, for the schedule line's name, interval and paused state;
- `/api/quality-profile/custom`, for quality names on rows;
- `/api/library/artists?search=`, for Open artist.

## Available today, not yet designed for

- **Automation run history:** `GET /api/automations/<id>/history?limit=&offset=`. Each run has `started_at`, `finished_at`, `duration_seconds`, `status`, `summary`, `result` (counts the run produced) and `log_lines`. The Automations prototype can use this as it is.
- **Library history:** `GET /api/library/history?type=download|import|podcast`. Past downloads and imports.
- **Sync history:** `GET /api/sync/history`. Playlist mirror runs.
- **Download batches:** `GET /api/downloads/batch-history`.

## Needs building

- **Activity feed:** one time-ordered list across downloads, imports, automation runs, playlist mirrors, previews that expired, and problems that need the user. Today it's spread across the four history endpoints above, and Dev would merge them into one endpoint. Proposed item: `time`, `kind` (`download` | `import` | `automation` | `sync` | `safety`), `status` (`ok` | `warning` | `error` | `info`), `title`, `detail`, `link`.
- **Targets summary (Home):** for each target (Wanted, mirrored playlists, followed artists' new releases, quality), how many items, how many you have, how many are in progress or not found yet, and when the next search runs. The counts exist in different places; Dev would add one summary endpoint once Ross approves the Home design.

Shapes under "Needs building" are proposals until built. Dev updates this file when they are.
