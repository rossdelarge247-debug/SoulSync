# Handoff log

Decisions and questions between Design and Dev, newest first. Design's entries come from canvas notes and comments; Dev copies them here with the date and artboard.

## Open questions for Design

1. **Home (`Main.dc.html`):** which four targets matter most on Home, and what does each card do when its target isn't set up yet (no mirrored playlists, nobody followed)? Today's prototype assumes all four are in use.
2. **Activity (`Activity.dc.html`):** how far back the timeline goes by default (today, 7 days?), and whether "Needs you" items stay pinned until they're dealt with.
3. **Navigation (`Nav.dc.html`):** should the module pages (Podcasts, Audiobooks, Chat, Sample Studio) sit in their group (Library, Get music) or in their own "More" group when they're on?
4. **Legacy pages:** the Settings page is still the legacy UI. Should redesigned screens wait for their React rebuild, or should we restyle legacy pages to the evolved rules in place?

## Log

### 2026-10-21: Dev, Wanted page

Built on `ux/wanted-page` from the "Wanted v3 (populated)" boards (2a–2d), "Wanted v2 (empty and loading)" (1d–1f), "Wanted (390)" (1g) and the 2s failure pattern (2t for timing). The code is in `webui/src/routes/wanted`.

**What's built**

- `/wanted?tab=wanted|followed` replaces the Wishlist and Watchlist pages:
    - `/wishlist` goes to `/wanted?tab=wanted`, and `/watchlist` to `/wanted?tab=followed`.
    - Old deep links keep their meaning: filter text, the Failing chip (now "Not found yet"), the Audiobooks tab, the Labels/Podcasts/Audiobooks tabs, sort, and an open artist's settings, panel or the global settings. `/audiobooks/wishlist` goes to Audiobooks on Wanted.
- **Header:** the tab's primary action ("Add to Wanted" opens Search; "Follow an artist" opens a provider search with Follow buttons) and a "…" button for the rest.
- **Tabs with counts.**
- **Filters and sort, kept in the URL.**
    - Wanted: All, Searching, Not found yet, Found this week.
    - Followed: All and New release. "Not checked yet", "Checked 30+ days ago" and "Own settings" appear only when they have something in them.
- **The schedule line,** using the real automation name and interval:
    - Wanted: "Next scheduled search in about 2 hours, for albums (Auto-Process Wishlist, every 6 hours). Search now".
    - Followed: "New releases are checked every 24 hours (Auto-Scan Watchlist); the next check is in about 9 hours. Check now".
    - While a search or check runs, the line shows a live status ("Searching now", "Checking now").
    - When automations are paused or the schedule is off, the line says so.
- **Rows:** actions show on hover and focus-within, always on touch. Each row has a "…" menu.
- **Paging:** "6 of 312 · Show 50 more", or "Show all" for the last 50 or fewer. The page number is in the URL.
- **Unfollow asks first:** "SoulSync stops checking X for new releases. The 5 things already on Wanted stay there and keep being searched for. Nothing in your library changes." The artist panel's remove button goes through the same dialog.
- **Loading, empty and failure** per Wanted v2 and 2s. The header and tabs stay. Failures say why (no answer in 10 seconds, or a server problem) and offer Try again and Run Setup check.
- **Phone layout** per 1g and 2c–2d:
    - stacked rows with a "⋮" menu that includes Search now;
    - equal-width tabs;
    - filters that scroll sideways;
    - a short schedule line.

**Differs from the boards, and why**

- **Tabs and filters sit on two rows at 1440.** The sidebar leaves a 1160px content pane, not the boards' 1280.
- **The header has a "…" button.** It holds what the old pages could do that the boards don't draw (list below).
- **Followed statuses are New release, Not checked yet and Nothing new.** The boards' Incomplete and Complete, and "9 of 14 in library", need each artist's full discography, which SoulSync doesn't store. Rows say "9 releases in your library · 5 on Wanted" instead.
- **The Followed row's hover action is "Open artist", not "Want all missing".** There's no discography to diff against. "Settings for this artist…", "About this artist…" and "Unfollow…" are in its menu.
- **Releases with some tracks on Wanted say "2 of 9 tracks wanted"**, not "7 of 9 tracks found". Wanted holds tracks, not releases.
- **No "Change quality" on a row.** Nothing can change a Wanted item's quality profile yet. The row shows the profile's name.
- **Titles aren't links.** "Open artist" is in each row's menu. Found rows have no "Added" date: once found, the track isn't on Wanted any more.
- **Followed artists has a sort control** (Name A–Z, Checked longest ago and so on), like the old page. Phones keep the sort control.
- **The old views keep their old look:** the nebula, Audiobooks on Wanted, the followed labels, podcasts and audiobook authors, the live check details, and the artist settings and panel. They are reached from the "…" menu and aren't redrawn yet.
- **The page no longer jumps to Downloads when a scheduled search starts.** The line says "Searching now" and links to Downloads.

