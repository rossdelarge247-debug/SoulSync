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

### Activity feed: `GET /api/activity`

One newest-first list of what SoulSync did, plus what needs you. Query: `range` (`today`, `7d` default, `30d`), `kind` (`all`, `download`, `import`, `automation`, `sync`, `safety`, `needs_you`), `limit` (1–200, default 50), `before` (the previous page's `next_before`, or unix seconds) and `since` (unix seconds; use it to send the browser's own midnight for "Today", since `today` alone means the server's midnight).

```json
{
  "items": [
    {"id": "automation:812", "time": 1792569302, "kind": "automation", "status": "error",
     "title": "Automation \"Fill Wanted\" failed",
     "detail": "Soulseek wasn't reachable. Next run in about 2 hours.",
     "link": "/automations", "needs_you": true, "has_log": true, "retry_at": 1792576500,
     "ref": {"automation_id": 4, "run_id": 812}},
    {"id": "lh:5120", "time": 1792561320, "kind": "download", "status": "ok",
     "title": "Downloaded 12 tracks", "detail": "Lantern by Saltmarsh and 1 more · Soulseek · FLAC",
     "link": "/active-downloads", "needs_you": false,
     "ref": {"first_history_id": 5109, "last_history_id": 5120, "tracks": 12}}
  ],
  "next_before": "WzE3OTI1NjEzMjAsMSw1MTIwXQ", "range": "7d", "since": 1791964800, "kind": "all",
  "counts": {"download": 14, "import": 2, "automation": 6, "sync": 3, "safety": 1, "needs_you": 2},
  "running_count": 1,
  "needs_you": [{"id": "safety:31", "kind": "safety", "status": "warning",
                 "title": "Duplicate cleaner preview expired",
                 "detail": "Nothing was changed. Preview again to recycle 214 duplicate files (3.2 GB).",
                 "link": "/tools", "needs_you": true, "ref": {"tool": "duplicate_cleaner", "plan_id": "…"}, "…": "…"}],
  "generated_at": 1792570000
}
```

- `status` is `running`, `ok`, `warning`, `error` or `info`. `detail` is one line; on a failure it says why and, when an automation will retry, when (`retry_at` is that time).
- `counts` covers the range, per kind, whatever `kind` and `before` are. `needs_you` (and `counts.needs_you`) ignores the range. `kind=needs_you` returns that list as `items`.
- `running_count`: download batches in progress, automations running, auto-imports processing.
- **Badges:** `GET /api/activity/status` returns just `{"running_count": 1, "needs_you_count": 2, "generated_at": 1792570000}`, with the same visibility and no list or per-kind counts, so the shell can poll it from every page (about 30 ms on a very large install, a few ms on a typical one).
- Logs aren't in the list: `has_log` says one exists, `GET /api/activity/log/<id>` returns `{"log_lines": [{"type", "text"}]}` for `automation:` and `mirror:` items.
- `ref` carries the ids an action needs (automation id, auto-import id, tool and plan id, batch id). Import items from the import folder also carry `import_status` (`pending_review`, `needs_identification`, `partial`, `failed`, `completed`, …), so a page can offer "Choose" only for a folder waiting on a choice and "Retry now" only for one that failed.
- Library history is one row per track, so tracks landing within 15 minutes of each other are one item. A download batch shows on its own only while it runs, if it stopped part way, or if tracks failed; otherwise the tracks it landed are the item. Seeded system automations show only when a run fails (Auto-Scan Watchlist always shows).
- Who sees what follows the history routes: downloads and imports are the shared library's; auto-imports need the Import page; automation runs are your automations plus the system ones; mirror runs and playlist syncs are yours; preview outcomes are admins' or the previewer's.

**Needs you** comes from current state and clears itself when the thing is dealt with:

| Kind | Needs you while | Clears when |
| --- | --- | --- |
| import | an auto-import folder is waiting for a choice (`pending_review`, `needs_identification`), was only partly imported, or failed | it's approved, imported by hand, retried or dismissed on Import |
| sync | a mirrored playlist's latest mirror run failed, or had a phase fail, on authorisation (401/403, token, login) | a later mirror run works |
| automation | an enabled automation's latest run failed or timed out (system automations: admins only) | a later run works, or it's switched off |
| download | an album or track download finished with failed tracks, none of them on Wanted, so nothing retries them | that release is downloaded again |
| safety | a preview expired without being confirmed | the same tool is previewed again or confirmed, or `POST /api/activity/dismiss {"id": "safety:31"}` |

Only `safety` items can be dismissed. Expired and confirmed previews are recorded from this release on (`action_plan_events`); earlier ones, and previews pending when SoulSync restarts, leave no record.

### Home targets: `GET /api/targets/summary`

The four targets in fixed order: `wanted`, `mirrored`, `followed`, `quality`. For each, `items` = `have` + `in_progress` + `not_found_yet`, in tracks.

```json
{
  "targets": [
    {"key": "wanted", "set_up": true, "items": 312, "have": 248, "in_progress": 41, "not_found_yet": 23,
     "unit": "tracks", "found_window_days": 30,
     "next_search_at": 1792577000, "next_search_automation": {"id": 3, "name": "Auto-Process Wishlist"},
     "schedule_paused": false, "status": "searching", "reason": null},
    {"key": "mirrored", "set_up": false, "items": 0, "have": 0, "in_progress": 0, "not_found_yet": 0,
     "playlists": 0, "status": "not_set_up", "…": "…"},
    {"key": "followed", "set_up": true, "artists": 18, "status": "cant_search",
     "reason_code": "download_source_unreachable",
     "reason": "Soulseek (slskd) didn't answer when SoulSync last checked, 4 minutes ago, so searches can't run.",
     "checked_at": 1792569760, "…": "…"},
    {"key": "quality", "set_up": true, "name": "FLAC or better", "preset": "flac",
     "tracks_checked": 4980, "meeting_target": 4512, "items": 4980, "have": 4512, "in_progress": 120,
     "not_found_yet": 348, "quality_profile_id": 1, "quality_profile_name": "Balanced", "…": "…"}
  ],
  "any_set_up": true,
  "download_source": {"reachable": true, "checked_at": 1792569760},
  "generated_at": 1792570000
}
```

- **wanted**: your Wanted tracks, plus the ones found from it in the last 30 days (`have`). `in_progress` is still retried every cycle or soon; `not_found_yet` has reached the slowest retry cadence (4+ tries with the standard retry profile).
- **mirrored**: tracks across your mirrored playlists: in the library (`have`), on Wanted (`in_progress`), neither (`not_found_yet`). `playlists` counts them.
- **followed**: new-release tracks from the artists you follow: on Wanted from the watchlist scan (split as for Wanted), and downloaded for one of them in the last 30 days (`have`). `artists` counts who you follow.
- **quality**: library tracks checked against the default quality profile (`tracks_checked`, `meeting_target`); `in_progress` is upgrades queued on Wanted. Checked from the file type and stored bitrate, no file reads.
- `status` is `not_set_up`, `cant_search` (the download source failed its last check, within 30 minutes; the check /status already makes, never a new probe), `searching` (something in progress) or `ok`. `reason` is set only for `cant_search`.
- `next_search_at` is the soonest run of an enabled automation you can see that serves the target; null when none, or when automations are paused (`schedule_paused`).
- `any_set_up` ignores quality: a default quality profile ships with every install, so that card is never "not set up". With the other three not set up, Home shows its single setup panel.
- Numbers refresh at most every 30 seconds; quality counts at most every 10 minutes.
- **"Try now" on a card that can't search** uses the existing download-source check, `POST /api/test-connection` with `{"service": "soulseek"}` (it tests whichever download source is configured, as Settings' test button does): `{"success": true, "message": "…"}` updates the cached check, so the next summary stops saying `cant_search`; `{"success": false, "error": "slskd is not connected to the Soulseek network. …"}` leaves it, and Home shows that sentence. It doesn't start a search.

