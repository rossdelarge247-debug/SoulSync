# Contracts: the data screens can rely on

What the API gives each screen today, and what would have to be built. Design within this. If a screen needs something new, ask in `HANDOFF.md`.

## Built

### Setup check: `GET /api/setup/check`

Admin only. `?scope=local` runs only the fast local checks (folders, folder layout, running user, and from settings alone whether a library is chosen). The full run can take up to about 25 seconds, because it calls slskd and the media server.

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
- **Recycle bin and quarantine (permanent):** `POST /api/deleted-files/purge-preview` (`{all}`, `{ids}`, or `{retention: true}` for what the recycle bin's keep window lets go now, which is what Library clean-up empties; its `meta.scope` is `retention`) and `POST /api/quarantine/clear-preview` return the count, total size, oldest and newest dates and a sample. `/api/deleted-files/purge` and `/api/quarantine/clear` only accept `{plan_id}`.
- **Video recycle bin (permanent):** `POST /api/video/downloads/recycle/purge-preview` takes `{all: true}` or `{entries: [{trash_dir, name}]}` and returns the same numbers (`files`, `total_bytes`, `oldest`, `newest`) plus `recycle_enabled`. Each sample item has `entry` (its name in the bin), `name` (without the stamp), `path` (where it came from, when recorded), `size`, `deleted_at` and `reason`. `/api/video/downloads/recycle/purge` only accepts `{plan_id}` and answers `{purged, skipped, errors, freed_bytes}`; an entry restored or replaced since the preview is skipped. Tool `video_recycle_purge`. Gated like the bin's other routes (the video side switch).
- **Audiobook recycle bin (permanent):** `POST /api/audiobooks/library/recycle/purge-preview` takes `{all: true}` or `{names: [...]}` (names in the bin) and returns the same shape, one item per book (`kind: folder`, `size` is everything under it, `path` is where it would go back to). `/api/audiobooks/library/recycle/purge` only accepts `{plan_id}`; so do `DELETE /api/audiobooks/library/recycle` and `DELETE /api/audiobooks/library/recycle/<name>`. Tool `audiobook_recycle_purge`. Gated by the Audiobooks page.
- **Video repair fixes:** `POST /api/video/repair/findings/bulk-fix-preview` takes `ids`, or `job_id` / `severity`, plus an optional `fix_action`, then `/api/video/repair/findings/bulk-fix` with `{plan_id}` fixes exactly those findings. Each item has `reason` (the finding), `path`, `size`, a sentence `effect` and `effect_kind` (`move`, `recycle`, `delete`, `library`, `write`, `none`); the preview adds `destructive`, `by_effect` (fixes per effect), `files_by_effect` (the files those fixes move, recycle or delete: a Watched Cleanup fix deletes every file the movie has, so this can be more than the fixes; each item has its `files` too), `per_type` and `recycle_deletes`. Without a plan, a selection that includes Watched Cleanup or Naming Conformance is `409 plan_required` with `plan` attached; anything else runs as before. Tool `video_repair_bulk_fix`. Admin only, like all video repair routes.
- **Lossy Converter (part of Repair fixes):** a bulk run over `missing_lossy_copy` findings whose quality profile keeps the lossy output only needs a plan. The preview adds `lossy: {convert, delete_originals, originals_bytes, estimated_freed_bytes, labels, recycle}` (`estimated_freed_bytes` is null when a track has no duration); each such item says "Converts to MP3-320, then moves the lossless original to the recycle bin" (or "deletes … permanently"), counts as `destructive` and carries the original's `size`. A confirmed plan deletes an original only where its preview said so; a bulk run without a plan never does. `GET /api/repair/finding-types` marks `missing_lossy_copy` as `destructive` while any profile keeps the lossy output only, and `safe_only` leaves those findings out.

### Activity feed: `GET /api/activity`

One newest-first list of what SoulSync did, plus what needs you. Query: `range` (`today`, `7d` default, `30d`), `kind` (`all`, `download`, `import`, `automation`, `sync`, `safety`, `needs_you`), `limit` (1–200, default 50), `before` (the previous page's `next_before`, or unix seconds) and `since` (unix seconds; use it to send the browser's own midnight for "Today", since `today` alone means the server's midnight).

```json
{
  "items": [
    {"id": "automation:812", "time": 1792569302, "kind": "automation", "status": "error",
     "title": "Automation \"Fill Wanted\" failed",
     "detail": "Soulseek wasn't reachable. Next run in about 2 hours.",
     "link": "/automations?automation=4", "needs_you": true, "has_log": true, "retry_at": 1792576500,
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
- Automation items (runs and running ones) link to `/automations?automation=<id>`. A preview run (below) is `status: info`, titled `Automation "Fill Wanted": preview`, with `ref.preview: true`; it never hides a failure from Needs you.
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

A `safety` item also records each lossless original the post-download conversion deleted under "Keep lossy output only" (nothing previews those, so each is written down): `status: info`, title "Lossy copy: lossless original deleted", detail "Converted 01 Song.flac to MP3-320, checked the copy, then deleted the lossless original (30 MB) for good, as the quality profile says.", `ref: {tool: "lossy_copy_import", path, kept}`. Admins see these; they never need you. Confirmed and expired previews of the video bin, the audiobook bin and video repair fixes link to `/active-downloads?media=video`, `/audiobooks` and `/video-tools`.

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
- **A service that's down**: no new request. The shell reads the `/status` frames the app already broadcasts as the `ss:service-status` window event (the socket push and the HTTP fallback both send it). A service with `connected: false` is down: `media_server` (unless `configured` is `false`: no library chosen, which Home and the Setup check say), `soulseek` (the download source) and `metadata_source` (unless Spotify is rate limited or cooling down, which is paused). It lights "Admin and help" and says so on the music Connections row ("Plex is down"); a slice that hasn't arrived counts as nothing.
- **Unread notifications** (phones): `downloads.js` announces the unread count as the `ss:notifications-unread` window event and the panel's opening and closing as `ss:notif-panel`; the top bar's Activity icon lights its dot for either something that needs you or an unread notification.

### Wanted page

Three read-only routes, scoped to the current profile and open to every profile, like the wishlist and watchlist routes beside them.

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

**What came in for each followed podcast: `GET /api/podcasts/watchlist/summary`** (the Following tab, 5e). One entry per show the profile follows, matched to `/api/podcasts/watchlist` by `feed_url`:

```json
{
  "success": true, "new_episode_days": 7,
  "podcasts": [
    {"feed_url": "https://…/exchange.xml", "kept": 40,
     "latest_episode": {"title": "EX.761", "downloaded_at": "2026-10-22T09:00:00Z"},
     "new_episode": true}
  ]
}
```

- `kept` counts downloaded episodes whose files are still there (not pruned by the show's keep setting).
- `latest_episode` (or `null`) is the newest episode downloaded, pruned or not, from the download record.
- `new_episode` is true when that download was in the last `new_episode_days` days. A show that doesn't download new episodes has no way to say it has one: its check only counts episodes.

Read-only, scoped to the current profile, behind the Podcasts module like the rest of `/api/podcasts`.

**Also read by the page, unchanged:**

- `/api/wishlist/tracks?category=albums|singles`, `/api/wishlist/stats` and `/api/wishlist/cycle` (a wanted item whose `source_type` is `watchlist_label` carries `source_info.label_mbid`: that's how a label's row counts what's on Wanted from it);
- `/api/watchlist/artists`, `/api/watchlist/count`, `/api/watchlist/scan/status` and `/api/watchlist/global-config`;
- `/api/labels/watchlist` (`{labels}` with no `success` key; install-wide, not per profile), `POST /api/labels/watchlist/backlog` and `/remove`;
- `/api/podcasts/watchlist`, `POST /api/podcasts/watchlist/settings`, `/remove` and `/scan-now`, while the Podcasts module is on;
- `/api/audiobooks/watchlist` (authors, narrators and series followed, with `last_scanned_at`, `found_total`, `last_error`), `DELETE /api/audiobooks/watchlist/<name>?role=`, `POST /api/audiobooks/watchlist/scan`, and `/api/audiobooks/wishlist` (what a follow has added, by its authors, narrators or series and `added_at`), while the Audiobooks module is on;
- `/api/automations` and `/api/automations/master`, for the schedule line's names, intervals, next runs and paused state (`scan_watchlist` covers artists and labels; `scan_watchlist_podcasts`; `audiobook_scan_watchlist`);
- `/api/quality-profile/custom`, for quality names on rows;
- `/api/library/artists?search=`, for Open artist.

### Artist page

`/artist-detail/<source>/<id>`, where `<source>` is `library` for a library artist (the id is the library's) or a metadata source (`spotify`, `deezer`, …) for anyone else; `?name=` travels with it for sources that can only look an artist up by name. Search params: `tab` (`tracks`, `similar`; Releases is the default), `show` (`albums`, `missing`; All is the default), `all=true` (every release), `manage=true` (Tracks: the tag and file tools, admins), `album=<library album id>` (old links; opens Tracks on that album).

**One artist's albums against the quality target: `GET /api/quality/artist/<artist_id>`.** New. `artist_id` is the library's artist id. Any profile may read it (the library is shared reading, like the page); it needs a profile (401 without one), and an artist the library doesn't hold is a 404.

```json
{
  "success": true, "artist_id": "42",
  "target": {"name": "FLAC or better", "preset": "flac", "quality_profile_id": 1, "quality_profile_name": "Balanced"},
  "tracks": 132, "below_target": 12,
  "albums": [
    {"id": "811", "title": "Low Light", "tracks": 11, "below_target": 11, "formats": ["MP3 320"]},
    {"id": "812", "title": "Night Ferry", "tracks": 10, "below_target": 0, "formats": ["FLAC"]}
  ]
}
```

- Per album (the artist's own album rows, in the caller's library scope): its tracks with a file, how many are below the default quality profile's bar, and the formats it holds, most tracks first ("FLAC", "MP3 320", "AAC 256"; lossless formats carry no bitrate).
- Judged from each file's type and stored bitrate by the same rules as `/api/quality/presets` (`core/quality/presets.py`): no file reads, FLAC 24-bit by the 1450 kbps estimate, `.m4a` as ALAC at 500 kbps or more. A profile with no targets puts nothing below. Ids are the library's own, as text.
- `tracks` is also the page's "132 tracks" and the Tracks tab's count.

**Which library album a release is: `library_album_id` on completion results.** Each owned result of the library completion stream (`POST /api/library/completion-stream`, and the artist completion routes) now names the library album row the check matched; missing releases carry `null`. The page joins the quality answer on it, and uses it for "Show in your library".

**Also read by the page, unchanged:**

- `GET /api/artist-detail/<id>` (`?source=&name=`): the artist and the discography (the provider's, or the library's albums when the provider fails, with `provider_error`); `enrichment_coverage`.
- `POST /api/library/completion-stream`: ownership per release (`status`, `owned_tracks`, `expected_tracks`, `formats`).
- `GET /api/artist/<id>/discography/gap-fill` and its own completion stream, when "Releases only your other metadata sources list" is on.
- `/api/wishlist/tracks?category=albums|singles`: what's on Wanted, matched to a release by the album id the track was added with, else by title.
- `POST /api/watchlist/check`, `/api/watchlist/artists` (following and "since"), `POST /api/watchlist/add` and `/api/watchlist/remove` (the toggle), `/api/watchlist/artist/<id>/config` (Following settings, About), `/api/watchlist/global-config`.
- `POST /api/artist/<id>/download-discography`: Add to Wanted and Add all missing (NDJSON: a line per release, then `{"status": "complete"}`); it skips tracks you own, tracks already on Wanted and what the release filters leave out.
- `GET /api/artist/similar/<name>`, `GET /api/artist/<id>/top-tracks` and `GET /api/artist/0/lastfm-top-tracks?name=`, `GET /api/library/artist/<id>/enhanced` (Tracks), `GET /api/album/<id>/tracks` (a release's tracks), `POST /api/library/check-tracks` (play what you have), `GET /api/artist/<id>/appears-on`, `GET /api/artist/<name>/concerts`.
- Admin tools, unchanged: `POST /api/library/artist/<id>/sync`, `DELETE /api/library/artist/<id>`, the art and match routes behind Change photo and Check matches.

What the data can't say: a release's full tracklist without fetching it (so "132 tracks" is the tracks you have); whether a whole discography is complete beyond what the provider lists; "Hide" or "Merge" for an artist (neither exists).

### Automations: Preview a run

**`POST /api/automations/<id>/preview`** works out what a run of this automation would do right now, from what SoulSync already stores, and changes nothing. An optional body `{action_type, action_config, then_actions}` previews those (unsaved edits) in place of the saved ones. **`POST /api/automations/preview`** takes the same body for an automation that isn't saved yet.

```json
{
  "success": true, "automation_id": 53, "previewed_at": 1792628814, "duration_ms": 2,
  "available": true, "action_type": "process_wishlist", "files": false,
  "summary": "A run now would search for 35 tracks on Wanted (this turn is albums). 4 tracks wait for their next try. Nothing was searched, downloaded, moved or changed.",
  "counts": [{"key": "would_search", "label": "Would search", "value": 35},
             {"key": "waiting", "label": "Waiting to retry", "value": 4},
             {"key": "unreleased", "label": "Not out yet", "value": 0}],
  "sample": [{"title": "Ferry Songs", "detail": "Saltmarsh · Ferry Songs · 2 tries"}],
  "sample_total": 35, "sample_noun": "track", "reason": null,
  "steps": [{"position": 1, "kind": "action", "type": "process_wishlist", "previewed": true, "note": null},
            {"position": 2, "kind": "then", "type": "telegram", "previewed": false,
             "note": "A preview doesn't send notifications."}],
  "recorded": true, "run_id": 65
}
```

- `available: false` means step 1 can't be tried without doing it; `reason` says why in a sentence to show, `counts` and `sample` are empty. Today these actions can be previewed: `process_wishlist`, `scan_watchlist` (not while the metadata source isn't ready), `refresh_mirrored`, `sync_playlist`, `discover_playlist`, `playlist_pipeline`, `clear_quarantine` and `library_cleanup`.
- At most three `counts`. A count with `"unit": "bytes"` is a size. `sample` is the first five items of `sample_total`, each a title and a detail line.
- `files: true` when the step deletes or moves files. Running it still goes through Preview, then confirm (above); a preview never makes a plan.
- `steps` lists every step in the order the engine runs them. Follow-up steps (`kind: then`) are never run in a preview; `note` says so.
- **Who:** the automation must be your own or a built-in one, else `404`; no profile is `401`. A body without `action_type` (and none saved) is `400`. A failure is `500` with "The preview didn't work. Nothing was changed."
- **Recorded:** when `available`, a preview of your own automation, or of any as an admin, is kept in the run history as `status: preview` (`recorded`, `run_id`). At most 20 previews are kept per automation, so they never push real runs out of the 100 kept. A draft preview is never recorded.

**Run history: `GET /api/automations/<id>/history?limit=&offset=`** returns `{history, total, automation_id}`, newest first. Each run has `id`, `started_at`, `finished_at`, `duration_seconds`, `status` (`completed`, `error`, `timeout`, `skipped`, or `preview`), `summary`, `result_json` (the facts the run produced, when the action records any) and `log_lines` (`[{"type", "text"}]`). `total` counts the runs kept, at most 100 per automation. The Wanted search's runs record only that it started its batches ("Started: 3 album batch(es), 4 per-track for cycle albums"); what they find isn't kept on the run.

**Also used by the pages, unchanged:** `GET`, `POST` `/api/automations`; `GET`, `PUT`, `DELETE` `/api/automations/<id>`; `POST /api/automations/<id>/run`, `/toggle` and `/duplicate`; `POST /api/automations/bulk-toggle`; `PUT /api/automations/group`; `GET /api/automations/blocks`, `/progress` and `/master` (and `POST /master`, admins); `POST /api/automations/test-notify`; `GET /api/scripts`; `GET /api/mirrored-playlists/list`.

## Available today, not yet designed for

- **Library history:** `GET /api/library/history?type=download|import|podcast`. Past downloads and imports.
- **Sync history:** `GET /api/sync/history`. Playlist mirror runs.
- **Download batches:** `GET /api/downloads/batch-history`.

The Activity feed above already merges these (and the mirror runs behind `GET /api/playlist-pipeline/history`); use them for a page about one of them.

## Needs building

For the boards Ross approved on 22 October (`HANDOFF.md`). Field names may change while they're built; Dev moves each section to "Built" when it lands.

### The Assistant (build d; boards 3a–3l, Settings → AI 5a)

**Status: `GET /api/ai/status`** returns `{success, configured, can_use, reason, model}` for everyone, plus `usage` for admins.
- `reason` is `null` when the Assistant can be used, else `not_configured` (no key), `members_not_allowed` (Settings → AI says admins only), `cap_reached` (this month's cap is spent) or `key_refused` (the last test or call was refused).
- `model` is `fast` (the default, "Faster and cheaper") or `best`.
- `usage` is `{month, requests, input_tokens, output_tokens, estimated_cost_usd, drafts_saved, cap_usd}`. The cost is estimated locally from token counts; `cap_usd` is `null` without a cap.

**Settings (admins): `GET`, `PUT /api/ai/settings`; `POST /api/ai/test`.** Settings are `{provider: "anthropic", api_key, model, who_can_use: "admins"|"everyone", monthly_cap_usd}`. `api_key` is write-only: `GET` returns it masked, and it's stored encrypted with the app's other secrets. `POST /api/ai/test` returns `{ok, message}` ("Key accepted", or the provider's reason in plain words).

**The conversation: `POST /api/ai/assistant`**, streamed as server-sent events.
- Body: `{conversation_id?, message, context}`. `context` is `{page: "list"|"editor", automation_id?, draft?, run_id?}`: what's on screen, so "explain this" and "fix this run" need no ids typed.
- Events:
    - `status` `{reading}`: what it's looking at ("your automations and their last 10 runs"), for the Thinking state.
    - `text` `{delta}`: the reply, a piece at a time.
    - `draft` `{draft, summary, why, facts}`: `draft` is exactly the body `POST /api/automations/preview` takes, already checked against `GET /api/automations/blocks` and the viewer's role; `why` is the "Why this shape" line and `facts` the numbers it used.
    - `cant_build` `{missing, nearest}`: what the engine can't do (for example "several actions in a row") and the nearest draft it can build.
    - `suggestions` `{items: [{key, title, reason, draft}]}`.
    - `error` `{code, message}`: `code` is `bad_key`, `no_credit`, `rate_limited`, `offline`, `cap_reached` or `busy` (two streams are already running). Nothing typed is lost.
    - `done` `{conversation_id, usage}`.
- Stop: the browser closes the stream and the server stops calling the provider.
- Library text (track, playlist and automation names, run logs) goes to the model only as quoted data, and every draft is re-checked before it's sent.
- The conversation is kept per profile in the browser session; `conversation_id` lets the server keep the last few turns for context.

**The suggestion card: `GET /api/ai/suggestion`** returns `{suggestion: {key, title, reason, draft_prompt} | null}`: one at a time, only when the Assistant can be used and the reason has a number in it. It's worked out locally from the library's facts (no model call); "Use this" sends `draft_prompt` to the conversation. **`POST /api/ai/suggestion/<key>/dismiss`** is "Not now", kept per profile.

**Additions to existing routes:**
- Automations (`GET /api/automations`, `GET /api/automations/<id>`) gain `paused_at`: when it was turned off, or `null`.
- The Wanted search's runs record what they found on `result_json`: `{found: {tracks, albums}, searched: {tracks, albums}}`, written back when the run's batches finish (HANDOFF 19).

### Internet radio (build e; boards 4a–4k, Settings → Radio 5b–5d)

All behind the "Internet radio" module (`radio` in `GET /api/modules`).

**Stations**
- `GET /api/radio/stations` returns `{favourites: [station], kinds: [{kind, label, stations: [station]}]}` for the built-in picks, in the order electronic, world, eclectic, jazz_soul_funk.
- A station is `{id, name, kind, city, country, logo_url, homepage, description, source, favourite, auto_add, has_now_playing, has_tracklists, streams}`. `source` is `built_in`, `directory` or `your_link`. `streams` is `[{id, codec, bitrate_kbps, lossless, label}]`, best first ("AAC 256 kbps (best offered)").
- `GET /api/radio/stations/<id>` returns one station, with `now_playing` (below) when it's playing.
- `POST`, `DELETE /api/radio/favourites/<station_id>`: favourites are per profile.
- `GET /api/radio/directory?q=&codec=&min_bitrate=&country=&page=` searches the Radio Browser directory: `{results: [station], total}`.

**Playing**
- `POST /api/radio/play` `{station_id, stream_id?}` returns `{play_url, mode, session_id}`. `mode` is `direct` (an `https` stream that allows it) or `relay`, where `play_url` is `/api/radio/relay/<session_id>`. A relay passes on audio only and ends when the listener stops. Relays are capped (two at once to start; a third gets `{error: "busy"}`), because each holds one of the server's threads.
- `POST /api/radio/stop` `{session_id}`.

**Now playing:** `GET /api/radio/now-playing?station_id=`, also pushed over Socket.IO as `radio:now_playing` while a station plays. It returns `{state, track, source, identified_at, library, on_wanted, reason}`.
- `state`: `identified`, `listening`, `not_identified`, `off` (identification turned off) or `unavailable`.
- `track`: `{artist, title, release, art_url}` or `null`.
- `source`: `station_feed`, `stream_titles` or `fingerprint`.
- `library`: `{in_library, below_target, track_id}`.
- `reason`: why when not identified, for example "This is a live DJ mix", or "The station doesn't publish what's playing and the fingerprint service didn't recognise it".

**Heard on radio**
- `GET /api/radio/heard?station_id=&days=` returns `{items: [{id, heard_at, station_id, station_name, artist, title, state, source}]}`, newest first, kept for Settings → Radio's days. `state` is `in_library`, `on_wanted`, `added_by_auto_add`, `not_added` or `cant_match`.
- `POST /api/radio/heard/<id>/want` adds one to Wanted at the quality target; the reply is the item with its new state.

**Auto-add**
- `GET /api/radio/stations/<id>/auto-add` returns `{enabled, identified_yesterday, already_have, would_add, daily_limit}`: the numbers the confirm (4d) shows.
- `PUT` the same route with `{enabled}`; turning it on needs download rights.
- Auto-add skips what's in the library or on Wanted, never adds a track twice, stops at the daily limit, and records an Activity item of a new kind, `radio`, one per station per hour ("Auto-add added 3 tracks from NTS 1").

**Tracklists**
- `GET /api/radio/stations/<id>/shows` returns `{shows: [{id, title, aired_at, track_count}]}` for stations that publish them.
- `GET /api/radio/shows/<id>` returns `{show, tracks: [{position, time, artist, title, state}]}`; a track without an artist has `state: "cant_match"`.
- `POST /api/radio/shows/<id>/want-missing` adds the ones you don't have and returns `{added, skipped}`.

**Your stream links (admins)**
- `POST /api/radio/links/check` `{url}` returns `{ok, codec, bitrate_kbps, sends_titles, error}`. It refuses private and link-local addresses and anything that isn't audio ("This link isn't an audio stream").
- `POST /api/radio/links` `{url, name, kind}` adds a link and needs a passing check; `DELETE /api/radio/links/<id>` removes one.

**Settings (admins):** `GET`, `PUT /api/radio/settings` with `{identification, acoustid_api_key, daily_limit, relay: "when_needed"|"always", prefer_lossless, keep_heard_days}`. `daily_limit` defaults to 50. The AcoustID key is the existing `acoustid.api_key`.

**The radio trigger:** `radio_track_heard` in `GET /api/automations/blocks`, "A track I don't have played on a favourite station", with `{stations: "favourites" | [station ids]}`.

**Setup check:** new rows `radio.fpcalc` (Chromaprint installed) and `radio.acoustid` (key set and accepted), shown while the module is on.

### The player (build c; board 6a)

- **Waveform peaks:** `GET /api/library/tracks/<id>/peaks` returns `{peaks, duration_s}`. `peaks` is 200 values from 0 to 1. The first request for a track answers `202 {pending: true}` and works them out in the background with Sample Studio's decoder (`core/sample/analyze.compute_peaks`). They're kept per track until the file changes, so imports stay as fast as today.
- **Audio details for the readout:** `GET /api/library/tracks/<id>/details` returns `{format, bitrate_kbps, bit_depth, sample_rate, path_label}` ("FLAC 24/96 · 2,304 kbps", "Library → Living room"). The library stores bitrate; bit depth and sample rate are read from the file once and kept on the track.
- **Output devices:** nothing on the server. The browser lists what it can switch to (speakers and headphones in Chrome and Edge; the AirPlay picker in Safari), and the output button hides when the browser offers nothing. Playing on a Plex, Jellyfin or Navidrome client, or Chromecast, isn't proposed yet.
- **Up next and Recent:** the queue stays in the browser as the player keeps it today. Recent comes from the listening history, through a small `GET /api/player/recent?limit=20` returning `{items: [{track_id, title, artist, played_at}]}`.
- **Radio and spoken word:** radio mode uses the radio routes above; podcasts and audiobooks keep their own routes and get the speed button, −15 s / +30 s and chapter ticks.

Shapes under "Needs building" are proposals until built. Dev updates this file when they are.
