# Contracts: the data screens can rely on

What the API gives each screen today, and what would have to be built. Design within this. If a screen needs something new, ask in `HANDOFF.md`.

## Built

### Setup check: `GET /api/setup/check`

Admin only. `?scope=local` runs only the fast local checks (folders, folder layout, running user, and from settings alone whether a library is chosen). The full run can take up to about 25 seconds, because it calls slskd and the media server.

The page adds one row the server can't run (Design's 312, since `feat/step2-names`): **This browser · Auto mix**, an info row (`data-status="info"`, never a warning), from `mixSupport()`: "Auto mix needs SYNCHRO.S on https, or opened on its own computer (localhost)…" or "Auto mix can run in this browser…". Not in the route's answer or its counts. Settings → Connections has the same answer with how (`#ss-https-note`, `features/automix/https-note.tsx`).

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

### Privacy check: `GET /api/setup/privacy`, `PUT /api/setup/privacy/settings` (BACKLOG "Privacy: a VPN for Soulseek and torrents")

Admin only (403 for anyone else): the answer holds the VPN's and the home connection's IP addresses. It reads Gluetun's control server (`/v1/vpn/status`, `/v1/publicip/ip`, `/v1/portforward`), slskd (`/api/v0/options`, `/api/v0/application`) and the torrent client's listening port, all at once, with the setup check's timeouts; the whole run ends within 15 seconds. Nothing is changed anywhere.

```json
{
  "success": true,
  "state": "protected",
  "tone": "ok",
  "headline": "slskd and qBittorrent go through Proton VPN (Netherlands) · port 51234 forwarded · if the VPN drops, they stop",
  "configured": true,
  "services_configured": true,
  "rows": [
    {"id": "privacy.vpn", "title": "VPN", "status": "ok", "detail": "Proton VPN is connected (Netherlands).", "fix": "", "category": "privacy"},
    {"id": "privacy.address", "title": "The address peers see", "status": "ok", "detail": "…", "fix": "", "category": "privacy"},
    {"id": "privacy.port", "title": "Forwarded port", "status": "ok", "detail": "A port is forwarded and slskd and qBittorrent listen on it.", "fix": "", "category": "privacy", "data": {"port": 51234, "listen_ports": {"slskd": 51234, "torrent": 51234}}},
    {"id": "privacy.kill_switch", "title": "Kill switch", "status": "ok", "detail": "…", "fix": "", "category": "privacy"}
  ],
  "settings": {"gluetun_url": "http://gluetun:8000", "api_key_set": true, "home_ip_lookup": false, "home_ip_service": "https://api.ipify.org?format=json"},
  "vpn": {"reachable": true, "status": "running", "up": true, "name": "Proton VPN", "country": "Netherlands", "city": "Amsterdam", "forwarded_port": 51234},
  "services": [{"key": "slskd", "name": "slskd", "reachable": true, "listen_port": 51234, "inside": true, "how": "same container as Gluetun", "signed_in": true}],
  "addresses": {"vpn": "185.65.134.10", "home": null, "home_lookup": false, "home_checked_at": null, "home_error": null, "home_service": "https://api.ipify.org?format=json"},
  "ran_at": 1792570000.0, "duration_ms": 180
}
```

