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

- **Remove from library (Library → Albums):** `POST /api/library/albums/remove-preview`, then `/api/library/albums/remove` with `{plan_id}`; tool `library_album_remove`, admins only. The files go to the recycle bin (see "Library: Albums, Genres and Artists").
- **Duplicate cleaner:** `POST /api/duplicate-cleaner/preview`, then `/api/duplicate-cleaner/start` with `{plan_id}`; `GET /api/duplicate-cleaner/plan` pages the full list.
- **Deep Scan:** `POST /api/database/deep-scan/preview`, which also returns `staging_path` and `max_move_percent` (25). `GET /api/database/deep-scan/plan` pages the full list without using the plan up.
- **Repair fixes:** `POST /api/repair/findings/bulk-fix-preview`, then `/api/repair/findings/bulk-fix-start` with `{plan_id}`. Both take a whole type, or a selection as `ids` plus `fix_actions` (finding type → action). Each preview item has a plain sentence ("Moves the file to the recycle bin") and an `effect_kind`. The preview also returns `recycle_deletes`, so copy can say "recycle bin" or "deleted permanently" correctly.
- **Recycle bin and quarantine (permanent):** `POST /api/deleted-files/purge-preview` (`{all}`, `{ids}`, or `{retention: true}` for what the recycle bin's keep window lets go now, which is what Library clean-up empties; its `meta.scope` is `retention`) and `POST /api/quarantine/clear-preview` return the count, total size, oldest and newest dates and a sample. `/api/deleted-files/purge` and `/api/quarantine/clear` only accept `{plan_id}`.
- **Video recycle bin (permanent):** `POST /api/video/downloads/recycle/purge-preview` takes `{all: true}` or `{entries: [{trash_dir, name}]}` and returns the same numbers (`files`, `total_bytes`, `oldest`, `newest`) plus `recycle_enabled`. Each sample item has `entry` (its name in the bin), `name` (without the stamp), `path` (where it came from, when recorded), `size`, `deleted_at` and `reason`. `/api/video/downloads/recycle/purge` only accepts `{plan_id}` and answers `{purged, skipped, errors, freed_bytes}`; an entry restored or replaced since the preview is skipped. Tool `video_recycle_purge`. Gated like the bin's other routes (the video side switch).
- **Audiobook recycle bin (permanent):** `POST /api/audiobooks/library/recycle/purge-preview` takes `{all: true}` or `{names: [...]}` (names in the bin) and returns the same shape, one item per book (`kind: folder`, `size` is everything under it, `path` is where it would go back to). `/api/audiobooks/library/recycle/purge` only accepts `{plan_id}`; so do `DELETE /api/audiobooks/library/recycle` and `DELETE /api/audiobooks/library/recycle/<name>`. Tool `audiobook_recycle_purge`. Gated by the Audiobooks page.
- **Video repair fixes:** `POST /api/video/repair/findings/bulk-fix-preview` takes `ids`, or `job_id` / `severity`, plus an optional `fix_action`, then `/api/video/repair/findings/bulk-fix` with `{plan_id}` fixes exactly those findings. Each item has `reason` (the finding), `path`, `size`, a sentence `effect` and `effect_kind` (`move`, `recycle`, `delete`, `library`, `write`, `none`); the preview adds `destructive`, `by_effect` (fixes per effect), `files_by_effect` (the files those fixes move, recycle or delete: a Watched Cleanup fix deletes every file the movie has, so this can be more than the fixes; each item has its `files` too), `per_type` and `recycle_deletes`. Without a plan, a selection that includes Watched Cleanup or Naming Conformance is `409 plan_required` with `plan` attached; anything else runs as before. Tool `video_repair_bulk_fix`. Admin only, like all video repair routes.
- **Lossy Converter (part of Repair fixes):** a bulk run over `missing_lossy_copy` findings whose quality profile keeps the lossy output only needs a plan. The preview adds `lossy: {convert, delete_originals, originals_bytes, estimated_freed_bytes, labels, recycle}` (`estimated_freed_bytes` is null when a track has no duration); each such item says "Converts to MP3-320, then moves the lossless original to the recycle bin" (or "deletes … permanently"), counts as `destructive` and carries the original's `size`. A confirmed plan deletes an original only where its preview said so; a bulk run without a plan never does. `GET /api/repair/finding-types` marks `missing_lossy_copy` as `destructive` while any profile keeps the lossy output only, and `safe_only` leaves those findings out.

### Activity feed: `GET /api/activity`

One newest-first list of what SoulSync did, plus what needs you. Query: `range` (`today`, `7d` default, `30d`), `kind` (`all`, `download`, `import`, `automation`, `library`, `sync`, `safety`, `radio`, `needs_you`), `limit` (1–200, default 50), `before` (the previous page's `next_before`, or unix seconds) and `since` (unix seconds; use it to send the browser's own midnight for "Today", since `today` alone means the server's midnight).

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
- **Library jobs** (built on `ux/oct23-3`, HANDOFF 68): "Look for releases you don't have" shows under `kind: automation` with ids `library-job:<run>`. While it runs: `status: running`, title "Looking for releases you don't have", detail "212 artists · 40 done" (plus "· waiting for Spotify's pause, 9 min 12 s left" while it waits), `ref: {job_id, stop_path: "library/missing-releases/stop"}`; the page offers Stop, a POST to `/api/<stop_path>`. Afterwards: "Looked for releases you don't have" (`ok`, or `warning` when some artists couldn't be checked) with "212 artists · found 61 releases by 18 artists"; "Stopped looking …" (`warning`, "Stopped after 40 of 212 artists · found 12 releases by 3 artists", "… when SYNCHRO.S restarted" for a run a restart cut off); "Couldn't finish looking …" (`error`, with the service's words). All link to `/library?show=incomplete`. Admins see every run; a member only one they started (members can't start one). A running job counts in `running_count`.
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
    {"key": "followed", "set_up": true, "artists": 18,
     "following": {"total": 31, "artists": 18, "labels": 6, "podcasts": 4, "authors": 3},
     "status": "cant_search",
     "reason_code": "download_source_unreachable",
     "reason": "Soulseek (slskd) didn't answer when SYNCHRO.S last checked, 4 minutes ago, so searches can't run.",
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
- **followed**: new-release tracks from the artists you follow: on Wanted from the watchlist scan (split as for Wanted), and downloaded for one of them in the last 30 days (`have`). `artists` counts the artists you follow. `following` counts everything the Wanted page's Following tab lists, by kind, from the same readers: `artists` (`GET /api/watchlist/count`), `labels` (`GET /api/labels/watchlist`, the install's), `podcasts` (your `GET /api/podcasts/watchlist`) and `authors` (your `GET /api/audiobooks/watchlist`: authors, narrators and series). `podcasts` is `null` while the Podcasts module is off, `authors` while the Audiobooks module is off or your profile isn't given the Audiobooks page; a `null` kind is left out of `total`. The card is set up when `total` is above 0, so following only a podcast or a label counts. `following` is worked out on every call (not in the 30-second cache), so a module switch shows at once. Home's card is labelled "Following": its title is the total and the new tracks ("31 followed · 52 new tracks", or the one kind when there's only one, "18 artists · 52 new tracks"), and on wide screens the footer says which kinds ("18 artists, 6 labels, 4 podcasts, 3 authors", leaving out kinds with none).
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

**The nebula and Follow… (evening phase 4, boards 9a and 9b), unchanged routes:**

- The nebula's panel reads `GET /api/library/artist-index?q=<name>&limit=20` and takes the artist of exactly that name (folded by case): `releases`, `in_library`, `following` for "6 releases · 3 in your library · … · Following", and `wantable` for "Want the N other releases you're missing", which is `POST /api/wishlist/bulk` with `{action: "add", filter: {artist_ids: [id]}, quality: "target"}` (more than one asks first with `POST /api/library/releases/summary`, as Library → Artists). Search now for both and Remove both are `POST /api/wishlist/bulk` `grab` / `skip` on the artist's exact track ids; Accept any quality is Search by hand (`POST /api/wishlist/inspect`, then `/inspect/download` with `override: {code, stage: "quality"}` on a "Grab anyway"). Photos and Following come from `GET /api/watchlist/artists` and the `artist_images` of `/api/wishlist/tracks`. "Why it's stuck" reads each row's `retry_count`, `failure_reason` and `last_attempted`: there's no record of which users a search saw (HANDOFF 77).
- Follow… searches and follows through each kind's own routes: artists `POST /api/library/search-service` `{service, entity_type: "artist", query}` (`service` one of deezer, spotify, itunes, discogs, musicbrainz) and `POST /api/watchlist/add` `{artist_id, artist_name, source}`; labels `POST /api/labels/search` `{query}` (MusicBrainz; `is_watching` per label) and `POST /api/labels/watchlist/add` `{musicbrainz_label_id, label_name}` (from now on: `backlog` stays false); podcasts `GET /api/podcasts/search?q=&limit=8` and `POST /api/podcasts/watchlist/add` with `auto_download` and `retention_days` (7, or 0 to keep every episode; the route forces `auto_download` off for a profile that can't download); authors `GET /api/audiobooks/search?q=&type=author&limit=30` (books, grouped by their first author in the page, `owned` per book) and `POST /api/audiobooks/watchlist` `{name, cover_url, role: "author"}` (from today). What's followed already comes from `GET /api/labels/watchlist`, `/api/podcasts/watchlist` and `/api/audiobooks/watchlist`; the meta line from `GET /api/automations` (`scan_watchlist`, `scan_watchlist_podcasts`, `audiobook_scan_watchlist`) and `GET /api/discovery/lookback-period` (what an artist's first check takes).

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

**Run history: `GET /api/automations/<id>/history?limit=&offset=`** returns `{history, total, automation_id}`, newest first. Each run has `id`, `started_at`, `finished_at`, `duration_seconds`, `status` (`completed`, `error`, `timeout`, `skipped`, or `preview`), `summary`, `result_json` (the facts the run produced, when the action records any) and `log_lines` (`[{"type", "text"}]`). `total` counts the runs kept, at most 100 per automation. The Wanted search's runs record that they started their batches ("Started: 3 album batch(es), 4 per-track for cycle albums"), and when the batches finish the server writes what they found onto the run's `result_json`: `{searched: {tracks, albums}, found: {tracks, albums}}`. `found.tracks` counts tracks downloaded; `found.albums` counts album batches that downloaded at least one. Runs from before this have neither, and a run whose batches are still going has `searched` only. The Runs panel shows "Found" and "· N found" from it.

**When it was paused:** automations (`GET /api/automations`, `GET /api/automations/<id>`) carry `paused_at`, when they were last turned off (UTC text), or `null` while on. Turning one on clears it; automations that were already off when the column arrived have it set to their last change.

**Saving an Assistant draft:** `POST /api/automations` and `PUT /api/automations/<id>` take an optional `assistant_draft: true` when the editor saves a draft that came from the Assistant; it only adds one to this month's "drafts saved" in Settings → AI.

**Also used by the pages, unchanged:** `GET`, `POST` `/api/automations`; `GET`, `PUT`, `DELETE` `/api/automations/<id>`; `POST /api/automations/<id>/run`, `/toggle` and `/duplicate`; `POST /api/automations/bulk-toggle`; `PUT /api/automations/group`; `GET /api/automations/blocks`, `/progress` and `/master` (and `POST /master`, admins); `POST /api/automations/test-notify`; `GET /api/scripts`; `GET /api/mirrored-playlists/list`.

### Accent per profile (Settings → Appearance 5f; HANDOFF 35)

Built on `ux/evening-2`. Each profile picks its own accent; the install's accent (`ui_appearance.accent_preset` / `accent_color` in `GET`/`POST /api/settings`, admins) is the default for profiles that haven't picked.

**`GET /api/profiles/me/appearance`** → `{success, accent, install_accent, effective_accent, is_admin}`. `accent` is the signed-in profile's own pick (`"#rrggbb"`) or `null` (follows the install's); `effective_accent` is what that profile sees. **`PUT /api/profiles/me/appearance`** `{accent: "#rrggbb" | null}` → the same. Three-digit and upper-case hex are accepted and stored as `#rrggbb`; a value that isn't a hex colour, or one whose light shade doesn't give dark text 4.5:1, is 400 `{error}` and nothing changes. Always the session's own profile (a header, query or body profile id is ignored, admins included); 401 without one. Stored in the new column `profiles.accent_color` (NULL for every profile on upgrade, so nobody's colour changes); it isn't in `GET /api/profiles` or `/api/profiles/current`.