### Quality presets: `GET /api/quality/presets`

For the "Set a quality target" dialog.

```json
{
  "total": 4980, "unknown_format": 12,
  "presets": [
    {"key": "mp3_320", "name": "MP3 320", "meeting": 4931, "total": 4980, "estimated": false},
    {"key": "flac", "name": "FLAC", "meeting": 4512, "total": 4980, "estimated": false},
    {"key": "flac_24", "name": "FLAC 24-bit", "meeting": 612, "total": 4980, "estimated": true},
    {"key": "lossless", "name": "Any lossless", "meeting": 4560, "total": 4980, "estimated": false}
  ],
  "current": {"preset": "flac", "name": "FLAC or better", "quality_profile_id": 1,
              "quality_profile_name": "Balanced", "updated_at": 1773446400,
              "upgrade_existing": true, "fallback_enabled": true,
              "targets": [{"label": "FLAC 24-bit/192kHz", "format": "flac", "bit_depth": 24, "min_sample_rate": 192000},
                          {"label": "FLAC 16-bit", "format": "flac", "bit_depth": 16}]}
}
```

- Counted from each track's file type and stored bitrate. `estimated` marks FLAC 24-bit: bit depth isn't stored, so a FLAC counts as 24-bit at 1450 kbps or more (the rule downloads already use). `.m4a` counts as ALAC at 500 kbps or more.
- MP3 320 counts lossless files and lossy ones at 320 kbps or more. Any lossless is FLAC, ALAC, WAV/AIFF and DSD.
- `current` is the default quality profile; `preset` is null when its targets don't match a preset, and `name` then comes from its lowest target. `updated_at` is when that profile was last saved or made the default; SoulSync doesn't record when the target itself changed.
- `current.upgrade_existing` is true when the profile keeps upgrading tracks below the target (`upgrade_policy` `until_cutoff`); the "Apply Quality Upgrades" automation acts only on those. `current.fallback_enabled` is true when a search that finds nothing at the target takes the best other copy. `current.targets` is the target's bar: a file meets the target when it meets any one of them (the Search page's "At your target" filter uses it).