- `state`: `not_set_up` (no Gluetun address; `rows` holds one skipped row saying how, `vpn` is `null`), `unreachable` (Gluetun doesn't answer in time, or something else does), `refused` (Gluetun refused the key), `vpn_down`, `leak` (slskd still looked signed in to Soulseek while the VPN was down, in two reads a few seconds apart; or the VPN's address is the home one), `not_using_vpn` (slskd or the torrent client has its own container, outside Gluetun), `service_unreachable` (slskd or the torrent client didn't answer), `no_port`, `port_mismatch`, `not_confirmed` (the VPN works but the kill switch or a listening port couldn't be confirmed), `protected`. `tone` is a setup-check status (`ok`, `warning`, `error`, `skipped`). **Only `protected` is `ok`**: anything the check couldn't see is `warning`, never green.
- `headline` is the sentence to show; it names only the services it checked ("slskd and qBittorrent go through …"). Rows are setup-check results; **no row's `detail` or `fix` holds an IP address or a port number**, so the copied setup-check report and the Assistant's summary never do. Addresses are only in `addresses`; port numbers in the rows' `data` and in `vpn.forwarded_port`.
- `services_configured`: Soulseek or a torrent client is set up. With neither (and no Gluetun address), the card folds to one line.
- Gluetun's control server is asked with redirects off and a 16 KB cap on each answer; an unknown status word reads as `unknown`. The whole run stops waiting at 15 seconds: a source that hasn't answered is `reachable: null`, `how: "didn't answer in time"`, never fine.
- `vpn.up` is Gluetun's status `running` **and** a public address: Gluetun reports `running` while a tunnel that passes nothing is still being tried, with an empty `public_ip`.
- `services[].inside`: `true` only when SYNCHRO.S reaches the service and Gluetun by two different Docker service names (one label, not an address; `slskd` and `gluetun`), SYNCHRO.S asks Docker's embedded DNS (127.0.0.11), and every address of the service's name is one of Gluetun's, on a network SYNCHRO.S's own container is on that isn't the home network (the network carrying its default route counts only on a Docker bridge, a `veth` interface, inside 172.16.0.0/12, Docker's own pool); `false` when such names lead to separate containers there; `null` (can't tell) for anything else: one name for both, a LAN address, a name with a dot, the Docker host, a NAS publishing both ports, host networking or macvlan. slskd's own Gluetun integration at 127.0.0.1 is shown in `how` but never counts as proof (slskd on the host with Gluetun's 8000 published looks the same).
- The home address is looked up only with `home_ip_lookup` on: one `GET https://api.ipify.org?format=json` through the outbound guard, kept for an hour (five minutes after a failure).

`PUT /api/setup/privacy/settings` takes JSON (at most 4 KB; 413 above, 400 for a form) with any of `gluetun_url` (http or https, a host and port, nothing after it; `""` clears it), `api_key` (Gluetun's key, printable ASCII without spaces; `""` removes it; leave it out to keep the saved one) and `home_ip_lookup` (boolean; turning it off forgets the cached address). Every value is checked before any is written: a bad value is 400 with `field`, and nothing changes. Answers `{"success": true, "settings": {…}}` as above; the key is never sent back. Settings: `privacy.gluetun_url`, `privacy.gluetun_api_key` (encrypted at rest, redacted in `GET /api/settings` and the API's `GET /api/v1/settings`), `privacy.home_ip_lookup`, `privacy.vpn_name` (the name in the sentences, "Proton VPN" unless set).

**Setup check:** the four rows (category `privacy`, "Privacy (VPN)") are in the full run once `privacy.gluetun_url` is set; never in `?scope=local`.

Code: `core/privacy_check.py`, `api/setup_check.py`, `webui/src/routes/setup-check` (`-ui/privacy-card.tsx`, `-setup-check.privacy.ts`); the torrent adapters' `listen_port()`. The VPN set-up itself: `docker-compose.vpn.yml` (slskd), `docker-compose.vpn-qbittorrent.yml` (a new qBittorrent) or `docker-compose.vpn-qbittorrent-existing.yml` (the one already in the compose file), `vpn.env.example`, `Support/VPN.md`.

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
  "channels": 2, "on_disk_kbps": 2296,
  "path_label": "Library", "on_disk": true,
  "title": "Harbour Light", "artist": "Pale Harbour", "artist_id": "42",
  "album": "Lantern", "album_id": "811", "year": 2024, "track_number": 3, "disc_number": 1,
  "album_track_count": 11,
  "quality": {"at_target": true, "target_name": "FLAC or better"},
  "image_url": "..."
}
```

- `format` is the readout's word (FLAC, ALAC, MP3, AAC, OGG, Opus, WAV, AIFF, DSD); `bit_depth` is only given for lossless files. Bit depth and sample rate are read from the file with mutagen the first time and kept on the track (`tracks.bit_depth`, `sample_rate`, with `audio_probe_sig` so a changed file is read again; `core/playback/audio_details.py`). `bitrate_kbps` is the library's own, or the file's when the library has none.
- `channels` (1 mono, 2 stereo, more for surround) is read with the bit depth and sample rate and kept on the track (`tracks.channels`; 0 kept when the file doesn't say, answered as `null`); a track whose facts were kept before `channels` existed is read once more. `on_disk_kbps` is the file's size over its length, `null` when the file isn't on this machine. Both feed the Visuals' Data readout (board 30i; Lyrics step 1 and the Data visualiser of 30 October).
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
- Stored in the music database's `radio_recent` (`profile_id`, `station_id`, `station_json`, `played_at`; primary key `(profile_id, station_id)`, index `(profile_id, played_at)`; migration step `add_radio_recent`, ledger `radio_recent_v1`). Removing a link removes its rows; deleting a profile removes the profile's (the profile sweep). The browser keeps its own copy per profile in `localStorage` `ssRadioRecentStations:<profile id>` (eight, with `played_at`; the old shared `ssRadioRecentStations` is removed) as the first paint and the fallback, and merges the server's list over it (`mergeRecent` in `src/features/radio/radio.recent.ts`).

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

- `bpm_source`: `tag` (the file's own TBPM / BPM / tmpo), `enrichment` (the BPM the metadata source gave at import, `tracks.bpm`), or `analysis`. A track analysis hasn't reached yet still shows the enrichment BPM. Since the drum and bass BPM fix (`fix/dnb-bpm`, HANDOFF 300 built): **`override`** (a person's Double BPM / Halve BPM, below) comes first, then **`grid`** (the beat grid's measured BPM, to a hundredth, once the track has a grid at this version: tags no longer win over a measured grid), then the tag, enrichment or analysis. `bpm_tag` is the file's tagged BPM when another one is shown (null otherwise), for the title "Tagged 87". A tag or enrichment at half the analysis's tempo where the analysis chose the fast octave **from evidence** (the file's genre, or the backbeat at the fast tempo: `track_dj.analyzed_bpm_basis` `genre` or `backbeat`; drum and bass tagged 87, analysed 174) is kept at the analysis's octave (`analysis`); a fast reading that's only the tracker's (`kept`) or the range's never overrides a tag, and a tag is never halved. Browse's BPM range and sort, "Mixes well with", the Mix tab, sets' steps, the planner and Export to Traktor all read this one value.
- `key` is Camelot (1–12, A minor, B major); `key_name` the short musical form the tags use; `key_long` the name for the title. `key_source`: `tag` or `analysis`. `key_uncertain` is analysis under 0.5 confidence (shown with "?").
- `energy` 1–10 (analysis only): the RMS level of the loudest half of the track (−30 dBFS → 0, −8 dBFS → 1) weighted 0.6, onset density (0 → 0, 8 a second → 1) weighted 0.4, `1 + round(9 × score)`.

**`POST /api/library/dj/tracks`** `{track_ids: [...]}` (up to 500; more is 400) → `{tracks: {<id>: dj}}`: the track rows' BPM and key on Listening history, the Artist page's Tracks tab and Search. Unknown ids and tracks with nothing known are left out.

**`GET /api/library/dj/browse`** (Library → Tracks). Params `bpm_min`, `bpm_max` (swapped when backwards; unreadable ones ignored), `key` (a Camelot code or any key spelling: "8A", "Am", "A minor", Open Key "1m"; `8A:mix` adds the keys that mix with it), `q` (title, artist or album), `sort` (`bpm` default, `key` wheel order, `energy` highest first, `title`, `artist`, `recent`), `page`, `limit` (50, at most 200). Tracks without the sort's value go last. Each track says whether the caller starred it (`starred`, see "Stars"); **`starred=1`** (Tracks' Starred filter, 24a) keeps only the caller's starred tracks, the other filters still applying, and keeps a starred track whose file has gone (`file_missing: true`; it keeps its star and shows as File missing).

```json
{"success": true, "tracks": [{"id": "981", "title": "Static Bloom", "artist_name": "Saltmarsh", "album_title": "Lantern",
  "artist_id": "42", "album_id": "811", "duration_ms": 276000, "file_path": "…", "bitrate": 900,
  "image_url": "/api/image?…", "dj": {"bpm": 124.0, "key": "8A", "…": "…"}}],
 "total": 4980, "page": 1, "limit": 50, "has_more": true, "sort": "bpm", "bpm_min": 120, "bpm_max": 128, "key": "8A:mix",
 "keys": ["8A", "7A", "9A", "8B"]}
```

`total` counts every track the filter matches in the caller's library (the BPM range, the key or `:mix`, `q`), not the page, and the filter comes back as read, so it is what 17a's count line ("38 tracks at 120–128 BPM in 8A, 7A, 9A or 8B · Clear filters") needs (HANDOFF 168). `keys` (phase B2) is what the key filter covered, in the count line's order: the key, −1 and +1 on the wheel, then the relative major or minor (`core/dj/store.py` `mix_keys` over `compatible_keys`); one code without `:mix`, `[]` with no key or an unreadable one. `POST /api/library/dj/tracks` is a lookup by `track_ids` (at most 500) for rows other pages show; it has no filter or total.

**`GET /api/library/dj/mixes/<track_id>`** ("Mixes well with…") → `{track, matches, total, reason}`. A match is in the same key (`key_relation: "same"`), ±1 on the wheel (`up`, `down`) or the relative major/minor (`relative`), at a BPM within ±6% of the track's, straight or at half or double time (`bpm_relation: "same" | "half" | "double"`, `bpm_diff_pct` signed, after halving or doubling). Ranked: same key, relative, neighbours; then straight tempo before half/double; then the closest BPM. Up to `limit` (50, at most 200). `reason` is `not_analyzed` when the track has no BPM or key yet, `none` when nothing matches, else `null`. 404 for a track outside the library. `within` (phase B2, 17b's "Widen to 10%"): the tempo window in percent, 1–12 (clamped; unreadable means 6); the answer's `within` says which was used.

**`GET /api/library/dj/status`** → `{settings: {analyze, write_tags, overwrite_tags}, counts: {tracks, analyzed, failed, unreachable, pending}, job, held, analyzer_version, can_start, can_stop}`. `job` is the running sweep `{id, status: "running", total, done, failed, unreachable, tags_written, started_at, waiting: null | "download" | "import" | "drive_away", current, recent}`, else the last one (`status` `done | stopped | failed`, `finished_at`, `note`: `restart` for one a restart cut off, or the failure's words). `held` is true after a person pressed Stop: automatic sweeps wait for a restart or a Start. Tracks' analysis line (153) counts `counts.tracks − counts.pending` as done (analysed, or skipped, failed or unreachable with a reason), shows the bar while anything is pending, and says "All N tracks have BPM, key and energy" only while `job.recent` (a day after the last sweep).

**`POST /api/library/dj/start`** (admins) → 202 `{job}`; 409 when one runs or every track is done. With `{track_id}` (phase B2, the Mixes panel's "analyse it now"): the track goes first in a new sweep, or next in the running one (202 `{queued: true, job}`; the running sweep's `total` grows by one if it wasn't in it). A track that's already done isn't redone.

**"Mixes well with" in the browser** (phase B2, `features/dj/mixes-store.ts`; retired in step 3, whose Mix tab takes these keys out of the browser once): the open track is kept per tab in `sessionStorage` `soulsync.dj.mixes.seed` (`{id, title}`), so a full page load reopens the panel; "Follow what's playing" per browser in `localStorage` `soulsync.dj.mixes.follow` (`on` / `off`, on by default). Follow reads `window.SoulSyncPlayer.state().track.id` on each `ss:player` event and asks `/mixes/<id>` before re-seeding. "Make a playlist from these…" calls `POST /api/user-playlists` `{name, tracks}` (the existing route); the toast's Open it calls `openMirroredPlaylistModal(id)`. `showToast(message, type, helpSection, opts)` takes `opts.action = {label, run}` (`static/downloads.js`). **`POST /api/library/dj/stop`** (admins) → `{success: true}`; 409 when nothing runs.

**The analysis** (`core/dj/worker.py`): one sweep at a time, one track at a time, through Sample Studio's `analyze_track` (`ANALYZER_VERSION` 5 since the drum and bass fix: the tempo's octave, `core/sample/tempo.py`) and its `sample_analysis` row both ways. Its thread runs at nice 10 (Linux), rests at least as long as each track took (≥ 0.5 s), waits while a download batch or an auto-import runs and while the library's drive is away (`core.drives.markers.library_away`). The first sweep starts two minutes after boot, then every 30 minutes for new tracks; a sweep only gets a row when it has work. Resumable: each finished track is a `track_dj` row at `dj_analyzer_version`; a new analyzer version redoes the library. A file that isn't there is `unreachable` (asked again a day later, or on Start), not failed; 25 failures in a row, or librosa missing, end the sweep as failed. Tracks over 30 minutes or 400 MB are `skipped` ("too long to analyse": `dj.skipped`, `counts.skipped`); of the rest only the first 10 minutes are decoded. A provisional `analyzing` row precedes each decode; one left by a crash becomes an error at the next start. The sweep also waits for a drive move (`waiting: "drive_move"`, and the move pauses it) and for the Write Tags batch (`waiting: "tag_write"`). Settings: `library.dj_analysis` (on), `library.dj_write_tags` (off), `library.dj_overwrite_tags` (off).

**Activity:** each sweep is a `library_jobs` row (`kind: "dj_analysis"`; `found_releases` carries files tagged, `found_artists` files that weren't there), shown under `kind: library` (Activity's Library jobs filter) with id `library-job:<run>`. Running: "Working out BPM, key and energy", "4,980 tracks · 1,240 done · waiting while a download runs", `ref.stop_path: "library/dj/stop"`. Then "Worked out BPM, key and energy" (`ok`, `warning` with failures) "4,980 tracks · 3 tracks couldn't be analysed · 7 files weren't there · BPM and key written into 1,200 files · No beat grid found for 2 tracks" (a track whose BPM and key were kept but whose beat grid failed counts as done; the grid failures are counted apart, from the run's own count (its note once finished), and the line adds ", so the rest wait for the next run" when 25 in a row stopped the looking for grids; `warning` with either); "Stopped working out …" ("Stopped after 1,240 of 4,980 tracks", "… when SYNCHRO.S restarted"); "Couldn't work out …" (`error`). All link to `/library?view=tracks`. Admins see every sweep (automatic ones run as the admin profile); a member only one they started.

**File tags** (`library.dj_write_tags`): ID3 `TBPM` (whole number) and `TKEY` ("Am", "F#", "Ebm"); FLAC / Ogg / Opus `BPM` and `INITIALKEY`; MP4 `tmpo` and `----:com.apple.iTunes:initialkey`. Only where the file has no such frame or field, even an unreadable one (with `dj_overwrite_tags`, where the value differs, then with analysis's values); a BPM only between 20 and 400; a key under 0.5 confidence is never written; only into the library's own file (the stored path, or inside the configured library folders), and only if the file is unchanged since it was analysed. Under the per-file lock, through `core.metadata.common.save_audio_file(allow_inplace_fallback=False, preserve_layout=True)` (temp copy, audio checked, atomic replace; never an in-place rewrite; ID3v1 and the ID3v2 version kept); the stored file signatures (`track_dj.source_sig`, `sample_analysis.source_sig`) follow the new size and mtime so nothing re-analyses, and the slskd share rescan is noted (`notify_library_import`, debounced).

**Storage:** the new table `track_dj` (`track_id` TEXT key; `bpm`, `bpm_source`, `musical_key`, `key_name`, `key_source`, `key_confidence`, `energy`, `energy_source`, `analyzed_bpm`, `analyzed_key`, `dj_analyzed_at`, `dj_analyzer_version`, `source_sig`, `status`, `error`, `tags_written`, `tags_written_at`; indexes on `bpm`, `musical_key`, `dj_analyzer_version`), added by `_add_track_dj_table` (ledger `track_dj_v1`), and `sample_analysis.energy`. The drum and bass fix adds `bpm_override`, `bpm_override_at`, `bpm_override_by` (the profile) `analyzed_bpm_basis` (why the analysis's tempo is in its octave: `unambiguous`, `kept`, `genre`, `range`, `backbeat`; Sample Studio's row keeps it too, `sample_analysis.tempo_basis`) and `bpm_tag_written` (a BPM written into the file from a person's ×2 / ÷2) through the same add-only step, and `track_grid.measured_json` (below), and the one-time `_promote_settled_tempos` (ledger and metadata marker `dj_tempo_octave_v5`).

**The tempo's octave** (`core/sample/tempo.py`, analyzer 5 and grid 3): a reading of 70–100 or 140–200 BPM is checked against its double or half; 100–140 is never changed. A fast reading is kept unless the file's genre is a slow one (hip hop read at 180 is 90) and the backbeat isn't at the fast tempo. A slow reading is doubled when the file's genre tag is drum and bass or a cousin (jungle, neurofunk, liquid, breakcore, footwork, juke …), or dubstep, trap, grime or drill when the double lands at 125–160; when it's under 78 (dubstep's 70 is 140; not for the grid's hint); or when the snare's backbeat (the mids, 160–2500 Hz) falls on every other beat of the double (it also overrules a slow genre). The grid tests a half-time hint the same way (it never halves a hint, and folds one only from 200). **The upgrade:** rows the rule can't change (DJ data analysed at 100–140, an error, too long; Sample Studio's analyses that fold into 100–140; grids at 100–140 found from a hint at 100–140 or none, too short, an error, too long, unreachable) move to the new versions without a decode; the rest are analysed again by the sweep, one decode for both.

### Double BPM / Halve BPM (`POST /api/library/dj/bpm`; HANDOFF "Dev, drum and bass BPM (half-time) fix of 27 October")

For a track read at half (or double) its tempo. **`POST /api/library/dj/bpm`** `{track_ids: [...], action: "double" | "halve" | "reset"}` (1–500 ids; tracks in the caller's library scope, as every DJ read: an admin any of them, a member only their own library's, since a shared track's BPM is everyone's; JSON only, body at most 64 KB; one request a second a profile, 429 `rate_limited` with `Retry-After`) → 200

```json
{"success": true, "changed": {"981": 174.0, "982": null}, "skipped": {"983": "no_bpm"},
 "tracks": {"981": {"bpm": 174.0, "bpm_source": "override", "…": "…"}}}
```

- `double` / `halve` take the BPM shown (above) ×2 or ÷2, kept as `track_dj.bpm_override` (`bpm_source: "override"`). Analysis never writes that column, so **no later analysis undoes it**; a track analysis hasn't reached yet keeps it too.
- `reset` clears it (`changed` says `null`): the measured BPM shows again, and the measured grid is put back (no decode).
- **The grid follows at once, without a decode,** always worked out from the grid as measured, which the row keeps in `track_grid.measured_json` while it's rescaled (so ÷2 then ×2 is the measured grid exactly): doubling halves the period (each beat stays a beat, with one added halfway; a drifting grid's halfway point is where the off-beat falls), keeps the downbeat, and doubles bars, sections and mix regions (the phrases are counted again from the same section changes). Halving keeps the downbeat's beats (every other one), and pairs the bars so that the most section changes stay on a bar line (an odd one rounds down). A grid found later at the other octave (a new grid version, a re-analysis) is rescaled to the person's BPM as it's saved; the save reads the person's BPM and writes the grid in one transaction, as the route does, so neither undoes the other. A grid that isn't an octave of the person's BPM is no grid to mix on: `GET /grid`, `/grids` and the planner see `analyzed: false`, `reason: "bpm_mismatch"` (the plan plays on or echoes out, "… has a BPM set by hand that its beat grid doesn't match"). With Settings' "Write BPM and key into files" on, the person's BPM is the one written, and remembered (`track_dj.bpm_tag_written`): a file tag equal to it is SYNCHRO.S's own, ignored by later analyses, so "Use the measured BPM" stays measured; a different BPM written into the file later is the file's own again.
- `skipped` reasons: `no_bpm` (nothing to double yet), `out_of_range` (it would leave 40–300 BPM), `not_set` (`reset` with nothing set), `shared` (a member, a shared track), `not_yours` (a member, another profile's track). Ids outside the caller's library are left out of the answer; **404** when none of them is in it; **403** `shared` ("Only an admin can change the BPM of a track in the shared library.") when every one was a member's shared or not-theirs track. 400 for a missing or unknown `action`, `track_ids` not a non-empty list or over 500, or a body that isn't JSON; 413 over 64 KB; 401 without a profile. `Cache-Control: no-store`.
- **In the browser** (`src/features/dj/tempo.ts`, `track-menu.ts`): Tracks' row "…" (after Add to playlist…: Double BPM, Halve BPM, and Use the measured BPM on a BPM set by hand; Double is disabled over 150 with "It would be over 300 BPM", Halve under 80; for a member on a shared track (`shared: true` on browse's rows) all three are disabled with "Only an admin can change a shared track's BPM") and the selection's "…" (Double BPM, Halve BPM, after Add to playlist…; disabled for a member whose picks are all shared; past 500 picked the first 500 are sent and the toast says so). A toast says what changed ("Now 174 BPM", "Doubled the BPM of 3 tracks · 1 not changed: no BPM yet"); the DJ queries are read again. The BPM's title: "174 BPM, measured from the beats · Tagged 87", "172 BPM, set by hand".

### Export to Traktor (`/api/library/dj/traktor/*`; BACKLOG "DJ area", stage 2a; boards 21a, 21b)

Built on `feat/dj-traktor-export`. Code: `core/dj/traktor.py` (the `.nml` writer, Mac paths, the export folder), the routes in `api/dj.py`; the web pieces in `src/features/dj/` (`traktor.api.ts`, `traktor.format.ts`, `traktor-export-dialog.tsx`, `traktor-card.tsx`). Both files are on `.github/gauntlet-paths.txt`. Every route needs a profile (401 `profile_required`).

**`POST /api/library/dj/traktor/export`** (any profile; JSON body at most 64 KB, else 413, a chunked body included: at most 64 KB + 1 byte is ever read)

```json
{"action": "preview", "source": "playlist", "playlist_id": 4}
{"action": "download", "source": "tracks", "track_ids": ["981", "982"], "name": "optional"}
{"action": "save", "source": "mixes", "track_id": "981", "within": 6, "overwrite": false}
```

- `action`: `preview` (default) | `download` | `save`; anything else 400. `source`: `playlist` (`playlist_id`, a positive integer; a playlist that isn't the caller's reads as 404, admins read any, as the mirrored-playlist routes do), `tracks` (`track_ids`, a non-empty list of at most 1,000, else 400; unknown ids, and ids outside the caller's library, are left out as `not_in_library`), `mixes` (`track_id`, `within` 1–12: the seed and up to 200 tracks that mix with it, in the panel's order; 404 for a track outside the library). Any other source 400.
- Library tracks are read through the DJ store's `_scope` (the active media server and the caller's own or the shared library); a playlist's rows are matched by title and artist (case-insensitive) to tracks with a file in that scope, the first 1,000 rows (the rest `too_many`).
- **`preview`** →

```json
{"success": true, "name": "Sunday Set", "filename": "Sunday Set.nml",
 "counts": {"tracks": 24, "found": 23, "left_out": 1},
 "example_path": "/Volumes/Music HD/SoulSync/Transfer/Tidewater/Night Ferry EP/01 Night Ferry.flac",
 "mac_path": "/Volumes/Music HD/SoulSync/Transfer", "library_folder": "/app/Transfer",
 "left_out": [{"title": "Copper Sky", "artist": "Tidewater", "reason": "not_in_library", "words": "isn't a file in your library"}],
 "reasons": {"not_in_library": 1}, "keys": 20, "can_edit": true,
 "folder": {"state": "unset", "shown": null, "can_save": false, "exists_at": null}}
```

  `left_out` lists at most 50; `reasons` counts them all: `not_in_library`, `no_mac_path` (neither the drive helper nor the card knows the Mac's name), `outside` (the file isn't under the library folder the Mac path names), `bad_path` (a folder or file name starting with a colon, which Traktor's notation can't spell), `too_many`, `lookup_limit` (the export had already looked up its 50 stored paths on disk, or spent 5 s doing so; see Mac paths). `keys` is how many keys go in the file. `folder.can_save` is true for an admin whose export folder is usable now; `folder.shown` is the folder by the Mac's name when it maps, else the container path. **`mac_path`, `library_folder` and `folder.shown` go to admins only**: a member's preview has `example_path` (their own first track as the Mac sees it), `folder.state`, `folder.shown: null` and `folder.can_save: false`. A tracks selection without a `name` is called "SYNCHRO.S tracks YYYY-MM-DD"; Mixes is "Mixes with <title>".
- **`download`** → 200 `application/octet-stream`, `Content-Disposition: attachment; filename="<ASCII>"; filename*=UTF-8''<percent-encoded>`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. The name has no folders, control, Unicode format (`Cf`: the right-to-left override, zero-width characters) or reserved characters, or leading dots, at most 80 characters before `.nml`, and is never Traktor's own `collection.nml` (it becomes `collection (playlist).nml`). 409 when nothing can go in.
- **`folder.exists_at`** (phase E, HANDOFF 234): for an admin whose folder can take the save, when something already named `filename` in it was written (epoch seconds, `lstat`: a link at the name counts and isn't followed), else `null` (always `null` for members). The dialog turns its last sentence into the warning and its primary into Replace it from it. Read only: the folder is checked and opened as the save does.
- **`save`** (admins; 403 for members, who download) → `{saved: true, filename, folder, counts}`. 409 `{exists: true, filename, exists_at}` when the file is already there and `overwrite` isn't `true`; 409 `{folder_state}` when the export folder isn't usable now; 500 when the write fails (nothing is left behind).

**`GET /api/library/dj/traktor/settings`** → admins: `{mac_path, mac_path_from_helper, library_folder, export_folder, export_folder_state, export_folder_on_mac, collection, can_edit: true}`; members: `{mac_path_set, mac_path_from_helper_set, export_folder_state, collection, can_edit: false}` (whether things are set, not where). `export_folder_state`: `ok`, `unset`, `invalid`, `outside`, `missing`, `not_writable`. `collection` is the words for where Traktor keeps `collection.nml` (stage 2b reads it).

**`PUT /api/library/dj/traktor/settings`** (admins) `{mac_path?, export_folder?}`; an empty string clears one. 400 `{field, error}` for a Mac path that isn't an absolute POSIX path (no `..`, `~`, backslash or control characters, at most 500), or an export folder that isn't a writable directory inside a configured folder once links are followed (the library `soulseek.transfer_path`, `soulseek.download_path`, `library.music_paths`). Stored as `library.traktor_mac_path` and `library.traktor_export_folder` through `config_manager.set` (the Settings page's own save writes leaves, so it never clears them).

**The `.nml` file** (Traktor Pro 3's NML, `VERSION="19"`): `HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"`, `MUSICFOLDERS`, a `COLLECTION ENTRIES` with each track once (`ENTRY TITLE ARTIST` > `LOCATION VOLUME DIR FILE`, `ALBUM TITLE`, `INFO BITRATE PLAYTIME PLAYTIME_FLOAT KEY RANKING`, `TEMPO BPM`, `MUSICAL_KEY VALUE`), then `PLAYLISTS` > `NODE TYPE="FOLDER" NAME="$ROOT"` > `SUBNODES COUNT="1"` > `NODE TYPE="PLAYLIST" NAME` > `PLAYLIST ENTRIES TYPE="LIST" UUID` > `ENTRY` > `PRIMARYKEY TYPE="TRACK" KEY`, in order (a track twice is listed twice). `DIR` writes each `/` as `/:` and ends `/:`; `KEY` is `VOLUME + DIR + FILE`. `/Volumes/<name>/…` is `VOLUME="<name>"`; anything else is on `VOLUME="Macintosh HD"` with the whole path as `DIR`. `MUSICAL_KEY VALUE` is 0–23 (0 C … 11 B major, 12 Cm … 23 Bm), and `INFO KEY` the Open Key text, both only for a key from the file's tag or analysis at 0.5 confidence or more; `TEMPO BPM` for 20–400 BPM. `INFO RANKING="255"` (Traktor's top rating, five stars) for a track the caller starred (core/stars; another profile's star changes nothing); no `RANKING` otherwise, so Traktor keeps its own. The preview's `starred` counts them. Never `CUE_V2` (cue points, grids) or `LOCK`. Built with ElementTree, so every attribute is escaped; characters XML 1.0 can't hold are dropped first.

**Mac paths:** the drive helper's `core.drives.host_paths.to_host(container_path)` first, once it lands (`traktor._load_to_host`); then the card's Mac path for the library folder (`/app/Transfer/<rest>` → `<mac_path>/<rest>`); a stored path that is a media server's is resolved to its file (`core.sample.worker.resolve_track_file`) and tried again; a path already under `/Volumes/` or `/Users/` is used as it is (a `/Volumes:/Volumes` mount, HANDOFF 160). Looking a stored path up on disk can ask the media server where its music lives, so it's bounded: it's skipped when nothing could place the result (no Mac path, no helper map, and no `/Volumes` or `/Users` in the container); one export looks up at most 50 paths or for at most 5 s (`RESOLVE_BUDGET`, `RESOLVE_SECONDS`), the rest are `lookup_limit`; a path that resolved to nothing isn't looked up again for 5 minutes (at most 5,000 remembered).

**The export folder** (`save`): checked again at the write (inside a configured, existing folder once every link is followed; a writable directory; its device and inode noted), the file name re-checked, then the folder is opened once (`O_DIRECTORY | O_NOFOLLOW`) and `fstat`ed to confirm it's the folder checked (and, where `/proc/self/fd` says, still inside a configured folder). Every later step is relative to that open folder (`dir_fd`): temporary files `.synchros-traktor-*.tmp` older than an hour are swept; the file is written to a new `.synchros-traktor-<random>.tmp` (`O_CREAT | O_EXCL | O_NOFOLLOW`), given `0644` less the umask, `fsync`ed, and hard-linked into place, which refuses an existing name or link; with `overwrite` it's renamed over the file (a link at the name is replaced, never followed; a folder at the name is refused). On a file system without hard links the name is claimed with an exclusive create and the written file renamed over the claim: **not atomic** (for that moment the name holds an empty file), and the claim is removed if anything fails. The temporary file never outlives the call.

### Sets (`/api/sets*`; BACKLOG "Famous mixes and AI set suggestions", Sets 1; boards 22a–22i, 22r–22s)

Built on `feat/sets-1`. Code: `api/sets.py`; `core/sets/` (`store.py` sets and their views, `steps.py` Smooth / Jump, `tracklist.py` reading tracklists, `matching.py` library matching, `sources.py` MixesDB / MusicBrainz / Discogs, `wanted.py`); the tables `dj_sets` and `dj_set_tracks` (`MusicDatabase._add_dj_sets_tables`). The web pieces are in `src/features/sets/`. `api/sets.py`, `core/sets/store.py` and `core/sets/sources.py` are on `.github/gauntlet-paths.txt`. Every route needs a profile (401 `profile_required`). **Sets are the caller's own, admins included**: another profile's set reads as 404, exactly like one that doesn't exist. Library reads use the DJ store's scope (the caller's library). Bodies are read with a hard cap even when chunked (`api.dj._read_json_capped`): 256 KB, 392 KB for a paste (64,000 characters at up to 6 bytes each in JSON; the text itself is then capped at 64,000 characters), 8 KB to open a mix, 64 KB for Wanted; over it, 413. Text a row carries (artist, title, note, the raw line, the version) and Wanted's words lose control and format characters (NUL, the bidi overrides, zero-width marks) before they're kept. Nothing here asks an AI.

**A row** (as sent and as kept): `{track_id | null, artist, title, at?, state: owned | version | missing | id, want: yours | wanted, version?, locked?, note?, transition?, mbid?, raw?}`. **`note`** is the mix set's note for the track (28e), up to 500 characters. **`transition`** is the step after this row (26i's chip, 28e): `{style, bars}`, `style` one of 26a's `auto | long_blend | short_blend | bass_swap | cut | echo_out | filter_sweep | drop_swap`, `bars` 2, 4, 8, 16 or 32 or null (a cut has none); anything else reads as auto, and a row always answers with one (`{"style": "auto", "bars": null}` by default). It's kept as compact JSON in `dj_set_tracks.transition`. Auto-mix isn't built: the chip only says what's saved. A row needs a library `track_id` or an artist and a title; at most 500 rows; a row whose `state` is `owned` or `version` needs its `track_id` (400 otherwise). A `track_id` new to the set that the caller's library doesn't have (another profile's, or gone) is kept as a plain Missing line, never as a pointer. **A `track_id` the set already holds is kept as it is on every update**, even while its file can't be reached (a server switch, a rescan, a moving file): the view gives that row `track: null` and `unreachable: true`, and it plays again when the file is back. `note` and `transition` are stored for the mix sets of "Star tracks and mix sets" (not shown yet).

**`GET /api/sets`** → `{sets: [{id, name, kind: hand | famous | suggested, status: "saved", shape, source, source_id, source_url, source_meta, playlist_id, created_at, updated_at, tracks (rows that play), lines (rows that aren't IDs), owned, seconds, energy: [1–10 | null per playing track]}]}`, newest change first.

**`POST /api/sets`** ("Save as mix set"; also the picker's New mix set…) `{name, kind, tracks: [row], source?, source_id?, source_url?, source_meta?, shape?}` → 201 `{id, playlist_id}`. Also makes a normal user playlist of the set's playing tracks in order (`core.playlists.user_playlists`, so it identifies, syncs and plays like any playlist); a failure there never loses the set (`playlist_id` null). `source_url` is kept only when it's the source's own page (`https://www.mixesdb.com/w/…`, `https://www.mixes.wiki/w/…`, `https://musicbrainz.org/release/…`, `https://www.discogs.com/release/…`). `source_meta` keeps `title, artist, date, edited, kind, seconds, lines`. 400 with a sentence for no name, no rows, more than 500, or a profile's 500th set.

**`GET /api/sets/<id>`** → `{set, rows, steps, summary}` (the view, below); `set` carries `revision` (the last autosave applied) and `playlist_state` (null, `changed` or `deleted`).

**`PUT /api/sets/<id>`** `{name?, tracks?, base_revision}` → `{id, revision, playlist_state}`. Send only what changed: a rename sends `name` alone. **`base_revision`** is the revision the page last read (`GET /api/sets/<id>`'s `set.revision`) or had a save confirmed at (this answer's `revision`). The save applies only while the stored revision still equals it, checked and written in one conditional update, and the set's revision becomes that plus one. Anything that moved the set on in between (an Add to mix set… from another tab or device, a save from another window) makes the save a 409 `{stale: true, revision}` that changes nothing: the page stops saving, keeps its edits and says "This set changed somewhere else" with **Reload it** and **Keep mine as a draft**; it never retries over the top. One window sends one save at a time: an edit made while a save is on its way goes after it, from its answer's revision. `base_revision` must be a whole number in 0..2^53 − 1 (400 otherwise). **It's required**, a rename included: a save without it (a page loaded before this change, which sent its own counted-up `revision`, or no revision at all) could write over a change it never saw, so it gets 409 `{stale: true, revision, reason: "reload"}` and nothing changes; such a page shows its "changed in another window" error once per edit and never overwrites. A scan that moves a set's row to a track's new id (`_absorb_track_row`) counts the set's revision on, so an open page holding the old id gets a 409 too. The set page reads the set again when the window comes back into focus and when the picker reads or adds to sets, and takes the newer set in place when it has nothing unsaved. **The playlist follows only when the set's tracks or their order changed**, and only while it still holds what the set last wrote there (the set keeps a hash of that): a playlist edited on the Playlists page stops following (`playlist_state: "changed"`, `playlist_id` null) and keeps the person's edit; a deleted playlist is never made again (`"deleted"`). A track the set holds that's briefly unreachable keeps its place in the playlist by the set's own artist and title.

**`POST /api/sets/<id>/playlist`** `{action: "new" | "dismiss"}` → `{playlist_id}`: "Make a new playlist from this set" (a new user playlist of the set's tracks, followed from now on) or "Not now" (the set stops saying its playlist went its own way; nothing else changes). `new` is only for a set with no playlist following it (`playlist_state` set, no `playlist_id`, or that playlist gone): otherwise 409 `{following: true, playlist_id}`. 404 for a set that isn't yours.

**`DELETE /api/sets/<id>`** → `{deleted}`; the set's rows go, its playlist stays.

**`POST /api/sets/<id>/tracks`** ("Add to mix set…", 28a, 28b; Brief B's drops onto a set, below, send `again: true`) `{track_ids: [...] (1–500), again?: bool}` (body at most 64 KB) → `{id, name, added: [{track_id, number}], already: [ids], left_out: [{id, reason: not_in_library | file_missing}], revision, playlist_state}`. The tracks go at the end, in the order sent. **Only library tracks of the caller's with their file present go in** (the downloaded-only rule); the rest are `left_out`. A track the set already holds is skipped (`already`) unless `again` ("Add again", "Add all 6"). `number` is where the page numbers it: every row with a library track counts, a File missing one included; tracklist lines that aren't in the library don't. The set's `revision` moves on by one in the same transaction as the write (as a save without a revision does), so a page holding the set with an older revision has its next autosave refused (409 `stale`) rather than undoing the add; with nothing added it doesn't move. The playlist follows (Sets 1's rules: only while it still holds what the set wrote). The sync after an add or a save reads the set's rows again under a lock (`store.follow_latest`), so of two changes at once the last sync always writes the newest rows. 404 for a set that isn't yours; 400 past 500 rows. **`after: {track_id, number}`** (the Mix tab while a set plays, 29b) puts the tracks straight after that row instead: the row numbered `number` when it still holds `track_id`, else that track's first row; the answer's `placed` says where they really went: `"after"` (together, straight after that row), `"later"` (together, but past locked rows that keep their places after it), `"split"` (locked rows between them) or `"end"` (together at the set's end; also when the set no longer holds the row, or without `after`); each `added[].number` says exactly where. The revision and the playlist follow as for an add at the end, the playlist in the set's new order. **Locked rows keep their places** (the set page's `moveRow` rule, server side in `store.insert_keeping_locked`): rows up to the insert stay, each locked row after it keeps its index, and the unlocked ones (the new first) fill the free places in order. **A row whose next track changes** (one track to another) has its transition reset to Auto, `{style: "auto", bars: 16}`, since it described another join (`store.reset_changed_joins`); a row that had no chosen transition, or no next track, is left. **`reset`** (Brief B's review, M1) names those rows, `[{track_id, number, transition}]`: each row's number after the add and the transition it had before, so a drop's Undo can give them back; `[]` for an add at the end or when no join changed.

**`POST /api/sets/holding`** `{track_ids: [...] (1–500)}` → `{sets: [{id, name, kind, updated_at, next, rows, holds: {track_id: [numbers]}}]}`: the picker's list, newest change first: `next` is the number the next track added takes ("adds as #25"), `holds` where the tracks asked about already are ("In it already · #4"). Your sets only.

**`POST /api/sets/view`** `{tracks: [row]}` → the view a draft (kept in the browser) is drawn from:

```json
{"rows": [{"track_id": "3", "title": "Undertow", "state": "owned", "locked": false, "track": {"id": "3", "title": "Undertow", "artist_name": "Tidewater", "duration_ms": 400000, "dj": {"bpm": 120, "key": "7A", "energy": 4}}}],
 "steps": [{"kind": "smooth", "reason": "7A → 8A, +2 BPM", "steps": 1, "bpm_diff": 2.0}, null],
 "summary": {"tracks": 16, "seconds": 5460, "bpm_min": 118, "bpm_max": 127, "smooth": 14, "jumps": 1, "unknown": 0, "locked": 3}}
```

A row whose track can't be reached now (`unreachable`, 28e's File missing) carries `gone_track`: its title, artist and values when the caller's library still has its row (no file path), else null. `steps[i]` is the step from row i to the next row that plays (rows without a library track are stepped over), or null. `kind`: `smooth`, `jump` (more than 3 BPM, or 2 or more steps round the Camelot wheel: ±1 or the relative major/minor is one step, both together two) or `unknown` (a side's BPM or key isn't known; "BPM not worked out yet"). The reason is the Mixes panel's words: "6A → 7A, +1 BPM", "7A → 7A, +1 BPM · same key", "8A → 8B, same BPM · relative major", "6A → 8A, +2 BPM · 2 steps on the wheel: mix on a break", "8A → 8A, +4 BPM: mix on a break"; half and double time count as the same tempo ("double time").

**`GET /api/sets/swap?before=&after=&current=&exclude=a,b&limit=8`** → `{alternatives: [{track, into, out_of, jumps, rank}], total, before, after}`: "Mixes well with" from the track before and the track after (`core.dj.store.mixes_with`), the set's own tracks excluded, ranked by how many sides are smooth, then in Mixes well with's order. `into` / `out_of` are steps. With neither neighbour, the row's own matches.

**`GET /api/sets/sources`** → `{sources: {mixesdb, musicbrainz, discogs: {state: ok | off, why?: terms | token}}}`. A search's answer can also say `{state: "down"}` or `{state: "limited", why: "rate_limited" | "profile" | "busy"}` (below).

**`GET /api/sets/famous/search?q=`** → `{query, results: [{source, id, title, artist?, date, edited, tracks, kind: mix | cd}], saved: [{source: "saved", id, title, from, tracks, source_id}], sources: {name: {state: ok | down | off, why?}}}`. The sources are asked together; one that fails is `down` and the others still answer. `saved` is the caller's saved famous mixes whose name has the words, so a mix opens while its source is down (22r). A pasted MixesDB or Mixes.wiki link is read for its page title and that page is looked up through the API; **the link itself is never fetched**, and a link to any other host is plain search text.

**`POST /api/sets/famous/open`** `{source, id}` → `{mix: {source, id, title, artist?, date, edited, url, kind, seconds?}, rows: [match row], counts}`; 503 `{down: "<source>"}` when the source didn't answer, 429 `{limited: "<source>", why: "rate_limited" | "profile" | "busy"}` while Discogs is backing off, the profile's budget for that source is spent (an uncached open counts; a cached one doesn't) or enough requests already wait for the source, 409 when the source isn't set up, 404 when the mix is gone (a Discogs id is 1–12 ASCII digits, else 404 without a request).

**`POST /api/sets/match`** `{lines: [{artist, title, at?, mbid?, kind?}]}` (at most 500) and **`POST /api/sets/paste`** `{text}` (at most 64 KB of text, 413 over it) → `{rows: [match row], counts: {owned, version, missing, ids, of}, unread?: [{n, raw, at, why}], lines?, cut?}`. A match row: `{artist, title, at, mbid, raw, note, n, state, track (the library track or null), confidence, matched_by: musicbrainz | title | null, have?, want_version?}`. `of` leaves IDs out ("You own 14 of 22"). A paste is read by code, line by line: "Artist – Title" with any dash, `//`, `///` or `~`, leading numbers ("01.", "1)") and times ("[27]", "1:02:30") taken off, a trailing "[Label]" dropped, "rmx" read as Remix (`note` says so), "ID – ID" an ID; the rest is `unread` with why ("A comment, not a track", "A time and a note, no artist or title", "Some letters are damaged"). Lines past 500 are left out (`cut`). The text is never stored, fetched or passed on.

**Matching** (`core/sets/matching.py`; HANDOFF 245; candidates come from an indexed range on `tracks.title_norm`, once per distinct prefix per call): a title is compared as its song and its version (brackets and dash tails with a version word: Remix, Dub, Edit, Mix…; "Original Mix" is the plain record; "feat." credits dropped), and the artists must share a credited name ("Okan Dere feat. Mira" and "Okan Dere"). `owned`: the same song and version (1.0), or a song spelt within 0.9 of it with the same version (0.9), or the same MusicBrainz recording on both sides (1.0). `version`: the same song exactly, by the same artist, another cut (0.8; `have` names the library's cut or "the original", `want_version` the mix's). Anything less is `missing`.

**`POST /api/sets/wanted`** `{tracks: [{artist, title, album?}], set_name?}` (at most 500, a set's own cap; the page sends longer lists in batches) → `{added, already, refused: [{artist, title, reason}]}`. Each goes on the caller's Wanted as a single (`add_to_wishlist_detailed`, `source_type: "set"`, `user_initiated`), its title as the mix names it ("Signal Fire (Dub)"), keyed `sets_<hash of artist and title>` so asking twice updates the row. The row's `source_info` lists the sets that asked for it (`set_names`, at most 20, the first also as `set_name`); another set asking adds its name. The request quota, the blocklist and the ignore list apply as for any add.

**`POST /api/sets/wanted/remove`** `{artist, title, set_name}` → `{removed}`: "Use yours" after "Want the Dub". `set_name` is required (400 without it). It takes back only this set's want, of a row a set added (`source_type: "set"`, `added_via: "sets"`) that's still on Wanted (a download takes it off) and lists this set: when it's the only set left the row goes, otherwise only its name does and the row stays for the others. Otherwise nothing changes (`removed: false`). Like Wanted's own remove, it doesn't check whether a download of the row is already under way.

**Sources** (`core/sets/sources.py`): **fixed hosts only**: MixesDB's MediaWiki API at `https://www.mixesdb.com/db/api.php` (`list=search`, `prop=revisions` for the page's wiki text, whose Tracklist section is read like a paste), Discogs at `https://api.discogs.com` (`/database/search?type=release&format=Mixed`, `/releases/<id>`, with the admin's token from Settings → Connections, `discogs.token`, one token shared by every profile; without one Discogs is `off`, `why: token`), MusicBrainz through the app's client (`MusicBrainzClient.search_dj_mixes`: releases of secondary type DJ-mix; `get_dj_mix_release`: tracks with recordings and artist credits; its pacing, retries and User-Agent; an id that isn't an MBID is refused before any request). No redirects; 5 s to connect, 10 s between bytes, **20 s for the whole answer** (checked as it streams); at most 2 MB read from an answer (streamed, cut off past it); **one request at a time per source** (a lock held for the whole request; a request that waits over 25 s for its turn is `down`, and while 3 already wait a fourth is refused at once, `limited`, `why: busy`) with 1 s between; the 20 s covers the wait for the answer's headers too (the read timeout is never more than what's left of it); searches cached for 10 minutes and tracklists for 6 hours in memory (failures aren't cached, so Try again asks again). Because Discogs' token is shared, **each profile may start 20 uncached Discogs requests a minute**, searches and opened tracklists together, and 20 to MixesDB (after that the source is `limited`, `why: profile`, for the rest of the minute; cached answers don't count), and **a 429 from Discogs pauses it for a minute** for everyone (`limited`, `why: rate_limited`). MixesDB pages are read in linear time: each wiki line is cut to 1,000 characters before it's read, and headings and links are found by scanning, not by patterns. User-Agent `SoulSync/2.2 Sets (+https://github.com/Nezreka/SoulSync)`. **MixesDB is `off` (`why: terms`) until an admin sets `sets.mixesdb_enabled`** (HANDOFF 240, 260). There's no control for it in Settings yet, on purpose, while Ross checks Mixes.wiki's licence. To turn it on, an admin sends `PATCH /api/v1/settings` with `{"sets.mixesdb_enabled": true}` (an admin-scope API key from Settings; read keys are refused on `/api/v1/settings`); `false` turns it off again. It takes effect on the next search. Any control added for it later must be admin-only (`@admin_only`, as the Traktor card's save is).

**Playing a set** (step 3, 33c, 34b; `src/features/automix/set-play.ts`): **Play** (the head's primary, and each row's Play, "from here") queues the set's tracks with their files through `window.playTrackList(queue, name, {startIndex})`, each marked `from_set: {id, name, row}`; **Play as a mix** marks them `mix_set: {id, name, row, transition, next}` as before (its chips play whatever Between tracks says). Either mark is what Mix's set card ("Playing Sunday Set · track 4 of 12 · as a mix"), Up next's "8 from Sunday Set" (294) and the set page's playing row (a green ▶, "Playing · 4 of 12") read, so nothing is inferred from the queue's order when it's there. `playTrackList`'s `startIndex` (`static/media-player.js`) starts the queue at that row. **Duplicate** (262) is `POST /api/sets` with the set's rows and "<name> (copy)"; **Make this my working set** is `PUT /api/sets/working`; **Remove this set…** confirms on 15a's frame (267), then `DELETE /api/sets/<id>`. A remove, a move or a swap on a set's page puts up a toast with **Undo** for 10 s (UX-8; `showToast`'s `action` with `ms: 10000`), which applies the edit's inverse to the rows as they are then (`features/sets/undo-rows.ts`) and lets the autosave save that. `showToast`'s action runs once and closes the toast, an action toast isn't dropped as a repeat, and its words go to the polite live region `#toast-live`; `opts.key` names a toast and `window.dismissToast(key)` takes it down (a set page's Undo, `set-undo`, when the page goes).

**Export to Traktor** from a set uses `POST /api/library/dj/traktor/export` with `source: tracks`, the playing tracks' ids in order, `name` and `left_out: [{title, artist}]` (the Missing lines and IDs, named in the dialog's Left out box as `not_in_library`; words only, nothing is looked up for them).

### Stars (`/api/stars*`; BACKLOG "Star tracks and mix sets"; boards 28a–28d)

Built on `feat/stars-mix-sets`. Code: `api/stars.py`, `core/stars/store.py`; the table `track_stars` (`profile_id`, `track_id`, `starred_at`; one row per star, key `(profile_id, track_id)`; `MusicDatabase._add_track_stars_table`, ledger `track_stars_v1`). The web pieces: `src/features/stars/` (the store `stars-store.ts`, shared as `window.SoulSyncStars`; the control `star-control.ts`; `star-button.tsx` for React rows) and `static/stars.css`. `api/stars.py` and `core/stars/` are on `.github/gauntlet-paths.txt`. Every route needs a profile (401 `profile_required`). **A star is the caller's own, admins included**: no route reads or changes another profile's, and a deleted profile's stars go with it. A star is plain (not a rating) and stays in SYNCHRO.S: nothing is written to Plex, Jellyfin or Navidrome. Bodies are read with a hard cap even when chunked (192 KB; over it, 413).

**What can be starred:** a library track in the caller's scope (the DJ store's `_scope`: the active media server, and the caller's own or the shared library) with its file present. A starred track whose file later goes missing keeps its star (it shows as File missing, and can be unstarred); it can't be starred again until its file is back. When a scan folds a superseded track row into the live one (`_absorb_track_row`), every profile's star (and a mix set's row) moves to the live id. **A star whose track row is gone for a while** (a full refresh stopped part way, an unplugged drive) **is kept**: nothing sweeps it, and it reattaches when the same id comes back (Plex's ratingKeys, Jellyfin's and Navidrome's ids). The 100,000-star cap per profile counts only stars on tracks the library has now, so ids that are away never fill it.

**`POST /api/stars`** `{track_ids: [...] (1–500)}` → `{starred: [ids], left_out: [{id, reason: not_in_library | file_missing}], count, missing}`; starring a starred track changes nothing. When none could be starred, 409 with the sentence and `left_out`.

**`POST /api/stars/remove`** `{track_ids: [...]}` → `{unstarred: [ids that were starred], count, missing}`.

**`GET /api/stars/count`** → `{count, missing}`: the Starred chip's number (the caller's starred tracks in their library) and how many of them have no file now.

**`POST /api/stars/status`** `{track_ids?: [...] (≤ 500), songs?: [{title, artist}] (≤ 500)}` → `{tracks: {id: {starred, can_star}}, songs: [{track_id | null, starred, can_star}]}`: a page of rows at once, never one request per row. `can_star` is "a library track with its file"; a row shows the star when either is true. `track_ids` and `songs` are looked up apart, so neither cuts the other off. `songs` are a playlist's rows, matched to the caller's library tracks with a file by the same title and artist, ignoring case (Export to Traktor's rule). Unknown ids read as `{starred: false, can_star: false}`.

The Starred list itself is `GET /api/library/dj/browse?starred=1` (above). Export to Traktor writes a starred track with `RANKING="255"` (above).

### The Mix tab (`/api/library/dj/mixes/<id>?rank=mix`, `…/vibe`, `/api/sets/working*`; BACKLOG "Star tracks and mix sets", the Mix tab; boards 29a–29d)

Built on `feat/mix-tab`. Code: `core/dj/ranking.py` (the tab's order), `core/dj/vibe.py` (Vibe), `core/sets/working.py` (the working set), the routes in `api/dj.py` and `api/sets.py`; the page is `src/features/mix/` (`mix-host.tsx` places it, `mix-model.ts` its data, `mix-tab.tsx` its views). Every route needs a profile and reads the caller's library scope.

**`GET /api/library/dj/mixes/<track_id>?rank=mix`** — "Mixes well with…" in the Mix tab's order. Without `rank`, `set_id`, `wide` or `exclude` the route answers exactly as before (DJ data, above). With them:

- `rank=mix`: the store's matches (the key rule and the tempo window, in key-then-tempo order) re-ranked, all in code: a starred track of the caller's moves up a little ("starred first among equals"); one in the caller's listening history (their own pile, `core.listening_scope`) in the last two days moves well down, in the last week a little; style closeness (the share of genres the two tracks' artists and albums have in common, and the same artist) moves a match up.
- `set_id` (one of the caller's sets; implies `rank=mix`): its tracks are left out, and the energy of its last four tracks with an energy says where it's heading (`up`, `down`, `steady`): a match that keeps going that way moves up, one that turns back moves down. A set that isn't the caller's reads as none (`set: null`), never an error.
- `wide=1` ("Widen the search", 29d): a 10% window and any key; a key outside the four that mix is `key_relation: "other"` and ranks after them.
- `exclude`: up to 50 comma-separated ids to leave out (More like this leaves out the playing track).
- `set_at` (with `set_id`, while the set plays): the number Add puts tracks after; the direction is read from the last four tracks up to it, where the next join is, not from the set's end.
- `limit`: 5 by default with `rank=mix` (at most 50).
- Numbers in the query (`set_id`, `set_at`, `limit`) are ASCII digits only (`²` or `٣` read as none, never an error).
- With `wide`, the candidates are read with the four keys that mix first, then the closest tempo, so the read cap (2,000 rows) can only cut the furthest of the other keys.

```json
{"success": true, "ranked": "mix", "wide": false, "within": 6, "total": 6, "reason": null,
 "track": {"id": "4", "title": "Night Ferry", "dj": {"bpm": 124.0, "key": "8A", "energy": 6, "…": "…"}, "…": "…"},
 "set": {"id": 3, "name": "Sunday Set", "direction": "up", "left_out": 2},
 "matches": [{"id": "7", "title": "Static Bloom", "key_relation": "up", "bpm_relation": "same", "bpm_diff_pct": 1.6,
              "reason": "One step on the wheel · +1.6% BPM · energy ↑1", "reason_short": "step · +1.6% · ↑1",
              "starred": true,
              "signals": {"starred": true, "played": null, "energy_delta": 1, "style": 0.5,
                          "shared_genres": ["deep house"], "same_artist": false}, "…": "…"}]}
```

`reason` is the step's words (key: "Same key", "One step on the wheel", "Relative major/minor", "2 steps on the wheel"; tempo: "+2% BPM", "same BPM", "half time"; energy: "energy ↑1", "same energy"); `reason_short` the phone's (29c). **`step`** (step 3, 33b): `smooth`, `jump` or `unknown`, the step a set would make from the seed to the match (`core/sets/steps.py`'s rule, 22c: two steps on the wheel or more than 3 BPM is a jump; 289), shown first on the match's line ("Smooth · same key, +4 BPM"). **With `set_id`, the set's direction weighs more** (Design's 297): a match keeping the set's way moves up 4; one turning it back moves down 8, plus 2 per step of energy, so a same-key track that turns a rising set down drops below the same and the relative key keeping its way (a key a step round the wheel still follows it). With no working set, harmonic fit leads as before. `reason` at the top is the state, as before: `not_analyzed` (with `set` still said), `none`, or null.

**`POST /api/library/dj/mixes/<track_id>/vibe`** `{set_id?, set_at?, wide?, limit?, exclude?: [ids]}` (body at most 4 KB, `_read_json_capped`; **JSON only**: a form-encoded or text/plain body, or anything but an object, is 400 "Send it as JSON", so another site's form can't spend AI usage; the Sets writes below are the same) → the ranked answer above with the matches in the AI's order and `vibe: {line, usage: {estimated_cost_usd}}`. Code ranks the top 20 first; the AI provider (`core/ai`: the same key, model and switches as the Assistant) only re-orders them through one tool (`rank_by_feel {order: [n], line}`): numbers it leaves out keep code's order after the ones it named, made-up or repeated numbers are ignored. **Only track details go to it**: each track's title, artist, album, genres, BPM, key and energy, numbered; no ids, paths, profile, set names or listening history; a set's heading (`up`/`down`/`steady`) when one is followed. 403 `{code}` when the AI can't be used by this profile: `not_configured`, `members_not_allowed`, `key_refused`, `cap_reached` (the sentence in `error`); 429 `busy` (two at once, server-wide) or `rate_limited`; 503 `offline`; 502 `provider_error` or `bad_key` (which also marks the key refused, as the Assistant does). Every request that reached the provider counts against the month's usage, for the install and the profile (`ai_usage`, `ai_usage_profiles`). **The monthly cap is one figure for the whole server** (Settings → AI), not per profile: `cap_reached` means the server's budget is spent, whoever spent it. Numbers in `order` that aren't finite whole numbers in range (`inf`, `1e999`, 2.5) are ignored. `line` is the AI's note, shown quoted and named as the AI's: control and format characters (bidi, zero-width) dropped, spaces collapsed, at most 160 characters, and empty when it holds a link (`://`, `www.`) or an email address, since a title can steer it.

**`GET /api/sets/working`** → `{working: {id, name, kind, revision, updated_at} | null}`: the caller's working set (one per profile, kept on the server). A set removed since reads as null.

**`PUT /api/sets/working`** `{set_id: <int> | null}` (body at most 1 KB) → `{working}`; null clears it. 404 "That set isn't one of yours" for another profile's set or one that doesn't exist (the same answer); 400 for anything but a positive whole number or null.

**`POST /api/sets/working/start`** `{name, track_ids: [...]}` (body at most 64 KB) → 201 `{id, tracks, working}` (`tracks`: how many went in): a new mix set of those tracks (only library tracks of the caller's with their file; 400 when none can go in, or with no name), its playlist made as "Save as mix set" makes one, made the working set. 29d's "New mix set", and A or Add with no working set yet ("Set from Monday 26 Oct").

**Storage:** the table `dj_working_sets` (`profile_id` INTEGER PRIMARY KEY, `set_id`, `chosen_at`), added by `_add_dj_working_sets_table` (ledger `dj_working_sets_v1`; only adds, `atomic=False`). The set is checked as the caller's own on every read (a join on `dj_sets.profile_id`); a deleted profile's row goes with it (the `profile_id` sweep).

**In the browser** (`src/features/mix/mix-store.ts`): the tray's mode (Now playing · Mix; DJ, `dj`, is reserved for DJ now, step 5: `DJ_MODE_READY` is false, so it's never shown, set or read back) per browser in `localStorage` `soulsync.player.tray-mode` (`now` / `mix`). **Vibe is kept per browser** (Design's 296) in `soulsync.mix.vibe` (`on` / `off`), and only acts while the AI is on for the profile. Suggest from, More like this and Widen aren't kept. **"Mixes well with…"** in any track's "…" (`features/dj/track-menu.ts`) calls `openMixWith(seed, {play})` (`features/mix/open-mix.ts`): the chain starts at that track, the mode is Mix, and the tray opens (`window.SoulSyncPlayerChrome.expand()`; on a phone, the sheet); with nothing playing it plays the track first (the caller's `play`). The docked Mixes panel (`features/dj/mixes-panel.tsx`, `mixes-store.ts`) is gone (Brief C; HANDOFF 329). **Step 3's tray** (33b): in Mix, `#media-player[data-tray-mode="mix"]` shows Mix's two columns (`[data-mix-col="this-track"]`, `="matches"`) and keeps `.ss-player-list` (Up next itself) as the third; `[data-player-upnext-from]` says "8 from Sunday Set" and `[data-automix-slot="list-head"]` holds Between tracks in Up next's header (both modes). `[data-player-keyline]` is the record's key line (36a, 279) with the star beside it. On a phone, `[data-player-modes="sheet"]` is the sheet's one tab row (Now playing · Mix · Set), the handle (`[data-player-sheet-close]`) closes it, and a swipe down closes it from any tab (`bindSheetSwipe` in `src/shell/player.ts`: from the head, or anywhere at the sheet's top, 72px more down than sideways). The host sets `#media-player[data-tray-mode="mix"]` and `html[data-mix-available]` (the tray is 500px then) for `static/player.css`. **Keys** (static/media-player.js's one handler, so S's guard holds: not in text fields, dialogs or menus): `window.SoulSyncMix.key('A' | 'N' | 'M')` → true when the Mix tab acted; where there's no Mix tab (a podcast, a book, a preview, a station not playing one of yours, nothing playing) M still mutes and N skips; **⇧M always mutes and ⇧N always skips** (Ross, HANDOFF 287). The bindings are one table, `NP_LETTER_KEYS` in `static/media-player.js`. X is reserved for Mix now (26c) and not bound. In Visuals, Escape closes the Mix drawer before the visuals (`window.SoulSyncMix.drawerOpen()`, `closeDrawer()`).

**Settings → Library → DJ** (UX-13, step 3) is its own folded section on the Library tab (`index.html` `[data-settings-section="dj"]`, `#settings-dj-section`: Between tracks, BPM, key and energy, Traktor Pro 3). **`/settings?tab=library&section=dj`** opens Settings on Library with it expanded and scrolled into view (`static/settings.js` reads `section` with `tab`; `requestSettingsSection(name)` asks for it before navigating; `openSettingsSection(name)` expands one). Every "Settings → Library → DJ" link (Player settings, the https note, the setup check's browser row, the Mix tab's keys line, the Traktor dialog) goes through `openDjSettings(target)` (`src/features/dj/dj-settings-link.ts`), which also focuses Between tracks or the Traktor card.

**Show the Mix tab** (Settings → Library → DJ, its own group `#dj-mix-tab-group`, the switch `#dj-show-mix-tab`; HANDOFF "Dev, Mix tab hidden while Ross rethinks mixing of 30 October"). Config key **`library.dj_show_mix_tab`**, default **`false`** (`core/settings.py`; `core/dj/worker.py` `show_mix_tab()`: strict, only `true` or the strings "true" / "1" show it; "false", "0", 1 or an unreadable config hide it, and Settings ticks the switch by the same rule). Admin-level, as the rest of the section: saved by Settings' `POST /api/settings` (`library.dj_show_mix_tab`, admins only, 403 for members), one value for the whole install, so every device and profile sees the same. Served two ways: **`GET /api/library/dj/status`** → `settings.show_mix_tab` (boolean; every profile), and the page shell's **`window.SOULSYNC_MIX_TAB`** (`api/dj.py` `initial_mix_tab`, a context processor as `initial_modules` is for the module switches), so the tray knows before first paint. In the browser `src/features/mix/mix-visibility.ts` holds it (`mixTabShown()`, `useMixTabShown()`): the page shell first, then each DJ status read (`noteMixTabSetting(value, mixTabReadMark())`: a read that started before Settings' latest save is ignored), then Settings' save (`static/settings.js` `_applyMixTabSetting` fires `soulsync:mix-tab-changed` with `{shown}`, which also reads the DJ status again); only `true` shows it, a missing field changes nothing. While it shows, `<html>` has `data-mix-tab` (set before first paint from the page shell); `static/player.css` shows `[data-mix-only]` (the `?` list's M, N and A rows) only then and `[data-mix-off-only]` (plain "M Mute", "N Next track") only without it. **Off** hides: the tray's Now playing · Mix switch and Mix mode (`[data-player-modes]` stay empty, `html[data-mix-available]` is not set), the phone sheet's Now playing · Mix · Set row and its sheet, Visuals' Mix button (`#np-v2-visuals-mix-btn`) and drawer, the Mix tab's keys (`window.SoulSyncMix.key` answers false, so M mutes and N skips; `available()` and `drawerOpen()` are false), "Mixes well with…" in every track's "…" (`track-menu.ts`, read again by each page while it's open; a stale one's `openMixWith` only says "The Mix tab is turned off in Settings → Library → DJ."), and with the tab its rows as drag sources and its set card as a target. No Mixes well with or AI status is asked for (`useMixModel`'s `askMatches`); the record's key line (BPM, key, Ready to mix) still shows. The tray's mode reads Now playing while hidden: a remembered `soulsync.player.tray-mode` of `mix` is kept in the browser but not used, `setTrayMode('mix')` and `followTrack` do nothing, and a tray in Mix (or the drawer open) when it goes off falls back to Now playing; turned back on, the remembered mode returns. Words that pointed at the tab change while it's hidden: Send to… the working set with none says `Make a working set first · "Make this my working set" on a set` (`REASONS.noSetHidden`), and Make this my working set's toast and title drop "the Mix tab adds to it". The API is unchanged (`/api/library/dj/mixes/*` still answers: Sets' swap panel and the engine's harness use it).

### Drag and drop (Brief B, step 4; `webui/src/features/dnd/`; boards 32a–32g)

Built on `feat/step4-dnd`. **No new route and no schema change**: a drop uses the routes that exist (the add's answer gained `reset` in the review round, above), and nothing is kept in the browser's storage.
- **Into a set that isn't open** (the sidebar's Your sets, Your sets on the Sets page, the Mix tab's set card, Send to…): `POST /api/sets/<id>/tracks` (above) with `again: true` (32b: a duplicate goes in again, "drop to add again") and, for the working set while it plays, `after: {track_id, number}` (293). Which of the lifted tracks each set holds comes from `POST /api/sets/holding`, asked once when a drag starts. A famous set (`kind: "famous"`) is refused in the browser before any request (32b's "a set you can't edit"). With no working set, the set card's or Send to…'s drop is `POST /api/sets/working/start`.
- **Its Undo** (6 s, ⌘Z): `GET /api/sets/<id>`, the joins the add reset given back (its `reset`, each found by its number and track and only while it's still the Auto the add left), the rows the add answered (`added: [{track_id, number}]`) taken out with the unlocked rows flowing back round locked ones (`removeKeepingLocked`, the inverse of `core/sets/store.insert_keeping_locked`), then `PUT /api/sets/<id>` with the `base_revision` just read; a 409 `stale` is read and tried once more. Only rows whose number still holds the added track count: when one was moved since, the Undo says "Can't undo: the set has changed since" rather than guess which copy was added (review L4). The working set while it plays takes its drops after the playing row from every surface (the sidebar's and the Sets page's Your sets too, 293). A start's Undo is `DELETE /api/sets/<id>`. Each fires `ss:mix-set-changed`.
- **Into the set whose page is open:** its rows change in the page (`insertKeepingLocked`, `moveRow`) and its autosave sends them (`PUT /api/sets/<id>`, `base_revision`), so a drop and its Undo are one edit each, exactly like Move… and Remove.
- **Analysis:** a drop onto a set asks for the tracks it brings (`askForAdded`, `source: set`, `set_id`); onto Up next it goes through `window.ssAnalysisToastWords` (asks only while Auto mix is on). The toast adds Brief A's words once.

**The player's queue (`static/media-player.js`, `window.SoulSyncPlayer`)** gains: `insertAt(index, tracks) → rows` (never at or above the playing row; with nothing playing and nothing queued it starts, as Add to Up next does), `removeTracks(rows) → count` (a drop's Undo: those rows, never the playing one, nor the incoming one while a mix holds it), `moveTrack(row, to) → index` (by the row itself; `-1` not in Up next, `-2` it's playing or played now, so an Undo never moves the playing track, `-3` it's the incoming row a mix holds; review H1, M3), `firstFree() → index` (the first place a drop may use: after the playing row, and after the incoming one while a mix runs or counts down; `insertAt` and `moveTrack` never go above it), `announce(words)` (Up next's polite region), `focusRow(index)`, `startMoveMode(index)` (32f). Up next's rows carry `data-dnd-row="upnext"`, `data-dnd-index` (the queue index) and, for a library track still to come, a grip `[data-dnd-grip]`; the list's own HTML5 drag (`npQueueDrag*`) and earlier / later are gone (HANDOFF 377). `window.SoulSyncDnd.showDropResult({words, undo})` is the drag's toast and Undo for the legacy player (its Move mode; its Undo refuses once the moved row plays: "Can't undo: it's playing now"). A drop of an Up next row finds it by the row itself (`items[0].queue`), not the index it had when lifted, and a keyboard pick-up whose rows moved under it is refused ("Up next changed while it was lifted · try again"). Play next while a mix holds the incoming row (Send to…, the phone's tray) goes straight after it and says so ("· after the incoming track"); a drag there is refused with 32b's words, the keyboard's included.

**In the browser:** a target is registered with `registerTarget` / `useDropTarget` (`dnd-engine.ts` `DropTarget`: `id`, `kind` (`set-list | set | working | upnext | gap | dj`), `listId` (a drop from the same list is a move, 32g), `el`, `accepts(drag) → {ok, reason?}`, for a list `rows()` (elements with `data-dnd-index`), `lockables()`, `preview(drag, gap) → {gap, line, duplicate?, locked?, invalid?}`, otherwise `hint(drag)`, and `drop(drag, gap) → {words, undo, focus?}`). The engine marks targets `data-dnd-state` (`lit`, `over`, `invalid`), the source rows `data-dnd-lifted` (`keyboard` for a keyboard pick-up) and the row the line opens at `data-dnd-gap` (`before`, `after`). A source passes `{items, source: {kind, listId, indexes}, rows}` from its grip's pointerdown (`onGripDown`) or a phone row's long-press (`onRowTouch`), or Space through the row grid (`row-grid.ts` `bindRowGrid` / `useRowGrid`; `keyboardLift`, `keyboardKey`). An item: `{id, title, artist?, key?, bpm?, fileMissing?, away?, inLibrary?, queue?}` (`queue` as the player's queue takes it). **The step on the line** is Sets' rule run in the browser (`dnd-model.ts` `stepBetween`, a port of `core/sets/steps.py`); **a gap's chips** come only from the plans already cached (`planKey(from, to, auto, lean)`; HANDOFF 327). **DJ now (step 5)** plugs in through `DJ_TARGET_READY` (`dnd-engine.ts`), a target of kind `dj`, and `provideDjNowEntry` (`send-to-ui.tsx`) for Send to…; until then it's absent. `trackMenu`'s `sendTo` (step 3's hook) takes the items: a submenu on a desktop, the foot tray on a phone.

### Auto-mix stage A: beat grids and the pair planner (`/api/library/dj/grid*`, `/api/library/dj/plan`; BACKLOG "Auto-mix: beat-matched transitions in Up next"; boards 26a–26j)

Built on `feat/automix-a`. Server only: the analysis the browser's two-deck engine (stage B) and auto-mix (stage C) will use. Code: `core/dj/grid.py` (the analysis), `core/dj/grid_store.py` (the `track_grid` table and its shapes), `core/dj/planner.py` (the pair planner), `core/dj/worker.py` (the sweep), the routes in `api/dj.py`. Every route needs a profile (401 `profile_required`) and reads the caller's library scope, like the other DJ routes; a track outside it is 404 "That track isn't in your library".

**One track's grid** (`GET /api/library/dj/grid/<track_id>` → `{success, grid}`). Times are seconds from the start of the file; bars count from the first downbeat (bar 0):

```json
{"track_id": "981", "analyzed": true, "version": 1, "bpm": 124.0,
 "grid": {"kind": "constant", "first_beat": 0.112, "period": 0.483871, "beats": null, "confidence": 0.86,
          "steady": true, "confident": true},
 "downbeats": {"first": 0.112, "beat_index": 0, "beats_per_bar": 4, "meter": "4/4", "confidence": 0.9,
               "uncertain": false, "note": null},
 "bars": 112,
 "phrases": [{"bar": 0, "time": 0.112, "level": 16, "section": false},
             {"bar": 16, "time": 31.079, "level": 32, "section": true}, "…"],
 "sections": [{"kind": "intro", "start_bar": 0, "end_bar": 16, "start": 0.112, "end": 31.079, "confidence": 0.9},
              {"kind": "main", "…": "…"}, {"kind": "breakdown", "…": "…"}, {"kind": "drop", "…": "…"},
              {"kind": "outro", "…": "…"}],
 "mix_in": {"start_bar": 0, "end_bar": 16, "start": 0.112, "end": 31.079, "bars": 16, "confidence": 0.9, "how": "intro"},
 "mix_out": {"start_bar": 96, "end_bar": 112, "start": 185.919, "end": 216.886, "bars": 16, "confidence": 0.9,
             "how": "outro"},
 "loudness": {"replaygain_db": -7.2, "level_db": -8.9, "source": "replaygain"},
 "analysed_s": 217.4, "truncated": false}
```

- `grid.kind`: `constant` (a steady tempo: beat *i* is at `first_beat + i × period`; nearly every dance track) or `beats` (the tempo drifts: `grid.beats` lists every beat). `confidence` 0–1; `confident` is ≥ 0.5, the planner's bar for beat-matching. `bpm` is the grid's, to a hundredth; it can be more exact than the DJ data's `bpm` (a tag's whole number, or the first analysis, which works in whole frames).
- `downbeats`: bar *b* starts at beat `beat_index + 4b`. 4/4 is assumed; `meter` is `not_4_4` when the accents fall in threes; `uncertain` (and a `note` in words) when it isn't 4/4 or the confidence is under 0.3.
- `phrases`: every 8 bars from each section change (and counted back from the first one, so a track that opens on a pickup bar keeps its phrases on the music's). `level` 32, 16 or 8 by how many bars from its change it falls; `section` where the change itself is.
- `sections[].kind`: `intro`, `outro`, `breakdown`, `drop` or `main`, best effort, each with a confidence. A track over 10 minutes is analysed for its first 10 (`truncated`): no outro then, and `mix_out` is null.
- `mix_in` / `mix_out`: where the incoming track can come in and the outgoing go out. `how`: `intro` / `outro` (steady drums there), `beat_only` (a stretch with the kick near that end, no intro or outro found), `edge` (just the first or last 8 bars, a low confidence). Vocals aren't detected.
- `loudness`: the file's ReplayGain track gain when it has one, else `level_db`, the analysed RMS level of the loudest half (dBFS).

Not analysed yet, or no grid: `{"track_id", "analyzed": false, "reason"}` with `reason` one of `not_analyzed` (also a grid from an older analysis version), `analyzing`, `no_beat` (with `beat_confidence`), `too_short` (under 20 s), `too_long` (skipped, as for BPM and key), `unreachable`, `error`. A track whose BPM and key couldn't be worked out (too long, unreadable, missing) has its grid marked the same way, and one that failed before grids existed is read from its DJ row: it says why, never `not_analyzed`, so a chip never waits for a grid that won't come.

**`POST /api/library/dj/grids`** `{track_ids: [...], beats?: true}` (up to 50, more is 400; body at most 8 KB, 413 past it, `_read_json_capped`) → `{grids: {<id>: grid}}`: the same shape for a queue's tracks, without a drifting track's `grid.beats` unless `beats: true`. Ids outside the caller's library are left out; repeats once.

**`GET /api/library/dj/plan?from=<id>&to=<id>&style=<style>&bars=<n>`** → `{success, from, to, plan}`: how `from` hands over to `to`. `style` is one of Sets' transition styles: `auto` (the default), `long_blend`, `short_blend`, `bass_swap`, `cut`, `echo_out`, `filter_sweep`, `drop_swap`; `bars` 2, 4, 8, 16 or 32 (ASCII digits; anything else is 400). Without `bars` each style has its length: long blend 32, short blend 8, bass swap 16, filter sweep 16, drop swap 16, echo out 4, cut none (it's on the one). Auto uses its pick's own length.

```json
{"status": "ok", "style": "long_blend", "label": "Long blend", "bars": 32, "requested": "auto", "chosen_by": "auto",
 "why": "8A → 9A, +2 BPM: the keys mix and the tempo is close", "pair": "8A → 9A, +2 BPM",
 "beatmatch": true, "fallback": null, "note": null, "confidence": 0.86,
 "tempo": {"from_bpm": 124.0, "to_bpm": 126.0, "relation": "same", "gap_pct": 1.6, "rate": 0.98413,
           "speed_change_ok": true},
 "key": {"from": "8A", "to": "9A", "relation": "up"},
 "out": {"start": 154.951, "end": 216.886, "bar": 80, "end_bar": 112, "phrase_level": 16, "in_outro": false,
         "confidence": 0.9},
 "in": {"start": 0.2, "bar": 0, "how": "intro", "confidence": 0.9},
 "length_s": 61.935,
 "styles": [{"style": "long_blend", "label": "Long blend", "available": true, "why": null},
            {"style": "drop_swap", "label": "Drop swap", "available": false, "why": "no drop found in Brass Tide"}, "…"]}
```

- A track's stated length (`tracks.duration`) is believed only up to 30 minutes (longer tracks are never analysed) and, for a track analysed whole, to its analysed length; past the analysed part the phrases carry on by arithmetic.
- `out.start`: where the outgoing track's mix starts, in its own seconds: a phrase boundary late enough that the window (`bars`) ends where its outro does; echo out and cut go at the outro's first phrase; drop swap at its last breakdown. "in 2:58" is `out.start` less the playback position. Past the analysed 10 minutes, the phrases carry on to the track's length (`note` says the ending is estimated).
- `in.start`: where the incoming track starts: its intro's first downbeat with steady drums (moved back onto its phrase when that's a bar or two before); for drop swap, `bars` before its first drop.
- `tempo.rate`: the incoming track's playback rate to match the outgoing tempo (half and double time count: `relation`); `speed_change_ok` within 3% (a plain speed change will do; beyond it, a time-stretch).
- `beatmatch`: the two play together on the beat (blends, bass swap, filter sweep, drop swap). Not over an 8% gap, nor when either grid isn't confident or isn't 4/4.
- **Auto** (BACKLOG, 26a): a key that mixes (the same, ±1, the relative) and a BPM within 3% → long blend; within 8%, or a key not known → short blend; a key clash → cut when the next track opens on steady drums, else echo out. A pair that can't be beat-matched (a gap over 8%, either grid not ready to mix) takes 302's move, below. **303** (since `feat/step2-names`): a long blend whose bars don't fit before the outgoing track's outro ends (a short track) becomes a short blend of 8 bars, with `shortened: "the outro is short"`; with room, a long blend still starts in the main part. **304:** an unsure "one" (downbeat confidence under 0.3) keeps its style, with `unsure_bars: true` and the note "Not sure where the bars start: …".
- **No crossfade; Design's 302 is the one rule** (since `feat/step2-names`; Ross, 27 October). "Ready to mix" is `core/dj/grid.py` `beatmatch_problem`'s (beat confidence at least 0.5 and 4/4). When a pair can't be beat-matched (Auto, a style that needs a beat-match, or any style with an outgoing grid not ready to mix), `fallback: {kind, code, reason}` says the move and what stood in the way (`code` `tempo_gap`, `low_confidence`, `not_4_4`, `no_beat`, `bpm_mismatch`, `too_long`, `unreachable`, `error`, `end_not_analysed`; `reason` like "the tempos are 9.7% apart" or "Sand Script has no steady beat") and `why` is Design's sentence, "Couldn't beat-match: cutting on the phrase · the tempos are 9.7% apart":
  - **the outgoing track ready to mix: a cut on its last phrase**: `status: "cut"`, `style: "cut"`, `bars: null`, `out.start`/`out.bar` on the last phrase line at or before the end of its mix-out region (the outro's last kick), `in: {start: 0, bar: null, how: "start"}`: the player starts the next track from its start there, no decks (so it needs no https). Whatever the incoming track lacks (no grid, too long, unreadable) and a tempo gap all cut here; an unsure "one" still cuts, with `unsure_bars` and the note. A ready track with no mix-out region plays straight on (`no_outro`). An outgoing track whose ending wasn't analysed (only its first 10 minutes) plays straight on instead (`end_not_analysed`), never cut on an estimated grid;
  - **only the incoming track ready to mix: an echo out into it**: `status: "ok"`, `style: "echo_out"`, `bars: 4`, `beatmatch: false`, `out.bar: null` and `out.start` a second before the outgoing track's end (by time: its length, kept to the analysed length), `in` on the incoming track's first downbeat with steady drums. Only for an outgoing track with no beat found, too short, a beat not steady enough or a BPM set by hand its grid doesn't match, and a length known (its decoded length where it was analysed whole: a `status: none` grid gives `analysed_s` and `truncated` since the Gauntlet review);
  - **neither, or a track not in 4/4 on either side (304), or an outgoing track too long to analyse, unreadable or missing: plays straight on**: `status: "play_on"`, `style: null`, no `out` or `in`: the outgoing track plays to its end and the next starts. Nothing without a reliable grid is ever cut by bar count;
  - a person's cut or echo out stays theirs (`status: "ok"`, on the decks) while the outgoing track is ready to mix;
  - one album's tracks in their order (the same `album_id`; track n into n + 1 on the same disc, or a disc's last track into the next disc's first, a disc not known being disc 1): **plays straight on** quietly (`fallback.code: "album_in_order"`, `why` "Plays straight on: one album's tracks in their order", `styles` empty), gapless as the player plays an album. Not a failure: the browser shows no chip and no sentence for it.
- A style the pair can't do stays in `styles` with `available: false` and `why` (26a's picker); asked for anyway, the plan is Auto's pick with `why` saying so ("Drop swap: no drop found in Brass Tide, so long blend (…)").
- `status: "waiting"` (`waiting_for`: `from` or `to`, `reason` `not_analyzed` or `analyzing`) while either track has no grid yet: 26g's "Waiting" chip.

**`GET /api/library/dj/status`** gains `grids: {done, ready, no_beat, pending}` (install-wide, like `counts`). Since the Gauntlet review of `feat/brief-a`, `ready` counts the grids the planner would beat-match (`core/dj/grid.py` `beatmatch_problem`: beat confidence at least 0.5 and 4/4, a meter not worked out reading 4/4), the same rule as `/progress`'s `ready`; Tracks' "2,140 of 4,980 ready to mix" reads it (`done` before then).

**The analysis** (in the DJ sweep, above): a new track's grid comes from the same decode as its BPM, key and energy (one decode a track: the first 10 minutes, mono at 22050 Hz). A track whose DJ data is already done for this file isn't analysed again: the sweep decodes it once more for the grid alone (the **top-up**, for libraries analysed before stage A or a new `GRID_VERSION`), with its known BPM as where to look. The same priority, rests, waits and Stop apply; a provisional `analyzing` grid row precedes each decode (one left by a crash becomes an error). A grid that fails or finds no beat never costs the track its DJ data. Grid failures are counted apart from the sweep's failures (since stage B): the track counts as done, the status's `job` gains `grid_failed`, `grids_paused` and (while it runs) `grids_waiting`, and 25 grid failures in a row stop only the looking for grids, never the sweep: BPM, key and energy carry on, and each remaining track that only needed its grid counts as done and goes by with no rest and no save (its grid waits for the next sweep). A finished run keeps its grid failures in its `note`: `grids:<n>`, or `grids_paused:<n>` when it stopped looking (a run from before this change has none). A failed grid is tried again after a week (one a crash left, never), and at once when the track's whole analysis is done again and works (a decode that failed doesn't stamp its grid row with the file). A track counts as done for the top-up only while its file's size and modification time are the ones its DJ data was worked out from: a file changed since (re-tagged elsewhere, replaced, or a reused track id) is analysed again whole, BPM, key and energy too, and with Settings' "Write BPM and key into files" on, that analysis may write them into the file as any new track's would. A grid kept for another file than the DJ data's is due again. A drifting grid needs its onsets to line up on a tempo half a minute at a time (noise, pink or brown noise and random clicks never do: no grid). Measured: about 1–5 s of analysis for a 10-minute track (the most for a drifting one, or the first after a start), and about 215–320 MB of memory on top of the decode.

**`GRID_VERSION` 2** (stage B): the grid checks which of the four sixteenths the beat is on (the kick there, and the backbeat: the snare's band differing between the beats in turn), so an Amen-style break whose kicks fall on the "and"s is gridded on the beat, not half a beat or a sixteenth off. A grid that check moved is kept (its bars and phrases are good), at most 0.45 confident, under the planner's 0.5, so it's never beat-matched: with a break going out, every style crossfades ("… has no steady beat"); with a break coming in, Auto picks echo out (which needs no beat-match), and a style that needs one crossfades with that reason; when no sixteenth clearly leads, the confidence is cut by 0.6. Grids from version 1 read as `not_analyzed` until the sweep finds them again.

**`GRID_VERSION` 3** (the drum and bass fix): a hint is folded into 70–200 (no longer 70–180: a 180–200 tag stays); a slow tempo (70–100, the hint included) is tested at double, and doubled when the snare's backbeat (the mids) falls on every other beat of the double; the grid's own scan, with no hint, also doubles a tempo under 78. A fast hint is never halved. A grid at 140–200 whose backbeat is on every other beat counts its beats on the whole spectrum as well as the kick (half its beats are snares). Grids at 100–140 found from a hint at 100–140 (or none) can't change and were moved to version 3 without a decode (`_promote_settled_tempos`); the rest read as `not_analyzed` until the sweep finds them again. A person's Double BPM / Halve BPM rescales a grid without a decode (above, "Double BPM / Halve BPM").

**Storage:** the table `track_grid` (`track_id` TEXT key; `grid_version`, `analyzed_at`, `source_sig`, `status`, `reason`, `kind`, `bpm`, `period`, `first_beat`, `downbeat_index`, `first_downbeat`, `beat_confidence`, `downbeat_confidence`, `meter`, `bars`, `beats_ms`, `phrases_json`, `sections_json`, `mix_json`, `analysed_s`, `truncated`, `level_db`, `replaygain_db`; index on `grid_version`), added by `_add_track_grid_table` (ledger `track_grid_v1`; only adds, `atomic=False`). A steady track's row is about 0.4 KB (phrases, sections and regions in bars, as compact JSON); only a drifting track keeps its beats, in `beats_ms` as the first beat and each gap after it in milliseconds (about 4 bytes a beat, 2–5 KB a track).

### Auto-mix stage B: the two-deck engine (`/api/library/dj/window/<id>`, `webui/src/features/engine/`; BACKLOG "Auto-mix: beat-matched transitions in Up next"; boards 26a–26j, 21e, 23b)

Built on `feat/automix-b`. The browser's engine that plays a stage A plan on two decks; stage C drives it from Up next. Nothing in plain playback changes: the engine is only used to mix.

**`GET /api/library/dj/window/<track_id>?start=<s>&dur=<s>&rate=<44100|48000>`** → `audio/wav` (16-bit PCM, two channels, at `rate`; 48000 by default): a stretch of the track for a deck. `start` and `dur` are plain decimal seconds (ASCII digits, at least one, and one dot at most, at most 16 characters: no signs, spaces, exponents, `nan` or `inf`); `dur` at least 0.05 and at most 180; the window ends by 1,980 s (33 minutes); a `start` a second or more past the track's known length is 400 "start is past the track's end" (nothing is decoded). Anything else is 400 with words. Decoded by ffmpeg on the analysis's timeline: past the first 5 s, a quick seek to 5 s before the window, then the rest decoded and dropped (in the first 5 s no quick seek at all, which would drop an AAC file's priming frame). That lands every sample where a decode from the file's start puts it on FLAC, MP3 CBR and VBR, AAC and Opus (tested to the sample; an MP3's encoder delay included); Ogg Vorbis comes within a few hundred samples (ffmpeg trims Ogg packets, most near the file's end), which the engine's beat correction (±25 ms) takes up. The cost doesn't grow with where the window starts; the file goes to ffmpeg as `file:` and its absolute path, and ffmpeg runs at niceness 10. A window past the track's end is shorter. Headers: `Content-Length`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `X-Window-Start` (the start, 6 decimals), `X-Window-Rate`; the body is sent in 1 MB pieces from one buffer. A HEAD is guarded and answered as the GET. A profile is needed (401 `profile_required`); a track outside the caller's library is 404 "That track isn't in your library", a file that can't be opened 404 "SYNCHRO.S can't open that track's file"; an explicit track for a hide-explicit profile is 403 `restricted` (the kids guard, as for the player's audio). At most two windows decode at once across the server, and one a profile: the next is 429 `{"error": "busy"}` with `Retry-After: 1` (a profile's place is taken before a server-wide one, so a request that can't have its own never holds one); each decode has a 60 s deadline (422 "Couldn't decode that track: …"). Code: `core/dj/window.py`.

**The engine** (`webui/src/features/engine/`; for stage C, not a page):
- `Engine.create({context, workletUrl, tap})` on the player's AudioContext, with its analyser as `tap` (so the visualisers see the mix; `window.SoulSyncPlayer.audioGraph()` returns `{context, analyser}`, making them if the player hasn't yet), else into the destination. One AudioWorkletNode (`worklet/deck-processor.js`, registered as `soulsync-decks`, loaded once a context) plays deck A and deck B; each deck's chain: trim, EQ (low shelf 150 Hz, mid peak 1 kHz, high shelf 7 kHz; −40 dB is a kill), high-pass, low-pass, volume, crossfader, an echo whose return bypasses volume and crossfader; then a limiter over −1 dBFS (a hard knee, its automatic makeup gain taken back off, so below the limit the engine plays at the player's level).
- `engine.load(deck, prepareDeck(audioBuffer, offset))` (`loader.fetchWindow` fetches and decodes a window at the context's rate; a tab fetches its windows one at a time, since the server decodes one a profile, and a 429 is asked again after its `Retry-After`, backing off, for up to 10 s in all); `engine.play(deck, at, from, rate)`; `engine.position(deck)`; `engine.sync()` (resolves once the worklet has every message before it).
- `engine.mix({plan, from, to, gridA, gridB, t0, trimDb?, correction?, keyLock?})` → a `Transition` scheduled whole: `t0` is the context time the outgoing deck reaches `plan.out.start`. Its `state()`: `phase` (`counting`, `mixing`, `done`, `cancelled`, `back`, `yours`, `interrupted`), `bar` of `bars`, `secondsLeft`, `label`, `marker` (`{beat, label}`: "bass swap", "filters cross", "drop"), `modes` (`resample` within 3%, else `stretch`; `keyLock: 'always'` stretches always), `rates`, `fallback` (the plan's reason), `canGoBack`. Actions: `cancel()`, `finishNow()`, `back()`, `takeover()`, `handBack()`, `cutNow(reason)` (a mix the system cut off finishes with a cut once sound is back, Design's 308: the controls in 10 ms, the outgoing deck stopped, event `{type: "cut"}`; an interrupted countdown is cancelled and the track plays out straight on).
- The plan's styles (26a), in master beats from `out.start` (four a bar): long and short blend (the incoming deck in over the first half with its bass killed, the bass swapped over one beat on the middle downbeat, the outgoing deck out over the second half), bass swap (a quarter-beat swap mid-window), filter sweep (the incoming high-pass opens from 900 Hz, then the outgoing one closes to 1.5 kHz), drop swap (the swap on the incoming drop, at the window's end), cut (on the one, a 1/32-beat ramp), echo out (the last beat into an echo of ¾ beat, the outgoing deck cut on the one, the tail thinning over the window), and the crossfade fallback (equal power over `length_s`). The incoming deck's trim (`relativeTrimDb`: ReplayGain, else the analysed levels, within ±9 dB) returns to 0 dB by the window's end.
- `refine.correction(onsets(a…), onsets(b…), …)`: where each grid's beats really are in the audio, as a correction for the incoming deck (±25 ms at most; none with fewer than 8 clear beats).
- Headphones (`outputs.ts`, 23b): `cueSupport()` (another output needs `setSinkId` on media elements and a MediaStream destination; where it can't, `CUE_WHY_NOT`), `CueRouter.apply({mode: 'device' | 'split', deviceId})`, `.test('left' | 'right')`. Kept per browser in `localStorage['soulsync-dj-cue']` as `{"mode", "deviceId"}`.

**The lab** (`/automix-lab`): the dev harness. Admins only, and only in a development build or with `?lab=1`; anyone else gets the unknown page. It uses the routes above and the stage A ones; nothing new on the server. Since `feat/analyse-now` each deck has a picker (`harness/track-picker.tsx`) reading routes that exist: the player's queue (`SoulSyncPlayer.state()`), `GET /api/library/listening-history?range=30d`, `GET /api/library/dj/browse?starred=1` and `?q=`, `GET /api/sets` and `/api/sets/<id>`, `GET /api/mirrored-playlists` and `/<id>` with `POST /api/stars/status` to match a playlist's rows to the library, `GET /api/library/dj/mixes/<out>?rank=mix&limit=20` (the incoming deck), `POST /api/library/dj/tracks` for rows without DJ data, and `/api/library/dj/progress`. **"Download a mix report"** (`harness/mix-report.ts`) is made in the browser, no route: a JSON file `{kind: "soulsync-mix-report", version: 1, created_at, pair: {from, to: {id, title, artist}}, request: {style, bars, prerollBars, keyLock, correct}, plan, grids: {from, to: {analyzed, version, bpm, kind, confidence, first_beat, period, beats_listed, downbeats, bars, phrases, sections, mix_in, mix_out, loudness, analysed_s, truncated} | {analyzed: false, reason}}, run: null | {started_at, t0, sample_rate, windows, key_lock, correction: [{beat, ms}] (every 4 beats) | null, samples: [{t, phase, bar, rates, modes, pos: {a, b}, reported: {a, b}, reportDriftMs: {a, b}, beatDriftMs}] (four a second, at most 2,000), end}, environment: {user_agent, platform, language, hardware_concurrency, device_memory_gb, secure_context, audio_worklet, audio_context: {sample_rate, base_latency, output_latency, state}}}`. `run` is the lab's last run when it was this pair. No audio, and no file paths: keys that can carry one (`file_path`, `path`, `src`, `url`, `image_url`, `folder`, `stored`) are dropped and path-like strings replaced; tracks are named by id, title and artist only.

### Auto-mix stage C: auto-mix in Up next (`webui/src/features/automix/`, `static/media-player.js`; BACKLOG "Auto-mix: beat-matched transitions in Up next"; boards 26a–26i)

Built on `feat/automix-c`. **No new route:** the browser drives stage A's `GET /api/library/dj/plan` and `POST /api/library/dj/grids`, stage B's `GET /api/library/dj/window/<id>`, the player's own `/api/library/play` and `/stream/*`, the waveform's `GET /api/library/tracks/<id>/peaks` (Smart crossfade's silences), `POST /api/library/dj/start` (Waiting's Analyse now, admins) and Sets' `GET`/`PUT /api/sets/<id>` (Save it to the set too). Two changes on the server side of stage B: the window decode no longer fails where no temporary file can be made (`core/dj/window.py`: ffmpeg's errors go to `DEVNULL` then), and the browser gives a window request 90 s (`loader.FETCH_TIMEOUT_MS`, the body included) before it lets the tab's line move on.

**Kept per browser** (`localStorage`; read by `static/media-player.js` too where noted):
- `soulsync-between-tracks`: `off` or `dj`, shown as **Off** and **Auto mix**: Settings → Library → DJ's two radio cards (33e, since `feat/step2-names`; they replace 26h's in Player settings), and the same choice small (a two-way segmented control) in Up next's head, the player's "…", Player settings and the Mix tab, still a choice where `mixSupport()` says the decks can't run (since the Gauntlet review: a 302 cut needs no decks), each saying "Cuts and straight on only here · blends need https or localhost" (or "… only in this browser" where there's no AudioWorklet); there a pair that needs the decks plays straight on and its chip says so. Since `feat/analyse-now` there's no crossfade: a stored `smart` (Smart crossfade) and `soulsync-crossfade` at `1` (the old switch) both read as `off` and are written back so, once, by the React side (`prefs.ts` `migratePrefs`) and the player (`initExpandedPlayer`); `soulsync-crossfade` stays `0`, the "…" menu's Crossfade and the crossfade length setting are gone, and `SoulSyncPlayer.setCrossfade` only turns it off.
- `soulsync-dj-auto`: 26h's Mix automatically is gone (33e): Auto mix mixes by itself; a stored `0` is written back to `1`, once a browser (`soulsync-dj-auto-migrated`), and `soulsync-dj-auto-gone` set to `1` so Up next's head says so once (Off or Dismiss write it `0`). Mix now still mixes early.
- `soulsync-dj-keylock`: `1` is "Key lock in DJ now" on (Design's 307; off by default). DJ now (Brief E) reads it; Auto keeps the planner's rule.
- `soulsync-dj-lean`: `long` or `short` leans Auto ("Style when Auto can choose", Settings → Library → DJ); none, Auto's own pick. The lean moves Auto's short blend to a long blend (or back) where the pair's plan lists it available; the chip still says "auto".

**The queue** (`npQueue` items, saved with the queue in `soulsync-np-queue`) gains two optional fields: `automix: {style, bars, to}`, the chip chosen in Up next for the gap after this item and the id of the track it was chosen for (283, since `feat/step2-names`: once the next track is another, the gap is Auto's again; a stored choice without `to` still applies), and `mix_set: {id, name, row, transition, next, draft?}`, set by a set's Play as a mix (28e, 319): the set's row, its saved chip and the id of the next row that plays here (the chip applies only while that's the next track); a draft's `id` is 0 with `draft: true`, and "Save it to the set too?" writes the draft in this browser. A pair whose two items are rows of one set in order plays with Auto mix whatever the setting; its chip is the Up next choice, else the set's, else Auto.

**`window.SoulSyncAutomix`** (made by `AutomixHost` in the router's root; media-player.js asks it when it's there and plays as before when it isn't):
- `gapsWanted()`: Up next draws a gap (`[data-automix-gap="<index>"]`, `role="listitem"`, "Transition into <title>") after each row from the playing one on; true with DJ mix on (not on shuffle), or while the queue holds a set played as a mix;
- `ownsAdvance()`: true while the decks play a mix (and while the player takes the incoming track back); `onAudioEnded` and the crossfade leave the advance alone then;
- `crossfade(current, next, index)`: always null since `feat/analyse-now` (no crossfade; the player's crossfade code stays for the hint's shape, `{skip?, startAt?, inAt?, gain?, seconds?}`, should one ever come). With Auto mix the decks mix; a `cut` plan (302's cut on the last phrase) ends the outgoing track there (`playIndex(next, {automix: true})` at `out.start`, set on the controller's own timer 2 s ahead, let go by a seek back, Next or another load), counted down over its last 16 bars like a mix (314) with Cancel, never past its point (a plan that comes late or a seek past it plays on straight; a seek back arms it again); Mix now cuts on the next phrase line where the outgoing grid is ready to mix, else now; after Back the controller cuts on the outgoing track's last phrase the same way where its grid is ready to mix (`lastPhraseCut`, 317), else it plays to its end; Cancel plays the track out with no fallback (316); a pair that plays straight on, a page that can't run the decks, or a mix that missed its windows plays to its end;
- `beforeLoad(index, options)`: any load that isn't auto-mix's own (`options.automix`) lets the decks go;
- `stop()`: every loader that doesn't go through the queue (`npPlayRadio`, `npPlayMedia`, `startStream`, `stopStream`, `clearTrack`, and `startAudioPlayback` under them all) calls it first: the decks let go, the element is unmuted at its level, and a mix never hands back over what was started. Auto-mix's own hand-back is exempt. The controller also lets go on its own when the element loads something it didn't ask for (`loadstart`, `emptied`) or the playing track is no longer the outgoing one;
- `next()`: true when it acted (Next while mixing cuts to the incoming track where it is); `previous()`: lets the decks go first;
- `key('X')`: Mix now, true when it acted (`NP_LETTER_KEYS` `X: ['automix:X']`);
- **Letter keys a page claims:** a page that binds plain letters of its own sets `document.documentElement.dataset.letterKeys` to them while they mean something there (the Import inbox: `jkadx` while it has rows) and removes it after; the player's handler leaves those letters (unshifted) to the page, so A and X don't act twice. Space, the arrows and shifted letters stay the player's. A page's own handler ignores a key whose event is already `defaultPrevented`;
- `view()`: what the chips and the handover draw (`controller.ts` `AutomixView`).

**`window.SoulSyncPlayer`** gains `playIndex(index, options)` (`options.handoff`, any object with `currentTime`, `pause()`, `src` and `volume`: the player joins it where it is; `options.automix`), `insertNext(track)` (no toast; its index; saves the queue and tells its views), `moveNext(index)` (moves that row to straight after the playing one, saves the queue; the row's new index, or -1 for an index that isn't a row; a row from above the playing one takes the playing row's place), `renderQueue()`, `persistQueue()`, and in `state()`: `between`, `crossfading` (always false now), `playbackRate`. `crossfadeInto` is gone with the player's crossfade (since the Gauntlet review of `feat/analyse-now`): nothing crossfades.

**The hand-over** (`controller.ts`): with DJ mix on, for the playing track and the next (library tracks with files, not shuffle, repeat one or the sleep timer's end of track), the pair is planned with its chip's style; about 45 s before `out.start` both grids and windows are fetched (the loader's line, one at a time); two bars (at least 3 s) before it, on the player's AudioContext, deck A starts where the element will be 0.12 s ahead, the element fades out over 80 ms and plays on muted (it keeps time for the bar, the record, lyrics and the Media Session), and `engine.mix` schedules the plan with `t0` at `out.start`; when the mix is over and deck B's rate is back to 1 (or 8 s from its window's end) the player loads the incoming track with deck B as its hand-off, and the decks unload. Pause suspends the context as the listener's (`Engine.setPaused`, `LifecycleWatch.setPaused`: not an interruption); a seek cancels a countdown (the element is unmuted where it was sent) or finishes a mix over one bar; a queue edit that changes the next track, or DJ mix turned off, cancels a countdown. The decks' level is the player's volume (linear, as the element's). Needs AudioWorklet, which browsers give a secure page only (https, or `localhost`); elsewhere `mixSupport()` says why ("Auto mix needs SYNCHRO.S on https…"), Auto mix is listed disabled with it, and pairs play on.

**Plans in the browser** (`features/engine/executor.ts` `PlanLike`): `status` is `ok`, `waiting`, `cut` or `play_on`; `out` and `in` are absent on a `waiting` or `play_on` plan, a `cut` plan has no bars, an echo out placed by time has `out.bar: null` (the browser places it a second before the element's own end once that's known), and `tempo` can be null; `shortened` (303) and `unsure_bars` (304) may be set. 302's words come from one place, `features/engine/plan-words.ts` (`fallbackOf`, `fallbackSentence`, `MOVE_WORDS`), shared by the chips, the picker, the bar and the lab; an album in its order and a page without the decks have no sentence. The view gains `cancelled` (the listener's Cancel); `barsToGo` and `inSeconds` count down to a `cut` plan's `out.start` as to a mix's. The executor, the windows and the lab's session take a `PlacedPlan` (both places), narrowed with `isPlaced(plan)`; every other reader guards each field.

**`TransitionChip`** moves to `features/automix/mix-chip.tsx` (`features/sets/mix-set-parts.tsx` re-exports it), shared by Up next and a set's step lines (26i, `SetStepChip`), with the plan's words and states (26g).

### Analyse on demand (`/api/library/dj/analyse`, `/api/library/dj/progress`; BACKLOG "Analyse on demand, with progress")

Built on `feat/analyse-now`; Brief A's additions (the line's order and reasons, step times, readiness, Cancel, Try again, Analyse mine) on `feat/brief-a`. Code: `core/dj/ondemand.py` (asking, each track's state, the line as a caller may see it), `core/dj/progress.py` (the steps), the asked-for line in `core/dj/worker.py` (`DjAnalysisJob.ask`, `promote`, `withdraw`, `prioritise`, `queue_snapshot`, `next_sweep_in`), the routes in `api/dj.py`; in the browser `features/dj/analysis.api.ts` (asking, the shared poll), `analysis-line.tsx` (Brief A's `AnalysisLine` and the hooks), `analysis.format.ts` (the words). Every route needs a profile (401 `profile_required`) and reads the caller's library scope (`store._scope`, as the other DJ routes): ids outside it are left out, never an error.

**`POST /api/library/dj/analyse`** `{track_ids: [...], reason}` (up to 500; more is 400) or `{playlist_id: <positive int>, reason}` (its rows matched to the caller's library by title and artist, as Export to Traktor does; a member reads only its own playlists, 404 "Playlist not found" otherwise). **JSON only** (a form or text/plain body, or anything but an object, is 400 "Send it as JSON"), body at most 64 KB (413, `_read_json_capped`). Any profile, for its own library's tracks. **One request a second a profile** (429 `{code: "rate_limited"}` with `Retry-After: 1`; a playlist's rows are read only after this check); 409 `{code: "off"}` while `library.dj_analysis` is off. **`reason`**: `"asked"` for a person's own ask (Analyse these, Analyse now, Analyse mine, the Mix tab's button, a lab pick) or `"auto"` for a page's (the default; anything else is 400). **The line is in tiers** (since the Gauntlet review): an admin's Move up first; then **Up next's next transition** (`soon`, below); then **a person's own ask**, after the other person-asked tracks; then every page's ask; then the sweep's own order. A track a page asked for that a person then asks for moves up to the person's tier (so a member's own tracks jump the line, HANDOFF 325), and keeps why it was first asked for. **`soon: true`** (with `source: "up_next"` and at most 2 ids, by id only: with `playlist_id`, `mine` or `cancel` it's 400): the browser's ask for the tracks Up next needs for its next transition (the playing track and the next, with Auto mix on or a set played as a mix). Each profile has at most two such tracks, its newest; a newer pair puts the older one back in its own tier, even a pair that needs no analysis. Within a tier the line is first come, first served: a track that changes tier, up or down, goes to the end of its new one (Move up's tier is newest first). So a member's long Analyse mine doesn't hold up the admin's next mix. **`source`** (optional): why the tracks are in line, for the popover's words: `asked`, `set` (with **`set_id`**, a positive integer; only the asker's own set is ever named), `up_next`, `mix`, `lab`, `dj_now`, `page` (anything else is 400). **`{mine: true, reason: "asked"}`** is Analyse mine: every track the caller has in the line moves up to the person's tier, in its order, keeping why it's there (→ 202 with `moved` and `yours`; an automatic `mine` is 400). **`{track_ids, cancel: true}`** is Cancel (the Mix tab): the caller's own asks for those tracks leave the line; one another profile asked for stays for them; a run's total drops only for a track an ask added to this run that the run hasn't taken (once taken, a retry doesn't make it count again) (→ 200 `{withdrawn}`; with `playlist_id` or `mine` it's 400). Cancel is answered while analysis is off too (it's checked before the `off` 409), and the browser shows it only on an entry with `yours`, saying so when `withdrawn` is 0. **`retry: true`** with `reason: "asked"` is Try again (admins only, 403 otherwise): tracks whose analysis failed (`error`) or whose grid failed (`no_grid`; the BPM, key and energy stay) are put back and asked for. The rate limit, the 200 cap, JSON only, 64 KB and the held 409 apply to all of these. While a person's Stop holds the sweeps an automatic ask is **409 `{code: "held"}`** (the browser says nothing and forgets those tracks, so a person's ask for them later goes); a person's ask goes in and the hold stays. → 202:

```json
{"success": true, "asked": 12, "queued": 9, "already_queued": 0, "already_done": 3, "cant": 0,
 "over_limit": 0, "limit": 200, "yours": 9, "started": true, "position": 2, "working": false}
```

`position` is where the first of the asked tracks now is in line and `working` whether one is being analysed (null and false when none waits), for the Added toast's "analysing, 2nd in line".

`asked` counts the ids in the caller's library with a file; a track **needs analysis** when it has no DJ row at the analyzer version (or one left `stale` or `analyzing`), no grid row at `GRID_VERSION` (or one for another file than the DJ data's), or its file wasn't there (`unreachable`: asked again); `already_done` have nothing to do; `cant` failed before and would fail again (an error, too long, a beat grid that failed) and aren't asked, plus a track the running sweep already took and retried once (it gets one more try in the same run, then is counted here); the track being worked out right now counts as `already_queued`. The rest go in the **asked-for line** in front of the sweep's own order, at most **200 a profile** (`over_limit` past that; one already in line keeps its place); `yours` is how many of this profile's are in line. With no sweep running, asking starts one for the asked-for tracks only (`started`; a `library_jobs` row of `kind: dj_analysis` under the asking profile), which doesn't lift a person's Stop on the automatic sweeps (`held` stays). Asked-for tracks don't wait for a download or an import; they still wait while the library's drive is away (`drive_away`), a drive move copies or switches (`drive_move`) and the Write Tags batch runs (`tag_write`). One track at a time at nice 10, with the usual rests (at least as long as the track took, ≥ 0.5 s) and error limits; the grid top-up and `GRID_VERSION` are as before. **The line is in memory:** a restart empties it (the automatic sweeps still reach every track) and so does a person's Stop; what a person asks for after a Stop, while the stopped run finishes its track, runs once that run ends. A run that fails, or stops because the setting was turned off, drops the line. A sweep's `done` never passes its `total`.

**`POST /api/library/dj/progress`** `{track_ids: [...], line?: true}` (up to 500, may be empty; JSON only, 64 KB) → `{success, tracks: {<id>: entry}, sweep}`, `Cache-Control: no-store`; cheap enough to poll every second or two (the browser asks in chunks of 500 and puts the answers together; it polls every 1.5 s while a track it shows is being worked out, or in line because someone asked for it, or within 5 of the front, or while Activity's DJ row is open and the sweep runs, else every 20 s (a library mid-sweep, its rows deep in the sweep's own order, polls slowly); never while the tab is hidden). Each of the caller's tracks:

- `{"state": "done"}` (a grid that found no beat is done too);
- `{"state": "working", "step": "grid", "percent": 60}`: being analysed now. `step` is reported from the analysis itself, at real points (`core/dj/progress.py`): `read` (the decode starts), `tempo`, `key`, `energy` (`core/sample/analyze.py`'s `on_step`), `tags` (the tag write, when on), `grid`, `phrases` (`core/dj/grid.py`'s `on_step`, once the beats are found). `percent` is the step's fixed place: a full analysis read 5, tempo 20, key 35, energy 45, tags 50, grid 60, phrases 85; a track that only needs its grid (the top-up, or Sample Studio's analysis reused) read 5, grid 40, phrases 80; `null` step (between taking a track and its first step) is percent 0;
- `{"state": "queued", "position": 2, "asked_for": true, "yours": true}`: in line, 1 being next; `asked_for` false for the sweep's own order (its position counts the asked-for line first); `yours` (since the Gauntlet review, on `waiting` entries too) is true when the caller's own ask holds it there, so a Cancel would take it out;
- `{"state": "waiting", "reason": …, "position": n | null, "asked_for": …}`: `drive_away`, `download`, `import`, `drive_move`, `tag_write` (what the sweep waits for; an asked-for track is never `download` or `import`), `held` (a person pressed Stop), `off` (analysis is switched off), `not_queued` (in no line; the next sweep reaches it);
- `{"state": "failed", "reason": "too_long" | "unreachable" | "error" | "no_grid"}` (`no_grid`: BPM, key and energy are known but the beat grid failed; `too_long` adds `duration`, whole seconds, for "Skipped, 2 h 14 min is too long to analyse").

Since Brief A every entry also says **`ready`** (ready to mix: a beat grid at this `GRID_VERSION`, for this file, that the planner would beat-match: beat confidence at least 0.5 and 4/4, a meter not worked out reading 4/4; one rule, `core/dj/grid.py` `beatmatch_problem`, for the planner, `ready` and the status count) and **`bpm_key`** (BPM and key are known, whatever the grid); a `done` track that can't be beat-matched adds **`beat`**: `no_beat` (no beat, or one under that confidence), `too_short` or `not_4_4`; a `working` one adds `mode` (`full` or `grid`).

`sweep`: `{running, held, analyze, id, total, done (done + failed + unreachable + skipped), percent, waiting, in_line, yours, current: {step, percent, asked_for, track_id, title} | null}`; `current.track_id` and `title` are null unless that track is in the caller's library. Brief A adds:

- `left`: the sweep's own tracks still to do after the asked-for line (the topbar's count is `in_line + left`); a track put back for later (a deferred or stale outcome) counts as finished;
- `next_in`: seconds until the scheduler's next automatic sweep, null while a Stop holds, analysis is off or no scheduler runs ("next sweep in about 25 min");
- `held_by`: who pressed Stop, the profile's name for admins and null for members ("an admin"), and `held_by_you`;
- `yours_first`: every one of the caller's tracks in line is ahead of the rest;
- `waiting_detail`: `{count, drive}` while it waits: the downloads left (an admin: across the live batches; a member: its own batches), the import's file count (admins only: an import keeps no owner, so a member gets the words without the number), the library drive's name (admins only); null for what isn't counted (a drive move, a tag write);
- on `current`, for a caller whose library holds the track: `artist`, `mode`, `times` (each finished step's seconds to 0.1, the tag write counted in energy's; HANDOFF 326), `now` (the step it's on) and `elapsed`;
- with `line: true` (only the popover and the phone's Activity panel ask): **`line`**, up to 8 tracks of the asked-for line in order as the caller may see them (a member: the tracks it asked for itself; an admin: every track in its library), each `{track_id, title, artist, position, source, by ("you", another profile's name for admins, else null), set_name (the caller's own set only), front}` (an admin's 8 are its library's, picked from the line before it's cut: read 100 at a time, at most 400 tracks a poll), and **`line_more`**, how many more are in the asked-for line (counted, never named).

**`POST /api/library/dj/start`** (admins) without a body is unchanged (a full sweep, lifting a Stop). **With `{track_id}`** it's Brief A's Move up (and Analyse now): the track goes to the very front of the asked-for line, as the admin's own ask (`source: "asked"`, so the line says "you asked"); a later one goes before an earlier one. With nothing running it starts a run for that track only, never a full sweep, and a Stop stays (`held` and `held_by` kept). One a second a profile (429 `rate_limited`), 409 `off` while analysis is off, 409 `{code: "nothing_to_move"}` with the words when the track is done already, can't be analysed, or isn't in the library, and 409 `{code: "over_limit"}` when the admin has 200 tracks in line already; the browser retries a 429 once after its `Retry-After`; → 202 `{queued: true}`. **`POST /api/library/dj/stop`** remembers who stopped (`held_by`); a Start forgets it.

**Activity:** the running DJ row's `ref` gains `dj_progress: true`; the page reads `/progress` (empty ids) for the sweep's bar and the track it's on. `ref.stop_path` is given to admins only (a member can't stop a sweep, so isn't offered Stop).

**`GET /api/library/dj/status`:** `job.current` (the track being analysed) is given to admins only; for members it's null (`/progress` names it only for a caller whose library holds it).

**In the browser:** `requestAnalysis(ids, {force?, reason?, source?, setId?, retry?})` gathers ids for 250 ms into one request (a person's asks and automatic ones, and asks with a different `source` or set, in separate requests; `reason` is `asked` with `force`, else `auto`; a person's ask says `source: "asked"` unless it names another), `askForAdded(ids, why)` asks for an Added toast's words (the answer, or null after 2.5 s), `analyseMine()` and `cancelAnalysis(ids)` wait their turn behind the asks, sends one at a time spaced a second apart, waits out a 429's `Retry-After` (six tries), answers null for a 409 `held` (and forgets those tracks), and doesn't ask an automatic trigger's track again for ten minutes (`force`, "Analyse these", always asks). The shared poll (`analysisStore`) reads every track any part of the page shows; `watch(ids, {sweep, summary, line})`: `sweep` (Activity's row, the popover) polls fast while the sweep runs, `summary` (the topbar's count on every page, and Tracks' head since the Gauntlet review: its own rows working, asked for or near the front still poll fast) reads the sweep at the slow pace only, `line` adds `line: true`; a line reads the last poll's sweep without a watch of its own, so a hidden part polls nothing (review M2); when tracks go from in line or working to done or failed, it gathers them for 3 s (one refresh every 3 s at most), then reads again the queries that name one (`['dj', 'tracks', ids]`, `['dj', 'mix' | 'mixes', id, …]`, `['automix', 'plan', from, to, …]`, the Mix tab's join `['sets', 'join', last, playing]`) and the lists that show them (`['dj', 'status']`, `['dj', 'browse', …]`, `['sets', 'set' | 'view' | 'list' | 'working', …]`), never Vibe's `['dj', 'mix-vibe', …]`, and dispatches `soulsync:dj-analysed` `{ids}` on `window` (auto-mix plans a waiting pair again, afresh). Triggers: the Mix tab's track (while the tab is shown: the tray in Mix and open, or the Visuals drawer; `source: mix`), a set's tracks (while its page is open, and when added with Add to set… or to the working set; `source: set` with its id), Up next's coming 50 library tracks with Auto mix on or a set played as a mix (`up_next`; the playing track and the next go first with `soon: true`, once each time that pair changes and again after a Stop turned it away, `requestAnalysis(ids, {soon})`), the lab's picks (`lab`), and "Analyse these" (Tracks' selection, an album, a playlist by id, a set). The player's Play next and Add to queue ask through `window.ssAnalysisToastWords(ids)` (set by the automix host while Auto mix is on) for their toast's "analysing, 2nd in line".

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

MilkDrop's preset list, one preset by key, favourites per profile, and where an admin's own presets live (`api/visuals.py`, `core/visuals/`). Every route needs a profile (401 `profile_required`). Recent, the chosen visual and family, Quality, Auto-cycle, Blend and "Every preset" (`soulsync-visuals-every-preset`) stay in the browser (`soulsync-visuals-*` keys, Auto-cycle in the SYNCHRO.S visuals' `soulsync-npv2-viz-autocycle`); nothing about them reaches the server.

**The index: `GET /api/visuals/presets?family=milkdrop&set=curated|all&keep=&q=&author=`.** Asked for once, when the MilkDrop family is first opened (never on page load), and again when "Every preset" changes; the browser then searches and filters it itself. `q` (every word in the name or the author) and `author` (case-insensitive) filter here too. Any other `family` is a 400 `bad_family`.

- **`set`** (HANDOFF 101, board 18a): `curated` (the default when it's left out) lists the presets in `butterchurn-presets`' curated packs (its main pack, Extra, Extra 2 and MD1: 395) and your own; `all` lists every bundled preset and your own ("Every preset" in the panel's foot). Anything else is a 400 `bad_set`. `total`, `count` and `authors` are of the set asked for; `curated` and `uncurated` count the bundled presets in and outside the packs (the switch says "Adds 1,359 more").
- **`kept`**: in the curated set, the bundled presets it leaves out that the person keeps: the profile's favourites (the server reads them) and the keys `keep` names (comma-separated `md-` keys, at most 50: the browser sends Recent's). So Favourites and Recent keep what's in them, switch or not. Always `[]` for `all`.

```json
{"success": true, "family": "milkdrop", "set": "curated", "total": 397, "count": 397,
 "bundled": 1754, "curated": 395, "uncurated": 1359,
 "presets": [{"key": "md-a2d4673ae1656827", "name": "Eggs", "author": "Geiss",
              "full_name": "Geiss - Eggs", "size": 1212, "source": "bundled", "curated": true}],
 "kept": [{"key": "md-…", "name": "…", "source": "bundled", "curated": false, "…": "…"}],
 "authors": [{"name": "Geiss", "key": "geiss", "count": 41}],
 "own": {"configured": true, "count": 2, "problem": null, "truncated": false,
         "too_big": 0, "read_at": 1792838578}}
```

- A–Z by name. `name` and `author` come from the preset's "Author - Title" (the file name for your own); leading underscores and the like are dropped from the author, and a name without " - " has `author: null` (the list says "author unknown"). `authors` folds spellings together (Flexi / flexi) and shows the commonest.
- **Bundled** presets are the installed `butterchurn-presets` npm package's `presets/converted/` (1,754 in 2.4.7), copied out of `node_modules` by the build (`webui/scripts/milkdrop-presets.mjs`, the last step of `npm run build`) into `static/dist/visuals/milkdrop/` as `index.json` and one `<key>.json` each. Nothing is in the repository; an install without a build lists none. `key` is `md-` + the first 16 hex of sha1(name). The build marks each `curated` from the package's pack meta (`lib/butterchurnPresetPackMeta.min.js`); an index built before the mark counts every preset as curated.
- **Your own** are `.milk` files in the folder an admin set (`visuals.own_presets_dir`, below), walked three levels deep, at most 5,000, each at most 512 KB; hidden files, other extensions and anything that resolves outside the folder (links) are left out. `key` is `own-` + 16 hex of the path inside the folder. `own.problem` is `missing` (not there inside the container) or `unreadable` when the folder can't be listed; `own.too_big` counts `.milk` files left out for being over 512 KB, and `own.read_at` (seconds since the epoch) says when the folder was read. The listing is reused for 30 seconds.

**One preset: `GET /api/visuals/presets/<key>`.** Fetched when it's picked and kept (`Cache-Control: private, max-age=604800` for bundled, an hour for yours, plus an ETag; the page also keeps it for the session). A bundled key answers Butterchurn's JSON; your own answers its `.milk` text (`text/plain; charset=utf-8`, `X-Preset-Format: milk`), which the browser converts (`milkdrop-preset-converter`). An unknown or malformed key is a 404 `not_found`. An own key is looked up in a listing of the folder (the request never names a path), and the file it names is checked again before it's read: still inside the folder once resolved, `.milk`, a regular file, under the cap.

**Favourites: `GET /api/visuals/favourites?family=milkdrop`, `PUT` and `DELETE /api/visuals/favourites/<family>/<key>`.** The signed-in profile's stars, newest first: `{"success": true, "family": "milkdrop", "keys": ["md-…"]}`; a change answers `{"success": true, "family", "key", "favourite": true|false}` (starring twice is fine). Only `milkdrop` (400 `bad_family`); a key that isn't a preset key is a 400 `bad_key`; 2,000 per profile (409 `too_many`). Table `visual_favourites (profile_id, family, preset_key, created_at)`, primary key on the first three (`core/visuals/favourites.py`, a MusicDatabase migration step).

**Your own presets folder: `GET /api/visuals/settings`, `PUT /api/visuals/settings` (admins).**

```json
{"success": true, "admin": true, "own_presets_dir": "/music/milkdrop",
 "own": {"configured": true, "count": 2, "problem": null, "truncated": false,
         "too_big": 1, "read_at": 1792838578}}
```

- Player settings' line under the folder reads from `own` (board 18b): read ("12 presets, read 2 minutes ago. 1 is too big (over 512 KB) and was left out.", success), empty (warning) or `problem` (danger), in words.
- `own_presets_dir` is only in an admin's answer. PUT `{"own_presets_dir": "/music/milkdrop"}` (or `""` for none) checks the folder first: a full path (400 `bad_path`), that exists (400 `missing`) and can be read (400 `unreadable`); members get 403 `admin_only`. Docker paths go through the same resolver as the other folders. Shown in Player settings → MilkDrop.

**The radio card's restart** uses the existing `POST /api/radio/play` with `force_relay: true` (`SoulSyncRadio.play(id, {forceRelay: true})`); nothing new on the server.

**Lyrics over the visuals (boards 27a–27g) and Data (30a–30i): no new routes.**

- **Lyrics** come from the fetch the player already makes for every music track, `POST /api/lyrics/fetch` `{title, artist, album?, duration?, file_path?}` → `{success, synced, plain, source, instrumental}`. `source` is `sidecar` (an `.lrc` or `.txt` beside the track wins) or `lrclib`; `synced` is LRC text as it came, word times (Enhanced LRC's `<mm:ss.xx>`) included; `instrumental` (new, 30 October) is true when LRCLIB marks the track as having no words and gives none, and then `success` is false. Radio, podcasts and audiobooks aren't asked for, as before. The page reads the answer through `SoulSyncPlayer.lyricsData()`.
- **Kept in the browser:** Lyrics on or off (`soulsync-visuals-lyrics`), Lyrics only (`soulsync-visuals-lyrics-only`), the text size (`soulsync-visuals-lyrics-size`: 36, 44 or 56) and the early/late nudge per track (`soulsync-lyrics-offsets`: a JSON map from `lib:<track id>` or `t:<title>|<artist>|<album>` to seconds, earlier positive, 0.1 s steps, ±10 s, the newest 500 tracks). Data's settings: `soulsync-visuals-data-numbers` (`hex` or `dec`), `-data-bits`, `-data-texture`, `-data-colour` (`accent`, `phosphor`, `white`), `-data-under-bars`, `-data-under-scope`; the family `data` in `soulsync-visuals-family`.
- **Data's readout** reads `GET /api/library/tracks/<id>/details` above (format, sample rate, bit depth, channels, bitrate, on disk) for a library track, and the station's stream (`codec`, `bitrate_kbps`) from the radio session for a station; the samples are the page's own audio graph (a channel splitter and an analyser per channel off the player's analyser), nothing fetched.

### Your music's drives (boards 14a–14t)

`api/drives.py`, `core/drives/`. Every route is admins only except `GET /api/drives/status` (any signed-in profile) and `GET /api/drives/helper.sh` (no session; its one-use token is the credential). Paths are the container's; with the drives folder mounted at the same path (`/Volumes:/Volumes`) they read the same inside and out. Admins also get the **computer's own names** where SYNCHRO.S knows them (`host_path`, `volume`, `host_source`; see "The computer's names" below); members never do.

- **`GET /api/drives/status`** → `{library_away, away: ["library"|"downloads"|"staging"], interval: 30, checked_at, boot_id, can_check, folders: {library: {role, label, connected, last_seen, drive, path?, reason?}, …}}`. Members get no `path` / `reason` and `can_check: false`. Admins also get `move: {id, status, promise}` while a move is open and `reminder: {move_id, source_label, target_label, bytes, files, switched_at}` a week after a switch whose old copies are kept. `reason` is `marker`, `content`, `fresh`, `missing`, `unreadable` or `empty`. Admins' folders also carry `host_path`, `volume` and `host_source` (each `null` when unknown). **`POST /api/drives/status/check`** looks again now.
- **`GET /api/drives/folders`** (14a) → `{folders: [{role, label, path, drive, holds, files, bytes, host_path, volume, host_source}], drive: {label, free, total, percent, tone: null|"warning"|"danger"}, move, platform, compose_folder}`. Sizes are measured in the background: `null` until the first measure.
- **`GET /api/drives/docker`** (14c) → `{platform, guessed, compose_folder, roots, visible_roots, drives, boot_id, lines: {mounts, slskd_config}, token: {state}, undo}`. **`POST /api/drives/docker/command`** `{folder, platform, names}` saves both (`drives.compose_folder`, `drives.platform`; each optional, the saved one when left out) and mints the one-use command → `{command, undo, expires_at, lines, names}`; with `names: true` the command ends `sh drives-helper.sh --names` (only the host hints: no compose change, no restart; `400` on Windows); a folder with anything but plain path characters is `400` with `field: "folder"`. **`GET /api/drives/docker/check`** (14d) → `{boot_id, drives, visible, token: {state: none|live|used|expired}}`: a new `boot_id` means SYNCHRO.S restarted. **`GET /api/drives/helper.sh?t=<token>`** answers the script once within ten minutes, else `403` with a line to echo.
- **`GET /api/drives/browse?path=`** → the folders one level under a path on a drive (no links, no dot-folders); without `path`, the drives offered.
- **The move.** `drive_move` is `{id, status, promise: {tone, words}, choice: {roles, target, separate, per_role, exfat, checksum, downloads_left}, checks: {rows: [{key, title, tone, tag, detail, stop?, needs_choice?, sign_in?, slskd_choice?, signed_in?, home_label?, target_label?}], ok, summary, dests, speed, format, need}, plan: {order, dests, sources, total_bytes, total_files, estimate_seconds, checksum_seconds, target_label, source_label, automations, library_paths, media_label}, folders: [{role, label, source, dest, files, bytes, copied_files, copied_bytes, verified, source_host_path, source_volume, dest_host_path, dest_volume}], progress: {phase, role, current, copied_bytes, total_bytes, speed, eta_seconds, checked, total, different, step, waiting_for}, failure: {kind: drive_away|full|write|mismatch|unreadable|refused|restart|error, words, files?, count?, matching_files?}, result: {checks: [{key, ok, title, detail, mono?, detail_host?}], media, slskd, removed}}`. `detail_host` is the computer's name for a `mono` detail that is a destination folder. `status`: `draft`, `copying`, `verifying`, `switching`, `switched`, `failed`, `stopped`, `removed`, `switched_back`.
  - `GET /api/drives/move` → `{move, overview?, running, boot_id}` (the open move, else one finished in the last hour; `overview` with the folders, drives and the home disk while it's a draft). `POST /api/drives/move` → the open move or a new draft.
  - `PUT /api/drives/move/<id>/choice` (any of the choice's keys), `POST …/check`, `POST …/slskd-session` `{username, password}` (only the session token slskd gives back is kept, encrypted), `POST …/plan`, `POST …/start` `{checksum}`.
  - **Check's slskd row (board 19a).** When Downloads moves and slskd is set up and editable, the row `key: "slskd"` has `slskd_choice: "move"`, `home_label` (where Downloads is now) and `target_label`. Before the sign-in it's `tone: "warning"`, `tag: "Needs your choice"`, `needs_choice: true`, `sign_in: true` (not a stop; `ok` is false, so the plan waits); after it, `tone: "success"`, `signed_in: true`, `tag: "Signed in as <user>"`. `PUT …/choice {downloads_left: true}` takes Downloads out of this move (`roles.downloads` false) and forgets any slskd session at once; the row then has `slskd_choice: "leave"` and `tone: "success"`. `{downloads_left: false}` puts Downloads back. Ticking `roles` without `downloads_left` resets it. A refused sign-in is a `400` with `code: "slskd_refused"` (said under Password). Neither the password nor the session token is ever in an answer or a log line; the session is forgotten after the switch, when a draft is left, when Downloads leaves the move, and when the move fails. A sign-in that lands after Downloads left the move (or the move left draft) isn't kept: `409` with `code: "slskd_not_needed"`.
  - **A folder that stays may not sit inside one that moves** (or hold it): `PUT …/choice`'s later Check, `POST …/check`, the plan and Start refuse with `400 code: "nested_folder"` and a sentence ("…Move Downloads too, or move it out of the Library folder first."), and Check stores a stop row `key: "nested"`. Start's walk also leaves out any folder that stays, and Remove skips anything inside a folder SYNCHRO.S still uses.
  - **Choices and Start don't cross:** a choice or a sign-in is written only while the move is still a draft (otherwise "The move has moved on…"); a Start whose move changed while it listed the files stops with "The move changed while SYNCHRO.S listed the files. Check again." and nothing copied.
  - **Carrying on after a failure** (`…/resume`, `…/recopy`, `…/skip-unreadable`) takes an optional `{username, password}`: when Downloads moves and the session went with the failure, a call without them is `409 code: "slskd_sign_in"`. A failed move without a plan can't carry on (`409 code: "no_plan"`); `…/leave` closes a failed move the way Stop and undo does (its half-made copy goes, never while the folder settings point at it).
  - `POST /api/drives/move/stop` (Activity's Stop) or `…/<id>/stop`: Stop and undo. `POST …/resume` (carry on, or try the switch again), `…/recopy` (copy the files that didn't match again), `…/skip-unreadable`, `…/switch-back`, `…/leave` (a draft).
  - `POST /api/drives/move/<id>/remove-preview` → a plan (tool `drive_move_remove_old`; the "Preview, then confirm" shape, items `action: "delete"`; each sample row also has `role` and `rel`, its path relative to its old folder) plus `roots: {library: {role, label, path, drive, host_path, volume, host_source}, …}`, each old folder the list heads with (19c), and `platform`. `GET /api/drives/plan-list/<plan_id>` the full list as text (the computer's paths where known, else the container's), `POST …/remove` `{plan_id}` → `{deleted, freed_bytes, skipped, move}`; refusals are `409` with the plan codes.
  - Refusals are `409` (or `400`, `404`) with a sentence in `error`.
- **The computer's names (Design's 125, Dev's 160; `core/drives/host_paths.py`).** The drives helper writes **one file into SYNCHRO.S's own settings folder**, `host-paths.json` beside `config.json` (`./config` on the computer, `/app/config` inside; found from the `soulsync` service's `/app/config` mount, and skipped with a sentence when the file has none), on every run that changes or checks the compose file, and alone with `sh drives-helper.sh --names`:
  `{"v": 1, "folders": {"<marker id, 32 hex>": {"host_path": "/Users/ross/SoulSync/music", "volume": "Macintosh HD", "os": "mac"|"linux", "target": "/app/Transfer", "written_at": <unix seconds>}, …}}`, written 0640 when it belongs to the owner of `config.json` (else of the settings folder), 0644 otherwise; run as root, the helper hands it to that owner. `target` is the folder inside SYNCHRO.S (the mount target, or a folder one level down in it that holds a marker). The helper reads `docker-compose.override.yml` (and `COMPOSE_FILE`'s other files) with the compose file, checks each entry it writes or keeps with `compose_tool.clean_entry` (the same check SYNCHRO.S applies) and skips one that fails, clears leftover `host-paths.json.*.tmp`, and calls a mount without a marker in it or one level down "not one of SYNCHRO.S's folders".
  **Nothing is written into the music folders** (slskd shares the library's root); an older build's `.synchros-host.json` inside one is deleted by the helper and never read by SYNCHRO.S. Entries for folders a run doesn't name (a move's old folders) are kept; at most 64, newest first. Markers carry `id` (32 lowercase hex), kept when SYNCHRO.S writes the marker again for the same role; the watch gives an older marker one. The marker itself holds only `{app, role, about, created, id}`: no path or name. SYNCHRO.S treats the file as **untrusted display text**: it reads it without following a link, from a regular file of at most 96 KB, requires exactly this schema (one bad entry refuses the whole file: an absolute POSIX path without `..`, control or direction characters; a volume without `/`), and **trusts an entry only while its key equals the id of the folder's current marker and the folder is exactly the entry's `target`** (a copy that kept the marker, inside the same mount or elsewhere, or a mount since moved, names nothing; a move's forward switch gives the new folder a fresh marker id, a switch back keeps the old one). The drives-folder rule below comes first. It never opens, lists, writes or deletes anything by a host path. `host_source` is `hint`, or `same` for a folder under the platform's own drives folder, which is mounted at the same path (`/Volumes/Music HD/…` is itself; `/drives/d/…` is `D:\…`); not with `SOULSYNC_DRIVES_ROOTS` set. `SOULSYNC_HOST_PATHS_FILE` overrides where the file is read; when SYNCHRO.S's settings folder isn't the `/app/config` the helper writes to, or the file is there but SYNCHRO.S can't open it, the log says so once. The file and each folder's answer are re-read at most every 5 seconds.
  **slskd's share filters.** slskd doesn't share hidden files (dot-files on Linux), so neither SYNCHRO.S's own files nor `._` files are shared; as belt and braces, a `slskd.yml` edit (the move's switch, and Check's dry run of it) adds `/\.synchros-[^/]*$` (and `/\._[^/]*$` for exFAT's carry on). slskd merges list settings by position across defaults, environment (`SLSKD_SHARE_FILTER`), `slskd.yml` and the command line, so the list written is **slskd's effective filters** (`GET /api/v0/options`, `shares.filters`) plus what's missing: never shorter, never reordered. When the effective list can't be read, lists a filter twice, isn't led by `slskd.yml`'s own list, or `slskd.yml` writes it on one line, the filters are left as they are, the rest of the edit goes ahead, and Check adds a row `key: "slskd_filters"` (`tone: "success"`, `tag: "Left as they are"`) saying why. A switch back keeps the `.synchros-` filter. Filters slskd took from `SLSKD_SHARE_FILTER` are then also in slskd.yml.
  **For other features: `core.drives.host_paths.to_host(container_path: str) -> str | None`** (stable). The computer's path for a file or folder under the library, downloads or staging folder (from that folder's trusted hint) or under the same-path drives folder; `None` for anything else, a relative path, `..` or a NUL. Export to Traktor (phase D2a) writes these into `collection.nml`; like the routes, it uses them as text only.
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