**The page shell** paints the viewing profile's accent (its pick, else the install's) in its inline `:root` style and hands it to `init.js` as `window._initialAccent`, which applies it at boot instead of the colour this browser kept last. The profile picker and the sign-in screen get the install's accent.

### The Assistant (boards 3a–3l, Settings → AI 5a)

Code: `api/ai.py` (routes), `core/ai/` (settings, context, prompt, provider, drafts, suggestions, usage), `webui/src/routes/automations/-automations.assistant.ts` (client) and `-automations.conversation.ts` (the conversation in the browser).

**Status: `GET /api/ai/status`** (anyone with a profile; none is `401`):

```json
{"success": true, "configured": true, "can_use": true, "reason": null,
 "model": "fast", "provider": "anthropic", "provider_name": "Anthropic", "is_admin": true,
 "usage": {"month": "2026-10", "requests": 41, "input_tokens": 460000, "output_tokens": 52000,
           "estimated_cost_usd": 1.42, "drafts_saved": 6, "cap_usd": 10.0}}
```

- `reason` is `null` when it can be used, else (in this order) `not_configured` (no key), `members_not_allowed` (Settings → AI says admins only and you aren't one), `key_refused` (the last test or call was refused) or `cap_reached` (this month's estimated cost has reached the cap).
- `model` is `fast` ("Faster and cheaper", the default) or `best` ("Best answers").
- `usage` is for admins only. `input_tokens` includes cached input. The cost is estimated locally from token counts and each model's price; `cap_usd` is `null` without a cap. Months roll over on the 1st (UTC).

**Settings (admins; anyone else `403`): `GET`, `PUT /api/ai/settings`.** Both return:

```json
{"success": true,
 "settings": {"provider": "anthropic",
              "api_key": {"set": true, "masked": "sk-ant-••••••••••••••••••••XYZ"},
              "model": "fast", "who_can_use": "admins", "monthly_cap_usd": 10.0,
              "key_status": {"state": "ok", "message": "Anthropic accepted the key.",
                             "tested_at": "2026-10-22T14:03:00Z", "tested_by": "Admin",
                             "added_at": "2026-10-22T14:02:41Z", "added_by": "Admin"}},
 "usage": {"month": "2026-10", "requests": 41, "...": "as in status"},
 "providers": [{"value": "anthropic", "label": "Anthropic (Claude)", "name": "Anthropic"}],
 "models": [{"value": "fast", "label": "Faster and cheaper", "name": "Claude Sonnet", "description": "…"},
            {"value": "best", "label": "Best answers", "name": "Claude Opus", "description": "…"}]}
```

- `usage.profiles` (built on `ux/evening-2`, HANDOFF 39; here only, never in `/api/ai/status`): `{month, rows: [{profile_id, name, requests, estimated_cost_usd}], unattributed: {requests, estimated_cost_usd} | null}`, this month per profile, most expensive first. `unattributed` is what the install's total holds beyond the rows (requests from before per-profile counting began on this release, or from a profile since deleted), so rows plus it add up to the total. Settings → AI shows the table while `who_can_use` is `everyone`. The cap stays one figure for the install. Kept in the new table `ai_usage_profiles` (month, profile).
- `PUT` takes any of `{provider, api_key, model, who_can_use: "admins"|"everyone", monthly_cap_usd}` (`null` or `""` clears the cap). A bad value is `400` with the sentence to show; nothing is saved.
- `api_key` is write-only: it's stored encrypted with the app's other secrets and never returned, here or by `GET /api/settings`, `/api/v1/settings` or the debug info (which says only whether one is set). An empty `api_key` leaves the saved one alone. A new key resets `key_status.state` to `untested`.
- `key_status.state` is `missing`, `untested`, `ok` or `refused`.

**`POST /api/ai/test`** (admins) tests the key in the body (`{api_key?}`), or the saved one, without spending tokens: `{ok, message, saved_key, key_status}`. `message` is "Anthropic accepted the key." or the provider's reason in plain words. Testing the saved key records the result.

**The conversation: `POST /api/ai/assistant`**, answered as server-sent events (`text/event-stream`).
- Body: `{message, conversation_id?, context}`; `context` is `{page: "list"|"editor", automation_id?, run_id?, draft?}`, what's on screen. `draft` is the editor's unsaved draft in the shape below. An empty message or a bad body is `400`. `not_configured`, `members_not_allowed` and `key_refused` are `403` `{error, reason}` before any stream.
- A `: keep-alive` comment goes out every few seconds while it thinks.
- Events, in order:
    - `status` `{reading}`: what it's reading ("your automations and Fill Wanted's last 10 runs").
    - `quote` `{run_id, started_at, lines}`: when asked about a run, the last lines of its log, shown in a `<pre>` before the answer.
    - `text` `{delta}`: the answer, a piece at a time.
    - `draft` `{draft, summary, why, facts, notes, automation_id}`. `draft` is `{name, trigger_type, trigger_config, action_type, action_config, then_actions}`, exactly what `POST /api/automations/preview` and `POST /api/automations` take. `notes` are sentences about anything the server left out ("I left out “Run Script”: only admins can add it."). `automation_id` is set when the draft changes one of your automations, else `null`.
    - `cant_build` `{missing, nearest}`: what the engine can't do, and the nearest draft (same shape as `draft`'s body) or `null`.
    - `suggestions` `{items: [{key, title, reason, draft, summary, why, facts, notes}]}`: at most three, each `reason` with a number in it.
    - `error` `{code, message}`: `bad_key`, `no_credit`, `rate_limited`, `offline`, `provider_error`, `cap_reached` or `busy` (two answers are already streaming). `message` is the sentence to show.
    - `done` `{conversation_id, usage: {input_tokens, output_tokens, estimated_cost_usd}}`.
- Stop: the browser aborts the request; the server stops the provider call and still counts what was used.
- Every draft is checked on the server before it's sent: the parts must be in `blocks_for_scope('music')`, the settings must match each part's fields (unknown keys dropped, choices from the lists, playlists and scripts that exist), notification credentials are never taken from the model, `confirm` is always off, and a member never gets a step `needs_admin()` marks (scripts, clean-up, repair, backup, purge, quarantine, video). What's dropped is said in `notes`.
- The Assistant writes drafts only: nothing is saved, run, turned on or sent (not even a test notification) until someone saves the draft in the editor.
- Library text (track, playlist and automation names, run logs) goes to the model only inside one quoted `<library_data>` block, with `<`, `>` and `&` escaped, capped in length, and the system prompt says it is information, never instructions. Context is limited to what the profile can see.
- The server keeps the last six turns of a conversation for two hours, per profile; the browser keeps the thread for the session.

**The suggestion card: `GET /api/ai/suggestion`** returns `{success, suggestion}`; `suggestion` is `{key, title, reason, draft_prompt, automation_id}` or `null`. It's worked out locally (no model call), only when the Assistant can be used, one at a time, and only when `reason` has a number in it. Keys today: `failing:<id>` (an automation that failed at least twice in 30 days with no notification step), `paused:<id>` (paused 14 days or more) and `wanted_stale` (10 or more Wanted tracks waiting over a month). "Use this" sends `draft_prompt` to the conversation. **`POST /api/ai/suggestion/<key>/dismiss`** is "Not now", kept per profile; an unknown key is `404`.

### The player (board 6a)

Three reads for the bar and tray (`api/player.py`). All need a profile (401 `profile_required` without one). A track is read in the caller's library scope, so one in someone else's own library is a 404 `not_found`; an id that isn't a track id is a 400 `bad_track_id`. A profile limited to clean tracks gets 403 for an explicit track, as when playing it. The request names a track id, never a path: the file is found through the playback resolver.

**Waveform peaks: `GET /api/library/tracks/<id>/peaks`.**

```json
{"success": true, "peaks": [0.12, 0.4, 0.97], "duration_s": 276.4}
```

- `peaks` is 200 values from 0 to 1, normalised to the loudest. The first request for a file answers `202 {"success": true, "pending": true, "retry_after": 2}` (and a `Retry-After: 2` header) and works them out in the background with Sample Studio's decoder (`core/sample/analyze.compute_peaks`, decoded at a low rate). One file is decoded at a time and at most 8 wait; a busy queue answers 202 again later. The player asks again after 1.5, 3 and 6 seconds, then every 8 seconds, six times in all, then keeps its flat line.
- They're kept in `track_peaks` (`core/playback/peaks.py`) against the file's size and modification time, so a replaced file is worked out again; imports don't change.
- A file that can't be drawn answers 200 with `"peaks": null` and a `reason`: `not_on_disk` (not on this machine, such as a track streamed from the media server), `not_audio` or `unreadable`. The player shows its flat line and stops asking.

**Audio details: `GET /api/library/tracks/<id>/details`.**

```json
{
  "success": true, "track_id": "981", "format": "FLAC", "format_key": "flac",
  "bitrate_kbps": 2304, "bit_depth": 24, "sample_rate": 96000, "duration_s": 276.4,
  "path_label": "Library", "on_disk": true,
  "title": "Harbour Light", "artist": "Pale Harbour", "artist_id": "42",
  "album": "Lantern", "album_id": "811", "year": 2024, "track_number": 3, "disc_number": 1,
  "album_track_count": 11,
  "quality": {"at_target": true, "target_name": "FLAC or better"},
  "image_url": "..."
}
```

- `format` is the readout's word (FLAC, ALAC, MP3, AAC, OGG, Opus, WAV, AIFF, DSD); `bit_depth` is only given for lossless files. Bit depth and sample rate are read from the file with mutagen the first time and kept on the track (`tracks.bit_depth`, `sample_rate`, with `audio_probe_sig` so a changed file is read again; `core/playback/audio_details.py`). `bitrate_kbps` is the library's own, or the file's when the library has none.
- `path_label` is where it plays from: "Library", or "Library (streamed from Navidrome)" when the file isn't on this machine. The player adds the output ("Library → This device"), since only the browser knows it.
- `quality` is the current quality target judged like the Artist page's tag (type and stored bitrate), or `null` when there's no target or the type is unknown. The rest feeds the record: the album line ("Lantern · 2024 · track 3 of 11"), the artist link and Open album.