### Quality target: `PUT /api/quality/target`

Admin only (403 otherwise). Makes a preset the target by writing its ladder into the default quality profile, through the same writes Settings → Quality uses.

```json
{"preset": "flac", "upgrade_existing": true, "based_on": 1773446400}
```

- `preset` is `mp3_320`, `flac`, `flac_24` or `lossless`. `upgrade_existing` sets the profile's upgrade policy (`until_cutoff` when true, `acceptable` when false). The rest of the profile (fallback, size limits, per-format settings) is left as it was.
- `based_on` (optional) is the `current.updated_at` the dialog showed. When the profile was saved since, nothing changes: `409 {"success": false, "error": "target_changed", "message": "The quality target was changed somewhere else while this was open. Nothing was saved."}`.
- `400 unknown_preset` or `bad_based_on`; `500 no_profile` or `write_failed`, each with a `message` sentence.
- Success answers with the presets payload above (`{"success": true, "presets": [...], "current": {...}}`), so the dialog shows the new numbers without asking again. Home's quality counts are recounted on the next summary.

### Search: `POST /api/search/stream`

The Search page's file search. The same search as `POST /api/search` (same `{"query", "source"}`; `source` picks one download source in hybrid mode), answered as newline-delimited JSON while it runs:

```
{"type": "progress", "files": 48, "users": 12, "results": [ … ]}
{"type": "waiting"}
{"type": "progress", "files": 55, "users": 12, "results": [ … ]}
{"type": "done", "files": 55, "users": 12, "results": [ … ]}
```

- `waiting` comes every 2 seconds while nothing new has arrived. It carries nothing to show; it's there so a closed tab is noticed on the next write and the search's request thread is freed instead of waiting out slskd. Clients skip any line type they don't know.

- `results` is the whole list so far each time (the same album and track shapes as `/api/search`), not just what's new. Progress lines come at most once a second, as Soulseek reports; other sources answer once, with `done`.
- `files` counts every file, tracks inside folders included. `users` is how many Soulseek users answered, or `null` when the source doesn't say.
- A failed search ends with `{"type": "error", "error": "<a sentence>"}`. An empty query is `400 {"error": "No search query provided."}`.
- Closing the connection ends the stream within about 2 seconds, but doesn't cancel the search on slskd; that finishes on its own timeout, as `/api/search` does.
- The Search page calls it only for a submitted query (`files=1` in its URL), never while you type.

### Library check: `POST /api/enhanced-search/library-check`

Already used by search; one addition. For each `{"name", "artist"}` in `tracks`, the answer at the same position now also carries the owned copy's stored `bitrate` (kbps, or `null`) beside `file_path`, so a page can name the copy you have ("upgrades your MP3 320 copy").

### Navigation shell badges

What the shell (`src/shell/nav-shell.ts`) reads, and how:

- **`GET /api/activity/status`** → `{"success", "running_count", "needs_you_count", "generated_at"}` for the top bar's "N running" link and Activity's needs-you badge. Built (Activity feed above). The shell polls it every 30 seconds while the tab is visible and again soon after the app's activity socket events (`ss:dashboard-activity`, `ss:automation-progress`, a change in active downloads). A 404, an error or `success: false` is unknown: no count, no badge, never "0". After a 404 it asks every 5 minutes instead.
- **The Setup check dot**: the fast local run, `GET /api/setup/check?scope=local` (admin only), once per visit about four seconds after the app is up, cached in the tab's `sessionStorage` for 10 minutes; and every report the Setup check page itself gets (it announces each one as the `ss:setup-check-report` window event, so the full run's answer replaces the local one). Warnings and problems both light the dot. Non-admins don't ask; they don't see the row.

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

The Activity feed above already merges these (and the mirror runs behind `GET /api/playlist-pipeline/history`); use them for a page about one of them.

## Needs building

Nothing at the moment. Ask in `HANDOFF.md`.

Shapes under "Needs building" are proposals until built. Dev updates this file when they are.
