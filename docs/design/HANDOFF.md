# Handoff log

Decisions and questions between Design and Dev, newest first. Design's entries come from canvas notes and comments; Dev copies them here with the date and artboard.

## Open questions for Design

None open. Questions raised while building go in the log entry that raised them.

## Log

### 2026-10-21: Dev, Home page

Built on `ux/home-page`, on `/dashboard` (the Home route), from "Main v2 (target not set up)" (1a, 1b), "Main (390)" (1c), the card failure in "Flows" (2s) and the evolved rules. Code: `webui/src/routes/dashboard/-home.*.ts` and `-ui/home/`.

**Built**

- Header: "Home", "What you want, what you have, and what SoulSync is doing about the gap." and a secondary "Search for music".
- **Targets** in the fixed order Wanted, Mirrored playlists, Followed artists, Quality. A live card has the label, title, a status tag with a word, the have-of-items bar, three numbers and a footer with the next search and one link. A target that isn't set up gets the quieter card with one sentence and one button. With none of the first three set up (`any_set_up` false) the grid folds into the one "Tell SoulSync what you want" panel.
- **Can't search** (`cant_search`): the card keeps its numbers, the tag turns to a danger "Can't search", the middle number is "—", and the footer says why with "Run Setup check · Try now".
- **Latest**: the newest 3 items of `GET /api/activity` and "See all activity".
- Loading says "Loading your targets…" beside a spinner, over card-shaped placeholders. A failed load keeps the header and the Targets heading and shows a danger Notice ("Couldn't load your targets", Try again, Run Setup check) in front of faded placeholders. Latest has its own placeholders and failure Notice.
- Phone (under 600px of content width): cards stack, stats 22/700, the card's link is a 44px tap target, not-set-up buttons go full width, the next search is said once beside the Targets heading ("Next search in 2 h"), and Latest rows put the tag and time above the title.
- Targets and Latest refresh every 30 seconds (the summary's own cache) and when the tab is looked at again.
- Every link goes through one route map (`-home.routes.ts`): Wanted → `/wanted`, or `/wishlist` until that page exists; See all activity → `/activity`, or `/active-downloads`; Open Followed artists and Follow an artist → `/wanted`, or `/watchlist` (its "Add Artist" search); Mirror a playlist and Open Mirrored playlists → `/sync` (it opens on Mirrored, where "Add playlist" starts a mirror); Add to Wanted → `/search`; Set a quality target and Change target → Settings → Quality (`/settings?tab=quality`, the default quality profile); Run Setup check → `/setup-check`, for admins only. A link to a page the profile can't open isn't drawn.
- No API changes. "Try now" uses the existing download-source check (`CONTRACTS.md`, Home targets).

**Differences from the boards**

1. Wanted's title counts tracks ("312 tracks"), not "tracks and albums". Followed artists reads "18 artists · 52 new tracks" (tracks from new releases); Mirrored playlists "3 playlists · 1,140 tracks", as on 1c.
2. Quality's title is the real target's name; a fresh install reads "MP3 192 or better".
3. Status words the boards don't draw: "Complete" (Quality: "At target") when nothing is missing; "Not found yet" (neutral) when only tracks on the slowest retry remain; "Up to date" when a target has nothing to get, say followed artists with no new releases; "Paused" when the Automations switch is off, with "Automations are paused" in the footer; "No search scheduled" when no enabled automation serves the target.
4. Can't search: the footer is the API's sentence ("Soulseek (slskd) didn't answer when SoulSync last checked, 4 minutes ago, so searches can't run."), not "since 21:15 yesterday, so the last 2 searches were skipped", which isn't recorded. As on 2s, "Not found yet" then counts everything still missing. "Try now" runs the download-source check again and refreshes the card; if it still fails, the card says what the check said. It doesn't start a search. "Run Setup check" shows only to admins, since the setup check is admin-only.
5. The not-set-up Wanted and Quality cards aren't drawn in the grid. Copy written to match the others: "Get the music you want / Add tracks and albums you want. SoulSync searches for them on a schedule, at the quality you set. [Add to Wanted]" and "Choose the quality you want / Pick a format or bitrate. SoulSync looks for that quality when it downloads, and can upgrade what you already have. [Set a quality target]". Quality is never not set up in practice.
6. Latest: the tags are Done, Running, Partly done (a warning), Failed, Info, and "Needs you" for anything flagged. Older items show "Yesterday", a weekday or a date in the time column. Only "needs you" rows carry a link, on the words the sentence already uses ("Preview again"). It reads the last 30 days, so a quiet week doesn't say "Nothing yet". Items can't say "for Wanted" (see the API entry below).
7. Phone: the page title is 24px and the stats 22/700, the handoff README's phone sizes; board 1c draws 28 and 24. "Search for music" stays on the phone: 1c drops it because Shell A's phone top bar has search, and today's shell has no such button.
8. Between desktop and phone (600 to 1000px of content width, not drawn) the cards sit two by two.
9. The not-set-up buttons and "Search for music" are links drawn as the secondary button, because they open another page.
10. The connection alerts from the old dashboard sit between the header and Targets, as a warning (or danger) Notice, only while a core connection is down: a download source that's down is why a target can't search.

**Where today's dashboard went**

Everything the boards don't cover is under a "Library and system" heading below Latest, each section the existing component with its behaviour, ids and tour anchors, restyled to the evolved rules (cards, type sizes, contrast, radii, 6px tags instead of pills, 44px buttons; the rules are the "Home" section of `static/dashboard-premier.css`). The sections' own copy is unchanged, Title Case included ("Recently Added", "Quick Scan", "Manage Workers"), for Design to rewrite when placing them.

| Today's dashboard | Now |
| --- | --- |
| Greeting and date ("Good evening, Ross") | Replaced by the Home header; the profile name is in the sidebar |
| Library size (tracks, albums, artists; each opens Library) | Library and system → Library |
| Library card: media server state, Quick scan / Stop, the menu (Deep scan, Browse library, Verify matches, Repair, Back up now, Review downloads with its count), setup messages | Library and system → Library |
| Enrichment workers: the 17 orbs (status on hover, pause or resume on click, the repair badge), Manage Workers, "Workers resting" | Library and system → Enrichment workers |
| Connection alerts (metadata source, media server, download source) and Open Settings | Under the Home header (difference 10) |
| Active downloads, while something downloads | Library and system, under Library |
| This week (listening digest, "full stats") | Library and system, left column |
| Recently Added and Fresh Releases, with play, queue and add to playlist | left column |
| Recently Played | left column |
| Library Radio and Mixes | left column |
| Playlist sync (schedules, Run now, Listen, run details, Manage) | right column |
| Up next (automations: Run now, pause or resume, See all, Automations) | right column |
| Artists watched and On your wishlist tiles | right column |
| Quick settings (Reduce effects, Max performance, Particles, Worker orbs, accent colour) | the foot of Library and system |
| Live refresh and the socket pushes | unchanged |
| Toasts | unchanged: the shell shows them on every page |
| The old activity feed (`/api/activity/feed`) | wasn't on today's page; Latest replaces it |

The tour still finds every dashboard stop; its welcome step now lands on the workers panel and still calls the page the "Music Dashboard".

**For Design**

- Where each "Library and system" section should live (some may belong on Library, Automations or Settings rather than Home).
- The place of the connection alerts (difference 10) and "Search for music" on the phone (difference 7).
- When the Wanted page lands, the route map should point "Open Followed artists" at its Followed artists tab; tell Dev its address.

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
