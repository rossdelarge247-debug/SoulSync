# Handoff log

Decisions and questions between Design and Dev, newest first. Design's entries come from canvas notes and comments; Dev copies them here with the date and artboard.

## Open questions for Design

None open. Questions raised while building go in the log entry that raised them.

## Log

### 2026-10-22: Dev, Automations

Built on `ux/automations` from "Automations v2" (2i–2l), the SafeAction v2 dialog and the 2s/2t failure pattern. The pages are in `webui/src/routes/automations`; Preview a run is `core/automation/dry_run.py`, behind the routes in `CONTRACTS.md`.

**What's built**

- **`/automations`, the list** (2i, 2j):
    - **Header:** "New automation", and a "…" button with Recipes and guides, Build one in the full builder, and (admins) Pause all automations or Resume all automations.
    - **Filters:** All, Needs attention, Yours, Built-in and Paused; a group picker when you have groups; a search box that matches names, schedules and step sentences. The selection, filter, group and search are in the URL (`/automations?automation=12&show=paused`), so back, forward and links work. Old links keep their meaning (`nav=attention|off|system|maintenance|operations|ungrouped|group:X|guides`, `health=failing`, `trigger=`, `action=`).
    - **Cards:** name; schedule line ("Every 6 hours · next at 16:00 · 2 steps"); an On, Paused or Running tag, always with its word; and a last-run line. The selected card adds its steps as numbered sentences and Preview a run, Run now (Resume when paused) and Edit. Its "…" menu has Pause, Run it once now (when paused), Duplicate, Put in a group…, Open in the full builder and Delete…. Built-in automations can't be duplicated, regrouped or deleted. Paused cards show Resume.
    - **Runs panel** (sticky): "31 in 30 days", three numbers (see Differs), the five newest runs tagged Done, Failed, Preview or Skipped, each row opening its log, "Show more", and "All runs in Activity" (`/activity?show=automations`). While the automation runs, a live row at the top streams its log.
    - **States:** loading (skeleton cards and runs), empty ("No automations yet", with New automation and Recipes), no match ("Nothing matches", Show all), failure ("Couldn't load your automations", Try again, Run Setup check) and the paused-automations Notice.
    - **Phone** (2k): cards stack; the selected card's runs collapse to "31 runs in 30 days · last failed yesterday 11:20", which opens them inside the card; "Preview a run" reads "Preview".
- **`/automations/new` and `/automations/<id>/edit`, the editor** (2k, 2l), a full page:
    - Breadcrumb, Name, Group (optional) and Runs: Every…, Daily at…, Weekly…, Monthly… or After something happens (a select on a phone, as 2l). Event triggers keep their conditions (all or any) and signal name. The line under Runs says when the next run is.
    - **Steps as sentences,** with inline selects for the step's real options. Each step's "⋮" has Move up, Move down, Duplicate and Remove; step 1's has Open in the full builder.
    - **Add a step:** Notify, Fire a signal or Run a script, up to three.
    - **Footer:** Cancel, Preview a run and Save. Leaving with unsaved changes asks first. A failed check says "Fix the 2 things marked below, then save." and marks them; a failed save keeps the edits and shows why.
    - **Preview panel** (right, or under the steps on a phone): what a run would do, three numbers, five sample rows ("5 of 35 tracks shown"), a line for each step that wasn't previewed, and "Run this now". Run this now is off while there are unsaved edits, with the reason beside it.
    - Built-in automations: the name, how it starts (on a timer or after an event) and what step 1 does stay as SoulSync set them; the timing, step 1's options and the follow-ups can change.
- **Preview a run** is on the selected card (a dialog) and in the editor (the panel, previewing unsaved edits). It changes nothing and never runs a follow-up step.

**How the boards' steps map onto the engine**

The engine runs one trigger, one action, then up to three follow-ups in order. So:

