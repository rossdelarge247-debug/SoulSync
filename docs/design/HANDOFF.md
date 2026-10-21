# Handoff log

Decisions and questions between Design and Dev, newest first. Design's entries come from canvas notes and comments; Dev copies them here with the date and artboard.

## Open questions for Design

1. **Home (`Main.dc.html`):** which four targets matter most on Home, and what does each card do when its target isn't set up yet (no mirrored playlists, nobody followed)? Today's prototype assumes all four are in use.
2. **Activity (`Activity.dc.html`):** how far back the timeline goes by default (today, 7 days?), and whether "Needs you" items stay pinned until they're dealt with.
3. **Navigation (`Nav.dc.html`):** should the module pages (Podcasts, Audiobooks, Chat, Sample Studio) sit in their group (Library, Get music) or in their own "More" group when they're on?
4. **Legacy pages:** the Settings page is still the legacy UI. Should redesigned screens wait for their React rebuild, or should we restyle legacy pages to the evolved rules in place?
5. **Navigation shell (`Nav v2 (Shell A)`, 1m and 1n):** Dev placed the pages and pieces the boards don't show (Discover, Playlist explorer, Import, Stats, the profile, service status, What's new, Support, the video side on phones) and chose the phone breakpoint. Each is listed as a question under "2026-10-21: Dev, navigation shell" below. Please redraw where you'd place them differently.

## Log

### 2026-10-21: Dev, navigation shell (Shell A)

Built on `ux/shell-a` from boards 1m (desktop) and 1n (390) in `Nav v2 (Shell A).dc.html`, the handoff README's "Navigation shell", and the design notes. Code: the sidebar, top bar and tab bar markup in `webui/index.html`, behaviour in `webui/src/shell/nav-shell.ts`, the route map in `webui/src/shell/nav-routes.ts`, the look in `webui/static/shell.css`.

**Name.** Ross decided the app keeps the name **SoulSync**: the wordmark reads "SoulSync" and the compact rail's monogram "SS". "Sync.FM" (and "S.FM") from the boards isn't used anywhere; nothing else about naming changed.

What was built:

- **Sidebar**, 256px on `#101010`: the wordmark (with the version as meta text, as the README says) is the button that folds it to the rail; Home, then Get music, Library, Automate and Settings with 12px group labels; 44px rows, 20px icons, the selected row in the accent wash with its border; the middle list scrolls while the bottom block (hairline, "Admin and help", "Switch to Video", the profile) stays pinned. A module that is off removes its row and nothing else moves (the existing module guard).
- **Compact rail**, 72px: icons with their names (and counts) as `title` and `aria-label`, 24px hairlines between groups, counts as 8px dots, "Admin and help" as a 256px popover beside the rail, the "SS" monogram expands it. Compact and the "Admin and help" fold are kept in `localStorage` and applied before first paint. Compact uses the old collapse toggle's key, so anyone who had collapsed the sidebar gets the rail.
- **Top bar**, 64px: back and forward through browser history (each disabled where the browser can say there's nowhere to go), the page name, one search field (⌘K or Ctrl K focuses it; Enter opens Search with the query; on the video side it searches video), and the live "N running" link to Activity.
- **Phone**: a 56px top bar (back, page name, search, Activity with the needs-you dot), a 64px tab bar (Home, Get music, Library, Automate, Settings; no "More"), and bottom sheets with 48px rows. Tapping a tab opens its sheet and tapping it again closes it; Escape or a tap outside closes it too, and focus goes back to the tab. The Settings sheet ends with "Admin and help" (folded the same way), "Switch to Video" and the profile.
- **Live badges**: Activity's needs-you count and the running count come from `GET /api/activity/status` (being built on `api/activity-and-targets`), polled every 30 seconds, paused while the tab is hidden, and refreshed after the app's activity socket events. A 404 or an error counts as unknown: the link says "Activity" with no count and the badge stays hidden, never "0". The Setup check dot comes from the setup check itself (see `CONTRACTS.md`). Wanted shows the wishlist count the sidebar showed before; Discover, Chat and Requests and issues keep their counts.
- **Kept**: deep links and reload on any route, profile and admin gating of every row, Hydrabase only when enabled, the requests count only while something waits, the video sidebar (restyled to the same rows; its sections still fold) with "Switch to Music" at its foot.

Where it differs from 1m and 1n, and why:

1. **The phone layout starts at the app's mobile breakpoint (768px), not at 390px.** Phones up to 430px wide and small tablets would otherwise get a 256px sidebar beside a 150–500px page. 1n is what every width up to 768 looks like.
2. **More rows than the boards.** With Discover, Playlist explorer, Import and Stats the middle list (and the rail) scrolls at 900px tall, as the boards' notes allow for short screens.
3. **Pieces the boards don't show, kept and placed by Dev:**
    - the profile (avatar and name, which opens the profile menu with "Profile & account" and "Sign out"; My Account and Sign out icons beside it) at the foot of the sidebar; just the avatar on the rail; the end of the Settings sheet on phones;
    - the service status as one "Connections" row with a dot per service (it opens the source switcher, as the old status block did), and "What's new" (the version, with an update tag when one is out) and "Support SoulSync", at the end of "Admin and help". The fold shows a dot for an update as well as for a setup problem, so folding doesn't hide either;
    - the opt-in sidebar weather line under the profile row (hidden on the rail).
4. **"Admin and help" on the rail is a disclosure, not `role="menu"`.** The popover holds links and the Connections row; it opens on click, closes on Escape (focus back on its button), on a click outside, or when you choose something.
5. **"Requests and issues" is always listed** (the board lists it; before, the Issues entry hid while nothing was open). When requests are waiting, a count at the end of the row opens Requests.
6. **Counts on the rail:** Activity's and the setup check's are warning dots as drawn. Discover's new items, Chat's unread and open issues get a neutral dot; Wanted gets none, as the board draws it.
7. **The running link when there's nothing to count:** "Nothing running" (meta grey) when the server says 0; just "Activity" when the count is unknown.
8. **The video side on phones** uses the same five tabs, with "Find" in place of "Get music": Find holds Search, Discover, Calendar and Chat; Library holds Library, Watchlist, Wishlist, Downloads and Requests; Automate holds Automations and Tools; Settings holds Settings, Issues and Help, then "Switch to Music".
9. **Icons:** the boards' glyphs for every row they draw; the app's own for Discover, Playlist explorer, Import and Stats; Feather glyphs for the Dev additions (Switch to Music, Connections, What's new, Support).
10. **⌘K / Ctrl K** used to open the helper's help search. It belongs to the search field now; help search stays in the helper's "?" menu.
11. **The artist page** used to rename the Library row "Library / <artist>". Rows keep their labels now; the top bar's page name is the artist.
12. No scrim behind a sheet (none is drawn); the floating help, bell and activity buttons and the mini player sit above the tab bar and step aside while a sheet is open.

Questions for Design (Dev's resolutions, please redraw where you'd do it differently):

1. **Discover** sits in Get music after Search.
2. **Playlist explorer** sits in Get music after Mirrored playlists.
3. **Import** and **Stats** sit in Library after Albums. (Import has no badge today, so none was added.)
4. **Wanted** opens `/wishlist` and stays lit on `/watchlist` and on label pages until the Wanted page lands; **Activity** opens `/active-downloads` until the Activity page lands. Both targets are one line each in `nav-routes.ts`.
5. **Albums** is the library's album view, `/library?view=albums` (it deep-links, so the row stays).
6. **Requests** is a count at the end of "Requests and issues" while requests wait; the row lights on `/requests` as well as `/issues`.
7. **The profile, Connections, What's new and Support** placements in item 3 above.
8. **The phone breakpoint** in item 1 above.
9. **The video side on phones** in item 8 above.

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