**Recent: `GET /api/player/recent?limit=20`.**

```json
{"success": true, "items": [
  {"track_id": "981", "title": "Harbour Light", "artist": "Pale Harbour", "album": "Lantern",
   "played_at": "2026-10-22 11:57:00", "file_path": "...", "artist_id": "42", "album_id": "811",
   "bitrate": 2304, "duration_s": 276.4, "format": "FLAC", "image_url": "..."}
]}
```

- Every item has a `kind`: `music`, `podcast` or `audiobook` (HANDOFF 46: Recent shows every kind). Podcast and audiobook items are this profile's plays of them, shaped as in `GET /api/player/plays` below (`media_id`, `subtitle`, `src`, `image_url`, `duration_s`, `position_s`, `finished`, `played_at`); the player plays one again with its `src`, from where you left it.
- The web player's own plays from the listening history (`server_source` `soulsync_web`), newest first, in the caller's listening pile (`core/listening_scope.py`), so it matches Library → Listening history. `played_at` is UTC. `limit` is 1–50 (20 by default). A track played twice in a row shows once; explicit tracks are left out for a profile limited to clean tracks. `track_id` is `null` for a play whose track has left the library; those rows can't be played again.

**Podcast and audiobook progress and plays** (built on `ux/evening-2`, HANDOFF 46; `core/playback/spoken.py`). Always the session's own profile: a header, query or body profile id is never read, admins included. All need a profile (401). `kind` is `podcast` or `audiobook`; `media_id` is what the page calls the item (an episode's guid, else its address; an audiobook's ASIN), up to 512 characters. A bad body is 400 `{error}`.

- `PUT /api/player/progress` `{kind, media_id, position_s, duration_s?, ended?}` → `{progress: {position_s, duration_s, finished, resume_at, updated_at}}`. The player sends it every 15 s while an item plays, on pause, at the end (`ended: true`), when another item takes over, and (as a `POST`, by `sendBeacon`) when the page closes. Finished means `ended`, or within the last 5% of the length (at least 10 s, at most a minute); a finished item's `resume_at` is 0, and so is one under 5 s in. Saving a position far from the end makes it unfinished again.
- `GET /api/player/progress?kind=&id=` → `{items: {<media_id>: progress}}` for one item; `POST /api/player/progress/lookup` `{kind, ids: [...]}` (up to 100; a POST because episode ids are often whole addresses) → the same for a page of items. Items never started aren't in `items`.
- `POST /api/player/plays` `{kind, media_id, title, subtitle?, art_url?, src?, duration_s?}` → `{play_id}`: the player sends it once an item has played 10 s. The same item again within half an hour is the same play (its time moves up). `src` is kept only when it's an http(s) address or the server's own `/api/audiobooks/sample-proxy` / `/api/podcasts/audio-proxy`; `art_url` only when it's http(s) or our own `/api/…`.
- `GET /api/player/plays?kind=podcast|audiobook&limit=50` (1–100) → `{items: [{play_id, kind, media_id, title, subtitle, image_url, src, duration_s, played_at, position_s, finished}]}`, newest first: Library → Listening history's Podcasts and Audiobooks. With `range` (`today`, `7d`, `30d`, `all`; built on `ux/oct23-3`) it's a page of that range: `tz`, `q` (the title or the show / book) and `offset` apply, each item adds `day`, and the answer adds `total`, `days` and `range` (see "Listening history" below). Without `range` the answer is as before.
- New tables `media_progress` (profile, kind, item) and `media_plays`. They're apart from `listening_history` on purpose: Stats, smart radio, the history importers and Last.fm / ListenBrainz scrobbling stay music only. Deleting a profile removes its rows.

**Output devices:** nothing on the server. The browser lists what it can switch to (`src/shell/player-output.ts`): `setSinkId` with `enumerateDevices` in Chrome and Edge, the browser's own picker in Firefox (`selectAudioOutput`), the AirPlay picker in Safari. The button hides when the browser offers nothing (fewer than two outputs, or no API). Playing on a Plex, Jellyfin or Navidrome client, or Chromecast, isn't proposed yet.

**Unchanged:** the queue stays in the browser as the player kept it; podcasts and audiobooks keep their own routes for finding and fetching (the stream address and the PodcastIndex chapters URL go to the player as they are).

### Internet radio (boards 4a–4k, Settings → Radio 5b–5d)

Code: `api/radio.py` (routes), `core/internet_radio/` (stations, directory, feeds, ICY, hub, relay, watcher, store, settings, Wanted add, fingerprint, Setup check rows), `webui/src/routes/radio` (the pages), `src/shell/radio-session.ts` (`window.SoulSyncRadio`), `src/shell/player-radio.ts` (the player's radio mode), `src/shell/radio-settings.ts` (Settings → Radio).

Everything is behind the "Internet radio" module (`radio` in `GET /api/modules`, on by default like the others): while it's off every `/api/radio/*` route answers 409 `module_disabled`, the sidebar row and the Settings tab are hidden, the watcher stops and every listening session ends. Every route needs a profile (401 `profile_required` without one). Members can listen, favourite and add to Wanted; adding links and Settings → Radio are admins only (403; members read Scan now's services and their state from now playing's `scan`, below); turning auto-add on needs download rights (403 `no_download_rights`). Errors are `{success: false, error, message}`, `message` being the sentence to show.

**Stations.** A station's id says where it comes from: a built-in pick (`core/internet_radio/stations.json`, e.g. `nts-1`), the Radio Browser directory (`rb-<uuid>`, looked up again by uuid whenever it's played) or an admin's link (`link-<n>`). The server fetches nothing else.

```json
{"id": "nts-1", "name": "NTS 1", "kind": "eclectic", "kind_label": "Eclectic tastemakers", "genre": "Eclectic",
 "city": "London", "country": "United Kingdom", "logo_url": "/api/radio/stations/nts-1/logo?v=3f9a0c21de", "logo_text": "", "homepage": "https://www.nts.live/",
 "description": "…plain text…", "source": "built_in", "favourite": true, "auto_add": false,
 "has_now_playing": true, "has_tracklists": true,
 "quality": {"codec": "MP3", "bitrate_kbps": 256, "lossless": false, "label": "MP3 256 kbps"},
 "tags": [], "sends_titles": null, "added_by": null,
 "streams": [{"id": "mp3-256", "codec": "MP3", "bitrate_kbps": 256, "lossless": false, "label": "MP3 256 kbps (best offered)"}]}
```