| Board | Engine |
| --- | --- |
| Runs | The trigger: `schedule`, `daily_time`, `weekly_time`, `monthly_time`, or an event (with conditions, or `signal_received`) |
| Step 1 | The action, with its optional wait (`action_config.delay`, in minutes; Run now skips it). Chosen from every action the engine offers, grouped as on the old builder. |
| Steps 2–4 | `then_actions`, in order: a notification (Discord, Telegram, Pushbullet, ntfy, Gotify or a webhook), fire a signal, or run a script. Each can run every time or "only when…" a condition holds. |

Step 1 can't move: the follow-ups run after the action finishes. Follow-ups reorder with Move up and Move down.

**What a preview can show, per step**

| Step | Preview |
| --- | --- |
| Search for what's due on Wanted | Would search, Waiting to retry, Not out yet, picked by the search's own rules (this turn's albums or singles, retry waits, release dates); the first five tracks |
| Check followed artists | Artists it would check, and how many were never checked. Not available while SoulSync's metadata source isn't ready. |
| Refresh, sync or discover mirrored playlists; the playlist pipeline | The playlists and tracks it would work on |
| Clear the quarantine; Library clean-up | The files and size it would delete for good (the quarantine, and the recycle bin past its keep window) |
| Anything else | "Can't be previewed", with the reason (for Deep Scan and the duplicate cleaner: Run now shows its own list before anything moves) |
| Follow-ups | Never run in a preview; each says so ("A preview doesn't send notifications.") |

A preview of your own automation, or of any as an admin, is kept as a run tagged Preview: at most 20, so they never push real runs out of the 100 kept. Previews are listed and counted with the runs, but left out of the three numbers; on Activity they never hide a failure.

**Run now on steps that move or delete files**

| Step | Run now |
| --- | --- |
| Clear the quarantine | Quarantine preview, then the permanent-delete confirm, then it runs with that plan |
| Library clean-up | The quarantine preview and confirm, then "Next: empty the recycle bin": the preview of what's past the keep window, and its confirm |
| Full Cleanup (music or video) | The quarantine preview and confirm, then "Run the rest of the clean-up". The rest works on the live download queue and runs as before, without a preview. |
| Deep Scan | The Deep Scan preview (with the 25% guard); when it would move nothing, it runs |
| Duplicate cleaner | Opens Maintenance at the duplicate cleaner, where its preview and confirm are |

The "Act without a preview" option (`confirm`) is a checkbox in the editor with that wording, and the card says when it's on. It applies to scheduled runs; Run now always previews.

**Differs from the boards, and why**

- **The selected card stacks its last-run line above the buttons, and the subtitle wraps.** The sidebar leaves a narrower content pane than the boards' 1280.
- **Filters, group picker, search and the "…" menus** aren't on the boards. They hold what the old page could do (table below).
- **The Runs numbers aren't "Found 184".** The Wanted search records only that it started its batches; what they find arrives later and isn't kept on the run. The first number is what the run produced where the action records it (Added to Wanted, Upgrades queued, Moved to the bin, Deleted, Playlists refreshed), else Done; then Failed runs, and Typical (the median time). Wanted run rows say "Started 3 album and 4 track searches · albums turn".
- **"Last 100, since 19 Oct"** replaces "N in 30 days" when the history's 100-run cap cuts the 30 days short.
- **One step does the Wanted search.** The board's "Search Soulseek…", "Download what's found…" and "Tag and file…" are one engine action, which reads "Search for what's due on Wanted, albums and singles in turn". Sources, "prefer users online", the path template and "remove from Wanted once filed" are app-wide settings, not per automation, so the editor doesn't show them.
- **No "Only by hand".** Every automation has a trigger. A paused automation can still be run by hand ("Run it once now").
- **No drag to reorder.** Move up and Move down in each step's menu do it.
- **Add a step offers Notify, Fire a signal and Run a script,** what the engine can run after the action. The board's Search for, Download, Tag and file, Upgrade quality and Tidy up are actions, chosen in step 1.
- **The preview has no "Found now", "Would download 1.1 GB", "32 had no result" or "Full list".** A preview doesn't search, so it can't know those. It shows the counts SoulSync's stored data supports, and the first five items.
- **Runs offers Monthly and After something happens,** engine triggers the boards don't draw. The subtitle says "Rules that run on a schedule or after something happens."
- **"Search for what's due on Wanted" has no category option.** The engine ignores it: the search alternates albums and singles.
- **Notification steps** show their main fields; the rest are under "More settings". "Add to the message" buttons insert the variables, and "Send a test" sends one with sample values.
- **Built-in automations are listed after yours,** with a Built-in filter, rather than in a section of their own.

**Data left out** (nothing in SoulSync to read it from)

- What each Wanted search found, per run.
- A preview's "found now", download size and "had no result": they need a real search.
- Runs older than the 100 kept per automation.

**Kept from the old page, and where it is now**

| Old page | Feature | Where it is now |
| --- | --- | --- |
| Overview | Hero with status and counts | The paused Notice, and the Needs attention filter |
| Overview | Up next | Each card's schedule line ("next at 16:00"); Home's Up next card is unchanged |
| Overview | Attention queue | Needs attention filter |
| Overview | Recently ran | Each card's last-run line, the Runs panel, and Activity |
| Sidebar | All, Needs attention, Switched off, System / Operations / Maintenance, My Automations | Filters: All, Needs attention, Paused, Built-in, Yours. Old `nav=` links map onto them. |
| Sidebar | Scheduled, Event-driven | Dropped as lenses; the search matches schedule words ("daily", "after") |
| Sidebar | Groups, with counts | Group picker; the group's "…" menu has Pause everything in this group (or Turn everything on), Rename this group…, Ungroup (keep the automations) and Delete the group and its automations… |
| Sidebar | Guides & reference (recipes) | "…" → Recipes and guides (`view=guides`); a recipe opens the full builder |
| Sidebar | Master switch | "…" → Pause all automations or Resume all automations (admins), and the paused Notice |
| Filter bar | Text, trigger and action filters | Search box; `trigger=` and `action=` links still filter, with a "Show all" note |
| Card | Runs badge and history dialog | Runs panel, with logs and Show more |
| Card | Editable cadence | Editor → Runs |
| Card | On/off switch | Pause / Resume |
| Card | Duplicate, Move to group, Delete | Card "…" menu (not for built-in automations) |
| Card | Drag onto a group | Card "…" → Put in a group… |
| Card | Live progress and log | Running tag, a "Running now · phase · %" line, and the live row in Runs |
| Card | "Acts without a preview" tag | A note on the card |
| Builder | The vanilla builder | The new editor; "Open in the full builder" stays on the card menu, step 1's menu and the header "…" |
| Builder | Test notification, message variables, per-step conditions, delay, signals, scripts | In the editor (Send a test, Add to the message, "only when…", Wait N minutes, signal fields, script picker) |
| Builder | Personalized pipeline's playlist kinds | Full builder only; step 1 says so |

**Also changed**

- Activity links each automation item to `/automations?automation=<id>`, so "Open this automation" opens that automation (the Activity entry's open point). Preview runs show there as "Automation "X": preview".
- The recycle-bin purge preview takes `{retention: true}` for Library clean-up's second half (`CONTRACTS.md`). The permanent-delete flow can offer a next step when it finishes.
- The scan-watchlist card sentence says "added 1 track to Wanted", not "wishlisted".

**Questions for Design**

1. **Runs numbers for the Wanted search:** Done, Failed runs and Typical, or should the Wanted search start keeping what it found on each run so "Found" can return? That's an engine change.
2. **"Only by hand":** worth a real trigger, or is Paused plus "Run it once now" enough?
3. **Filters, group picker and search:** fine on one row above the cards, or would you place them?
4. **Steps that can't be previewed:** is "can't be previewed, because…" plus Run now's own preview the right answer for Deep Scan and the duplicate cleaner?
5. **Built-in automations:** after yours with a Built-in filter, or a section of their own?
6. **The full builder:** keep "Open in the full builder" for what the editor doesn't cover (pipeline playlist kinds), or plan to retire it?

Screenshots (1440×900 and 390×844: list with a selected automation, a paused card, a run's log, the preview dialog, the file-step confirm, the editor, the editor with a preview, loading and failure), with the board renders beside them, are in the session scratchpad. They aren't in the repo.

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
- The page asks for a `.nav-button[data-page="wanted"]`; the shell's Wanted row has it now, and /wishlist and /watchlist redirect here.

**Questions for Design**

1. **Followed statuses:** is "New release / Not checked yet / Nothing new" the right set, now that Complete and Incomplete can't be known?
2. **Followed hover action:** what should it be without "Want all missing"? It's "Open artist" for now.
3. **Old-look views:** should the nebula and the followed labels/podcasts/audiobook authors be drawn in the new style, or left as they are behind the "…" menu?

Screenshots (1440×900 and 390×844; populated, hover, menu, empty, loading and failure for both tabs), with the board renders beside them, are in the session scratchpad. They aren't in the repo.

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

### 2026-10-21: Dev, navigation shell (Shell A)

Built on `ux/shell-a` from boards 1m (desktop) and 1n (390) in `Nav v2 (Shell A).dc.html`, the handoff README's "Navigation shell", and the design notes. Code: the sidebar, top bar and tab bar markup in `webui/index.html`, behaviour in `webui/src/shell/nav-shell.ts`, the route map in `webui/src/shell/nav-routes.ts`, the look in `webui/static/shell.css`.

**Name.** Ross decided the app keeps the name **SoulSync**: the wordmark reads "SoulSync" and the compact rail's monogram "SS". "Sync.FM" (and "S.FM") from the boards isn't used anywhere; nothing else about naming changed.

What was built:

- **Sidebar**, 256px on `#101010`: the wordmark (with the version as meta text, as the README says) is the button that folds it to the rail; Home, then Get music, Library, Automate and Settings with 12px group labels; 44px rows, 20px icons, the selected row in the accent wash with its border; the middle list scrolls while the bottom block (hairline, "Admin and help", "Switch to Video", the profile) stays pinned. A module that is off removes its row and nothing else moves (the existing module guard).
- **Compact rail**, 72px: icons with their names (and counts) as `title` and `aria-label`, 24px hairlines between groups, counts as 8px dots, "Admin and help" as a 256px popover beside the rail, the "SS" monogram expands it. Compact and the "Admin and help" fold are kept in `localStorage` and applied before first paint. Compact uses the old collapse toggle's key, so anyone who had collapsed the sidebar gets the rail.
- **Top bar**, 64px: back and forward through browser history (each disabled where the browser can say there's nowhere to go), the page name, one search field (⌘K or Ctrl K focuses it; Enter opens Search with the query; on the video side it searches video), and the live "N running" link to Activity.
- **Phone**: a 56px top bar (back, page name, search, Activity with the needs-you dot), a 64px tab bar (Home, Get music, Library, Automate, Settings; no "More"), and bottom sheets with 48px rows. Tapping a tab opens its sheet and tapping it again closes it; Escape or a tap outside closes it too, and focus goes back to the tab. The Settings sheet ends with "Admin and help" (folded the same way), "Switch to Video" and the profile.
- **Live badges**: Activity's needs-you count and the running count come from `GET /api/activity/status`, polled every 30 seconds, paused while the tab is hidden, and refreshed after the app's activity socket events. A 404 or an error counts as unknown: the link says "Activity" with no count and the badge stays hidden, never "0". The Setup check dot comes from the setup check itself (see `CONTRACTS.md`). Wanted shows the wishlist count the sidebar showed before; Discover, Chat and Requests and issues keep their counts.
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