**Data left out** (nothing in SoulSync to read it from)

- **Release totals and complete/incomplete per followed artist,** and "Want all missing".
- **Changing a Wanted item's quality.**
- **"Latest" on a Followed row** comes from the per-artist release cache (`recent_releases`), but nothing in the current code writes that table. In practice rows show "Last found: Album · 2 days ago" from the followed-artist check history instead.
- **"Found this week" ownership.** The removal record has no profile. A find shows for a profile when its library entry lists that profile, or lists no profile at all. Finds without a library entry are left out.

**Kept outside the design, and where it is now**

| Old page | Feature | Where it is now |
| --- | --- | --- |
| Wishlist | Nebula (orbs, moons, per-album and per-artist actions) | "…" → Show as a nebula (`view=nebula`). Sort gives the old Busiest first / Most tries first / A–Z. |
| Wishlist | Dense list view | The Wanted list itself (status tags carry the tries) |
| Wishlist | Filter box | "…" → Find in this list (`q`) |
| Wishlist | Failing chip | Not found yet filter, plus "Try them all on the next search" |
| Wishlist | Next auto-run countdown, albums/singles cycle | Schedule line |
| Wishlist | Run now | Search now on the schedule line |
| Wishlist | Retry profile | "…" → How often to try again… |
| Wishlist | Download all now | "…" → Download everything now… |
| Wishlist | Ignored tracks | "…" → Removed and skipped tracks… |
| Wishlist | Cleanup (in library) | "…" → Remove what's already in your library… |
| Wishlist | Clear all | "…" → Clear Wanted… |
| Wishlist | Audiobooks tab, "Audio plays from the music search", clear audiobook wishlist | "…" → Audiobooks on Wanted (`media=audiobooks`) |
| Wishlist | Per track: search manually, remove; remove album | Row menu (Search by hand…, Remove from Wanted…), and the tracks list under a release |
| Wishlist | Remove a whole artist | Nebula |
| Wishlist | Bulk select | "…" → Select several |
| Watchlist | Add artist (provider search) | Follow an artist |
| Watchlist | Attention tiles: never scanned, stale scans, custom rules | Filters: Not checked yet, Checked 30+ days ago, Own settings (shown when not empty) |
| Watchlist | Fresh releases tile | New release filter. It now comes from the followed-artist check history, not the release cache. |
| Watchlist | Recent releases panel | Each artist's latest cached release is on its row ("Latest: …"). The panel read the same cache, which nothing fills now (see Data left out); there's no "Owned" mark. |
| Watchlist | Artist inspector (watch rules, provider links, cached releases) | About this artist… and Settings for this artist… |
| Watchlist | Audiobook badge on routed artists | Meta line: "Filed in your audiobook library" |
| Watchlist | Include pills, source badges | Settings for this artist… and About this artist… |
| Watchlist | Global settings, override on | "…" → Followed artist settings… (`settings=true`), plus a warning while the override is on |
| Watchlist | Edit rules | Row menu → Settings for this artist… (`configId`) |
| Watchlist | Artist detail panel | Row menu → About this artist… (`detailId`) |
| Watchlist | Scan / Cancel scan | Check now / Stop checking |
| Watchlist | Live scan deck | Show details while checking |
| Watchlist | Last scan summary and track list | Check line, plus "What it found" |
| Watchlist | History, Download Origins, Blocklist | "…" → Check history…, Downloads from followed artists…, Blocklist… |
| Watchlist | Update Similar Artists | "…" → Update similar artists (Check now waits for it) |
| Watchlist | Labels, Podcasts, Audiobooks tabs | "…" → Also followed: Labels / Podcasts / Audiobook authors you follow (`list=`) |
| Watchlist | Select, remove selected, select all visible | "…" → Select several → Unfollow… (asks first) |

**For the navigation shell**

- `isPageAllowed('wanted')` in `static/init.js` is true when the profile may see Wishlist or Watchlist.
- The page asks for a `.nav-button[data-page="wanted"]`. Until the shell has one, it lights the old Wishlist or Watchlist button for the tab in view.

**Questions for Design**

1. **Followed statuses:** is "New release / Not checked yet / Nothing new" the right set, now that Complete and Incomplete can't be known?
2. **Followed hover action:** what should it be without "Want all missing"? It's "Open artist" for now.
3. **Old-look views:** should the nebula and the followed labels/podcasts/audiobook authors be drawn in the new style, or left as they are behind the "…" menu?

Screenshots (1440×900 and 390×844; populated, hover, menu, empty, loading and failure for both tabs), with the board renders beside them, are in the session scratchpad. They aren't in the repo.

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