- `logo_url` is always our own address, `/api/radio/stations/<id>/logo?v=<tag>` (the tag changes when the station's logo address does), or `""` when the station has none. The browser never loads a logo from the station's host. Show the station's letters (`logo_text`, else from the name) while it loads and when it answers 404.
- **`GET /api/radio/stations/<id>/logo`** (built on `ux/evening-2`, HANDOFF 55): the logo, fetched and cached by the server. Only a station the server resolved itself (a built-in pick's https `logo_url` from `stations.json`, a directory station's Radio Browser `favicon` looked up again by uuid, or the logo address an admin gave a link), and only that station's own logo: no address is ever taken from the request. Fetched through the outbound guard; raster images only, told by their first bytes (PNG, JPEG, GIF, WebP, ICO; never SVG); 512 KB and 4096 px a side at most. Answers carry the image's real type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, max-age=86400`. Cached on disk under `storage/radio_logos` (16 MB in all, oldest out first, a week); a logo that couldn't be fetched isn't asked for again for six hours. 404 `no_logo` for no logo or one that couldn't be used; 401 without a profile.
- `GET /api/radio/stations` → `{favourites, kinds: [{kind, label, blurb, stations}], heard_count, session, identification, is_admin}`. Kinds in the order electronic, world, eclectic, jazz_soul_funk. Favourites are the profile's, then every admin's link (`source: "your_link"`, with `link_ok`). `session` is this profile's listening session (`{session_id, station_id, mode, stream_id}`) or null. Stream addresses are never in these answers.
- `GET /api/radio/stations/<id>` → `{station, now_playing, session, heard_today: {identified, not_identified}, identification, is_admin, can_download}`. The phone sheet's "Heard on NTS 1 today · 14" and the tray's Heard today tab both count `identified` (HANDOFF 143); the tray counts it from `GET /api/radio/heard?station_id=&days=1`'s rows whose `state` isn't `not_identified`, and says the rest as one line.
- `POST` / `DELETE /api/radio/favourites/<id>`, per profile. A directory favourite keeps a snapshot of what the directory said, so Favourites draws it and it still plays when the directory is down.
- `GET /api/radio/directory?q=&codec=FLAC|AAC|MP3&min_bitrate=&country=<ISO 2>&page=` → `{results: [station], more, page, total}`, 20 a page, sorted by listeners in the directory. `total` counts what's been fetched (the directory doesn't give a total). Searches the name and the genre tags; HLS-only entries are left out. Cached 5 minutes, with a descriptive User-Agent. 502 `directory_unavailable` when no mirror answers. `GET /api/radio/directory/countries` → `{countries: [{code, name, stations}]}`.

**Playing.**
- `POST /api/radio/play` `{station_id, stream_id?, force_relay?}` → `{play_url, mode, session_id, station, stream: {id, label, codec, bitrate_kbps, lossless}}`. `mode` is `direct` only for an `https` stream the list marks as playable elsewhere (`direct` in stations.json, or a link whose check saw `Access-Control-Allow-Origin: *`), on a station with a now-playing feed, while Settings → Radio's relay rule is "when needed"; otherwise `relay` and `play_url` is `/api/radio/relay/<session_id>`. 409 `busy` when two relays are already live (counting ones waiting for the browser). Starting a station ends the profile's other session.
- `GET /api/radio/relay/<session_id>`: the audio, for the profile that made the session, once. Audio types only (`audio/*` except playlists, and Ogg); anything else is 502 `stream_failed` with the reason ("This link isn't an audio stream. The address answered with a web page."). Answers carry `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and none of the station's headers. Ends when the listener goes, on Stop, after 20 seconds without audio, or after 6 hours.
- `POST /api/radio/stop` `{session_id}` → `{stopped}`.

**Recent stations, per profile** (built on `ux/oct24-b1`, HANDOFF 142, 163; the expanded player's Stations tab, board 16b)
- `GET /api/radio/recent` → `{stations: [station + played_at], keep: 20, after_seconds: 30}`: the profile's own stations, newest first by `played_at` (unix seconds), at most 20. A station is the same shape as in `GET /api/radio/stations` (no stream addresses), drawn without asking the directory: a built-in pick by its id, an admin's link while it exists, a directory station from the snapshot kept with the row. A row whose station no longer resolves (a removed link, a pick dropped from `stations.json`) is left out. Another profile's rows are never read: there's no profile parameter. 401 `profile_required` without a profile.
- `POST /api/radio/recent` `{session_id}` → `{station_id}`: counts the playing station for this profile. The session must be the caller's own and still on (404 `no_session` otherwise, so one profile can't write another's list), and at least 30 s old (409 `too_soon`). The page sends it once per session after 30 s of its own playing, relayed or direct; the server writes the row (`played_at` now, a directory station's snapshot), moves it to the front and keeps the profile's newest 20. 401 `profile_required` without a profile.
- Stored in the music database's `radio_recent` (`profile_id`, `station_id`, `station_json`, `played_at`; primary key `(profile_id, station_id)`, index `(profile_id, played_at)`; migration step `add_radio_recent`, ledger `radio_recent_v1`). Removing a link removes its rows; deleting a profile removes the profile's (the profile sweep). The browser keeps its own copy in `localStorage` `ssRadioRecentStations` (eight, now with `played_at`) as the first paint and the fallback, and merges the server's list over it (`mergeRecent` in `src/features/radio/radio.recent.ts`).

**Now playing: `GET /api/radio/now-playing?station_id=&session_id=`** (polled every 10 s by the player, 30 s while the tab is hidden; the poll keeps a direct session alive, which otherwise ends after 90 s). Not pushed over Socket.IO: what it says about the library is per profile.

```json
{"station_id": "nts-1", "state": "identified", "source": "station_feed",
 "track": {"artist": "Pale Harbour", "title": "Harbour Light", "release": "Lantern", "art_url": null},
 "identified_at": 1761130000, "started_at": 1761130000, "reason": null,
 "library": {"in_library": true, "below_target": false, "track_id": "981"}, "on_wanted": false,
 "previous_title": "Night Ferry (Dub)", "now": 1761130040, "playing": true, "session_active": true,
 "heard_id": 312, "added_at": null}
```

- `state`: `identified`, `listening` (nothing named yet: "Its name usually arrives within a minute."), `not_identified` (`reason` says why: a show, a break, the station's own name, no fingerprint match), `off` (identification is off) or `unavailable` (no feed, no stream titles and no working fingerprint; `reason` names each).
- `source`: `station_feed`, `stream_titles` or `fingerprint`, in that order of preference: the station's feed is trusted over stream titles while it names tracks. `audd` is automatic AudD (built on `feat/audd-auto`): asked with the automatic fingerprint's clip only when the station is watched (played, or auto-add on), isn't naming the track (no healthy feed naming one, and an empty, missing or generic stream title), and AcoustID answered "no match"; it reads "found by AudD" and feeds Heard and auto-add like `fingerprint`. After a Scan now it can be `scan_acoustid`, `scan_audd` or `scan_acrcloud` (below); a feed that says "a show" doesn't undo a scan for four minutes.
- `now` is the server's clock, for "identified 40 s ago". `heard_id` is the profile's Heard row for this track (what the player's Add to Wanted uses), null until it's written.
- `scan`: `{available, reason, services}`, whether Scan now can run (also in `GET /api/radio/stations/<id>`). `reason` is the sentence for a disabled button: identification off, or no service set up ("No identification service is set up for Scan now. An admin can add an AcoustID key, or AudD or ACRCloud, in Settings → Radio."). `services` lists the ones a scan would ask, in order.
- `scan.states` and `scan.audd_auto` (built on `ux/oct23-a`, HANDOFF 87, board 15b), for everyone who can listen: `states` is `{acoustid, audd, acrcloud}`, each `ready`, `not_set_up`, `refused` or `no_requests_left`, worked out as the settings read's `scan.services[*].state` (below); `audd_auto` is `{on, stopped}`, `on` while automatic AudD is switched on with a cap above 0 and AudD's token is saved, `stopped` `null`, `cap_reached`, `bad_key` or `out_of_credit` (since local midnight). No keys, dates or counts. The station strip and the phone sheet say a refused or out-of-requests service from it, and the strip says automatic AudD's used-up day. Both are left out when they can't be read (the button still works).

**Scan now** (on demand; anyone who can listen; built on `ux/radio-scan`)
- `POST /api/radio/scan` `{session_id}` → `202 {scan_id, …the scan}`. The session must be the caller's own live one (404 `no_session` otherwise). Refusals: 409 `identification_off`, 409 `no_scan_service`, 409 `scan_running` (one at a time per profile), 409 `busy` (two scans at once across the server), 429 `rate_limited` (three a minute per profile; `retry_after` and a `Retry-After` header). Module off is 409 `module_disabled` like every radio route.
- `GET /api/radio/scan/<scan_id>` → the scan, the caller's own only (404 otherwise; finished scans are kept 15 minutes). The player asks every second while it listens.

```json
{"scan_id": "Qm3…", "station_id": "nts-1", "state": "identified", "phase": "identifying",
 "trying": null, "trying_label": null, "progress": 1, "capture_seconds": 10, "seconds_left": 0,
 "track": {"artist": "Marrow Field", "title": "Glasshouse", "release": "Glasshouse EP"},
 "source": "scan_audd", "source_label": "AudD", "heard_id": 41,
 "library": {"in_library": false, "below_target": null, "track_id": null}, "on_wanted": false,
 "reason": null, "provider_error": null, "asked": ["acoustid", "audd"],
 "started_at": 1761130000, "finished_at": 1761130014, "now": 1761130015}
```

- `state`: `listening` (`phase` `capturing` with `progress` 0–1 and `seconds_left`, then `identifying` with `trying` / `trying_label`, the service being asked), `identified`, `not_found` (`reason` "Couldn’t identify this — DJ mixes and talk often can’t be."; `provider_error` set when one service also failed) or `failed` (`reason` in plain words, and `provider_error: {provider, label, kind, message}` with `kind` one of `bad_key`, `out_of_credit`, `rate_limited`, `offline`, `bad_audio`, `provider_error`). Never a key in any of it.
- **Capture:** server-side from the station's stream, never a microphone: about ten seconds copied from the station's live relay when one is running (no second connection), otherwise one short read of the same stream the session plays (built-in, directory or admin-link stations only; audio only; capped at 3 MB and 16 seconds). ffmpeg makes a 10-second mono 16 kHz WAV; the temporary files are always removed.
- **The chain:** AcoustID (needs its key and fpcalc), then AudD (when Settings → Radio has its token), then ACRCloud (host, access key and access secret). The first confident match wins: AcoustID 0.7 or more, ACRCloud a score of 70 or more, AudD a named result. A service that errors doesn't stop the next one.
- **A match:** a Heard row for the person who pressed (`source` `scan_*`), the library, Wanted and quality-target check (`library`, `on_wanted`), now playing for everyone on the station, and the `radio_track_heard` trigger with `source` `scan_*`. Add to Wanted is `POST /api/radio/heard/<heard_id>/want`. A scan never sets off auto-add: auto-add stays on the station feed, stream titles, the automatic fingerprint and automatic AudD (`source` `audd`, above). Apart from automatic AudD, the paid services are only ever asked on a Scan now press.
- **Admins:** `POST /api/radio/scan/test` `{service: "acoustid"|"audd"|"acrcloud"}` → `{ok, state, message, spends, usage, services}`. AcoustID's test is a free key check; AudD's and ACRCloud's send one second of silence, which uses one request (counted in usage). `services` is the settings read's `scan.services` after the test (below). 403 for members.

**Heard on radio**
- `GET /api/radio/heard?station_id=&days=&missing=1` → `{items, days, keep_days, counts: {total, not_in_library, identified, not_identified}}`, newest first, the profile's own, at most 200. An item is `{id, heard_at, station_id, station_name, artist, title, release, source, state, added_at, added_by_auto_add, duration_s, reason, below_target, track_id}`; `state` is `in_library`, `on_wanted`, `added_by_auto_add`, `not_added`, `cant_match` (no artist) or `not_identified` (an unnamed stretch of 90 s or more, with `duration_s`). Library state is checked when read, the same check as Search.
- `POST /api/radio/heard/<id>/want` → `{item, skipped, message}`: adds it to Wanted at the quality target (the default quality profile) through Search's add (`add_album_track_to_wishlist`), after asking the metadata source for the track. `skipped` when the library already has it.

**Auto-add**
- `GET /api/radio/stations/<id>/auto-add` (the station page's confirm, and since evening phase 4 the phone sheet's in-place confirm, 9c) → `{enabled, identified_yesterday, already_have, would_add, would_add_without_limit, daily_limit, added_today, can_download, has_now_playing}`. Yesterday's numbers count distinct tracks identified on the station by anyone (local days).
- `PUT` the same route `{enabled}`. On: download rights (403 `no_download_rights`) and identification on (409 `identification_off`). Off by default, per profile and station.
- Guards, in order, on every add: download rights, in the library, on Wanted, added before by auto-add (never twice), the daily limit per station (Settings → Radio, 50 by default). Each addition is counted in Activity, kind `radio`: one item per station per hour, "Auto-add added 3 tracks from NTS 1", for the profile whose auto-add it was. Radio's items don't show on Home.

**Tracklists** (KEXP's show API; NTS's episode tracklists, for shows SoulSync saw on NTS's live feed while watching or listening).
- `GET /api/radio/stations/<id>/shows` → `{shows: [{id, title, aired_at, ended_at, track_count, missing_count}], publishes}`; counts for the first three.
- `GET /api/radio/shows/<id>` → `{show: {id, title, aired_at, ended_at, station_id, station_name, fetched_at, homepage}, tracks: [{position, time, artist, title, release, state, below_target, track_id}]}`; `state` is `in_library`, `on_wanted`, `not_added` or `cant_match`.
- `POST /api/radio/shows/<id>/want` `{position}` adds one row; `POST /api/radio/shows/<id>/want-missing` → `{added, skipped}`.

**Your stream links (admins)**
- `GET /api/radio/links` → `{links: [{id, station_id, name, url, kind, codec, bitrate_kbps, sends_titles, check_ok, checked_at, check_error, added_by, added_at, logo_url}]}`. `logo_url` is the logo address the admin gave, or `null` (new column `radio_links.logo_url`).
- `POST /api/radio/links/check` `{url}` → `{ok, codec, bitrate_kbps, sends_titles, allows_direct, answered_in_s, error}`: the server listens for a few seconds. The only routes that take an address from a request; private, loopback, link-local and multicast addresses are refused before and after DNS and on every redirect.
- `POST /api/radio/links` `{url, name, kind, logo_url?}` runs the check again and adds only when it passes; an optional `logo_url` is checked the same way (an http(s) address on the internet) and fetched once, and has to be a raster image under the limits above, else 400 `logo_failed` with the sentence to show and nothing is added; `POST /api/radio/links/<id>/check`; `DELETE /api/radio/links/<id>` (also drops it from favourites and auto-add).
- `PUT /api/radio/links/<id>` `{logo_url}` (built on `ux/oct23-2`, HANDOFF 66: Settings → Radio's "Change logo…") → `{success, link}`: changes the link's logo through the same check and fetch as adding one (an http(s) address on the internet, through the outbound guard, then fetched once: a raster image under the limits above), else 400 `logo_failed` with the sentence to show and the old logo stays. An empty `logo_url` (or `null`) goes back to the letters. 400 `bad_request` without `logo_url` or when it isn't text; 404 `not_found` for a link that isn't there. Only links: built-in and directory stations have no logo override. The station's `logo_url` tag changes with the address, so browsers fetch the new one.

**Settings (admins): `GET`, `PUT /api/radio/settings`** → `{settings: {identification, daily_limit, relay: "when_needed"|"always", prefer_lossless, keep_heard_days: 7|30|90|365, acoustid_api_key: {set, masked}, scan_services: {audd_api_token: {set}, acrcloud_host: {set}, acrcloud_access_key: {set}, acrcloud_access_secret: {set}, audd_ready, acrcloud_ready}}, status: {fpcalc: {found, detail}, acoustid: {state: "missing"|"untested"|"ok"|"refused"|"unreachable", detail, checked_at}}, auto_add: {stations, added_this_week}, links, scan: {order: ["acoustid", "audd", "acrcloud"], labels, ready: {acoustid, audd, acrcloud}, usage: {acoustid: {requests, found}, …}, month: "October", available}}`. `PUT` takes any of those keys; `acoustid_api_key` is the existing `acoustid.api_key`, write-only (an empty one leaves it alone). `audd_api_token`, `acrcloud_host`, `acrcloud_access_key` and `acrcloud_access_secret` are write-only too (`radio.*` in the config, encrypted with the app's other secrets and masked in every settings read, `/api/v1/settings` included); the host must be a name under `acrcloud.com` (`identify-eu-west-1.acrcloud.com`). `remove: ["audd"]` or `["acrcloud"]` clears a service's keys. `usage` counts this month's requests each service was sent (scans and paid tests) and how many found the track. A bad value is 400 and nothing is saved.
- `scan.services` (built on `ux/oct23-2`, board 11c): `{acoustid: {state, set_at}, audd: {…}, acrcloud: {…}}` for the "Scan now services" card's tags and "Token set, 14 March 2026". `state` is `not_set_up` (not ready: a key missing, ACRCloud's three not all set, or fpcalc missing for AcoustID), `refused` (the service refused the key at its last answer, from a scan or a Test; for AcoustID also Setup check's own check when that's newer), `no_requests_left` (it said so this month; a new month reads `ready` again) or `ready`. A new key, or any answer from the service (a match or not), clears what was said before. `set_at` is when the key was saved through this route (unix seconds; any of ACRCloud's three counts), or `null` when that isn't known (a key saved before this was recorded; AcoustID's key saved from another page). Stored in the music database's `radio_scan_keys` (provider, `set_at`, the last `state` and its time); a removed service's row goes. Never a key, in the answer, the table or the logs.
- `settings.audd_auto` (bool, default `true`) and `settings.audd_auto_daily_cap` (integer 0–1000, default 100; 0 turns it off), built on `feat/audd-auto`: automatic AudD's switch and daily cap (`radio.audd_auto`, `radio.audd_auto_daily_cap` in the config). `PUT` takes either; a non-bool switch or a cap outside 0–1000 (or not a whole number) is 400 and nothing is saved.
- `scan.audd_auto`: `{on, daily_cap, used_today, ready, stopped}` for the card's switch row and AudD's "12 of 100 automatic today". `on` is the switch with a cap above 0; `ready` is whether AudD's token is saved; `used_today` counts automatic requests since local midnight (stored in `radio_scan_usage` as provider `audd_auto`, keyed by the local day); `stopped` is `null`, `cap_reached`, or `bad_key` / `out_of_credit` when AudD said so since local midnight (from `radio_scan_keys`; stops automatic requests until midnight). Scan now presses and Tests never count against the cap; automatic requests also count in `scan.usage.audd` for the month. Per station, automatic requests are at least 180 s apart and one per track window (a stream-title change, or 600 s on a station without titles). Never the token.
- **Members** get 403 from `GET /api/radio/settings` too (built on `ux/oct23-a`, HANDOFF 87): the cut-down members' answer went with the members' card, since Settings is admins only; members read Scan now's state from now playing's `scan.states` and `scan.audd_auto` (above). Admins' answers carry `is_admin: true`.

**The radio trigger:** `radio_track_heard` in `GET /api/automations/blocks` (drawer "Radio"), label "A track I don't have played on a favourite station", conditions on `station`, `artist`, `title`; variables `station`, `artist`, `title`, `release`, `source`. It fires when a track is identified, for an owner who doesn't have it, on the owner's favourite stations, or on the stations a `trigger_config` `stations: [ids]` list names (API and Assistant only; the editor keeps the default). Stations favourited by owners of such automations are watched by feed without anyone listening.

**Setup check:** `radio.fpcalc` and `radio.acoustid` (category `radio`, "Internet radio"), while the module is on. Not configured is `skipped`; fpcalc missing with a key set is a warning; a refused key is a problem.

### Library: Albums, Genres and Artists (boards 7a–7g)

Built on `ux/evening-3`. Code: `core/library/release_index.py` (the index), `core/library/bulk_wanted.py` (the bulk add), `api/library_index.py` (the routes); the page is `src/routes/library`. Every route needs a profile (401 without one) and reads the **acting profile** (`acting_profile_id`: the session's own for a member; an admin may name one with `profile_id`) in the caller's library scope (active media server, the profile's library), like the other library and Wanted routes.

**The release index.** One build per profile and library, cached 30 seconds (cleared by these routes' own writes; one build per key at a time). It reads, in five set-based queries and never one per album: your albums with the tracks that have a file, grouped by album and audio quality; the profile's Wanted rows; the metadata cache's releases; the watchlist. Measured on seeded libraries: 4,000 albums / 43,000 tracks / 10,500 cached releases build in about 150 ms and serve a page in 1–7 ms; 12,000 albums / 128,000 tracks in about 500 ms and 4–20 ms. The queries use existing indexes (`idx_albums_source_owner`, `idx_tracks_album_id`, `idx_mce_stats`, the `wishlist_tracks` profile index); no migration was needed.

A **release** is one of:

- an album you have (`kind: "library"`, id `album:<library id>`): at least one track with a file. `state` is `owned`, `partial` (fewer tracks with a file than the metadata source's `api_track_count`), or `below_target` (any track below the quality target, judged like `GET /api/quality/presets`: extension and stored bitrate, no file reads). `format` is what most of its tracks are ("FLAC", "FLAC 24/96", "MP3 320");
- an album of one of your artists you don't have (`kind: "missing"`, id `release:<source>:<id>`): a release a metadata service listed for an artist in your library, from SYNCHRO.S's metadata cache (`metadata_cache_entities`, filled whenever a discography is fetched: the Artist page, a followed-artist scan, enrichment). Albums and EPs only (singles and compilations aren't listed); matched to the library artist by that source's artist id when the library has one (a namesake on a source where the library knows the artist by another id is left out), by name otherwise; a title that matches one you have, editions folded ("(Deluxe Edition)", "- Remastered 2011"), is yours. One release listed by several sources appears once (Spotify, Deezer, iTunes, Discogs, … in that order). Releases age out of the cache with it (30 days unused); visiting the artist brings them back;
- an album only on Wanted (`kind: "missing"`, id `wanted:<source>:<album id>`): your artist's album on this profile's Wanted that neither list above has.

`wanted` is `null` or `{status: "searching" | "not_found", tracks}` for a release you don't have, or have part of, with rows on this profile's Wanted (grouped by album title and artist); `not_found` once the most-tried row has had 3 tries, as on the Wanted page.

**Genre: where it comes from** (Design's question). The album's own `albums.genres`: what the media server read from the files' tags, which SYNCHRO.S's enrichment fills in from Deezer, Last.fm, Discogs, Qobuz, AudioDB or Bandcamp where the tags had none (after the genre whitelist; `genres_locked` keeps a genre SYNCHRO.S settled through rescans). An album with no genres takes its artist's (`artists.genres`, the same two sources plus Spotify's artist genres). A release you don't have takes the genres the metadata service gave it, else its artist's. Both, then: file tags first, the metadata services fill the gaps. An album with several genres counts in each; genres are folded by case ("ambient" and "Ambient" are one, shown capitalised).

**`GET /api/library/releases`** (the Albums tab, 7a–7c). Params: `show` (`all`, `library`, `missing`, `below`), `genre` (a genre's key, lower case), `q` (matches title, artist or genre), `sort` (`recent`, `artist`, `title`, `year`, `genre`), `page`, `limit` (50, at most 200). Unknown values fall back to the default.

```json
{
  "success": true,
  "releases": [
    {"id": "album:811", "kind": "library", "album_id": "811", "title": "Tidewater", "artist_id": "42",
     "artist_name": "Pale Harbour", "year": 2026, "art_url": "/api/image?…", "genres": ["Ambient"],
     "album_type": "album", "tracks_total": 12, "tracks_owned": 11, "below_target": 0, "format": "FLAC",
     "state": "partial", "wanted": null, "added_at": "2026-10-20 09:00:00", "source": null, "source_id": null},
    {"id": "release:spotify:4xyz", "kind": "missing", "album_id": null, "title": "Lantern", "…": "…",
     "state": "missing", "wanted": {"status": "not_found", "tracks": 11}, "source": "spotify", "source_id": "4xyz"}
  ],
  "total": 494, "page": 1, "limit": 50, "has_more": true, "show": "all", "sort": "recent", "genre": "",
  "show_counts": {"all": 494, "library": 410, "missing": 61, "below": 23},
  "genre_total": 494,
  "genres": [{"key": "electronic", "name": "Electronic", "count": 212}, "…"],
  "totals": {"albums": 494, "library": 410, "missing": 61, "below": 23, "tracks": 4980, "genres": 38,
             "artists": 186, "following": 18, "incomplete": 41},
  "missing_summary": {"count": 61, "tracks": 520, "artists": [{"id": "42", "name": "Pale Harbour"}], "sample": ["…4 releases"]},
  "genre_summary": {"name": "Ambient", "albums": 48, "library": 31, "missing": 17, "below": 4,
                    "wantable": {"count": 17, "tracks": 189, "artists": [], "sample": []}, "below_album_ids": ["811"]},
  "target": {"name": "FLAC or better", "preset": "flac", "quality_profile_id": 1, "quality_profile_name": "Default"},
  "built_ms": 148.7
}
```

- `show_counts` are counted with the genre and text filter applied; `genres` (most albums first) with the show and text filter applied; `genre_total` is the "All" chip (show and text, any genre). So Genre and Show combine and each one's counts follow the other.
- `sort=genre` adds `group` to each release (the picked genre, else its first, else "No genre") for the headings.
- `missing_summary` is what "Select all N missing" picks under this view: releases you don't have at all that aren't on Wanted. `genre_summary` (only with a genre) is the 7b line; its `wantable` is what "Add the 17 missing to Wanted" adds.

**`GET /api/library/genres`** (7e). Params `show` (`all`, `gaps`), `sort` (`albums`, `name`), `q`. Each tile: `{key, name, albums, library, missing, wantable, below, covers}`; `covers` are up to four art URLs of the genre's albums you have, most played first (`tracks.play_count`), then the newest. `show_counts: {all, gaps}`, `totals`, `target`.

**`GET /api/library/artist-index`** (7f). Params `show` (`all`, `following`, `incomplete`), `genre`, `q` (name or genre), `sort` (`name`, `recent`, `missing`), `page`, `limit`. Each artist: `{id, name, image_url, genres, following, releases, in_library, missing, wanted, wantable}` (`releases` = in your library + not; `wantable` = missing and not on Wanted, the hover's "Add N missing"). Artists are folded by name like the old grid (the lowest library id). `following` is this profile's watchlist (Spotify, iTunes or Deezer id, else the name). Plus `show_counts`, `genre_total`, `genres` (artist counts), `totals`.

**A selection**, as the next three routes take it: `release_ids` (any releases, picked by hand: an album you have part of adds its missing tracks), and/or `filter` (`show`, `genre` or `genres` (any of them), `q`, `artist_ids`) less `exclude_ids`. A filter picks only releases you don't have at all that aren't on Wanted. At most 500 releases per call: more is `400 {"error": "too_many", "count", "max", "message"}` ("That's 1,204 albums. Add up to 500 at a time: pick a genre or an artist to narrow it.").

**"Select all" is server-side, by filter** (Design's question). The bar's "Select all 61 missing" stores the filter it was pressed under; the page sends that filter with the albums unticked since as `exclude_ids` and any hand picks as `release_ids`, and the server resolves it against the whole library, not the loaded page. It's cheap (the index is already built for the page) and the confirm's numbers are counted the same way, so what the confirm says is what gets added.

**`POST /api/library/releases/summary`** (7d). The confirm's numbers for a selection: `{count, tracks, artists: [{id, name}], sample, selected, already_have, already_wanted, types: {album: 16, ep: 1}, target, following: [artist ids already followed]}`. `count`/`tracks` are what would be added (tracks = what you don't have); `sample` is the first 4, or `sample: N` in the body for more (the confirm's Show all).

**`POST /api/wishlist/bulk` with `action: "add"`** (the bulk add). Body: a selection plus `quality` (`"target"`, or a quality profile id from `GET /api/quality-profile/custom`; an unknown one is `400 unknown_quality`) and optionally `follow_artists: true`. For each release: an album you have whole (or below the target) is **already have**; one with rows on this profile's Wanted is **already wanted**; otherwise its tracklist comes from the metadata service (the album's own source id where known, the source-priority lookup the Artist page's Add to Wanted uses; four at a time) and every track you don't have on that album goes on Wanted with `source_type: "album"`, held to the quality asked. A release whose tracks were all on Wanted already counts as already wanted; one whose tracklist can't be found is **failed**. Rows go through `add_to_wishlist_detailed` for the acting profile, so the ignore list, the blocklist and request rules apply as for one album: **a profile without download rights adds requests** an admin approves (`asks_first: true`), and a request limit refuses what's past it (`refused`).

```json
{"success": true, "added": 15, "already_wanted": 2, "already_have": 0, "failed": 0, "refused": 0,
 "tracks_added": 170, "asks_first": false,
 "followed": {"followed": 4, "already_following": 1, "no_id": 1},
 "results": [{"id": "release:spotify:4xyz", "title": "Lantern", "artist_name": "Pale Harbour", "outcome": "added", "tracks_added": 11, "message": ""}],
 "unknown_ids": []}
```

The route's other actions (`grab`, `skip`, `retry` on `track_ids`) are unchanged.

**`POST /api/library/artists/follow`** `{artist_ids: [library artist ids]}` (the bar's Follow these artists, and the confirm's "Also follow"): each on the first source the library has an id for, the active metadata source first. `{followed, already_following, no_id}`.

**`POST /api/library/albums/upgrade`** (admins) `{album_ids}` or a selection: the genre line's "Upgrade the 4 below target". Applies the Quality Upgrade Finder's pending findings for those albums' tracks through Library Maintenance, as the Apply Quality Upgrades automation does (each better copy goes on Wanted). `{queued, failed, albums, albums_with_upgrades, albums_without}`; albums without a finding yet are counted, not guessed at. `503 maintenance_off` when Library Maintenance isn't running.

**Remove from library** (admins; the bar's "…", through Preview, then confirm). `POST /api/library/albums/remove-preview` with `album_ids` or a selection returns a plan (tool `library_album_remove`): one item per track, `{path, action: "recycle", reason: "artist · album", size, album_id, track_id}`, `meta.albums`. `POST /api/library/albums/remove` with `{plan_id}` moves each file to the recycle bin (`.deleted` under the library folder, restorable from Maintenance → Recycle bin) and drops the albums and their tracks from the library; an album with a file that couldn't be moved keeps its rows. `{albums_removed, files_moved, skipped, errors, kept_albums}`. Plan refusals are the usual 409s.

**The Artist page's Remove from library** (built on `ux/oct23-3`, HANDOFF 74): the same two routes. `remove-preview` with `{artist_id: <library artist id>}` plans every album row of that artist in the caller's library scope (files or not; tracks without a file are `action: "forget"`), with `meta.artist_id`; on confirm, once none of the artist's albums or tracks are left (a guest track on someone else's album keeps them), the artist's row goes too, with its `similar_artists` and `rematch_hints` rows, and the answer adds `artist_removed: true`. The database-only `DELETE /api/library/artist/<id>` is unchanged for other callers; the page no longer uses it.

**"You have N albums" on Follow…'s artist rows** (built on `ux/oct23-3`, HANDOFF 80): `POST /api/library/artists/album-counts` `{source: "deezer" | "spotify" | "itunes" | "discogs" | "musicbrainz", ids: [up to 50 of that service's artist ids]}` → `{counts: {<id>: albums you have}}`: albums with at least one track with a file, in the caller's library scope. One query on the service's indexed artist-id column (`idx_artists_deezer_id` and its siblings), joined to albums by `idx_albums_artist_id` and checked against tracks by `idx_tracks_album_id`: cheap for a page of eight results. An id the library doesn't know, or with no album, is left out (the row then says nothing). An unknown source is 400; more than 50 ids is 400.

**Look for releases you don't have** (built on `ux/oct23-3`, HANDOFF 68; `core/library/missing_releases.py`).

- Library → Artists (board 15e, HANDOFF 95, built on `ux/oct23-a`) reads `job.waiting_until` for the header's "waiting for Spotify's pause, 9 min left", and POSTs `…/stop` from the header's Stop (admins). No route changed.
- `GET /api/library/missing-releases` → `{job, candidates, can_start}`. `candidates` is how many library artists the metadata cache lists no release for (any type, singles included: their discography was never fetched, or came back empty). `can_start` is true for admins. `job` is the running job `{id, status: "running", total, done, failed, started_at, waiting_until, current, recent: true}`, else the last run `{id, status: "done" | "stopped" | "failed", total, done, failed, found_releases, found_artists, started_at, finished_at, note, recent}` (`recent` while it finished within a day; `note: "restart"` for a run a restart cut off), else `null`.
- `POST /api/library/missing-releases/start` (admins) → 202 `{job}`: starts the job over those artists. 409 when one is running, or when there's nothing to look up.
- `POST /api/library/missing-releases/stop` (admins) → `{success: true}`; 409 when nothing runs. The job stops before the next artist or while it waits.
- The job: one at a time for the install, on its own thread, one artist at a time and at most one a second, through the Artist page's discography fetch (`core.metadata.discography_strict.get_artist_discography`, each service given the artist's own id from the library, else a name search), which fills the metadata cache the release index reads. When the discography chain includes Spotify it waits while Spotify is paused or cooling down (`SpotifyClient.is_rate_limited()`, `get_post_ban_cooldown_remaining()`), saying so in Activity; a rate-limit refusal mid-run waits for the pause, then asks once more. Its calls run under `spotify_feature("looking for releases you don't have")`, so a pause it sets off names it. Five refusals in a row (not rate limits) end the run as failed. When it ends it rebuilds the release index and counts the releases you don't have, and that aren't on Wanted, by the artists it checked: `found_releases`, `found_artists`. Each run is a row in the new `library_jobs` table (`kind: "missing_releases"`), which Activity reads.

### Listening history (boards 13a–13b; HANDOFF 64)

Built on `ux/oct23-3`. Code: `core/playback/history.py`, `core/playback/spoken.py` (`plays_page`), the routes in `api/player.py`; the page is `src/routes/library/-ui/history-page.tsx` (`/library?view=history`). All need a profile (401 `profile_required`). Ranges are the browser's: `tz` is `Date.getTimezoneOffset()` (minutes, UTC minus local; ±840 at most), so "Today" starts at the browser's midnight and each play's `day` is the browser's date. `range` is `today`, `7d` (the default; rolling), `30d` (rolling) or `all`.

**Music: `GET /api/library/listening-history?range=7d&tz=-60&q=&offset=0&limit=50`** (1–100). Every play in the caller's listening pile (`core/listening_scope.py`), whatever its source: SYNCHRO.S's player (`soulsync_web`), the media server's poll (`plex`, `jellyfin`, `navidrome`) and Last.fm / ListenBrainz imports. Recent (`GET /api/player/recent`) reads the same table, the player's own plays only. `q` matches the title, artist or album. Explicit tracks are left out for a profile limited to clean tracks.

```json
{
  "success": true,
  "items": [
    {"id": 51203, "kind": "music", "played_at": "2026-10-23 13:02:00", "day": "2026-10-23",
     "title": "Static Bloom", "artist": "Saltmarsh", "album": "Lantern",
     "track_id": "981", "artist_id": "42", "album_id": "811", "file_path": "…", "bitrate": 2304,
     "format": "FLAC 24/96", "below_target": false, "length_s": 276, "image_url": "/api/image?…",
     "in_library": true, "was_in_library": false,
     "server_source": "plex", "player_name": "Living room", "heard_on": null}
  ],
  "total": 412, "offset": 0, "limit": 50, "range": "7d", "since": "2026-10-16 14:30:00",
  "days": {"2026-10-23": 31, "2026-10-22": 58},
  "sources": ["soulsync_web", "plex"],
  "shared_with": 0,
  "target_name": "FLAC or better"
}
```

- **Format and length come from the track** (Design's question): the history keeps what the source said about a play (title, artist, album and the length the source reported, `duration_ms`), not the file. `format`, `below_target` and the length are read from the library track the play is linked to (`db_track_id`), as the queue does: the format the Artist page's way ("FLAC", "MP3 320", "FLAC 24/96" from the track's bit depth and sample rate), judged against the current quality target by extension and stored bitrate. So they describe the copy you have now; an upgraded album shows its new format on old plays. A play with no library track keeps the source's length and has no format.
- `in_library` is false for a play whose track has gone; `was_in_library` tells "no longer in your library" (it was linked once) from "not in your library" (an import of something you never had). Neither has a `track_id`, so neither can be played.
- **Where it was played:** `server_source`, and `player_name` where the server names its player: Plex's history gives a device id, which the poll turns into its name through the server's device list (one request per poll); the new column `listening_history.player_name` keeps it. Jellyfin and Navidrome don't say. `heard_on` is the station when a play in SYNCHRO.S's player matches (artist and title) a Heard on radio row this profile added to Wanted ("heard on FIP Jazz"); one ask per page.
- `days` counts each local day the page touches, the whole day (not only the loaded rows), for the day heads. `sources` are the range's sources, most plays first, for the meta line. `shared_with` is how many other profiles write to the same pile (0 for a profile's own pile; the shared pile's count otherwise), so the line can say "yours only".

**Counts: `GET /api/library/listening-history/counts?tz=-60`** → `{"counts": {"music": {"today": 31, "7d": 412, "30d": 1180, "all": 1204}, "podcast": {…}, "audiobook": {…}}}`: every kind and range in one ask (two queries: one over the listening pile, one over `media_plays`). The Kind buttons show the `all` counts; the range's count is the list's own `total`.

**Podcasts and Audiobooks:** `GET /api/player/plays` with a `range` (above, under "The player").

### DJ data: BPM, key and energy (`/api/library/dj/*`; BACKLOG "DJ area", stage 1)

Built on `feat/dj-stage1`. Code: `core/dj/` (`camelot.py` keys and mixing, `store.py` the `track_dj` table and the queries, `tags.py` the file tags, `worker.py` the background analysis), `core/sample/energy.py`, the routes in `api/dj.py`; the page is `src/routes/library/-ui/tracks-page.tsx` (`/library?view=tracks`), the shared pieces `src/features/dj/`. Every route needs a profile (401 `profile_required`) and reads the caller's library scope (active media server, own library), like the other library routes.

**One track's DJ data** (`dj`), or `null` when nothing is known yet:

```json
{"bpm": 124.0, "bpm_source": "tag", "key": "8A", "key_name": "Am", "key_long": "A minor",
 "key_source": "analysis", "key_confidence": 0.82, "key_uncertain": false, "energy": 7, "analyzed": true,
 "skipped": null}
```

- `bpm_source`: `tag` (the file's own TBPM / BPM / tmpo), `enrichment` (the BPM the metadata source gave at import, `tracks.bpm`), or `analysis`. A track analysis hasn't reached yet still shows the enrichment BPM.
- `key` is Camelot (1–12, A minor, B major); `key_name` the short musical form the tags use; `key_long` the name for the title. `key_source`: `tag` or `analysis`. `key_uncertain` is analysis under 0.5 confidence (shown with "?").
- `energy` 1–10 (analysis only): the RMS level of the loudest half of the track (−30 dBFS → 0, −8 dBFS → 1) weighted 0.6, onset density (0 → 0, 8 a second → 1) weighted 0.4, `1 + round(9 × score)`.

**`POST /api/library/dj/tracks`** `{track_ids: [...]}` (up to 500; more is 400) → `{tracks: {<id>: dj}}`: the track rows' BPM and key on Listening history, the Artist page's Tracks tab and Search. Unknown ids and tracks with nothing known are left out.

**`GET /api/library/dj/browse`** (Library → Tracks). Params `bpm_min`, `bpm_max` (swapped when backwards; unreadable ones ignored), `key` (a Camelot code or any key spelling: "8A", "Am", "A minor", Open Key "1m"; `8A:mix` adds the keys that mix with it), `q` (title, artist or album), `sort` (`bpm` default, `key` wheel order, `energy` highest first, `title`, `artist`, `recent`), `page`, `limit` (50, at most 200). Tracks without the sort's value go last.

```json
{"success": true, "tracks": [{"id": "981", "title": "Static Bloom", "artist_name": "Saltmarsh", "album_title": "Lantern",
  "artist_id": "42", "album_id": "811", "duration_ms": 276000, "file_path": "…", "bitrate": 900,
  "image_url": "/api/image?…", "dj": {"bpm": 124.0, "key": "8A", "…": "…"}}],
 "total": 4980, "page": 1, "limit": 50, "has_more": true, "sort": "bpm", "bpm_min": 120, "bpm_max": 128, "key": "8A:mix"}
```

`total` counts every track the filter matches in the caller's library (the BPM range, the key or `:mix`, `q`), not the page, and the filter comes back as read, so it is what 17a's count line ("38 tracks at 120–128 BPM in 8A, 7A, 9A or 8B · Clear filters") needs (HANDOFF 168). What `:mix` expanded to isn't returned yet: the page knows the rule (`core/dj/camelot.py` `compatible_keys`: the same number's other letter and ±1 on the wheel), and Phase B adds `keys` to the answer rather than repeat it in TypeScript. `POST /api/library/dj/tracks` is a lookup by `track_ids` (at most 500) for rows other pages show; it has no filter or total.

**`GET /api/library/dj/mixes/<track_id>`** ("Mixes well with…") → `{track, matches, total, reason}`. A match is in the same key (`key_relation: "same"`), ±1 on the wheel (`up`, `down`) or the relative major/minor (`relative`), at a BPM within ±6% of the track's, straight or at half or double time (`bpm_relation: "same" | "half" | "double"`, `bpm_diff_pct` signed, after halving or doubling). Ranked: same key, relative, neighbours; then straight tempo before half/double; then the closest BPM. Up to `limit` (50, at most 200). `reason` is `not_analyzed` when the track has no BPM or key yet, `none` when nothing matches, else `null`. 404 for a track outside the library.

**`GET /api/library/dj/status`** → `{settings: {analyze, write_tags, overwrite_tags}, counts: {tracks, analyzed, failed, unreachable, pending}, job, held, analyzer_version, can_start, can_stop}`. `job` is the running sweep `{id, status: "running", total, done, failed, unreachable, tags_written, started_at, waiting: null | "download" | "import" | "drive_away", current, recent}`, else the last one (`status` `done | stopped | failed`, `finished_at`, `note`: `restart` for one a restart cut off, or the failure's words). `held` is true after a person pressed Stop: automatic sweeps wait for a restart or a Start. Tracks' analysis line (153) counts `counts.tracks − counts.pending` as done (analysed, or skipped, failed or unreachable with a reason), shows the bar while anything is pending, and says "All N tracks have BPM, key and energy" only while `job.recent` (a day after the last sweep).

**`POST /api/library/dj/start`** (admins) → 202 `{job}`; 409 when one runs or every track is done. **`POST /api/library/dj/stop`** (admins) → `{success: true}`; 409 when nothing runs.

**The analysis** (`core/dj/worker.py`): one sweep at a time, one track at a time, through Sample Studio's `analyze_track` (`ANALYZER_VERSION` 4) and its `sample_analysis` row both ways. Its thread runs at nice 10 (Linux), rests at least as long as each track took (≥ 0.5 s), waits while a download batch or an auto-import runs and while the library's drive is away (`core.drives.markers.library_away`). The first sweep starts two minutes after boot, then every 30 minutes for new tracks; a sweep only gets a row when it has work. Resumable: each finished track is a `track_dj` row at `dj_analyzer_version`; a new analyzer version redoes the library. A file that isn't there is `unreachable` (asked again a day later, or on Start), not failed; 25 failures in a row, or librosa missing, end the sweep as failed. Tracks over 30 minutes or 400 MB are `skipped` ("too long to analyse": `dj.skipped`, `counts.skipped`); of the rest only the first 10 minutes are decoded. A provisional `analyzing` row precedes each decode; one left by a crash becomes an error at the next start. The sweep also waits for a drive move (`waiting: "drive_move"`, and the move pauses it) and for the Write Tags batch (`waiting: "tag_write"`). Settings: `library.dj_analysis` (on), `library.dj_write_tags` (off), `library.dj_overwrite_tags` (off).

**Activity:** each sweep is a `library_jobs` row (`kind: "dj_analysis"`; `found_releases` carries files tagged, `found_artists` files that weren't there), shown under `kind: library` (Activity's Library jobs filter) with id `library-job:<run>`. Running: "Working out BPM, key and energy", "4,980 tracks · 1,240 done · waiting while a download runs", `ref.stop_path: "library/dj/stop"`. Then "Worked out BPM, key and energy" (`ok`, `warning` with failures) "4,980 tracks · 3 tracks couldn't be analysed · 7 files weren't there · BPM and key written into 1,200 files"; "Stopped working out …" ("Stopped after 1,240 of 4,980 tracks", "… when SYNCHRO.S restarted"); "Couldn't work out …" (`error`). All link to `/library?view=tracks`. Admins see every sweep (automatic ones run as the admin profile); a member only one they started.

**File tags** (`library.dj_write_tags`): ID3 `TBPM` (whole number) and `TKEY` ("Am", "F#", "Ebm"); FLAC / Ogg / Opus `BPM` and `INITIALKEY`; MP4 `tmpo` and `----:com.apple.iTunes:initialkey`. Only where the file has no such frame or field, even an unreadable one (with `dj_overwrite_tags`, where the value differs, then with analysis's values); a BPM only between 20 and 400; a key under 0.5 confidence is never written; only into the library's own file (the stored path, or inside the configured library folders), and only if the file is unchanged since it was analysed. Under the per-file lock, through `core.metadata.common.save_audio_file(allow_inplace_fallback=False, preserve_layout=True)` (temp copy, audio checked, atomic replace; never an in-place rewrite; ID3v1 and the ID3v2 version kept); the stored file signatures (`track_dj.source_sig`, `sample_analysis.source_sig`) follow the new size and mtime so nothing re-analyses, and the slskd share rescan is noted (`notify_library_import`, debounced).

**Storage:** the new table `track_dj` (`track_id` TEXT key; `bpm`, `bpm_source`, `musical_key`, `key_name`, `key_source`, `key_confidence`, `energy`, `energy_source`, `analyzed_bpm`, `analyzed_key`, `dj_analyzed_at`, `dj_analyzer_version`, `source_sig`, `status`, `error`, `tags_written`, `tags_written_at`; indexes on `bpm`, `musical_key`, `dj_analyzer_version`), added by `_add_track_dj_table` (ledger `track_dj_v1`), and `sample_analysis.energy`.

### Spotify pause (rate limits): the `spotify` slice of `/status`, `POST /api/spotify/rate-limit/clear`

When Spotify answers "too many requests", SYNCHRO.S stops calling it for a while. The `spotify` slice of every `/status` frame (the `ss:service-status` event) says so:

```json
{
  "rate_limited": true,
  "rate_limit": {
    "active": true, "remaining_seconds": 712, "retry_after": 720,
    "endpoint": "get_artist_albums", "set_at": 1792792556.1, "expires_at": 1792793276.1,
    "source": "spotify",
    "trigger": "checking an artist's albums for the watchlist scan",
    "feature": "the watchlist scan",
    "estimate_step": null
  },
  "post_ban_cooldown": null,
  "account": {"name": "ross", "playlists": 14}
}
```

- `account` (built on `ux/oct23-a`, HANDOFF 85): the connected account as the server last saw it, for Settings → Connections' "Connected as ross · 14 playlists · metadata source": `name` (Spotify's display name, else the user id) from the auth check's own `current_user` request, `playlists` (Spotify's `total`) from the first page of a playlists read. Either is `null` until such a request has run; `account` is `null` while Spotify isn't authenticated. Nothing asks Spotify for it, so a pause never costs a request; only the install's own client fills it (a profile's own Spotify connection doesn't). "metadata source" comes from the `metadata_source` slice (`source: "spotify"`).

- `source` (new): `"spotify"` when the time is Spotify's own Retry-After, which is obeyed exactly however long it is; `"estimate"` when Spotify sent none and SYNCHRO.S guessed: 10 minutes first, doubling for each repeat within an hour of the last pause ending (10, 20, 40, 80, 160 min, then 4 h at most). `estimate_step` (new) is that step, `null` for Spotify's own time.
- `trigger` (new): what was happening, in words that follow "after" ("checking an artist's albums", "searching for tracks", "checking the Spotify connection"; "a Spotify request" when unknown), with the background job when one named itself ("… for the watchlist scan", "… for background enrichment"). `feature` (new) is that job alone, or `null`.
- `remaining_seconds` is right when the frame is built; count down from when it arrived rather than trusting the clock against `expires_at`.
- `post_ban_cooldown`: after the pause ends, seconds that background jobs (enrichment, watchlist and following scans, auto-sync, discography lookups) still wait: as long as the pause was, at least a minute, at most 30 minutes. Things a person does use Spotify again straight away. Everything then eases back in with slower, jittered calls for 15 minutes.
- The Spotify enrichment worker's status (`/api/enrichment/spotify/status` and the enrichment frames) carries the same `rate_limit` and a new `post_ban_cooldown`.
- **`POST /api/spotify/rate-limit/clear`** (admins; 403 otherwise) is "Try again now": it clears SYNCHRO.S's pause and cooldown and answers `{"success": true, "spotify": {…the slice…}}`. If Spotify is still limiting, the next call brings the pause back, and an estimate comes back longer (the ladder remembers). Pages say so beside the button.
- `GET /api/spotify/rate-limit-status` also returns `source`, `trigger` and `post_ban_cooldown`.
- The words: `src/features/spotify-pause/spotify-pause.ts` (`spotifyPauseView`, `formatWait`, `TRY_AGAIN_NOTE`), also on `window` for the classic scripts as `ssSpotifyPauseView`, `ssClearSpotifyPause`, `ssCanClearSpotifyPause` and `ssSpotifyTryAgainNote`.

### Visuals (boards 10a–10f)

MilkDrop's preset list, one preset by key, favourites per profile, and where an admin's own presets live (`api/visuals.py`, `core/visuals/`). Every route needs a profile (401 `profile_required`). Recent, the chosen visual and family, Quality, Auto-cycle and Blend stay in the browser (`soulsync-visuals-*` keys, Auto-cycle in the SYNCHRO.S visuals' `soulsync-npv2-viz-autocycle`); nothing about them reaches the server.

**The index: `GET /api/visuals/presets?family=milkdrop&q=&author=`.** Asked for once, when the MilkDrop family is first opened (never on page load); the browser then searches and filters it itself. `q` (every word in the name or the author) and `author` (case-insensitive) filter here too. Any other `family` is a 400 `bad_family`.

```json
{"success": true, "family": "milkdrop", "total": 1756, "count": 1756, "bundled": 1754,
 "presets": [{"key": "md-a2d4673ae1656827", "name": "Eggs", "author": "Geiss",
              "full_name": "Geiss - Eggs", "size": 1212, "source": "bundled"}],
 "authors": [{"name": "Geiss", "key": "geiss", "count": 266}],
 "own": {"configured": true, "count": 2, "problem": null, "truncated": false}}
```

- A–Z by name. `name` and `author` come from the preset's "Author - Title" (the file name for your own); leading underscores and the like are dropped from the author, and a name without " - " has `author: null` (the list says "author unknown"). `authors` folds spellings together (Flexi / flexi) and shows the commonest.
- **Bundled** presets are the installed `butterchurn-presets` npm package's `presets/converted/` (1,754 in 2.4.7), copied out of `node_modules` by the build (`webui/scripts/milkdrop-presets.mjs`, the last step of `npm run build`) into `static/dist/visuals/milkdrop/` as `index.json` and one `<key>.json` each. Nothing is in the repository; an install without a build lists none. `key` is `md-` + the first 16 hex of sha1(name).
- **Your own** are `.milk` files in the folder an admin set (`visuals.own_presets_dir`, below), walked three levels deep, at most 5,000, each at most 512 KB; hidden files, other extensions and anything that resolves outside the folder (links) are left out. `key` is `own-` + 16 hex of the path inside the folder. `own.problem` is `missing` or `unreadable` when the folder can't be listed. The listing is reused for 30 seconds.

**One preset: `GET /api/visuals/presets/<key>`.** Fetched when it's picked and kept (`Cache-Control: private, max-age=604800` for bundled, an hour for yours, plus an ETag; the page also keeps it for the session). A bundled key answers Butterchurn's JSON; your own answers its `.milk` text (`text/plain; charset=utf-8`, `X-Preset-Format: milk`), which the browser converts (`milkdrop-preset-converter`). An unknown or malformed key is a 404 `not_found`. An own key is looked up in a listing of the folder (the request never names a path), and the file it names is checked again before it's read: still inside the folder once resolved, `.milk`, a regular file, under the cap.

**Favourites: `GET /api/visuals/favourites?family=milkdrop`, `PUT` and `DELETE /api/visuals/favourites/<family>/<key>`.** The signed-in profile's stars, newest first: `{"success": true, "family": "milkdrop", "keys": ["md-…"]}`; a change answers `{"success": true, "family", "key", "favourite": true|false}` (starring twice is fine). Only `milkdrop` (400 `bad_family`); a key that isn't a preset key is a 400 `bad_key`; 2,000 per profile (409 `too_many`). Table `visual_favourites (profile_id, family, preset_key, created_at)`, primary key on the first three (`core/visuals/favourites.py`, a MusicDatabase migration step).

**Your own presets folder: `GET /api/visuals/settings`, `PUT /api/visuals/settings` (admins).**

```json
{"success": true, "admin": true, "own_presets_dir": "/music/milkdrop",
 "own": {"configured": true, "count": 2, "problem": null, "truncated": false}}
```

- `own_presets_dir` is only in an admin's answer. PUT `{"own_presets_dir": "/music/milkdrop"}` (or `""` for none) checks the folder first: a full path (400 `bad_path`), that exists (400 `missing`) and can be read (400 `unreadable`); members get 403 `admin_only`. Docker paths go through the same resolver as the other folders. Shown in Player settings → MilkDrop.

**The radio card's restart** uses the existing `POST /api/radio/play` with `force_relay: true` (`SoulSyncRadio.play(id, {forceRelay: true})`); nothing new on the server.

### Your music's drives (boards 14a–14t)

`api/drives.py`, `core/drives/`. Every route is admins only except `GET /api/drives/status` (any signed-in profile) and `GET /api/drives/helper.sh` (no session; its one-use token is the credential). Paths are the container's; with the drives folder mounted at the same path (`/Volumes:/Volumes`) they read the same inside and out.

- **`GET /api/drives/status`** → `{library_away, away: ["library"|"downloads"|"staging"], interval: 30, checked_at, boot_id, can_check, folders: {library: {role, label, connected, last_seen, drive, path?, reason?}, …}}`. Members get no `path` / `reason` and `can_check: false`. Admins also get `move: {id, status, promise}` while a move is open and `reminder: {move_id, source_label, target_label, bytes, files, switched_at}` a week after a switch whose old copies are kept. `reason` is `marker`, `content`, `fresh`, `missing`, `unreadable` or `empty`. **`POST /api/drives/status/check`** looks again now.
- **`GET /api/drives/folders`** (14a) → `{folders: [{role, label, path, drive, holds, files, bytes}], drive: {label, free, total, percent, tone: null|"warning"|"danger"}, move, platform}`. Sizes are measured in the background: `null` until the first measure.
- **`GET /api/drives/docker`** (14c) → `{platform, guessed, compose_folder, roots, visible_roots, drives, boot_id, lines: {mounts, slskd_config}, token: {state}, undo}`. **`POST /api/drives/docker/command`** `{folder, platform}` saves both (`drives.compose_folder`, `drives.platform`) and mints the one-use command → `{command, undo, expires_at, lines}`; a folder with anything but plain path characters is `400` with `field: "folder"`. **`GET /api/drives/docker/check`** (14d) → `{boot_id, drives, visible, token: {state: none|live|used|expired}}`: a new `boot_id` means SYNCHRO.S restarted. **`GET /api/drives/helper.sh?t=<token>`** answers the script once within ten minutes, else `403` with a line to echo.
- **`GET /api/drives/browse?path=`** → the folders one level under a path on a drive (no links, no dot-folders); without `path`, the drives offered.
- **The move.** `drive_move` is `{id, status, promise: {tone, words}, choice: {roles, target, separate, per_role, exfat, checksum}, checks: {rows: [{key, title, tone, tag, detail, stop?, needs_choice?, sign_in?}], ok, summary, dests, speed, format, need}, plan: {order, dests, sources, total_bytes, total_files, estimate_seconds, checksum_seconds, target_label, source_label, automations, library_paths, media_label}, folders: [{role, label, source, dest, files, bytes, copied_files, copied_bytes, verified}], progress: {phase, role, current, copied_bytes, total_bytes, speed, eta_seconds, checked, total, different, step, waiting_for}, failure: {kind: drive_away|full|write|mismatch|unreadable|refused|restart|error, words, files?, count?, matching_files?}, result: {checks: [{key, ok, title, detail}], media, slskd, removed}}`. `status`: `draft`, `copying`, `verifying`, `switching`, `switched`, `failed`, `stopped`, `removed`, `switched_back`.
  - `GET /api/drives/move` → `{move, overview?, running, boot_id}` (the open move, else one finished in the last hour; `overview` with the folders, drives and the home disk while it's a draft). `POST /api/drives/move` → the open move or a new draft.
  - `PUT /api/drives/move/<id>/choice` (any of the choice's keys), `POST …/check`, `POST …/slskd-session` `{username, password}` (only the session token slskd gives back is kept, encrypted), `POST …/plan`, `POST …/start` `{checksum}`.
  - `POST /api/drives/move/stop` (Activity's Stop) or `…/<id>/stop`: Stop and undo. `POST …/resume` (carry on, or try the switch again), `…/recopy` (copy the files that didn't match again), `…/skip-unreadable`, `…/switch-back`, `…/leave` (a draft).
  - `POST /api/drives/move/<id>/remove-preview` → a plan (tool `drive_move_remove_old`; the "Preview, then confirm" shape, items `action: "delete"`), `GET /api/drives/plan-list/<plan_id>` the full list as text, `POST …/remove` `{plan_id}` → `{deleted, freed_bytes, skipped, move}`; refusals are `409` with the plan codes.
  - Refusals are `409` (or `400`, `404`) with a sentence in `error`.
- **Activity:** `kind=library` ("Library jobs") holds Look for releases you don't have and the move; the move's running row has `ref.stop_path: "drives/move/stop"` and `link: "/move"`. `counts.library`.
- **Settings:** a settings POST from a page loaded before a switch drops the folder paths the move switched away from; while a move copies, the three folder paths don't change.

## Available today, not yet designed for

- **Library history:** `GET /api/library/history?type=download|import|podcast`. Past downloads and imports.
- **Sync history:** `GET /api/sync/history`. Playlist mirror runs.
- **Download batches:** `GET /api/downloads/batch-history`.

The Activity feed above already merges these (and the mirror runs behind `GET /api/playlist-pipeline/history`); use them for a page about one of them.

## Needs building

For the boards Ross approved on 22 October (`HANDOFF.md`). Field names may change while they're built; Dev moves each section to "Built" when it lands.

Nothing is waiting here now: Internet radio moved to "Built" above (built on `ux/radio`).

Shapes under "Needs building" are proposals until built. Dev updates this file when they are.
