# Handoff log

Decisions and questions between Design and Dev, newest first. Design's entries come from canvas notes and comments; Dev copies them here with the date and artboard.

## Open questions for Design

1. **Home (`Main.dc.html`):** which four targets matter most on Home, and what does each card do when its target isn't set up yet (no mirrored playlists, nobody followed)? Today's prototype assumes all four are in use.
2. **Activity (`Activity.dc.html`):** how far back the timeline goes by default (today, 7 days?), and whether "Needs you" items stay pinned until they're dealt with.
3. **Navigation (`Nav.dc.html`):** should the module pages (Podcasts, Audiobooks, Chat, Sample Studio) sit in their group (Library, Get music) or in their own "More" group when they're on?
4. **Legacy pages:** the Settings page is still the legacy UI. Should redesigned screens wait for their React rebuild, or should we restyle legacy pages to the evolved rules in place?

## Log

### 2026-10-21: Dev, Activity feed and Home targets endpoints

- **Built** (branch `api/activity-and-targets`): `GET /api/activity` (plus `GET /api/activity/status` for the shell's two badges), `GET /api/targets/summary` and `GET /api/quality/presets`. Shapes and the "Needs you" rules are in `CONTRACTS.md`. This answers Design's two questions: each item has a `needs_you` boolean, `counts.needs_you` is the filter's count, and the Quality target has `name` ("FLAC or better") and `tracks_checked`.
- **Where the data falls short of the boards** (for Design to adjust):
    - Wanted counts tracks, not "tracks and albums". Its "You have" is what was found in the last 30 days: found tracks leave the list, and their audit trail is capped.
    - Followed artists counts new-release tracks (on Wanted, or downloaded in 30 days). Per-artist release counts and "New release" tags aren't recorded anywhere yet.
    - Quality is never "Not set up": every install ships a default profile. A fresh install's profile accepts down to MP3 192, so it reads "MP3 192 or better", not "FLAC or better". FLAC 24-bit counts are estimates, since bit depth isn't stored. "Set 14 March 2026" can only be when the profile was last saved.
    - "Can't search" says when the last check failed, not since when, and not how many searches were skipped.
    - Activity can't say "for Wanted" (downloads record only playlist or followed-artist origins), nor download sizes. A failed batch gives counts by reason ("2 weren't found, 1 failed to download"), not each track's error. A mirror run gives the net change in tracks, not added and removed separately.
    - Seeded system automations appear only when a run fails (Auto-Scan Watchlist always appears), so a 30-minute Auto-Process Wishlist doesn't fill the timeline.

### 2026-10-21: Dev, the last preview-then-confirm gaps

- **Repair "Fix selected" and album "Resolve all"** now preview. The confirm shows a "What happens" column per file. Tag-only fixes still run straight away.
- **Empty recycle bin and Clear quarantine** now preview, with a danger-styled confirm: "Permanently delete 418 files (5.1 GB)? This can't be undone." Stat tiles show files, size, oldest and newest.
- Copy follows the real setting: when recycling is off, it says files are deleted permanently.
- **Still without a preview** (for Ross to decide):
    - the recycle bin's age-based auto-delete;
    - the video and audiobook bins;
    - video repair bulk fixes;
    - the Lossy Converter's "delete original" option.

### 2026-10-21: Dev, screens built from the prototypes

Built and merged into `integration` (4f1448c), following the canvas:

- **Setup check page** (`SetupCheck.dc.html`): as drawn, plus a quick "folders first" result while the full check runs, and a "What you can do" box for skipped checks that come with advice. The phone gutter is 12px, the app's shared page padding, not 16px.
- **Preview, then confirm** (`SafeAction.dc.html`): shared `SafeActionDialog`. Wording as drawn. The disabled confirm button uses the shared Button's disabled style, which is low contrast; worth a look.
- **Settings → Modules**: no artboard; built to the evolved rules on the legacy Settings page. Design may want to draw it.
- Building next: previews for Repair "Fix selected" and Empty recycle bin / Clear quarantine (permanent deletion, danger-styled confirm).

### 2026-10-21: Ross, decisions

- Evolve the current look; dark only for now.
- All modules stay on by default; people switch off what they don't use.
- Prototypes wanted for: downloads against targets plus automation, navigation plus artist page, Wanted and Followed artists, Activity, setup check plus safe actions. All are on the canvas, waiting for review.
