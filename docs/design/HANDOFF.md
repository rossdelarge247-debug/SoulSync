# Handoff log

Decisions and questions between Design and Dev, newest first. Design's entries come from canvas notes and comments; Dev copies them here with the date and artboard.

## Open questions for Design

None open. Questions raised while building go in the log entry that raised them.

## Log

### 2026-10-21: Dev, Activity page

Built on `ux/activity-page`: a React route at `/activity` (`webui/src/routes/activity`), from "Activity v3" (2e, 2f), "Activity v2" (1h, 1i) and the 2s failure pattern, over `GET /api/activity`.

- **Header:** "N running now" in info blue with a live dot, from `running_count`; hidden at 0.
- **Filters** All / Downloads / Imports / Automations / Playlists / Needs you map to `kind` (all, download, import, automation, sync, needs_you); Needs you carries `counts.needs_you` in a warning badge. **Range** Today / 7 days / 30 days: 7 days by default, the last choice remembered per browser (`localStorage`, failures ignored). Both live in the URL (`/activity?show=downloads&range=30d`), so back, forward and links work; a URL without a range gets the remembered one written in (replacing the entry). Today sends the browser's own midnight as `since`.
- **Needs you** is pinned above the timeline whatever the range. With a kind filter it keeps that kind's items; the Needs you filter lists them all and no timeline. Actions: Preview again goes to the tool that made the preview (Duplicate cleaner and Deep Scan open the Tools tab and bring their card into view; Repair fixes open Tools; Empty bin and Clear quarantine open Downloads, where they live), Dismiss (`POST /api/activity/dismiss`, safety items only), Choose for an import folder waiting on a choice, Open for the rest.
- **Timeline:** day groups ("Today · Wednesday 21 October"), rows of time, status tag, title, one detail line and one action. Show log loads `/api/activity/log/<id>` into the `<pre>` with "Open this automation · Copy log". Retry now appears only where a route exists: a failed import folder (`POST /api/auto-import/retry/<id>`) and a failed automation run without a log (`POST /api/automations/<id>/run`). Everything else with a page says Open. "Show earlier days" pages with `next_before`.
- **Live:** refetches every 10 seconds while something runs and every minute otherwise, never while the tab is hidden, and once on coming back to it.
- **Times** are in the browser's locale. When an item has `retry_at`, the server's "in about 2 hours" becomes the time itself ("Next run at 18:15"), so it doesn't go stale on an open page.
- **Loading, empty, failure** as 1i, 1h and 2s: the header, filters and range stay usable; loading names the range; the failure Notice offers Try again and, for admins, Run Setup check, over faded placeholders.
- **API:** import items now carry `ref.import_status`, so "Choose" and "Retry now" only show where they fit (`CONTRACTS.md`).
- **Access:** every profile can open Activity (the shell's page check); the API already scopes each item to what the profile may see.

Where it differs from the boards, and why:

- **Copy is the API's own** `title` and `detail`, so there's no "for Wanted", no sizes, no per-track errors and no added vs removed (see the API entry below). The board's "Downloading 3 tracks for Wanted · 1.4 MB/s" reads "Downloading 3 tracks for Wanted · 2 of 3 done".
- **Status words:** the boards draw Running, Done and Failed. The data also has warnings and notes, so a warning item in the timeline that is pinned says "Needs you", any other warning says "Incomplete" (it stopped part way or didn't find everything, and will try again), a preview outcome says "Preview", and anything else "Info".
- **Retry now** isn't offered on a failed download batch: there's no route that retries a batch (sync history can only add one failed track to Wanted at a time). Those rows say Open and go to Downloads. A failed automation with a log shows Show log, as drawn.
- **Logs** have no timestamps or phases (`log_lines` are type and text), so the `<pre>` shows the type as a column, then the text.
- **Width:** at 1440 with the sidebar the content is 1120px wide, not the board's 1200; rows flex.
- **Paging** stays inside the chosen range. When there's nothing earlier, a line says "That's everything from the last 7 days."
- **Empty states** for each filter have their own title and two sentences (the board draws only All); the Needs you filter's says "Nothing needs you" and offers "Show all activity". Today offers "Show 7 days", 7 days "Show 30 days", 30 days only "Open Automations".
- **Needs you note** says "The newest 50 of N" when more need you than the API lists.
- **Phone:** every row shows its action under the detail line, including Open (the board draws no Open rows on the phone); Needs you rows keep their detail line; "N running now" and the note beside Needs you are left off, as drawn.
- **Needs you badge** keeps the last count while another filter or range loads, instead of a placeholder each time; the placeholder shows only on the first load, and no badge shows when the first load fails.

Not done, for Ross or Design:

- Preview again for Empty bin and Clear quarantine opens Downloads, not its Review view: that page has no link into Review yet.
- "Open this automation" opens Automations; there's no link to one automation.
- A route to retry a download batch's failed tracks would let those rows say Retry now.

### 2026-10-21: Design's answers and Ross's naming decision

From the handoff package ("Start here - Design notes 2026-10-21" and the board notes):

1. **Home:** all four targets stay, in the order Wanted, Mirrored playlists, Followed artists, Quality. A target that isn't set up shows a "Not set up" card with one sentence and one button; with nothing set up the grid folds into one panel (`Main v2 (target not set up)`).
2. **Activity:** 7 days by default, remembered per browser; Today and 30 days are one click away. "Needs you" stays pinned above the timeline, whatever the range, until it's dealt with.
3. **Navigation:** module pages sit inside their groups (Chat & Arcade in Get music; Podcasts, Audiobooks and Sample Studio in Library). No "More" group or tab. Video keeps its own switch and sidebar.
4. **Legacy pages:** restyle them in place to the evolved rules (CSS first) rather than waiting for their React rebuild.

**Name:** the handoff renames the app "Sync.FM". Ross decided to keep **SoulSync** for now, so the wordmark reads "SoulSync" (compact monogram "SS") and the Home sentences say SoulSync. Please use SoulSync on new boards.

### 2026-10-21: Dev, Activity feed and Home targets endpoints

- **Built** (branch `api/activity-and-targets`): `GET /api/activity` (plus `GET /api/activity/status` for the shell's two badges), `GET /api/targets/summary` and `GET /api/quality/presets`. Shapes and the "Needs you" rules are in `CONTRACTS.md`. This answers Design's two questions: each item has a `needs_you` boolean, `counts.needs_you` is the filter's count, and the Quality target has `name` ("FLAC or better") and `tracks_checked`.
- **Where the data falls short of the boards** (for Design to adjust):
    - Wanted counts tracks, not "tracks and albums". Its "You have" is what was found in the last 30 days: found tracks leave the list, and their audit trail is capped.
    - Followed artists counts new-release tracks (on Wanted, or downloaded in 30 days). Per-artist release counts and "New release" tags aren't recorded anywhere yet.
    - Quality is never "Not set up": every install ships a default profile. A fresh install's profile accepts down to MP3 192, so it reads "MP3 192 or better", not "FLAC or better". FLAC 24-bit counts are estimates, since bit depth isn't stored. "Set 14 March 2026" can only be when the profile was last saved.
    - "Can't search" says when the last check failed, not since when, and not how many searches were skipped.
    - Activity can't say "for Wanted" (downloads record only playlist or followed-artist origins), nor download sizes. A failed batch gives counts by reason ("2 weren't found, 1 failed to download"), not each track's error. A mirror run gives the net change in tracks, not added and removed separately.
    - Seeded system automations appear only when a run fails (Auto-Scan Watchlist always appears), so a 30-minute Auto-Process Wishlist doesn't fill the timeline.

### 2026-10-21: Dev, design foundations from the handoff package

Built on `ux/design-foundations`, from the "Interaction states", "SafeAction v2", "Settings Modules", "Flows" (2s) and "Wanted v2" boards and the design notes:

- **Tokens:** the handoff's colours, radii, focus ring, hover wash and motion as `--ss-*` in `static/tokens.css`, shared by React and the legacy sheets. `--ss-accent-light-rgb` is the +16% lightness the app already computes from the preset. The 7 presets are listed in `DESIGN-SYSTEM.md`.
- **Interaction states** in the shared form controls, dialog and safe-action pieces: hover wash, keyboard-only focus ring, no movement on press, the selected wash, neutral disabled with a written reason (`Button disabledReason`), input errors, `Button` lg at 44px (phones too).
- **Safe action v2:** neutral disabled confirm with its reason in the footer; the expired-preview state (warning Notice, faded counts, Preview again).
- **Settings → Modules** restyled to the board in `static/modules.css`. Today's intro copy is kept, as the board's note allows.
- **Loading and empty:** `LoadingState`, `SkeletonList`, `EmptyState variant="panel"`, and `Notice` with a title for failures.
- **Differs from the boards:** the deep-scan sample shows the file name with its folder under it, not one path; its count tiles are Files / Size / In your library (the real numbers); the expiry line keeps today's wording; the shared dialog scrim stays as built. Primary fills use the computed accent-light (`#46e27d` for the default green), not the boards' `#1ed760` stand-in.

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
