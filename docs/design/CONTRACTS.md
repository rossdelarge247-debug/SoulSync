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

## Available today, not yet designed for

- **Automation run history:** `GET /api/automations/<id>/history?limit=&offset=`. Each run has `started_at`, `finished_at`, `duration_seconds`, `status`, `summary`, `result` (counts the run produced) and `log_lines`. The Automations prototype can use this as it is.
- **Library history:** `GET /api/library/history?type=download|import|podcast`. Past downloads and imports.
- **Sync history:** `GET /api/sync/history`. Playlist mirror runs.
- **Download batches:** `GET /api/downloads/batch-history`.

## Needs building

- **Activity feed:** one time-ordered list across downloads, imports, automation runs, playlist mirrors, previews that expired, and problems that need the user. Today it's spread across the four history endpoints above, and Dev would merge them into one endpoint. Proposed item: `time`, `kind` (`download` | `import` | `automation` | `sync` | `safety`), `status` (`ok` | `warning` | `error` | `info`), `title`, `detail`, `link`.
- **Targets summary (Home):** for each target (Wanted, mirrored playlists, followed artists' new releases, quality), how many items, how many you have, how many are in progress or not found yet, and when the next search runs. The counts exist in different places; Dev would add one summary endpoint once Ross approves the Home design.

Shapes under "Needs building" are proposals until built. Dev updates this file when they are.
