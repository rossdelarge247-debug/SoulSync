# Handoff log

Decisions and questions between Design and Dev, newest first. Design's entries come from canvas notes and comments; Dev copies them here with the date and artboard.

## Open questions for Design

Questions 1–28 were answered in Design's session of 22 October, and 29–57 in its evening pass (the README of the hand-off, "Build order for Dev, 22 October evening"). All four phases of that order are built (the log entries "Dev, evening phase 1" to "… phase 4" below say what changed for each); 32, 36 and 51 were the last, built in phase 4. The ones still open are "later" and Dev's questions from the builds; 58 is taken by the Scan now build; new questions start at 83. Answer on the canvas, naming the board, as before.

**Later (Ross: not yet)**
31. The first-run setup flow in the design system.
33. The video side's Wanted.

**From evening phase 1 (no boards)**
59. The web app manifest's `theme_color` is still `#1db954` (the old default accent), which colours an installed app's title bar on some systems. Should it become `#101010`, the tab icon's ground?
60. 9d draws "Visuals V", but in the app V moves to the next visual and F opens the Visuals (the shortcuts list says so). The menu shows F. Right, or should both show?
61. 8a draws Home's phone top bar with the name centred and Search and Activity on the right. The built bar keeps the shell's layout: the name sits where every page's name goes, after the back button, at 17/600 with the wordmark's 0.02em tracking. Centre it on Home only?
62. 8a's note says the tab title is "SYNCHRO.S" on Home and "Wanted · SYNCHRO.S" on inner pages. The tab still reads "SYNCHRO.S - Music Sync & Manager" everywhere (nothing in Phase 1 asked for it, and the video side writes its own subtitle). Build it with the next shell change?

**From evening phase 2 (no boards)**
63. Members have no Settings (it's admins only), so a member picks their accent in My Account, as an "Accent colour" section after Music services, with the same cards, Custom… and preview strip, two cards a row. Admins pick theirs in Settings → Appearance. Right place for members, or should they get a Settings with only Appearance in it?
64. There's no Library → Listening history page yet. The Kind filter (Music / Podcasts / Audiobooks) is on the Stats page's history card, renamed from "Recently Played" to "Listening history" and still in the Stats page's older look; the charts stay music only. Draw Listening history as its own Library page, or keep it as the Stats card?
65. Admins set the install's default with "Make Rose the default" under the cards (it shows only while their own accent differs from the default). Is one button the right size for it, or should the default be its own small select?
66. Station logos: FIP's five stations keep their letters (the only logo found for them is Radio France's, not FIP's), and an admin's link takes its logo only when it's added. Should a link's logo be changeable afterwards (Settings → Radio's links table), and should admins be able to replace a built-in station's logo?
67. In the app, audiobooks play only the store's sample (a few minutes). Their place and plays are kept like a podcast's. Keep that, or leave audiobooks out of Listening history until whole books play?

**From evening phase 3 (Library: Albums, Genres, Artists; boards 7a–7g)**
68. "Albums you don't have" are the releases a metadata service listed for your artists, from SYNCHRO.S's metadata cache, so an artist whose discography was never fetched (never opened, not followed) shows no gaps. Should SYNCHRO.S fetch every library artist's discography in the background (slow, and it spends Spotify's rate limit), offer a "Look for releases you don't have" action, or leave it as is?
69. The old grid's alphabet strip and metadata-source filter ("No Spotify", "Has MusicBrainz") aren't on the boards and are gone (the watchlist chips became Show → Following, "Could be better" Show → Below target). Should the source filter live somewhere (Maintenance, say), or stay gone?
70. A missing album that's on Wanted is drawn with its art and the info tag (7a's Lantern); one that isn't is the empty dashed square, even when the service has its cover. Right, or a faded cover inside the dashed square?
71. 7a draws All plus six genre chips and "31 more" (38 genres); the README says "the top seven". Built as drawn (six, one row at 1440). Confirm.
72. 7g draws no Albums / Genres tabs; the phone keeps them as two equal buttons under the filter, or Genres can't be reached. Draw where they go?
73. The header's "…" (Shuffle your library, Export artists…, Follow every artist you don't follow…) holds the old grid's tools the boards don't place. Right home?
74. Remove from library sends the files to the recycle bin and takes the albums out of the library (a media-server rescan would bring a database-only removal back). The Artist page's Remove from library is database-only. Which should both be?
75. An artist with nothing missing has Play (their top tracks) on hover, as the old grid had; 7f draws only "Add N missing to Wanted". Keep it?

**From evening phase 4 (Follow-ups 9a–9c)**
76. 9a's "Accept any quality for Lantern": nothing can hold a Wanted item to a looser quality yet (no route, and no "any quality" profile to hold it to). Built as Search by hand on the stuck item's most-tried track, where a file below your target can be taken with "Grab anyway" (the existing quality override, one file at a time). Right, or should the button change the item's quality profile (a route, and a profile that takes anything, to draw and build)?
77. 9a's "Why it's stuck" draws "3 users seen with Lantern, all went offline…". SYNCHRO.S keeps one reason per track (the last try's, as written by the download source), not which users a search saw, so the sentence is the tries, which thing, the last reason in the list's words, and when: "14 tries with Lantern: user went offline. Last try 2 hours ago." Right?
78. 9a doesn't draw an artist from Found this week opened. Built: their finds as rows with the success tag ("Found today 14:02"), the meta line "N found this week", and Open artist only (nothing of theirs is on Wanted to search for or remove). Right?
79. 9b's podcast switches don't match what podcasts do: new episodes download straight away (they don't go to Wanted, and nothing keeps "the last 10"), and pruning goes by when an episode downloaded, not whether it was played. Built as "Download new episodes" ("Each new episode downloads when the check (every hour) finds it.") and "Keep every episode" ("Off: each episode is removed a week after it downloads." / "On: episodes stay until you delete them."), writing `auto_download` and `retention_days` (7 or 0). Right words, or should "Keep episodes after listening" exist (the plays from phase 2 could drive it; a backend change)?
80. 9b's "You have 6" is built for authors only (the owned audiobooks in the results). Artist, label and podcast searches don't say what you have: it would take a library lookup per result. Leave them without, or ask Dev for it?
81. 9b names "MusicBrainz and Spotify" as the artist search's source; the artist search asks one service at a time, so the source inside the field is a quiet select (Deezer first, as the old Follow an artist dialog, then Spotify, Apple Music, Discogs, MusicBrainz). Right, or one fixed source (the active metadata source)?
82. 9c draws the whole phone sheet more compactly than the built one (56px logo with the name, Live and "kind · city · quality", a close button, no 200px art, no Scan now). Only the in-place confirm is built; the sheet is still 4j's with Scan now. Should the sheet's head become 9c's?

**Scan now for radio (no board yet)**
58. Scan now was built before it was drawn (log entry "Dev, Scan now for radio"). Please draw the Scan now button and its states properly: where it sits in the bar beside the one action (today a quiet 44px control after Add to Wanted, icon only under 1180px), in the phone sheet (full width under Add, with a result card above it) and as the strip at the foot of the station's Now playing card; Listening… (today "Capturing 10 seconds · 6 s left" with a thin progress bar, then "Identifying… · Asking AudD"); Identified (track, "Found by AudD · Scan now", Add to Wanted or the tag, Done); Not found ("Couldn’t identify this — DJ mixes and talk often can’t be."); Failed (the reason in words: a refused key, no requests left, too many requests, didn't answer); and disabled with its reason (nothing playing; no service set up). Also Settings → Radio's "Scan now services" card (three rows in the order a scan asks them, Test, Remove, this month's requests, the AudD and ACRCloud key fields). Should the result be told apart from what the station itself named, now that both can fill Now playing?

## Log

### 2026-10-23: Dev, slskd rescans its shares after imports

Built on `feat/slskd-rescan` from `integration`. Ross's slskd had shared 0 files for days while SYNCHRO.S downloaded 88 GB into the library. slskd scans its shared folders once, when it starts; it had started with an empty `/music`, never rescanned, and kept sharing nothing as the library grew to 3,627 files. The Soulseek network blocks people who share nothing.

**What changed**

- **After imports, slskd is asked to rescan.** `core/slskd_share_rescan.py`. The import pipeline calls `notify_library_import()` where a file has landed in the library (both successful ends of `core/imports/pipeline.py`'s post-processing, next to `emit_track_downloaded`), and `core/downloads/lifecycle.py` calls it again when an atomic album batch is published out of staging. The note only records the time, so it never slows or fails an import.
- **Debounced on one background thread.** A rescan goes out 2 minutes after the last import in a burst, and never more than 10 minutes after the first, so an album is one rescan and a long Wanted run rescans every 10 minutes. Before asking, SYNCHRO.S reads slskd's state (`GET /api/v0/application`, `shares.scanning`); if a scan is running it doesn't queue another and looks again 30 seconds later. Then `PUT /api/v0/shares`. slskd starts the scan in the background and answers 200 even when one is running, which is why the state is read first.
- **Through the existing slskd client.** `SoulseekClient._make_request` (`get_shared_soulseek_client()`), so the configured URL, API key and timeout apply and no new HTTP path exists. Nothing happens when slskd isn't configured or the setting is off. A failure (slskd down, a refused key) is one WARNING per outage, without the key; the burst is kept and retried 10 minutes later.
- **Startup check, for installs like Ross's.** Once slskd answers (it's asked every 30 seconds for up to 10 minutes), if it shares 0 files (`shares.files`, or the per-share `files` from `GET /api/v0/shares` on older slskd) while the library folder holds an audio file, one rescan is requested. One-shot, in its own thread (`@_deferred_start("slskd share check")`).
- **Setting.** "Rescan slskd's shares after imports", on by default, in Settings → Sources → Soulseek, under the API key: "Keeps what you share on Soulseek up to date with your library. The network blocks people who share nothing." Stored as `soulseek.rescan_shares_after_import`.
- **Activity.** Each rescan adds "Soulseek shares updating" to the activity feed, without a toast.
- **README.** The "share files in slskd" notes now say SYNCHRO.S rescans automatically. slskd still has to share the library folder itself; SYNCHRO.S can only ask it to rescan what it's set to share.

**Not drawn:** the checkbox follows the other Soulseek settings; no board.

**Tests:** `tests/test_slskd_share_rescan.py` (30: bursts coalesce, the ceiling, a scan in progress, the single worker thread on a real clock in under a second, disabled and unconfigured make no calls, the startup check's cases including waiting for slskd and the older share listing, failures swallowed and logged once without the key, the real client's helper used with its key, the wiring and the setting's markup); `tests/test_web_server_import_side_effects.py` lists the new deferred start.


### 2026-10-23: Dev, evening phase 4 (nebula, Follow…, radio sheet confirm)

Built on `ux/evening-4` from `integration`, from Phase 4 of Design's "Build order for Dev, 22 October evening": `Follow-ups (nebula, follow, confirm, record).dc.html` 9a–9c, approved by Ross (9d was built in phase 1). Design's answers 32, 36 and 51 are done and out of the open list. No routes changed: everything goes through routes that were there (`CONTRACTS.md`, "Wanted page" and "Internet radio"). The patterns are in `DESIGN-SYSTEM.md` ("Wanted as a nebula", "Follow… dialog", "A confirm in place"). Code: `webui/src/routes/wanted` (`-wanted.nebula.ts`, `-ui/nebula-view.tsx`, `-wanted.follow.ts`, `-ui/follow-dialog.tsx`), `webui/src/shell/player-radio.ts`, `webui/static/player.css`.

**Per board**

- **9a, Wanted as a nebula (32).** A view toggle beside the Show filters replaces "Show as a nebula" in the "…" menu: two 44px icon buttons, "Show as a list" and "Show as a nebula", each with `aria-pressed`, remembered per browser (`localStorage` `soulsync_wanted_view`; an old `?view=nebula` link still opens it and is remembered). Sort hides in the nebula (it's always busiest first). The field is a 2% quiet card of three columns, `repeat(3, 1fr)`, gap 16, padding 24, the middle one between hairlines, headed at 12px uppercase in the status colours with the 8px dot: "Searching · 17 / Not found yet · 9 / Found this week · 6" (the Show filters' counts, things not artists). Each artist is a 120px button (8px 4px padding, 14px radius, hover wash) with a circle of 96 (5 or more), 72 (2–4) or 56 (1), the artist's photo or album art where there is one, a 26px count badge in the group's colour bottom-right, and the name at 14/500; selected = accent wash and border on the button and a 2px accent-light ring on the circle. Four per column, then "All N artists" (and "Show fewer"). A Show filter keeps the three columns and says what it hides in the other two ("Not shown while Show is on Not found yet."). The line under the toolbar gains 9a's sentence ("Each artist is sized by how much of theirs you're waiting on; the groups are what the searches say."). **The open artist** sits in a 440px column beside the field, sticky at 24px (under the field when the page is too narrow for three 120px columns and the panel, a container query at 940px; a `#141416` bottom sheet with a grabber on a phone): the 48px avatar, the name at 18/600 (it opens the artist), "10 releases · 8 in your library · 2 on Wanted · Following", the 44px close; the warning box "**Why it's stuck:** 14 tries with Lantern: all 3 users seen with it went offline before the download finished. Last try 2 hours ago."; the items as `44px 1fr` rows on a 4% card, stuck first, with the list's tags ("Not found yet · 14 tries", "Searching · 1 try") and "Album · 11 tracks · FLAC or better · added 1 week ago"; then "Search now for both" (filled), "Accept any quality for Lantern" and "Want the 1 other release you're missing" (ghost), and the links "Open artist · Remove both from Wanted". Escape and the close button close it and give the focus back to the artist; the name takes the focus when it opens. Phone: the three groups stack as sideways-scrolling rows of 104px buttons.
- **9b, Follow… (36).** "Follow…" on the Following tab is a primary that opens one 680 dialog, on the kind in view (an empty kind's "Follow a label…" opens it on labels; the empty Following tab's "Follow an artist…" on artists). Title "Follow…" and "New releases or episodes go to Wanted as they come out."; Kind OptionButtons Artist / Label / Podcast / Author (Podcast and Author while their modules are on and the profile may see them); a 48px field with the search icon, the source named inside it ("MusicBrainz", "Apple Podcasts", "Audible · Apple"; for artists a quiet select of the five providers, question 81) and a 44px Clear; radio result rows `20px 44px 1fr auto`, 64px, the art round for artists and authors and square (initials) for labels and podcasts, "by The Quiet Rooms · 48 episodes" as the meta, a followed result a disabled row with the Following tag, the picked row on a 10% accent wash with the accent-light dot. Podcasts add the options card with two Modules switches drawn as 9b (word first, the track right, accent with a white knob). The meta line says when the kind is checked (its automation's interval) and what happens to what's already out, per kind. Footer Cancel / "Follow Quiet Rooms Radio", the primary disabled-neutral with "Pick one from the results" beside it until a pick. Following closes the dialog with "Following Quiet Rooms Radio." and refreshes the tab.
- **9c, the radio sheet's confirm (51).** On the phone sheet in radio mode, switching auto-add on swaps the switch row for a card (4% fill, 12% border, 14px radius, 16px padding): "Add everything NTS 1 plays to Wanted?" at 16/600, "Skips what you have or already want, at your quality target. Stops at 50 a day. Shows in Activity.", three tiles in one row (Identified yesterday 61 / You already have 19 / Would be added 42; 14px labels at 0.62, 22/700 values), then the full-width primary "Turn on auto-add for NTS 1" and "Not now". Not now puts the switch row back, off; Turn on brings it back on with "Auto-add is on for NTS 1." Turning off stays immediate. The station page's ?confirm=auto-add link still works but the sheet no longer goes there.

**Routes used** (none added): Wanted's own reads; `GET /api/library/artist-index?q=` (the panel's numbers and what "Want the N other releases" adds); `POST /api/wishlist/bulk` with `grab` and `skip` (Search now for both, Remove both) and with `action: "add"` and `filter.artist_ids` (Want the N other releases; more than one asks first in Library's confirm, `POST /api/library/releases/summary`); `POST /api/wishlist/inspect` and `/inspect/download` with the quality override (Accept any quality, through Search by hand); `GET /api/watchlist/artists` (photos and Following). Follow…: `POST /api/library/search-service` and `POST /api/watchlist/add`; `POST /api/labels/search` and `POST /api/labels/watchlist/add`; `GET /api/podcasts/search` and `POST /api/podcasts/watchlist/add`; `GET /api/audiobooks/search?type=author` and `POST /api/audiobooks/watchlist`; `GET /api/labels/watchlist`, `/api/podcasts/watchlist`, `/api/audiobooks/watchlist` (what's followed already); `GET /api/automations` and `GET /api/discovery/lookback-period` (the meta line). The sheet: `GET` and `PUT /api/radio/stations/<id>/auto-add`. Each reads the session's profile and keeps its own rules: the bulk add's request rules for a profile without download rights, the podcast follow forcing downloads off for one (the dialog shows the switch off and disabled with "Your profile can't download, so new episodes are counted, not downloaded."), auto-add's download-rights refusal (the card says "Auto-add needs download rights, so it can't be turned on for your profile." with Not now only).

**Decided by Dev (the boards don't show these; redraw where you'd do it differently)**

1. **Upstream's grouping, the page's words.** Upstream filed each artist under its worst track in four zones (rejected, no match, keeps failing, still hunting). 9a's columns are Wanted's three states, so each artist goes under its worst: Not found yet over Searching over Found this week, busiest first (upstream's order), ties by name. The "what went wrong" words are upstream's `describeTrouble`, through the list's `lastTryPhrase`.
2. **Counts:** a column's header counts things in that state (as the Show filters do); an artist's badge counts their things on Wanted (releases or tracks, as the list's rows), or their finds this week for a found-only artist. So an artist filed under Not found yet with one release still searching counts in Searching's header too.
3. **Four artists per column** before "All N artists", as drawn; "Show fewer" folds it back.
4. **Accept any quality** opens Search by hand on the stuck item's most-tried track (question 76); it shows only for something Not found yet and for a profile that can download.
5. **"Want the N other releases"** shows when the library knows the artist and has releases you don't have that aren't on Wanted (`wantable`); one adds at once, more opens Library's Add to Wanted confirm, as Library → Artists does.
6. **Search now** is "Search now for both", "… for all 3" or "Search now" for one; Remove is "Remove both from Wanted" etc. and asks first when it's more than one track, as the list does.
7. **The panel on narrow pages** goes under the field rather than becoming a sheet; only phones get the sheet.
8. **Follow…'s podcast switches** say what podcasts actually do (question 79); a profile without download rights gets the download switch off and disabled with the reason.
9. **"You have N"** only for authors (question 80).
10. **The meta line per kind:** artists "The first check adds what came out in the last 30 days (the discovery lookback setting); after that, only new releases go to Wanted."; labels "Only new releases go to Wanted; its back catalogue stays where it is (its row on the Following tab can ask for it)."; podcasts "The 48 episodes already out stay where they are; open the podcast to download any of them."; authors "Only books that come out from today go to Wanted; the ones already out stay where they are." When the kind's automation is off: "Not checked on a schedule right now; Check now on the Following tab checks it."
11. **Authors** come from an author search's books grouped by their first author, the name match first; following one follows the author (from today, as the Audiobooks page does).
12. **Old pieces:** the Follow an artist dialog and the "Follow…" menu of detours are gone. Upstream's orb components (`routes/wishlist/-ui/wishlist-orb.tsx`, `wishlist-artist-sheet.tsx`) are no longer used by Wanted; they're left in place for upstream syncs, with `nebula-parts.tsx` which the video Wishlist still uses.

**Components**

- `DialogHeader` takes `description` (the sentence under the title, 15px at 72%, 4px below; the dialog's accessible description), and the header, close, body and footer carry `data-slot` names so a dialog drawn to a board can restyle its frame (the Follow… dialog: no header rule, 24px padding, the close without a box, the footer at `16px 24px 24px`). Nothing changes for other dialogs.
- The sheet's confirm card and the Follow… dialog's switch are drawn to the boards in their own styles (`static/player.css`, `follow-dialog.module.css`); the shared `Switch` (the bare 40×24 track) and the radio page's switch are unchanged.

**Questions for Design:** 76–82 in the list above.

**Tests:** vitest: the full suite, 630 files and 11,308 tests, all pass; new `-wanted.nebula.test.ts` (grouping, filing, columns, sizes, the stuck sentence, labels, the remembered view), `-wanted.follow.test.ts` (sources, the four kinds' rows, the meta line), the nebula and Follow… blocks in `routes/wanted/-route.test.tsx` (the toggle and its memory, an old link, the columns, a filter, the panel and its actions through the real routes, Escape and focus; one dialog for four kinds, artist, label, podcast and author follows with their bodies, a profile without download rights, an empty kind), the redrawn nebula in `routes/wishlist/-route.test.tsx`, and the sheet's confirm in `shell/player-radio.test.ts` (the card and its numbers, Turn on, Not now with the focus back, a refusal, no download rights, off at once). `npm run check` has no errors, `tsc --noEmit` and `npm run build` are clean, and the built shell loads in Chromium with no console errors. No Python changed.

**Screenshots** (session scratchpad, not in the repo), 1440×900 and 390×844 beside the board renders (`board-9a`, `board-9b`, `board-9c`): the nebula, open, all artists, a filter, keyboard focus, the toggle, the phone rows and sheet (9a); Follow… on podcasts empty and picked, artists and labels (9b); the radio sheet before, the confirm and on (9c, 390; the sheet is driven by a stand-in session since the sandbox can't play a stream).

### 2026-10-23: Dev, evening phase 3 (Library: Albums, Genres, Artists)

Built on `ux/evening-3` from `integration`, from Phase 3 of Design's "Build order for Dev, 22 October evening": `Library (albums, genres, artists).dc.html` 7a–7g, approved by Ross. The routes and fields are in `CONTRACTS.md` ("Library: Albums, Genres and Artists"); the patterns in `DESIGN-SYSTEM.md` ("The flat grid", "Genre chips", "The genre line", "Selection mode and its bar", "Add to Wanted confirm"). Code: `webui/src/routes/library`, `core/library/release_index.py`, `core/library/bulk_wanted.py`, `api/library_index.py`.

**Per board**

- **7a, Albums** (`/library?view=albums`): the flat grid, six across in the content column at 1440 (four up to 1180px, three on a phone), `gap: 28px 16px`, square art at 6px, the title at 15/500 and one meta line at 14/0.62, each clamped to two lines. Tags only for a state that isn't "you have it": Below quality target (warning), "11 of 12 found" and "Wanted · searching" / "Wanted · not found" (info), Not in your library (neutral) on the empty dashed square. Hover or focus inside: the 44px accent-light Play (it queues the album's tracks) or the secondary Add to Wanted (one album, no confirm; the toast says what happened). The toolbar as drawn: "494 albums · 4,980 tracks · 38 genres · 61 you don't have yet", the 320px filter (titles, artists and genres; a genre name offers "Genre: Ambient" first), Select, the Albums / Genres tabs with counts, Show (All / In your library / Missing / Below target, with counts) and Sort (Recently added · Artist A–Z · Title · Year · Genre; Genre groups the grid under headings), the genre chips and "18 of 494 · Show 50 more". Genre and Show combine, and each one's counts follow the other. The URL holds view, tab, show, genre, sort and the filter; defaults stay out of it.
- **7b, the genre line:** "**Ambient** · 48 albums · 31 in your library · **17 you don't have** · 4 below your quality target", the primary "Add the 17 missing to Wanted" (the confirm) and, for admins, "Upgrade the 4 below target", which applies the Quality Upgrade Finder's pending findings for those albums, as the Apply Quality Upgrades automation does (`POST /api/library/albums/upgrade`; albums with no finding yet are counted in the toast).
- **7c, selection:** Select ↔ Done (selected style, `aria-pressed`); each square a toggle button (`aria-pressed`) with the 28px checkbox and the checked frame; the bar at the foot of the column above the player with "6 albums selected · 49 tracks", "Select all 61 missing" (the current Show filter), "Add 6 to Wanted" (disabled-neutral at zero, "Click albums to select them" beside it), "…" (Follow these artists · Hold to a different quality… · Remove from library…, admins) and Done. Escape and Done clear it; it survives the filter, the genre and the tabs. "Hold to a different quality" picks a quality profile, then the same confirm. "Remove from library" is the Safe action: a preview of every file, "I checked the list", then the files go to the recycle bin and the albums leave the library (`library_album_remove` plan).
- **7d, the confirm:** 680px, "Add 17 albums to Wanted?", Albums / Tracks / Held to, the sentence (what it is, the scheduled search by its name and interval, Activity, undoable), the first four with "4 of 17 · Show all 17", "Also follow these 6 artists…" (off; it counts only the ones not followed yet, and hides when there are none), Cancel / "Add 17 to Wanted". Not a Safe action. The numbers are the server's for exactly the selection. The toast: "Added 15 albums to Wanted · 2 already wanted · 1 you already have" (or "Asked for 15 albums; an admin approves them before anything downloads" for a profile without download rights).
- **7e, Genres:** four columns of 2×2 mosaics (the genre's most-played covers), the name, "212 albums · 180 in your library", "32 you don't have · 11 below quality target" or "All of it in your library"; hover "Add 32 missing to Wanted"; the tile opens Albums with that chip picked; Show All / With gaps; Sort Most albums / Name A–Z; Select picks genres ("Add 49 missing across 3 genres").
- **7f, Artists** (`/library`, its own sidebar row): the same grid with square art, "9 of 14 releases", the Following tag; hover "Add N missing to Wanted" (one adds at once, more asks first); Show All / Following / Incomplete with counts; Sort Name A–Z / Recently added / Most missing; genre chips with artist counts; "Filter by name or genre". It opens the Artist page. Select picks artists for the same bar (Add N missing, Follow these artists, a different quality).
- **7g, phone:** three columns at `gap: 16px 8px`, 24px checkboxes, Show and Genre as two sideways-scrolling rows (the picked chip scrolled into view), the genre line's button full width, no tags on the albums grid, the bar above the tab bar ("2 albums · 19 tracks" · Add to Wanted · "…"), the Albums / Genres tabs as two equal buttons.

**Routes** (`CONTRACTS.md`): `GET /api/library/releases`, `GET /api/library/genres`, `GET /api/library/artist-index`, `POST /api/library/releases/summary`, `POST /api/wishlist/bulk` with `action: "add"` (the route's `grab` / `skip` / `retry` are unchanged), `POST /api/library/artists/follow`, `POST /api/library/albums/upgrade`, `POST /api/library/albums/remove-preview` and `/remove`. All read the acting profile in the caller's library scope; a bulk add goes through `add_to_wishlist_detailed` for that profile, so per-profile Wanted, download rights (requests) and request limits hold.

**Query cost** (seeded libraries, `core/library/release_index.py`): five set-based reads per build, none per album, on existing indexes (no migration needed). 4,000 albums, 43,000 tracks and 10,500 cached releases: a build in about 150 ms, a page in 1–7 ms, "Select all" in about 3 ms. 12,000 albums and 128,000 tracks: about 500 ms and 4–20 ms. The build is cached 30 seconds per profile and library, built once per key at a time, and cleared by these routes' own writes.

**Design's two questions, answered**

- **"Select all": server-side, by filter.** The bar keeps the filter it was pressed under, sends it with the albums unticked since (`exclude_ids`) and any hand picks, and the server resolves it against the whole library. The confirm is counted the same way, so what it says is what's added. Up to 500 albums a call ("That's 1,204 albums. Add up to 500 at a time: pick a genre or an artist to narrow it.").
- **Genre: both.** The album's own genres, which are what the media server read from the files' tags, filled in by SYNCHRO.S's enrichment (Deezer, Last.fm, Discogs, Qobuz, AudioDB, Bandcamp) where the tags had none; an album without any takes its artist's (which adds Spotify's artist genres). A release you don't have takes the metadata service's genres, else its artist's. Folded by case.

**Decided by Dev (the boards don't show these; redraw where you'd do it differently)**

1. **Where "albums you don't have" come from:** the releases a metadata service listed for your artists, from SYNCHRO.S's metadata cache (filled when a discography is fetched: the Artist page, a followed-artist scan, enrichment), albums and EPs only, matched by the source's artist id where the library has one, editions folded against what you have. An artist whose discography hasn't been fetched shows no gaps until it is (question 68).
2. **"Missing" buttons** ("Select all N missing", the genre line's, a genre or artist tile's) add releases you don't have at all and that aren't on Wanted. An album you have part of is added (its missing tracks) only when picked by hand, so the counts beside "17 you don't have" stay honest.
3. **A missing album that's on Wanted** is drawn with its art and the info tag (as 7a's Lantern); one that isn't is the empty dashed square, even when the service has a cover (question 70).
4. **Genre chips:** All plus the six genres with most albums, then "N more ▾", as 7a draws them (the README says "top seven"; seven doesn't fit one row at 1440 with real counts; question 71).
5. **"Tag albums you own"** (the board's tweak) isn't built: owned albums carry no tag.
6. **Tag order:** "11 of 12 found" wins over Below quality target on an album that's both; Below target still counts it.
7. **Genre sort** files each album under one heading: the picked genre, else its first.
8. **One album asks nothing** (a tile's hover); an artist's hover asks when it's more than one album.
9. **Upgrade and Remove from library are admins' tools** (they act on the shared library); members don't see them. Remove acts on the albums you picked that you have, not on a "Select all".
10. **Remove from library = the recycle bin**, not database-only: a media-server scan would otherwise bring the albums straight back (question 74).
11. **An artist with nothing missing** gets Play (their top tracks) on hover, the old grid's button (question 75).
12. **The header's "…"** holds the old grid's Shuffle your library, Export artists… and "Follow every artist you don't follow…" (Watch all unwatched); the 1202 "imported without a match" banner is a warning Notice above the page; the downloads bubbles keep their host (question 73).
13. **Gone with the old grid:** the alphabet strip, the metadata-source filter, the watchlist chips (now Show → Following), "Could be better" (now Show → Below target), page numbers (now Show 50 more) and the provider badges on cards (question 69).
14. **The phone keeps the Albums / Genres tabs** (7g doesn't draw them) so Genres is reachable (question 72).
15. **Following follows on the first source the library has an id for**, the active metadata source first; artists with no id are counted ("not matched on a metadata service yet").
16. **While the selection bar is up,** the floating help, bell and activity buttons move up 80px so they don't cover Done.
17. **The guided tour's anchors** stay on the new controls (`#library-search-input`, `#library-artists-grid`); its alphabet and pagination steps now centre themselves and their copy is the tour's to rewrite.

**Components**

- `Button` size `lg` is padded `0 18px` (was 20): every board draws 18 (`DESIGN-SYSTEM.md`).
- The library's own parts (`routes/library/-ui/parts.tsx`: the filter field with its genre suggestion, genre chips, Show buttons, the bar) follow the board's values; the shared `StatusTag`, `Select`, dialog and Safe action dialog matched the boards as they are.

**Also fixed:** `shell.js` stopped at load with "process is not defined": `features/spotify-pause/spotify-pause.ts` (which the shell imports) carried a React hook, and the shell's library-mode build leaves React's `process.env.NODE_ENV` check in. On `integration` the sidebar never lit the current row and the top bar said "Home" everywhere. The unused hook moved to `use-spotify-pause.ts`, and `src/shell/no-react.test.ts` walks the shell's imports and fails on any React import.

**Questions for Design:** 68–75 in the list above.

**Tests:** Python: `tests/library/test_release_index.py` (29: states, the cache, editions, namesakes, sources, scope, Wanted per profile, genres and their counts, sorts, paging, the genre line, tiles, artists, selections, one build per key) and `tests/library/test_library_bulk_wanted.py` (20: added / already wanted / already have / failed / refused, quality and profile kept, the routes, filters with exclusions, too many, members and download rights, follow, upgrade, Remove from library's preview and confirm, admin gating), with the library, wishlist, watchlist, quality, admin-gating, database-upgrade and file-reading tests: 5,090 tests, all pass; `ruff check` is clean. Vitest: the full suite, 628 files and 11,276 tests, all pass (the one failure in the first run, the token test catching `--ss-player-h` in the library's CSS, is fixed and the suite re-run); new `-library.grid.test.ts`, `-ui/library-page.test.tsx` (Albums, the genre line and confirm, selection, Genres, Artists through the real router) and `-route.test.tsx`. `npm run check` has no errors, `tsc --noEmit` and `npm run build` are clean.

**Screenshots** (session scratchpad, not in the repo), 1440×900 and 390×844, beside the board renders: Albums (7a), its hover Play and Add to Wanted, Genre sort, the "Genre: Ambient" suggestion and "N more"; Ambient with the genre line (7b); selection empty, with picks, after "Select all", and its menu (7c); the confirm and Show all (7d); Genres, hover and selecting (7e); Artists and hover (7f); the phone (7g); Remove from library and the quality picker.

### 2026-10-23: Dev, Spotify rate limits

Built on `fix/spotify-rate-limit` from `integration`. Ross saw "Rate limit detected on get_artist_albums - no Retry-After header, using 14400s default", then "GLOBAL RATE LIMIT ACTIVATED: 14400s ban": one 429 bought a four-hour pause, and the UI said "banned for 4 hours", which looked stuck.

**The cause.** Spotify did send Retry-After; SYNCHRO.S never saw it. spotipy 2.26.0 builds its session with urllib3 `Retry(total=retries, status=status_retries, status_forcelist=(429, 500, 502, 503, 504))`. `core/spotify_client.py` passed `retries=0`, but urllib3's `Retry.is_retry` checks `status_forcelist` before `total`, so a 429 still counts as retryable, the zero budget is exhausted at once and urllib3 raises `MaxRetryError`. spotipy turns that into `SpotifyException(429, "… Max Retries")` with no headers (`spotipy/client.py`, the `RetryError` branch), and `_detect_and_set_rate_limit` mapped "max retries" to `_BASE_MAX_RETRIES_BAN = 14400`. The decorator did the same after five retries. A test against a local server reproduces both halves.

**What changed**

- **The real Retry-After.** Every official client is built by `make_spotipy_client()`: a requests session whose adapter never retries (`HTTPAdapter(max_retries=0)`, no forcelist), `retries=0`, `status_retries=0`. A 429 reaches us as an HTTP error carrying `Retry-After`; `retry_after_from_exception()` reads it (seconds or an HTTP date, from `.headers`, `.response.headers` or the cause chain). Used by the main client, the auth probe and the per-profile clients (`core/metadata/registry.py`). Spotify's time is obeyed exactly, however long.
- **Guesses when there's no header.** 10 minutes first, doubling for each repeat within an hour of the previous pause ending, 4 hours at most (`estimated_pause_seconds`). Requests already in flight when a pause starts don't escalate it. The decorator retries a header-less 429 once after ~5 s, then estimates; a short Retry-After is slept through up to three times, then estimated. No more flat 4 hours.
- **After a pause.** Background jobs (no Flask request on the thread) keep waiting for a cooldown as long as the pause, between 1 and 30 minutes; a person's own request may go ahead at once. Then, for 15 minutes, calls are spaced 2 s apart easing back to normal, with random jitter, so a backlog trickles instead of firing together. The enrichment worker already slept through the pause and cooldown; its status now carries `post_ban_cooldown`. The watchlist scan and the enrichment worker name themselves (`spotify_feature`), so a pause they trigger says so.
- **Try again now** (admins): `POST /api/spotify/rate-limit/clear` clears the local pause, keeping the estimate's history so a repeat comes back longer.
- **What people see.** One set of words (`src/features/spotify-pause/spotify-pause.ts`), counting down live: "Spotify asked us to wait 12 min (after checking an artist's albums)" with "That time came from Spotify", or "Paused Spotify for 10 min to be safe (after …)" with "Spotify didn't say how long to wait, so this is SYNCHRO.S's estimate." After the pause: "Spotify is back. Background jobs wait 5 min more". Home's alert (a note, not a live region, since it ticks), the rate-limit modal (now "Spotify is paused": time left, how long and whose number, what we were doing), Settings → Connections' Spotify card (a tag in its header and a warning box in its body) and the enrichment chip ("Paused by Spotify" / "Paused to be safe" / "Easing back in"). Admins get "Try again now" with "Clears SYNCHRO.S's pause. If Spotify is still limiting, the pause comes back." beside it.
- Nothing evades Spotify's limits: no extra keys or apps, only obeying them accurately.

**Contracts:** new `source`, `trigger`, `feature`, `estimate_step` in `rate_limit`; `post_ban_cooldown` in the worker status; the clear route (CONTRACTS.md, "Spotify pause").

**Not drawn yet:** the modal, the Settings box and Home's Try again now follow the design system's attention box and buttons but have no board. Please draw the Spotify pause's states (paused by Spotify, paused on our estimate, easing back in, member vs admin) if you'd change them.

**Tests:** `tests/test_spotify_rate_limit.py` (38: spotipy against a local server with and without the fix, header extraction for 429 with and without a header and `MaxRetryError`, the ladder, stragglers, Try again now's history, the post-pause pacing and jitter, background vs interactive in the cooldown, the decorator, trigger words, the worker pausing); vitest `spotify-pause.test.ts`, the alerts band's live countdown and Try again now, and the updated services, alerts and enrichment-chip tests.

### 2026-10-22: Dev, evening phase 2 (per-profile accent, spoken-word progress, AI usage per profile, station logos)

Built on `ux/evening-2` from `integration`, from Phase 2 of Design's "Build order for Dev, 22 October evening" (approved by Ross): Design's answers 35, 39, 46 and 55, and board 5f for the Appearance card. The routes and fields are in `CONTRACTS.md` ("Accent per profile", "The Assistant", "The player", "Internet radio"); the patterns in `DESIGN-SYSTEM.md` ("Colour", "Station card", "Kind filter on a history list", "Usage by profile").

**Per answer**

- **35, accent per profile (5f).** Each profile picks its own accent; the install's accent (what an admin chose before) is the default for profiles that haven't. New column `profiles.accent_color` (NULL on upgrade for everyone, so nobody's colour changes), read and written by `GET`/`PUT /api/profiles/me/appearance`, the session's own profile only, with the same 4.5:1 check as the cards. The page shell paints the viewing profile's accent in its first paint and `init.js` applies that (`window._initialAccent`) instead of the colour the browser kept last, which could be another profile's; the install's accent no longer overrides it after Settings loads. Settings → Appearance keeps "Yours only; each profile picks its own" and drops "It applies to everyone using this SYNCHRO.S"; the cards save the profile's pick, "The default" marks the install's accent, a meta line says whose colour it is ("Yours: Rose. Profiles that haven't picked their own use Lilac." with "Use the default, Lilac"), and the preview strip shows the profile's pick ("With Rose, yours"). **The install default (admins):** one line under the cards on a hairline, "Default for profiles that haven't picked: Lilac." with **"Make Rose the default"** while the admin's own accent differs; it writes Settings' form as before and the page autosaves. Contrast and nearest preset (`accent.ts`) apply to both. Members get the same picker in My Account (question 63); Home's quick swatches save the profile's pick too. Code: `src/shell/appearance.ts` (`mountAccentPicker`), `src/features/settings/profile-accent.ts`, `core/ui_appearance.py`, `api/user_profiles.py`, `web_server.py`.
- **46, podcast and audiobook progress and plays.** The player keeps where each profile got to in an episode or an audiobook (new table `media_progress`): saved every 15 s while it plays, on pause, at the end, when another item takes over and when the page closes; playing it again starts there, with a toast "Picking up where you left off, at 12:34". Within the last 5% (between 10 s and a minute) it's finished and starts from the top. A play is logged after 10 s (new table `media_plays`, one play per half hour per item). Both are apart from `listening_history`, so Stats, smart radio, the history importers and Last.fm / ListenBrainz scrobbling stay music only (a test checks no episode reaches `/api/library/log-play`). **Library → Listening history** (the Stats page's history card, question 64) has the Kind filter, Music first and selected; Podcasts and Audiobooks list the profile's plays with "show · 23 min left" or "Finished" and play from where you left off. The player's Recent (`GET /api/player/recent`) shows every kind, each item with a `kind`. A podcast show's episode rows say "• 23 MIN LEFT" or "• PLAYED" and the play pill "Resume · 23 min left". Routes: `GET`/`PUT`/`POST /api/player/progress`, `POST /api/player/progress/lookup`, `GET`/`POST /api/player/plays`. Code: `core/playback/spoken.py`, `api/player.py`, `static/media-player.js`, `src/routes/stats/-ui/listening-history.tsx`, `src/features/playback/spoken-progress.ts`.
- **39, AI usage per profile.** Every Assistant request is now also counted for the profile that asked (new table `ai_usage_profiles`, month and profile). With Who can use it on everyone, Settings → AI shows "By profile" under the install total: profile, requests, estimated cost, most expensive first, and a "Not counted per profile" row for what the total holds beyond them (requests from before this release, or a deleted profile's), so the rows add up. Admins only (`usage.profiles` in `GET /api/ai/settings`); the cap stays one figure.
- **55, real station logos.** 20 of the 25 built-in stations have an https `logo_url` in `stations.json`, each with a `logo_source` note: SomaFM's from its channel list's 256px logos (`api.somafm.com/logos/256/<channel>256.png`), and for dublab, Worldwide FM, KEXP, NTS, Radio Paradise, Jazz24 and WWOZ the site's own touch icon (`/apple-touch-icon.png`). None could be fetched from the sandbox, so every one is unverified; a wrong one just shows the letters. FIP's five have none (question 66). Directory stations use Radio Browser's `favicon`. "Add a stream link" has an optional "Logo address" (admins; new column `radio_links.logo_url`), checked like the stream link and fetched once before the link is added. The server fetches and caches every logo and serves it as `GET /api/radio/stations/<id>/logo`; the station shape's `logo_url` is that path now, never the station's host. The tile shows the letters while the logo loads and when there's none, and the logo fades in over them.

**Decided by Dev (the boards don't show these; redraw where you'd do it differently)**

1. **Where members pick:** My Account, since Settings is admins only (question 63).
2. **"The default" on the cards** now marks the install's accent (what you get without a pick), not Lilac as such; on a fresh install they're the same.
3. **Picking the default's own card** makes it your pick (you keep it if the default changes later); "Use the default" goes back to following it.
4. **A custom colour** is shown as you type and saved when typing pauses (450 ms), or at once on Enter or leaving the field.
5. **Listening history is the Stats card** (question 64), renamed "Listening history"; the Kind filter is OptionButtons with a 12px "Kind" label.
6. **Finished** = the player's end, or within the last 5% (10 s to a minute); a finished item starts from the top. Under 5 s in isn't worth resuming.
7. **Resume says so** in a toast, since the player otherwise starts at a time the person didn't choose.
8. **Audiobook samples** keep their place and plays like episodes (question 67); the audiobook pages don't show it.
9. **"Not counted per profile"** keeps the per-profile rows honest against the total for the month this release lands in.
10. **Logo fallbacks:** a guessed touch icon rather than nothing, where the station's own site is the only source found; FIP left out rather than show Radio France's logo.
11. **Logo limits:** PNG, JPEG, GIF, WebP and ICO only (never SVG), 512 KB and 4096 px at most, a 16 MB cache kept a week, a failed logo left alone for six hours.

**Questions for Design:** 63–67 in the list above.

**Tests:** vitest: the full suite, 627 files and 11,327 tests: all pass but one, a Following-tab test that reads "followed 10 minutes ago" against the clock and missed by a minute under the load of the full run (it passes on its own with the rest of `routes/wanted`, and nothing here touches it); new tests for the picker in Settings and My Account, the install default, refusals and the custom check (`src/shell/appearance.test.ts`), Listening history's Kind filter (`routes/stats/-ui/listening-history.test.tsx`), the player's progress, resume and plays in `media-player.js` (`src/test/media-player-spoken.test.ts`), Recent with an episode (`player.test.ts`), the progress words (`player-state.test.ts`), the per-profile usage table (`ai-settings.test.ts`), the logo tile (`routes/radio/-ui/station-logo.test.tsx`) and the dialog's logo field (`routes/radio/-route.test.tsx`). `npm run check` has no errors, `tsc --noEmit` and `npm run build` are clean. Python: `tests/test_profile_accent.py`, `tests/playback/test_spoken_word.py`, `tests/ai/test_ai_usage_profiles.py`, `tests/internet_radio/test_logos.py`, and the related and file-reading tests (profiles, appearance, podcasts, audiobooks, listening and stats, AI, radio, admin gating, database upgrades from old releases), 240 files and 6,511 tests: all pass; `ruff check` is clean.

**Screenshots** (session scratchpad, not in the repo), 1440×900 and 390×844: Settings → Appearance following the default and with the admin's own pick (with "Make Rose the default"), a member's Home in their own Teal from the first paint and their My Account accent section, Settings → AI's usage by profile, Listening history on Music, Podcasts and Audiobooks, the radio home with logos (stand-in images written into the cache, since the sandbox can't reach the stations; FIP shows its letters) and Add a stream link with the logo field.

### 2026-10-22: Dev, evening phase 1 (the name and the small answers)

Built on `ux/evening-1` from `integration`, from Phase 1 of Design's "Build order for Dev, 22 October evening" (approved by Ross): the boards `Wordmark (SYNCHRO.S)` (8a) and `Follow-ups (nebula, follow, confirm, record)` (9d), and Design's answers to 29–57 where there's no board. No routes changed.

**Per answer**

- **57, the name (8a).** The sidebar's wordmark is plain text "SYNCHRO.S" in the system stack at 18/700 with 0.02em tracking, white, the dot a full stop (still `aria-label="SYNCHRO.S"`), the version in meta beside it; the row is still the compact-mode toggle with the chevrons at its right edge. The rail's monogram is a single "S" at 18/700 in the 48×44 button (no box around it any more). On a phone, Home's top bar shows "SYNCHRO.S" at 17/600 with the same tracking where the page name goes; every other page keeps its name, and wide screens keep "Home". `favicon.png`, `pwa-icon-192.png` and `pwa-icon-512.png` are redrawn as the white "S" on `#101010`, its glyph 18% of the tile's height in from top and bottom, at the same filenames and sizes. "Support SoulSync" left Admin and help; the Help page has "Support upstream SoulSync" pinned to the foot of its docs sidebar, opening the same modal (`showSupportModal()`). Code: `index.html`, `static/shell.css`, `static/docs.css`, `src/shell/nav-shell.ts` (`APP_NAME` in `nav-routes.ts`).
- **30, Downloads.** `/active-downloads` (music and video) restyled through CSS only, as the last section of `static/downloads-premier.css`: the Music / Video switch and the count chips as OptionButtons (44px, 10px radius, 16% border, the selected wash), Button-sized controls (44px; the primary in accent-light with dark text; disabled neutral, never faded), tabs at 44px and 15/600 with an accent-light underline, 15/14 type, Wanted's row grid (72px rows, 12px 24px padding, 48px art at 6px), tags and states as StatusTags (colour at 12%, 8px dot, 6px radius, 14/600), the card wash on lists and the live strip, no gradient strip and no blurred art behind group heads. Nothing moved.
- **37.** On a phone the Assistant sheet's header has New chat as a 44px icon button (the new-message glyph, `aria-label="New chat"`) between the title and close. The list's and the editor's panels keep the labelled button.
- **38.** A draft card has a Name row: "Morning Wanted search (you can change it)" for a new automation, "Keeps your name" for one that exists (the editor of a saved automation, or a draft with an `automation_id`). Putting a draft in a new automation's editor fills the Name only when it's empty; a name you typed stays. An existing automation's name and group never change.
- **40.** In the block editor, choosing Ask the Assistant from the "/" menu with words after "/" sends "Add a follow-up that …" at once (the panel opens on the answer, "from the / line"); a bare "/" opens the panel with "Add a follow-up that " in the box.
- **44.** A queued library track whose details say it's below your target shows its format in `#fbbf24` on the row's meta line ("Saltmarsh · MP3 320"). The details come from the player's `GET /api/library/tracks/<id>/details`, asked only for rows that come into view (an IntersectionObserver), once per track per session; a redrawn queue is marked again from what's known. Code: `src/shell/player-queue-quality.ts`.
- **47, the record (9d).** The quality line is the tag with Open album beside it; under it a control row: Add to playlist (44px outlined icon, hidden when the track can't go on a playlist), Sleep timer (icon only while off; the icon and the time left in tabular figures, "23 min" or "End of track", in the selected style while it runs; it opens its choices in a small menu) and "…" at the right end. The "…" menu is 280px on `#141416` with a 14px radius and the popover shadow, grouped under 12px headings: Playback (Crossfade · 4 s, Speed · 1.0×, Equalizer · Flat, A–B loop, Add similar tracks when the queue ends · Off), Show (Lyrics, Track details, Visuals `F`, Keyboard shortcuts `?`), Queue (Clear played tracks, Download missing queue tracks, Stop and clear the queue), a hairline, Player settings and Report a problem. Every action of the old menu is still reachable (the player's test lists them).
- **49.** The radio bar's Live tag moved into the left button, beside the station's name; the level meter stays in the centre.
- **53.** A station without a now-playing feed carries the neutral tag "Identified while you listen" on its station card (its own row under the name) and on the auto-add card's heading row; the card's sentence stays.
- **54.** Settings → Radio has one meta line under the relay select: "Each relayed station holds one of the server's 8 threads; two at a time."
- **56.** An NTS station with no tracklists yet says "No tracklists yet. They appear after SYNCHRO.S sees a show on NTS live. Until then, nts.live has them." with the link to https://www.nts.live. Other stations keep their sentence.
- **No change, as answered:** 29 (the "Finish setting up" card stays under Latest), 34 (the two Following tags), 41 (the full-width tray), 42 (no Clear on Recent), 43 (no visual in the bar or tray), 45 (the phone sheet's Up next / Recent), 48 (no bar while nothing plays), 50 (Stop, no Pause, on radio), 52 (Heard per profile; "Identified yesterday" counts anyone's).

**Decided by Dev (the boards don't show these; redraw where you'd do it differently)**

1. **Visuals shows `F`, not `V`:** F opens the Visuals; V moves to the next visual (question 60).
2. **Menu values:** Crossfade shows its length while on and "Off" while off; Equalizer the preset's name while on, "Off" while off; Add similar tracks "On" / "Off"; A–B loop keeps the state it showed before. Rows with a value no longer show the "On" badge. Download missing queue tracks has no value on the board, so it keeps the badge while on.
3. **Speed** stays an expanding list inside the menu; the spoken-word "1.2×" button keeps its own picker.
4. **Menu rows** follow 9d: primary white at 15/400 with 12px padding (they were 86% white at 15/500). Report a problem lost its "…", as on the board.
5. **The record's gaps** are 10px (14 before) and the readout's padding 8/12, so the control row fits the 360px tray at 1440 and 1180.
6. **"/" with words, before the first-use note:** the panel opens with the words in the box instead of sending, so nothing reaches the provider before the person has read what goes there.
7. **The Help row** is pinned to the foot of the docs sidebar (it sat after the whole index, out of sight).
8. **The below-target colour** comes with words for a screen reader (" · below your quality target") and a title, since colour alone isn't a status.
9. **The tab and app icons** keep their sizes, the favicon's odd 314×341 included; the manifest's `theme_color` is unchanged (question 59).
10. **Downloads:** the review and client sub-pages' own pieces that the answer didn't name (detail sheet, compare panel, selection bar) keep upstream's look beyond what the shared classes changed.

**Questions for Design:** 59–62 in the list above.

**Tests:** vitest: the full suite, 620 files and 11,285 tests, all pass; new tests for the wordmark and monogram, the Help row, the phone Home name (`nav-shell.test.ts`), the Downloads restyle (`src/test/downloads-restyle.test.ts`), the Assistant's phone New chat, the draft's name and the "/" line (`routes/automations/-route.test.tsx`), the record's control row, Sleep timer, the grouped menu and its values, Live beside the station (`player.test.ts`, `player-state.test.ts`), the queue's below-target marking (`player-queue-quality.test.ts`), the radio tag and NTS's empty state (`routes/radio/-route.test.tsx`) and the relay line (`radio-settings.test.ts`). `npm run check` has no errors, `tsc --noEmit` and `npm run build` are clean. Python: `tests/test_sidebar_collapse.py` (the monogram) and the 95 test files that read the web files changed: 2,337 pass; `ruff check` is clean.

**Screenshots** (in the session scratchpad; not in the repo; the boards' renders beside them in `boards/`), 1440×900 unless noted: the sidebar head (cropped), the rail (cropped), the phone top bar on Home (390, cropped), Help with the support row (and 390 with the docs drawer open), the support modal from Help, Downloads (and 390), the record, the record's menu, the Sleep timer running with its choices, the phone sheet and its menu (390), the radio bar with Live beside the station and the station cards, a station without a feed (the auto-add tag), NTS's empty tracklists, Settings → Radio's relay line, the radio home (390), the Assistant sheet with the New chat icon (390), the list panel with a draft for a new automation, the editor with "Keeps your name", and the "/" line with words typed.

### 2026-10-22: Dev, Scan now for radio

Ross approved an on-demand **Scan now** for Internet radio: AcoustID first (free, already set up), then a paid service, AudD and/or ACRCloud, only when an admin has added that service's key in Settings → Radio. Built on `ux/radio-scan` from `integration`, before Design drew it (question 58). The routes are in `CONTRACTS.md`, "Internet radio" → Scan now; the pattern is in `DESIGN-SYSTEM.md`, "Scan now".

**What's built**

- **Scan now** in three places: the bar in radio mode (after the one action), the phone sheet (full width, with a result card) and a strip at the foot of the station page's Now playing card. The phone's mini bar says "scanning…" and then what was found.
- **States:** Listening… (a live region with the seconds left and a thin progress bar, then "Identifying… · Asking AudD"), Identified (the track, which service found it, Add to Wanted or In your library / On Wanted / Upgrade via Wanted, and Done), Not found ("Couldn’t identify this — DJ mixes and talk often can’t be."), Failed (the service's problem in plain words). Disabled with its reason when nothing plays or no identification service is set up (and while identification is off). Each change is also announced in the player's live region.
- **Capture on the server, never a microphone.** When the station is already relayed (for anyone), the scan rides on that relay: the relay copies what it passes on into the scan's buffer, so no second listener connection is opened and the relay never waits on the scan. For a direct-mode session (or a relay that ends mid-scan) the server opens one short read of the same stream the session plays: built-in, directory or admin-link stations only, the same audio-only gate and address guard as the relay, capped at 3 MB and 16 seconds. Ogg and FLAC streams carry their headers only at the start, so a tap adds the first audio the relay passed on, and falls back to one direct read if the clip still can't be decoded. ffmpeg makes ten seconds of mono 16 kHz WAV in a temporary folder that's always removed.
- **The chain:** AcoustID (fpcalc and the AcoustID key; skipped without them), then AudD (`radio.audd_api_token`), then ACRCloud (`radio.acrcloud_host`, `access_key`, `access_secret`). It stops at the first confident match: AcoustID 0.7 or more (the rule the automatic fingerprint uses), ACRCloud a score of 70 out of 100, AudD a named result (its standard answer has no score). A service that errors doesn't stop the next.
- **What a match does,** as other identifications: a Heard on radio row for the person who pressed, with `source` `scan_acoustid` / `scan_audd` / `scan_acrcloud` (Heard and now playing say "Found by AudD (Scan now)"), the library, Wanted and quality-target check, now playing for everyone on the station, and the `radio_track_heard` trigger.
- **Settings → Radio** gains a "Scan now services" card: AcoustID, AudD and ACRCloud in the order a scan asks them, whether each is ready, this month's requests and how many found the track, a Test each, Remove for the paid ones, and write-only fields for the AudD token and ACRCloud's host, access key and access secret. It says the paid services are asked only when someone presses Scan now.

**Decided by Dev (redraw where you'd do it differently)**

1. **Paid services run only on a press.** The automatic identification (feed, stream titles, the periodic fingerprint) and auto-add never call them, and a scan never sets off auto-add, even when AcoustID found it: auto-add stays with what the station and the free fingerprint name on their own.
2. **Limits:** one scan at a time per profile, three a minute per profile, two at once across the server (the server runs one worker with 8 threads; scans have two threads of their own and never use a request's or a relay's). Admins see each service's requests this month in Settings → Radio.
3. **Keys are write-only:** Settings → Radio is only told whether each key is set (AcoustID keeps its masked hint, as before). The ACRCloud host must be a name under `acrcloud.com`; anything else isn't saved.
4. **Tests:** AcoustID's is a free key check. AudD's and ACRCloud's send one second of silence, which uses one request of the account's allowance; the Test button says so and the request is counted.
5. **A scan's answer fills Now playing for everyone on the station,** and a station feed that says "a show" doesn't undo it for four minutes; the next track the station names replaces it as usual.
6. **The answer stays until Done,** Stop, another station or the next scan; it isn't cleared by a timer.
7. **Members can scan** (anyone who can listen); only admins see settings and run Tests.
8. **What the providers say** was mapped from their documented answers as known when this was built: the sandbox couldn't reach AudD's or ACRCloud's documentation or APIs, so error codes (AudD 900 / 901 / 902, ACRCloud 1001 / 2004 / 3001 / 3003 / 3014 / 3015) and the request shapes want a check with real keys.

**Questions for Design** (58 in the list above)

**Tests:** Python: `tests/internet_radio/test_scan.py` (73: the chain's order and stopping at the first match, each service's answers and errors, the ACRCloud host check, keys kept out of every answer, settings read and log, encrypted at rest, the limits, members and admins, the module switch, the capture caps, temporary files, and a scan never running on a relay's thread), the rest of `tests/internet_radio`, the admin gating, settings redaction, config, schema and debug-info tests, and every test that reads the web files changed: all pass; `ruff check` is clean. Web: new tests for the words, the session, the player and sheet, the station strip and Settings → Radio; the full vitest run passes; `npm run check` has no errors, `tsc --noEmit` and `npm run build` are clean.

**Screenshots** (session scratchpad, not in the repo), 1440×900: the station playing with Scan now ready, Listening…, Identifying…, Identified, Not found, Failed, no service set up, not playing, and Settings → Radio's Scan now services; 390×844: the station page listening, the phone sheet listening and identified, and Settings → Radio.

### 2026-10-22: Dev, the visuals work again

Ross: the Visuals were "just a black screen" after choosing a visual. Built on `fix/visuals` from `integration`.

**The cause.** Choosing "Off" hides the visuals canvas (`#np-v2-bg` gets `display: none`), and the visual you choose is remembered. Only `npv2SetBgOn` showed the canvas again (`static/media-player-v2.js`). Choosing a visual (`npv2SetTheme`) never did, and neither did opening the Visuals, which swaps a remembered Off for Aurora. Before build (c), the theater's "Animated background" switch called `npv2SetBgOn` and so showed it again, and the theater had the cover and glow behind it anyway. The player rebuild removed that switch and made the overlay plain black (`#000`), so with Off remembered, every visual drew onto a hidden canvas. The audio side was fine: the analyser was connected and returning data, the AudioContext was running and the canvas was full size.

**The fix.** `npv2SyncBgCanvas()` shows the canvas whenever the background is on and the visual isn't Off. `npv2SetBgOn` and `npv2SetTheme` both call it, so choosing a visual always shows the canvas and choosing Off hides it. Tests in `src/test/media-player-v2.test.ts` ("the visuals canvas follows the picked visual") fail without the fix.

**Checked in the running app at 1440 with a track playing:** the Visuals open from "…" and from F, and all 18 visuals draw, including after a remembered Off or a saved-off background. In Motion and effects, every sidebar visualizer type works, and so do particles, Reduce visual effects and Max performance. The worker orbs are the same as before build (c), and the waveform is drawn from the track's peaks. Seen but left alone: while a panel is open it covers the header's ‹ › arrows, so you choose visuals from the panel's grid.

### 2026-10-22: Dev, the app is named SYNCHRO.S

Ross decided the app is displayed as **SYNCHRO.S**, written exactly that way everywhere: all capitals with the dot, in the wordmark and inside sentences alike. Built on `ux/rename-synchros` from `integration`. Only what a person sees changed.

**What changed**

- **The shell:** the sidebar wordmark reads "SYNCHRO.S" (with `aria-label="SYNCHRO.S"`), the browser tab's title is "SYNCHRO.S - Music Sync & Manager", the top bar's fallback page name is SYNCHRO.S, and the web app manifest's `name` and `short_name` are SYNCHRO.S. The lock screen says "SYNCHRO.S is Locked" / "Sign in to SYNCHRO.S"; the invite pages say "You're invited to SYNCHRO.S" and "Go to SYNCHRO.S".
- **First-run setup** (`src/features/onboarding`): "Welcome to SYNCHRO.S", "Set up SYNCHRO.S", "Restore from a SYNCHRO.S backup", "What will you use SYNCHRO.S for?", "SYNCHRO.S is ready", "Open SYNCHRO.S" and every step's sentences.
- **Sentences in React and the legacy pages:** empty states, errors and confirmations ("SYNCHRO.S searches for them on a schedule", "SYNCHRO.S didn't answer", "SYNCHRO.S stops checking …"), source and server labels (the SYNCHRO.S library, SYNCHRO.S Discovery, the SYNCHRO.S chip on Downloads), the welcome tour ("Tour of SYNCHRO.S", "Welcome to SYNCHRO.S"), helper text, What's new ("What's New in SYNCHRO.S", "SYNCHRO.S vX is available!"), Settings copy (Appearance's "It applies to everyone using this SYNCHRO.S.", the SYNCHRO.S API card, Connections and Modules subtitles) and the Help pages (`static/docs-content`).
- **Server text the app shows or sends:** Setup check's messages and fixes, OAuth callback pages (Spotify, Tidal, Deezer), errors returned to the UI, repair-job descriptions, automation block descriptions, the Assistant's system prompt and its offline messages, the Discord notification's sender name and test notification, the calendar feed's name ("SYNCHRO.S Airings"), the OPML and JSPF export titles, and the tag comments the app writes ("Downloaded via SYNCHRO.S", "Made with SYNCHRO.S Sample Studio").
- The "SS" abbreviation in the seeding hints became SYNCHRO.S or "it", so nothing relies on the reader knowing the old initials.
- The root `README.md` gains one line saying this fork's interface is named SYNCHRO.S; the rest of upstream's README is unchanged.

**What deliberately didn't change**

- Code identifiers, `window.SoulSync*` globals, package, image and container names, file and folder names, config keys and paths (`~/SoulSync`, `soulsync_data`, `SOULSYNC_*`), database names, routes, storage keys, API JSON fields, log messages, CSS classes and test ids. Updates, `update.sh` and upstream syncs keep working.
- **Names other software sees:** the Subsonic/Navidrome client name (`c=SoulSync`, so Navidrome's player is still called "SoulSync" and the "Players → SoulSync" hints keep that name), Jellyfin's client and device name, Plex's product name, MusicBrainz and other User-Agents, the MCP server's title and instructions, the Lidarr-compatible API's values, and the names sync gives playlists on your media server (renaming them would make duplicates).
- **Chat:** the Soulseek community room is still called "SoulSync", and "SoulSync rooms", "SoulSync clients", "SoulSync only", the SoulSync emoji set, the arcade's game name and the developer badges stay, because they describe upstream's chat network that other people's copies share.
- **Upstream:** the Support modal (the upstream maintainer's own words and donation links) and helper text pointing at upstream's Discord and GitHub. The Admin and help row "Support SoulSync" keeps its name too: it opens that modal and the support goes to upstream's maintainer ("Support upstream SoulSync" was tried and doesn't fit the 256px sidebar). The debug-info report pasted into upstream's GitHub issues keeps its "SoulSync Debug Info" heading.
- **Docker wording:** "the SoulSync container", "SoulSync's image" and "SoulSync's volumes" (Setup check, Settings and the Help pages' docker-compose sections, and the install section with upstream's images) name the Docker container and image, which keep their names.
- The compact rail's monogram still says "SS" (question 57). New mirrors of SYNCHRO.S Discovery playlists store "SYNCHRO.S" as their owner; ones saved before keep "SoulSync" in the database and the mirrored playlist shows them as SYNCHRO.S.

**For Design:** question 57, the wordmark treatment.

### 2026-10-22: Dev, Internet radio and Settings → Radio

Built on `ux/radio` from `Internet radio` (4a–4k), `Settings AI and Radio` (5b–5d), BACKLOG's entry and Design's radio answers 1–4. The routes are in `CONTRACTS.md`, "Internet radio"; the patterns in `DESIGN-SYSTEM.md`, "Station card" and "Radio in the player".

**What's built**

- **The module** "Internet radio" (`radio`), on by default like the others. While it's off the Radio row and Settings → Radio are hidden, the pages say it's off, every radio route answers 409, the watcher stops and every listening session ends.
- **Radio in Get music** after Mirrored playlists (sidebar, compact rail, the phone's Get music sheet), at `/radio`: Stations / Heard on radio (count); Favourites (with admins' links, "Your link · added by ross"), then Electronic, World, Eclectic tastemakers and Jazz, soul and funk as rows of four with "All N"; the directory search field. Admins get "Add a stream link".
- **A station** (`/radio/station/<id>`, 4b): breadcrumb, 120px logo, name with Playing, the station line ("Eclectic · London · Built-in pick · Publishes what's playing and tracklists after shows"), the description, the stream picker ("AAC 256 kbps (best offered)") with the lossless note, Favourite / Play or Stop / "…" (the station's website). Now playing in every state of 4c (identified with In your library, Below quality target with Upgrade via Wanted, or the primary Add to Wanted; Listening… as a live region with the disabled Add and its reason; Not identified, calm, with the station's schedule), the auto-add card and its confirm with the three numbers (4d), Heard on the station (today, five rows), Shows with tracklists and How tracks are identified.
- **A show's tracklist** (`/radio/tracklist?show=<id>`, 4e): "Add the N you don't have to Wanted", each row's state and its own Add, "Can't be matched" for rows without an artist.
- **Directory search** (`/radio/search`, 4f): the field, Any codec / FLAC / AAC / MP3, a minimum bitrate and a country; rows with tags, country, declared quality, Favourite and Play; "Show 20 more".
- **Add a stream link** (4g): Check listens from the server; the success line ("Playing. MP3 320 kbps · sends track names with the stream · answered in 0.4 s…") or the danger Notice ("This link isn't an audio stream" with the web-page explanation); Add stays disabled with its reason until a check passes.
- **Failures** (4h): the station won't play (danger Notice with Try again and "Try the MP3 128 stream", the page faded), identification off (warning, Open Settings → Radio for admins, the sentence for members), identification unavailable (warning naming no feed / no names / fingerprint down, Run Setup check for admins).
- **The player's radio mode** on its seam: Live tag, level meter, the identified track with "identified 40 s ago", ONE action (Add to Wanted or In your library), Station and Stop. Phone (4i, 4j): the mini bar with Add and Stop, the sheet with the card, Add, the auto-add switch, Stop, volume and "Heard on NTS 1 today · 14". A station keeps playing (and being identified) between pages.
- **Heard on radio** (4k): every station, All stations / Not in your library (count) / how far back, grouped by day.
- **Settings → Radio** (5b–5d), a Settings tab while the module is on, restyled in place like AI: Track identification (the switch, the AcoustID key, the status line from Setup check's radio rows, Run Setup check), Auto-add (daily limit per station, the stations with it on and this week's count, "See what it added in Activity"), Streams (the relay rule, prefer lossless, keep Heard for 7 / 30 / 90 / 365 days), Your stream links (name and address, quality or "Didn't answer …", added by, Check, Remove).
- **Auto-add**: off by default per station and profile; turning it on asks first with the numbers and needs download rights. It skips what's in the library or on Wanted, never adds a track twice, stops at the daily limit (50), and adds through Search's add at the quality target. Activity gets a new kind, **Radio** (a filter while the module is on): one item per station per hour, "Auto-add added 3 tracks from NTS 1". Radio's items don't show on Home.
- **The radio trigger** "A track I don't have played on a favourite station" in the block editor's new Radio drawer; the Assistant's drafts accept it.
- **Setup check** gains "Chromaprint (fpcalc) for radio" and "AcoustID key for radio" (group "Internet radio") while the module is on.

**The built-in stations** (`core/internet_radio/stations.json`, easy to edit; each entry says where its addresses came from). The sandbox this was built in can't reach the internet, so none of the addresses could be fetched: they're the stations' published addresses as known, and want a look on a real install (Settings → Radio's Check and the station pages show a station that won't play). Free only.

| Kind | Station | Streams | What's playing |
| --- | --- | --- | --- |
| Electronic | SomaFM · Drone Zone, Groove Salad, Deep Space One, Beat Blender, Fluid | `ice1.somafm.com/<channel>-<kbps>-<codec>` (MP3 256 where offered, AAC/MP3 128) | `somafm.com/songs/<channel>.json` |
| Electronic | FIP Electro | `icecast.radiofrance.fr/fipelectro-hifi.aac` (AAC 192), `-midfi.mp3` | radiofrance.fr's live API (undocumented; falls back to stream titles and fingerprints) |
| Electronic | dublab | `dublab.out.airtime.pro/dublab_a` | stream titles |
| Electronic | Radio Paradise · Mellow Mix | `stream.radioparadise.com/mellow-flac` (FLAC), `-320`, `-128` | `api.radioparadise.com/api/now_playing?chan=1` |
| World | FIP Monde | `fipworld-hifi.aac`, `-midfi.mp3` | radiofrance.fr |
| World | Worldwide FM | `worldwidefm.out.airtime.pro/worldwidefm_a` | stream titles |
| World | Radio Paradise · Global Mix | `global-flac`, `-320`, `-128` | RP `chan=3` |
| World | SomaFM · Suburbs of Goa, ThistleRadio | SomaFM | SomaFM |
| Eclectic | KEXP | `kexp.streamguys1.com/kexp160.aac`, `kexp-mp3-128.streamguys1.com/kexp128.mp3` | `api.kexp.org/v2/plays`; tracklists `api.kexp.org/v2/shows` |
| Eclectic | NTS 1, NTS 2 | `stream-relay-geo.ntslive.net/stream`, `/stream2` | `nts.live/api/v2/live` (shows only); tracklists from `nts.live/api/v2/shows/<show>/episodes/<episode>/tracklist` |
| Eclectic | FIP | `fip-hifi.aac`, `-midfi.mp3` | radiofrance.fr |
| Eclectic | Radio Paradise · Main Mix (FLAC), Rock Mix (FLAC) | `stream.radioparadise.com/flac`, `aac-320`, `mp3-192`; `rock-flac`, `-320`, `-128` | RP `chan=0`, `chan=2` |
| Jazz, soul and funk | FIP Groove, FIP Jazz | `fipgroove-hifi.aac`, `fipjazz-hifi.aac` | radiofrance.fr |
| Jazz, soul and funk | SomaFM · Sonic Universe, Seven Inch Soul | SomaFM | SomaFM |
| Jazz, soul and funk | Jazz24 | `live.wostreaming.net/direct/ppm-jazz24aac256-ibc1` | stream titles |
| Jazz, soul and funk | WWOZ | `wwoz-sc.streamguys1.com/wwoz-hi.mp3` | stream titles |

**Decided by Dev (the boards don't show these; redraw where you'd do it differently)**

1. **Direct or relayed:** a station plays in the browser directly only when its stream is `https`, is known to allow other sites (SomaFM's, in the list; a link whose check saw it), the station has a now-playing feed (the browser can't read stream titles, and the server never opens a second connection to read them), and Settings → Radio says "only when needed". Everything else is relayed. If the browser can't play a direct stream, the player asks again through the relay without saying anything.
2. **Two relays at once** (each holds one of the server's 8 threads); a third listener gets "Two stations are already playing through this server…". One station at a time per profile: starting another ends the first.
3. **Identification without listening:** a light watcher reads the now-playing feeds (never the audio) of stations someone is listening to, stations with auto-add on, and favourites of anyone with a radio automation, every 20 seconds at most, cached. So auto-add and the trigger work on stations with a feed while nobody listens; a station without a feed is identified only while someone listens through the relay (its stream titles, then fingerprints). The auto-add card says so for those stations. The watcher's thread only runs while it has one of those to watch: at boot it starts only if a station already has auto-add on or a radio automation's favourites, otherwise when a station is played, favourited or set to auto-add (or the Radio page is opened), and it stops itself after a minute with nothing to watch.
4. **Fingerprints** only when the feed and the stream titles don't name the track, at least 25 seconds into a stretch, one per station every 2½ minutes and one across all stations every 20 seconds, on a 12-second clip the relay keeps. The AcoustID key is the download identifier's; Settings → Radio shows it masked.
5. **Heard is per profile** (what that profile heard, and what auto-add found for it). "Identified yesterday" on the confirm counts the station's distinct tracks heard by anyone.
6. **Polled, not pushed:** the player asks what's on every 10 seconds (30 while the tab is hidden); what it says about the library is per profile, so it isn't broadcast over Socket.IO.
7. **The bar for radio:** Live and the meter stay where the player's seam put them (centre), the track and its one action beside them, Station and Stop on the right; there's no Pause and no tray on a desktop (the bar's left button opens the station's page). On a phone the sheet is the station card.
8. **The sheet's auto-add switch** turns auto-add off at once, but turning it on opens the station's page with the confirm, since 4d asks first.
9. **Each tracklist row has its own Add to Wanted**, as 4e draws, as well as the "Add the N" button. NTS tracklists are for shows SoulSync saw on NTS's live feed while watching or listening (NTS's API lists episodes by show, not by channel).
10. **Settings → Radio's relay rule** is a select ("Only when a browser can't play the stream itself" / "Always, so the server reads every stream's track names"); 5b doesn't draw it, the brief lists it.
11. **Setup check's radio rows** read "skipped" while there's no key, so turning radio on adds no warning for an optional fallback; fpcalc missing with a key set is a warning, a refused key a problem.
12. **Logos:** no station art is fetched (the server would have to fetch it, or the browser hot-link it); tiles show the station's letters ("NTS", "RP", "SF", "KX"). `logo_url` exists for an https logo if you'd like real ones.

**Questions for Design** (49–56 in the list above)

**Tests:** Python: `tests/internet_radio/` (154: which addresses the server will fetch; the audio-only gate and the relay's headers; the relay cap and session ownership; admin, member and download-rights gating; auto-add's guards, never twice and the daily limit; ICY parsing; the module off), plus the activity, automation, AI, chat, module, setup check and schema tests near the changes and every test that reads the web files changed: all pass; `ruff check` is clean on the Python touched. Web: vitest for radio (the session, the player's radio mode, Settings → Radio, the pages and the words) and the shell, platform, activity, dashboard, setup check and modules suites; `npm run check` has no errors, `tsc --noEmit` and `npm run build` are clean.

**Screenshots** (in the session scratchpad; not in the repo), 1440×900 unless noted: the radio home with a station playing in the bar; a station identified (In your library), on Wanted, Listening… and Not identified; the auto-add confirm; identification off; a station that won't play; a tracklist; directory search; Heard on radio; Add a stream link refusing a web page; Settings → Radio; and at 390×844 the radio home with the mini bar, the player sheet, Heard on radio, a station and Settings → Radio.

### 2026-10-22: Dev, the Assistant, the block editor and Settings → AI

Built on `ux/assistant` from `Automation assistant (block editor)` (3a–3l), `Settings AI and Radio` (5a) and Design's answers 1–4, 19, 21 and 24 below. The routes are in `CONTRACTS.md`, "The Assistant"; the patterns in `DESIGN-SYSTEM.md`, "Block card", "Assistant panel" and "Suggestion card".

**What's built**

- **Settings → AI** (5a), a new tab after Quality, admins only (members don't see it): provider (Anthropic), the API key (write-only, masked, "Save and test", Replace, Test, and a status line saying when it was added or tested and by whom), Model ("Faster and cheaper", the default, or "Best answers", one click), Who can use it (admins by default, or everyone with a profile), this month's usage (requests, estimated cost, drafts saved) and an optional monthly cap, which stops new requests only. The key is stored encrypted with the app's other secrets and never comes back from any settings or debug route. Code: `webui/index.html` `#ai-settings`, `static/ai-settings.css`, `src/shell/ai-settings.ts`, `core/ai/config.py`.
- **The block editor** (3b, 3l) on `/automations/new` and `/automations/<id>/edit`: one When, one Do ("after waiting N minutes" beside it), up to three Then. Thens reorder by dragging their grip or from the grip's Move up / Move down; the dashed line under them takes "/" (Notify, Fire a signal, Run a script for admins, Ask the Assistant). Name, Group, Preview a run and Save work as before.
- **The Assistant** (3a, 3c–3k): "Assistant" in the header of the list and the editor. On the list it takes the Runs column (440px); in the editor it shares the right column with Preview as tabs; on a phone it's a full-screen sheet. One conversation per profile follows you between them for the session. Every state on the boards: not set up (admin and member), admins only, first use, thinking with Stop, draft ready, couldn't build with the nearest draft, suggestions, explaining an automation ("Explain" on the selected card) or a failed run ("Ask the Assistant why it failed" under the run, with its log quoted in a `<pre>`), and the provider errors with the message kept in the box. A draft opens in the editor unsaved, under "Draft from the Assistant." Saving it counts towards "drafts saved".
- **The suggestion card** at the top of the list: one at a time, only while the Assistant can be used and only with a number in its reason (a failing automation without a notification, one paused for two weeks or more, Wanted tracks waiting over a month). It's worked out on the server without calling the model. "Not now" holds per profile.
- **`paused_at`** on automations, and **what the Wanted search found** on each run (answer 19): the Runs panel's first number becomes "Found" and each run's line adds "· N found" once runs carry it.
- **Phones' filter row** (answer 21): the Show filters scroll sideways in one row, and the search folds into an icon button at its end that opens the field under the row.

**Where the old editor's features went**

| Before | Now |
| --- | --- |
| Runs: Every… / Daily at… / Weekly… / Monthly… / After something happens buttons | The When block's select ("Every", "Daily at", "Weekly on", "Monthly on", "After something happens") with the same fields beside it. Event conditions (all or any) and signal names are unchanged. The next-run line sits under the block. |
| Step 1: the action, its options and its wait | The Do block. The wait is the "after waiting" select (0 minutes to 24 hours; an unusual saved value is kept as it is). |
| Steps 2–4 and their "⋮" (Move up, Move down, Duplicate, Remove) | Then blocks with the same "⋮", plus the grip: drag, or open it for Move up / Move down from the keyboard. "Only when…" conditions and Send a test are unchanged. |
| Add a step: Notify / Fire a signal / Run a script | The "/" line. At three it says so instead. |
| Step 1's "Open in the full builder" | The header's "…" only (answer 24). The list card's "…" no longer has it; the list header's "…" keeps "Build one in the full builder". |
| Footer: Cancel, Preview a run, Save | The header on a desktop (with Assistant); on a phone a full-width Save, then Preview, Assistant and Cancel. |
| Preview panel | Unchanged; it shares the right column with the Assistant as a tab while the Assistant is open. |
| Leaving with unsaved changes, the save check, built-in automations' limits | Unchanged. |

**Decisions**

- **Provider SDK:** the official `anthropic` Python package, pinned to `anthropic==1.12.1` in `requirements.txt` (CI installs it through `requirements-dev.txt`). 1.12.1 has been out two weeks; 2.x came out on 21 October and is too new to pin. The app starts without it: it's imported only when the Assistant answers or a key is tested.
- **Model:** "Faster and cheaper" is the default, "Best answers" one click away in Settings → AI. Testing a key reads the model's details, which costs no tokens.
- **Streams:** two at once (the server has 8 threads); a third gets the `busy` error. Closing the panel, Stop or leaving the page stops the provider call; what was used is still counted. A keep-alive comment goes every few seconds.
- **Drafts only:** the server never saves, runs, turns on or sends anything for the Assistant, not even a test notification. Every draft is rebuilt from the parts list on the server: settings must match the part's fields, playlists and scripts must exist, notification credentials (tokens, webhook URLs) are never taken from the model and are left for you to fill in, a file step's "act without a preview" is always off, and members never get an admin-only step. What's dropped is said on the draft card. Tests check that every kind of draft goes through `POST /api/automations/preview` unchanged.
- **Library text** goes to the model only inside one quoted block, escaped and capped, and the instructions say it's information, never instructions. The model sees only what the profile can see.
- **Members:** they aren't offered admin-only actions in the Do list, the "/" menu or a Then, in the editor as well as in drafts.
- **Usage** is one figure for the install per month (UTC), not per profile, estimated from token counts at each model's price.
- **Editing with a draft:** "Put it in the editor" on an existing automation replaces the blocks but keeps the name and group on screen, and asks first when there are changes. On a built-in automation the draft keeps how it starts and what Do does, as the editor already does.
- **A failed run without a log** still offers "Ask the Assistant why it failed", under its row.
- **Error codes** add `provider_error` (anything the others don't cover) and the `quote` event (the run log the answer is about), both in `CONTRACTS.md`.

**Questions for Design** (37–40 in the list above)

**Screenshots** (in the session scratchpad; not in the repo), each at 1440×900 and 390×844: Settings → AI empty and with a key; the list with the suggestion card; the panel not set up, first use, thinking, draft ready, couldn't build, suggestions, explaining a failed run, a refused key and a rate limit; the phone filter row closed and with the search open; the editor's blocks, the "/" menu, three Thens, the Assistant tab with a draft and a draft opened from the list.

### 2026-10-22: Dev, Lilac is the default accent

On `ux/lilac-default`, as Ross decided on 22 October. An install with no accent saved now gets Lilac (`#8b5cf6`, accent-light `#c2a9fa`) instead of Spotify Green: the fresh-install config (`core/settings.py`, from `DEFAULT_ACCENT` in `core/ui_appearance.py`), the page shell's fallback (`web_server.py`), `init.js` (`applyAccentColor`, the bootstrap and the fallback colours), `settings.js`, the `tokens.css` `:root` triplets, `particles.js`, `DEFAULT_ACCENT` in `src/features/settings/accent.ts`, the Appearance markup and labels, Home's quick swatches and the visual harness. What's saved is never rewritten, so an install that chose Spotify Green (or any preset) keeps it. Lilac's card was already first; it now says "The default", and Spotify Green is a normal preset. Spotify's brand green stays on everything that marks Spotify itself. Three hover borders in `downloads.js` that hard-coded the old green now use the accent.

**Tests:** vitest on `src/features/settings`, `src/shell`, `src/routes/dashboard` and `src/features/onboarding`, with new tests that the default is Lilac everywhere and that a saved Spotify Green stays; pytest for a fresh config and the shell (`tests/test_initial_appearance_template.py`) and every test file that reads the files touched. The visual baselines (`webui/tests/visual/`, Docker) aren't refreshed: the harness renders in Lilac now.

### 2026-10-22: Dev, the player (6a)

Built on `ux/player` from `DESIGN-SYSTEM.md`, "Player bar and tray (6a)", the 6a board in `Player rail (exploration).dc.html` and the phone boards 4i/4j. The floating mini player and the Now Playing modal are gone; one player replaces both.

**What's built**
- **The bar:** 72px, pinned full width along the bottom of the window under the sidebar and the page, which both end above it. `340px 1fr 400px`, padding 0 24. Art, title and "artist · format" (one button that expands); Previous, the 44px accent-light Pause, Next, the times either side of a 28px waveform; mute, volume, the output button, "Up next · N" and a labelled Expand.
- **The tray:** 360px, rising from the bar; the page keeps its width and loses height. `280px 1fr 360px`, gap 32, padding 24 24 20. The record (112px art, title, the artist as a link, "Lantern · 2024 · track 3 of 11", the mono readout with Format and Path, the quality tag and Open album, and a "…" menu), the deck (a 72px waveform, elapsed and remaining, Shuffle, Previous, a 48px Pause, Next, Repeat, volume with "−12 dB", output) and the list (Up next / Recent, Clear, Collapse; 56px queue rows, dragged to reorder; "8 up next · from Lantern · then playback stops · Show all").
- **One component, two states,** remembered per browser like the compact rail (`html[data-player]`); every toggle carries `aria-expanded` pointing at the tray; Escape closes a menu, then the tray.
- **The waveform** comes from the new peaks route, worked out in the background the first time a track plays, and is a keyboard slider (arrows 5 s, Page Up/Down 30 s, Home/End) whose values change when someone moves it, not as the time runs. The played bars and the Pause use the accent variables, so Lilac and the other accents follow.
- **The readout** (format, bit depth / sample rate, bitrate, where it plays from) comes from the new details route; bit depth and sample rate are read from the file once and kept on the track. **Recent** comes from the listening history.
- **Source kinds:** library and stream tracks as above; podcasts and audiobooks get "1.2×", −15 s / +30 s and chapter ticks (from the feed's chapters, when it publishes them); radio is only the seam (a Live tag instead of the times, one action slot, a level meter instead of the waveform), for build (e).
- **Podcasts and audiobooks play in the app's player** now, instead of a bar of their own on their pages, so an episode keeps playing while you browse.
- **Output:** browser-side only. Chrome and Edge list the outputs (`setSinkId`); unnamed devices get "Show the outputs' names…", which asks for the microphone permission the browser needs before it names them. Firefox opens its own picker, Safari the AirPlay picker. The button is hidden when there's nowhere else to send the sound.
- **Phone (≤768px):** a 64px mini bar on the tab bar (art, "title · artist", "source · format", Next or +30 s, Play/Pause) that opens the tray as a `#141416` sheet with Close; Escape closes it and focus goes back.
- **"Library Radio" is "Shuffle your library"** everywhere a person sees it (Ross's decision): the Library page's button (its title; the button says "Shuffle"), Home's listen band, Discover's stations row, the help pages and the player's messages. Function names and URLs are unchanged.
- **The routes** are in `CONTRACTS.md`, "The player" (now under Built): `GET /api/library/tracks/<id>/peaks`, `GET /api/library/tracks/<id>/details`, `GET /api/player/recent?limit=20`; new table `track_peaks`, new track columns `bit_depth`, `sample_rate`, `audio_probe_sig`.

Code: `webui/index.html` (`#media-player`, the Visuals overlay), `static/player.css`, `src/shell/player.ts`, `player-state.ts`, `player-output.ts`, `src/features/playback/app-player.ts`; the engines stay in `static/media-player.js` (now with `window.SoulSyncPlayer` and an `ss:player` event) and `static/media-player-v2.js`; `api/player.py`, `core/playback/peaks.py`, `core/playback/audio_details.py`, `core/sample/analyze.py` (`compute_peaks`).

**Where each old feature went**

| Old player | Now |
|---|---|
| Mini player: art, title, artist | The bar's left button (and the mini bar on phones) |
| Mini player: Play/Pause, Previous, Next | The bar's centre; the deck; the mini bar (Play/Pause and Next) |
| Mini player: Shuffle, Repeat (with the "1" badge) | The deck (Repeat's name says "this track" / "the queue") |
| Mini player: Stop | "…" → Stop and clear the queue |
| Mini player: progress bar and seeking | The waveform (bar and deck), a slider |
| Mini player: volume | The bar and the deck, with mute and a dB readout |
| Mini player: "30-second preview" badge | The meta line and the quality tag say "30-second preview" |
| Mini player: loading bar and percentage | The meta line says what's happening (preparing, downloading, buffering), Pause shows a spinner, and the live region announces it |
| Mini player: cover-colour glow (`mp-viz`) | Dropped (question 43) |
| Expand button / clicking the mini player | Expand, the bar's left button, Up next · N |
| Now Playing: big art, title, artist, album | The record |
| Now Playing: "Go to artist" | The artist link in the record, plus Open album |
| Now Playing: format badges | The readout (Format and Path) and the quality tag |
| Now Playing: "Playing from …" | The queue foot ("from Lantern") |
| Now Playing: Up next card | The Up next list and "Up next · N" in the bar |
| Now Playing: transport, seek tip, buffering ring | The deck; the time under the pointer on the waveform; a spinner in Pause |
| Now Playing: mute and volume | The deck |
| Now Playing: Add to playlist, Report a problem | "…" menu |
| Now Playing: Crossfade, Sleep timer (with its label) | "…" menu (the menu shows the sleep time left) |
| Now Playing: Radio mode (auto-add similar tracks) | "…" → Add similar tracks when the queue ends |
| Now Playing: download missing queue tracks | "…" → Download missing queue tracks |
| Now Playing: Stop | "…" → Stop and clear the queue |
| Queue panel: list, reorder, remove, play from here, Clear, Clear played | Up next (drag, or the ↑ / ↓ "Move earlier / later" buttons; remove; play), Clear, "…" → Clear played tracks; Show all brings back what's played |
| Lyrics toggle and panel (synced lines) | "…" → Lyrics, in the list column |
| Album-art visualizer (click the art) and the CSS bars | Dropped; the Visuals overlay is the visualizer (question 43) |
| v2: visuals mode, themes, fullscreen, Shift+click cycle, V / Shift+V, F | "…" → Visuals (the old theater as a full-screen overlay with its own transport and drawer); the keys still work |
| v2: Equalizer (Shift+click opens settings), A–B loop and its range | "…" menu; the A–B range shows on the deck |
| v2: speed button and [ / ] | The "1.2×" button for spoken word, "…" → Speed for everything; the keys still work |
| v2: History panel and its Clear | Recent, from the listening history (Clear dropped: question 42) |
| v2: Track details, Copy info, Copy path | "…" → Track details, in the list column |
| v2: Settings (speed, crossfade seconds, wake lock, EQ, normalise, visual, auto-cycle, energy, palette, dim, quality, reduce motion, reset) | "…" → Player settings, in the list column |
| v2: animated background toggle | Dropped: the only animated background is the Visuals overlay itself |
| v2: keyboard shortcuts list (?) | "…" → Keyboard shortcuts, and ? |
| Keyboard: Space, arrows, M, N/P and the rest | Unchanged, except Escape (the chrome's now) and that keys typed in a field or a menu are left alone |
| Media Session, scrobbling, listening history, queue restore and prefetch | Unchanged (`media-player.js`) |
| Podcast and audiobook bar: Play/Pause, −15 s / +30 s, seek, speed, volume, close | The app's player; close is Pause (Stop is in "…") |
| `openNowPlayingModal()`, `closeNowPlayingModal()`, `playMedia`, the queue globals | Still there: they expand and collapse the player, and `window.SoulSyncPlayerChrome` / `window.SoulSyncPlayer` are new |

**Decided by Dev (the boards don't show these; redraw where you'd do it differently)**
1. **The tray spans the full width,** under the sidebar as the bar does (question 41).
2. **No bar while nothing plays;** the remembered state comes back with the next track (question 48).
3. **The phone sheet isn't remembered:** a reload shows the mini bar. A desktop "expanded" doesn't open the sheet on a phone.
4. **Up next shows what's coming;** "Show all" brings back what's already played, which the old queue always showed.
5. **The utility row became the record's "…" menu,** with the old tooltips as the rows' words. Menus close on Escape, a click outside or a choice, and focus goes back to the button.
6. **Lyrics, Track details and Player settings open in the list column** with a back to Up next, rather than as more tabs: two tabs (Up next / Recent) is what 6a draws.
7. **The quality tag** reads the current quality target the same way as the Artist page; with no target or an unknown type, there's no tag. A preview says "30-second preview" and a track still downloading says "Downloading".
8. **Path** says "Library", or "Library (streamed from Navidrome)" when the file isn't on this machine, then "→" and the output ("This device" until another is chosen; "AirPlay" when Safari is sending it there).
9. **A file that can't be drawn** keeps a flat waveform that still seeks; the route says why, and the player stops asking.
10. **Recent** is this player's own plays in your listening pile, the same rows as Library → Listening history; a played track can be played again from there (it goes after the current one).
11. **Podcast and audiobook plays** aren't logged to the listening history, which is music only today (question 46). The album line says "Podcast episode" or "Audiobook sample".
12. **Floating buttons and toasts sit above the player** on desktop, and are hidden over the Visuals overlay.

**Tests:** Python: the new `tests/playback/test_player_peaks.py`, `test_player_audio_details.py` and `test_player_api.py` (39), the related playback, sample, content-guard and migration tests (398), and every test that reads `index.html`, `media-player.js`, `media-player-v2.js`, `style.css`, `mobile.css` or the podcast and audiobook pages (2,497): all pass; `ruff check` is clean on the Python touched. Web: the full vitest run passes (611 files, 11,161 tests), with new tests for the tray state and its persistence, the source kinds, the waveform slider, what the tray fetches, the phone sheet, output availability, the pure helpers, the app player and podcast playback, and one per row of the table above (each old feature still has its control). `npm run check` has no errors (its warnings were there before), and `tsc --noEmit` and `npm run build` are clean.

Screenshots (1440×900 and 390×844, Lilac, in the session scratchpad; not in the repo): the bar and the tray with a library track; the tray's "…" menu, Recent, Lyrics and Player settings; the bar and the tray with a podcast (speed, −15 s / +30 s, chapter ticks); the phone's mini bar and sheet (top and scrolled) for a library track and a podcast; and the Visuals overlay.

### 2026-10-22: Dev, Design's small changes (answers 2, 11, 13, 18, 22, 23, 25, 26)

Built on `ux/design-1022-small` from Design's answers in the entry below and the boards they name (`Nav v2 (Shell A)` 1m/1n, `Artist v2` 2g/2h, `Search results` 2m/2n, `Automation assistant (block editor)` 3a). Answer 7 ("Checking…") and the Following tab are on another branch; the nebula half of 9 waits for open question 32.

**2. The sidebar foot.** The pinned block is Admin and help, Switch to Video and the profile row, nothing more: the My Account and Sign out icons beside the profile are gone, because both were already in the profile's menu ("Profile & account" for members, "Sign out" in login mode). Connections, What's new and Support SoulSync were already only in Admin and help. A service that's set up but not connected (the media server, the download source, the metadata source) now lights Admin and help's dot the way a Setup check problem does, and the Connections row says it under its name in the warning colour: "Plex is down", "Plex and Soulseek are down", "3 services are down". It reads the `/status` frames the app already broadcasts, so it asks for nothing new (`CONTRACTS.md`, "Navigation shell badges"). Code: `index.html`, `src/shell/nav-shell.ts`, `nav-routes.ts` (`downServices`), `static/shell.css`; the rail's popover and the phone's Settings sheet show the same row.

**11. Artist filters.** All · In your library · Missing · Albums, with `?show=library` in the URL like the others (`src/routes/artist-detail`). The artist tour's filter step names the new one.

**13. The artist header line.** "14 releases · 9 in your library (132 tracks) · 5 on Wanted": the library's tracks sit with the library part, so the line can't read as a total.

**18. Better copies below.** On Search, a library album tagged "Below quality target" gets a "Better copies below" link when the search has that album's folder at your target in the Soulseek section; otherwise nothing. Play and Open stay. Following it opens the rest of the Soulseek list if the row is further down, brings the row to the middle of the page, gives it the selected wash until focus leaves it, and puts focus on the row's action ("Upgrade: Pale Harbour - Low Light (2021) FLAC"). The search tour's library step mentions it.

**22. Can't be previewed.** The preview's notice is titled "Can't be previewed" and the reason follows: "Deep Scan decides what to move while it runs. Run now shows you the list before anything moves." The duplicate cleaner: "The duplicate cleaner decides what to move while it runs. Run now opens it on Maintenance, which shows you the list before anything moves." (`core/automation/dry_run.py`, `src/routes/automations/-ui/preview-panel.tsx`).

**23. Built-in.** Built-in cards start their schedule line with it, as 3a draws: "Built-in · Daily at 06:00 · 1 step" (with the next run after the schedule while it's on, as on every card).

**25. Phones, no floating buttons.** At 768px and under the floating notification, help and server activity buttons go; desktop keeps them.
- The top bar's Activity icon carries the notifications. It's a button now: it opens the notifications panel docked under the top bar, which starts with a row to Activity ("2 running · 1 needs you"). One warning dot covers something that needs you and a notification you haven't seen, as 1n draws it; the button's name says both. Escape closes the panel.
- Help is the Settings sheet's Help row, which opens the help menu above the tab bar, and a "?" in the header of each page with a tour (Home, Search, Discover, Mirrored playlists, the Artist page, Library, Import, Stats, Automations, Settings, Requests and issues), which opens the menu under it with that page's tour first. The menu and the panels its items open (help search, What's new, the tour list and the rest) sit by whichever button opened them.
- The welcome tour's phone steps point at the new places; the mini player sits just above the tab bar now that nothing floats under it.

**26. Video repair's confirm.** "Permanently delete 2 files?" whenever any delete in the fix is permanent, with the full picture in the lead ("This can't be undone. Fixes 4 findings: 2 files deleted for good, 1 moved to the recycle bin, 1 renamed."); "Fix 4 findings?" only when nothing is permanent. A Watched Cleanup fix deletes every file the movie has, so the preview now counts files per effect (`files_by_effect`, `CONTRACTS.md`), and the "Deleted for good" count is files too.

**Decided by Dev (the boards don't show these; redraw where you'd do it differently)**

1. **The weather line stays** under the profile row. It's opt-in and off by default, so the pinned block is still three rows for nearly everyone.
2. **"Down" means** an explicit `connected: false`: a media server that was never set up isn't down (Home says no library is chosen), and a rate-limited or cooling-down Spotify is paused, not down. The word names the service (the server's type, the download source's name, "your download source" for a hybrid one) and goes on a second line under "Connections", since the row has no room beside its dots. Music side only: the video side has its own Connections row. Everyone sees it, as everyone sees the dots; only admins can open the switcher, as before.
3. **In your library includes a partly complete release**, so the filter shows exactly the releases the header's "9 in your library" counts; a partly complete album is under both In your library and Missing.
4. **Zero on Wanted is left out** of the header line ("4 releases · 2 in your library") rather than said as "0 on Wanted"; the library part always shows. No library tracks, no brackets. The phone's short form (2h) keeps its shape without the tracks.
5. **"Better copies below" sits under the album's meta line**, like a Soulseek row's "Show tracks", rather than at the end of it, so a phone never cuts it off. It counts a folder grouped under the same artist and title (tags and brackets ignored, the way the Soulseek rows group) whose best copy meets your target.
6. **The phone's notifications also offer Server activity** (what the media server is playing) while the media server reports live streams: the floating button that disappeared opened that, not the Activity page, and nothing else on a phone does.
7. **The Help row opens the help menu** on phones rather than the Help page, so the menu ends with "Help pages" there. Its rows are 44px and 14px on phones.
8. **Where the "?" goes:** beside the page's title; by the search field on Search, whose title is hidden on phones; with Radio and Export on Library, where the title would otherwise wrap. It opens the help menu, this page's tour first, rather than starting the tour.
9. **"This can't be undone." stays first** in video repair's lead, as the preview-then-confirm rule says for permanent deletes; Design's lead follows it.

**Tests:** vitest on `src/shell`, `src/test`, `src/components`, `src/features/safe-action` and the routes touched (dashboard, automations, discover, library, sync, stats, import, issues, search, artist-detail): all pass, with new tests for each answer. `npm run check` has no errors (the warnings it lists were there before, none in the files touched), and `tsc --noEmit` and `npm run build` are clean. Python: `tests/automation`, the video repair plan tests and every test that reads `index.html`, `init.js`, `helper.js`, `style.css`, `shell.css` or `downloads.js` (3,708 tests) pass; `ruff check` is clean on the Python touched. The live-server spec `tests/shell-chrome.spec.ts` now expects phones to open the notifications from the Activity icon and help from Home's "?"; it needs a running server, so it wasn't run here (the same steps pass against the visual harness).

Screenshots (1440×900 and 390×844, in the session scratchpad; not in the repo): the sidebar with Admin and help open and Plex down, the same on the rail's popover and in the phone's Settings sheet, no library chosen (no dot); the Artist page header and filters, In your library; Search with "Better copies below" and after following it; the Automations list with Built-in cards and the "Can't be previewed" notice; video repair's "Permanently delete 2 files?" confirm; the phone's Home without floating buttons, the Activity icon's notifications, the Help row's menu, a page header's "?" and its menu, the welcome tour's phone steps for the Activity icon and its last step; desktop keeping the floating buttons and the bell's panel; and the header of every page with a tour at both widths, with the phone headers as they were before.

### 2026-10-22: Dev, Settings → Appearance (Lilac) and Following with kinds

Build (b), on `ux/design-1022-appearance`: Settings → Appearance from "Settings Appearance" (5f) and Wanted's Following tab from "Followed (kind filter)" (5e), with the Lilac rename. Nothing from the other boards of this session is built here, and the nebula is untouched (question 32).

**Settings → Appearance (5f)**

The legacy Settings page's Appearance tab, restyled in place like Modules: markup in `webui/index.html` (`#appearance-settings`), look in `webui/static/appearance.css`, behaviour in `webui/src/shell/appearance.ts`, the presets and the contrast sums in `webui/src/features/settings/accent.ts`.

- **Accent colour:** a 4-up grid of radio cards (14px; selected = 14% accent wash + 45% accent border), each a 60×40 swatch of the accent and the light shade the app makes from it (10px radius), its name, and "Selected" or "The default" under it. A real radio group: one tab stop, the arrow keys (and Home/End) move the choice and the focus together.
- **The rename:** "Boulder Purple" is **Lilac** and "Purple" is **Pale Purple**. What's saved (`ui_appearance.accent_preset`) was always the preset's hex, never its name, so nothing in anyone's config changes: an install that chose Boulder Purple has `#8b5cf6` saved and now sees the Lilac card selected, in the same colour. The default stays Spotify Green.
- **Custom…** takes any hex (`#8b5cf6`, `8b5cf6` or `#85f`; a native colour picker sits beside the field) and checks dark text `#0b0b0f` on its light shade, computed as `applyAccentColor` and the page shell do (+16% HSL lightness, capped at 95%). One that reaches 4.5:1 is used and saved as you type; one that doesn't says so ("#1e3a8a is too dark for an accent. Dark text on its light shade, #2d56cd, is 3.1:1, and buttons need 4.5:1. Your accent stays Lilac.") with "Use Ocean Blue instead" for the nearest preset, and nothing changes.
- **The preview strip** on the page ground: the primary button, a selected row, a link, the focus ring and a played waveform, all following the accent live, with the mono line "#8b5cf6 → light #c2a9fa · dark text on it 9.7:1".
- **Theme:** "Dark only for now…" with a neutral Dark tag.
- **Motion and effects:** the settings that were already on the tab (sidebar visualizer, particles, worker orbs, reduce visual effects, max performance) as one card of rows on hairlines, with a 44px select or the design system's 20px checkbox. Everything still saves the way it did.

Decisions the board doesn't show:

- **"Yours only; each profile picks its own" isn't true today:** the accent is install-wide config, set by an admin (Settings is admin-only), so the card says "It applies to everyone using this SYNCHRO.S." Question 35 below. The board's "Sync.FM" is "SYNCHRO.S" (it was "SoulSync" until the rename of 2026-10-22), as everywhere else.
- **Choosing Custom starts from the accent in use**, so it never changes the colour by itself. A saved custom colour that fails today's check (from before the check) is shown as it is, with the warning and the offer, and isn't changed.
- **The nearest preset** is the one with the nearest hue (a custom accent fails for being too dark, so lightness is the one thing not to match on); a grey goes by plain colour distance.
- **Saving:** the page's existing autosave (a change on the hidden `#accent-preset` select), so the card behaves like every other setting on the page; no Save click needed.
- **A saved hex that matches no preset** (one of upstream's older presets, or a hand-edited config) now shows as Custom in that colour, which is what the page shell already painted; Settings used to show the custom field's colour instead. An upper-case saved hex now matches its preset.
- **The preview samples aren't controls** (they're hidden from screen readers; the mono line is read).
- **Phones** (no board): two cards a row with the swatch above the name; the strip wraps and the mono line takes its own row.
- **Max performance** still turns the three switches it overrides off; their rows say "Off while Max performance is on." in words, neutral, not faded.
- **Home's quick swatches** (the "Library and system" footer) use the same preset list, so they say Lilac and Pale Purple too, and their custom swatch refuses a colour that fails the same check.

**Following with kinds (5e)**

`webui/src/routes/wanted`: the tab in `-ui/followed-tab.tsx`, rows in `-ui/rows.tsx`, the per-kind rules in `-wanted.following.ts`.

- **The tab is "Following"** with the combined count of artists, labels, podcasts and audiobook follows (`?tab=followed` stays, so links keep working).
- **Show:** All / New release / Not checked yet / Nothing new, with counts on the first two, and a live **"Checking…"** tag with the pulsing dot beside them while a check runs; the row being checked shows a live "Checking" tag and "Checking…" in its latest column.
- **Kind:** All / Artists / Labels / Podcasts / Authors with counts, and the sort select at the row's end, defaulting to **Newest activity first**. Podcasts and Authors are there only while their modules are on (and Authors only for a profile that may see Audiobooks). Kind, filter and sort are in the URL; an old `?list=labels|podcasts|audiobooks` or `/watchlist?tab=…` link lands on its kind.
- **Rows** keep the `48px 1fr 260px 160px 224px` grid. The meta line starts with the kind ("Label · 6 on Wanted · new releases only", "Podcast · 212 episodes · 40 kept for 30 days · new episodes download", "Author · 4 found since you followed · 1 on Wanted"); art is round for people (artists, authors, narrators) and square for labels (their initials) and podcasts (a microphone when there's no art). The hover action is Open artist / label / podcast / author; the row menu has Unfollow… (asks first, and says what stays) plus each kind's own settings.
- **The primary is "Follow…"**, a menu that asks what: "An artist…" opens the follow search as before; a label, a podcast or an audiobook author take you to where those are followed (Search, Podcasts, Audiobooks).
- **The schedule line** names each kind's check ("Artists and labels are checked every 24 hours (Auto-Scan Watchlist) and new releases go to Wanted; the next check is in about 9 hours. Podcasts are checked every hour; audiobook authors every 7 days."), and **Check now** checks the kind on show: artists and labels share one check; podcasts and authors have their own ("Check podcasts now", "Check authors now").
- **Select several → Unfollow…** works across kinds.

Decisions the board doesn't show:

- **What "new" means per kind**, from what's stored (the board's note asked for a kind on the summary, podcast episode counts and author book counts): an artist, as before (a check found something in the last 7 days); a **label**, a release its check put on Wanted in the last 7 days that's still there (wishlist source `watchlist_label`); a **podcast**, an episode downloaded in the last 7 days ("New episode", from the new route below); an **audiobook follow**, a book by them, published after the follow's date, added to the audiobook wishlist in the last 7 days.
- **Two words outside answer 7's set**, because "Nothing new" would be untrue: a podcast that doesn't download new episodes says **"Not downloading"** (its check only counts episodes, so SoulSync can't know), and an audiobook follow whose last check failed says **"Check failed"** (warning) with the reason in the latest column. Question 34 below.
- **No library counts for labels, podcasts or authors** ("42 releases in your library", "4 audiobooks in your library"): SoulSync doesn't store them per label or author. Labels say what's on Wanted from them; podcasts what's kept; authors what following them has found.
- **"Authors" holds every audiobook follow:** authors, narrators and series, each saying which on its meta line ("Narrator", "Series"); a series has square art and "Open series" searches the audiobook catalogue for it.
- **The latest column wraps to two lines** instead of cutting off, since it now says where the new thing went ("· on Wanted", "· downloaded").
- **Newest activity first** orders by the newest find, or the follow itself when there's none. It's the default, so an old `/watchlist` link without a sort no longer lands on A–Z.
- **Show counts are within the chosen kind**; "Nothing new" has no count, as drawn. "Checked 30+ days ago" and "Own settings" stay as artist-only extras, offered under Kind → Artists when they have something in them.
- **Labels are install-wide** (the label watchlist has no profile), as they were on the old Labels view.
- **Each kind's row menu:** an artist's "Settings for this artist…"; a label's "Also get the whole catalogue" / "Only new releases from now on"; a podcast's "Stop downloading new episodes" / "Download new episodes" and "Keep and download settings…"; an author's "Settings for this author…" (narrator, series).

**The old-look views in the "…" menu**

- **Removed:** Labels you follow, Podcasts you follow and Audiobook authors you follow. Their rows on this tab do everything those cards did: open, the latest and check state, the label's back-catalogue switch, the podcast's download and keep settings, the author's settings, unfollow, find, and the authors' Check now. Their components are deleted.
- **Kept,** because 5e doesn't cover them: Followed artist settings…, Update similar artists, Check history…, Downloads from followed artists… and Blocklist… in the tab's "…" menu; the old-look podcast and author settings dialogs, opened from those rows' menus (5e asks for "the options that exist today"); the live check details and the artist panel fallback, as before.

**New route (`CONTRACTS.md`, "Wanted page")**

`GET /api/podcasts/watchlist/summary`: per show the profile follows, the downloaded episodes still kept, the newest episode downloaded and when, and whether that was in the last 7 days. Read-only, from the download record; the watchlist list route has neither. Tests in `tests/test_podcasts_watchlist_api.py`.

**Tests:** vitest for the accent sums and the preset list against `#accent-preset` (`src/features/settings/accent.test.ts`), the cards, keyboard and custom check over the real markup (`src/shell/appearance.test.ts`), the per-kind rows (`-wanted.following.test.ts`) and the tab end to end (`routes/wanted/-route.test.tsx`, `routes/watchlist/-route.test.tsx`); pytest for the route. The visual baselines (`webui/tests/visual/`, Docker) aren't refreshed: Settings and `/watchlist` look different now.

Screenshots (in the session scratchpad; not in the repo), 1440×900 and 390×844, in Lilac and in the default green:

- `appearance-lilac-1440(-full)`, `appearance-lilac-390(-full)`, `appearance-green-1440(-full)`, `appearance-green-390(-full)`;
- `appearance-keyboard-focus-1440`, `appearance-custom-pass-1440`, `appearance-custom-fail-1440`, `appearance-custom-fail-390`;
- `following-1440-lilac(-full)`, `following-390-lilac`, `following-1440-green(-full)`, `following-390-green`;
- `following-checking-1440-lilac(-full)`, `following-checking-1440-green(-full)`;
- `following-podcasts-1440-lilac` (hover), `following-row-menu-1440-lilac`, `following-authors-1440-lilac`, `following-labels-390-lilac`, `following-follow-menu-1440-lilac`;
- `before-appearance-1440`, `before-appearance-390` (the tab before).

### 2026-10-22: Design, the two BACKLOG features, the player and Lilac (approved by Ross)

From Design's session in the Claude Design project: `design_handoff_syncfm_ui/README.md` ("Added 2026-10-22") and the "Start here - Design notes 2026-10-22" board. New boards: `Automation assistant (block editor).dc.html` (3a–3l), `Internet radio.dc.html` (4a–4k), `Settings AI and Radio.dc.html` (5a–5d), `Followed (kind filter).dc.html` (5e), `Settings Appearance.dc.html` (5f) and `Player rail (exploration).dc.html` (6a chosen, 6b the alternative not taken). The 1440 boards include the real shell (256px sidebar, top bar), so their content pane is the width to build to. Nothing earlier was overwritten; the block editor sits beside 2j/2l in its own file.

**Approved by Ross ("yes to all"):** the Assistant's placement and the block editor (3a–3l); Radio's placement, the player/page split and the Heard list (4a–4k); an auto-add limit of 50 a day per station; Settings → AI and Settings → Radio (5a–5d); the Following tab's Kind filter (5e); Settings → Appearance with Lilac (5f); the player 6a.

**Decisions**

- **The player is 6a:** a 72px bar pinned full width along the bottom of the window (under the sidebar as well as the page) that expands into a 360px tray; the page keeps its width and loses height. One component, two states, remembered per browser. Details in `DESIGN-SYSTEM.md`, "Player bar and tray".
- **The accent is Lilac:** today's "Boulder Purple" preset, `#8b5cf6` with accent-light `#c2a9fa` (dark text 9.7:1). Rename "Boulder Purple" to "Lilac" and "Purple" (`#a78bfa`) to "Pale Purple" in `#accent-preset`. Every board from this session renders in Lilac; the earlier boards stay green.
- **Names:** "Library Radio" becomes "Shuffle your library" if it gets confused with Radio once Radio exists (Ross to say). Merge duplicate artist goes to `BACKLOG.md` as Exploring, as a Maintenance tool with preview-then-confirm.
- **Settled with Ross (BACKLOG "Questions for Ross"):** Settings → AI shows usage and an optional monthly cap, estimated locally from token counts; the default model is the faster, cheaper one, with the best one a click away. Auto-add is limited to 50 a day per station; radio doesn't count towards Home.
- **Decided by Ross (22 October):** Lilac is the default for new installs (see "Dev, Lilac is the default accent" above).

**BACKLOG: Questions for Design, answered**

Automation assistant and block editor (3a–3l):
1. **Where it lives:** one panel in two places. "Assistant" in the Automations header opens it in the right column, in place of Runs on the list and beside the blocks in the editor (where the column has Assistant / Preview tabs). One conversation follows you between the two. Not a tab beside the list: what you ask about stays in view. Phone: a full-screen sheet (3k).
2. **Next to today's editor:** the block editor replaces it; it isn't a mode. Same page, same Name / Group / Preview / Save. "Runs" becomes the When block, step 1 the Do block, follow-ups are Then blocks with drag handles and "/" on the empty line. One When, one Do, up to three Then, drawn honestly (3b, 3l). Step 1's "Open in the full builder" goes; the header "…" keeps it until the pipeline playlist kinds are covered.
3. **Suggestions:** in the Assistant, and one at a time as a quiet dashed card at the top of the Automations list, only when the Assistant is set up and the reason has a number in it. "Not now" hides it per profile. Not on Home in the first version.
4. **Scope:** Automations for the first version, reading the app-wide facts BACKLOG lists to explain and suggest. "Why is Wanted so full?" gets an automation-shaped answer; anything else says what the Assistant is for and points to Help.

Internet radio (4a–4k):
1. **Navigation and name:** "Radio", in Get music after Mirrored playlists: its one job ends in Add to Wanted, so it's a way of getting music. The module is "Internet radio". "Library Radio" stays in the player.
2. **Player versus page:** the player carries the station with a Live tag, the identified track with how long ago, and one action (Add to Wanted, or the In your library tag). Everything else (stream picker, auto-add, Heard, tracklists) is on the station's page. On a phone the mini bar opens a sheet with the card, Add, auto-add and Heard (4j).
3. **The auto-add switch:** the Modules switch in its own card, headed "Auto-add what NTS 1 plays to Wanted", with the guards in the sentence (skips what you have or want, at your quality target, shows in Activity) and yesterday's identified count. Off by default per station; turning it on asks first with the numbers (4d).
4. **Heard on radio:** both, with different jobs. The radio page keeps the list (per station, and a Heard tab across stations) for adding later. Activity records only what auto-add added, rolled up per station per hour.

**Open questions 1–28, answered**

Navigation (Nav v2, 1m/1n)
1. Agreed as built. Note for later: Get music is getting long (Radio adds a row); folding Discover into Search's idle page is the next step for BRIEF problem 1 (an Idea in `SCREENS.md`).
2. Keep only the profile row at the foot of the sidebar. Connections, What's new and Support SoulSync live in Admin and help only, so the pinned block stays three rows. A service that's down lights the Admin and help dot, the way a Setup check problem does, with the word on the Connections row.
3. 768 is right; the 390 boards are the floor, not the breakpoint. A compact rail for 768–1040 can wait until someone asks.
4. Fine. "Find" on the video side; "Get music" on the music side.

Home (Main v2, 1a–1c)
5. Home keeps Targets and Latest only. Library stats go to Library's index page when it's rebuilt; enrichment workers to Activity as running items (controls in Settings → Metadata); listening to the player and Library → Listening history; playlist sync to Mirrored playlists; up next is each Automations card's next run; quick settings to Settings. Until each has landed, "Library and system" stays on Home as one closed disclosure at the foot.
6. Connection alerts: the target card that can't search says why (built) and Activity's Needs you lists the outage. One warning Notice at the top of Home only while a target can't search; never a stack. "Search for music" stays on the phone as the header's secondary button.

Wanted (2a–2d)
7. Right set: New release (info), Not checked yet (neutral), Nothing new (neutral), plus "Checking…" with the live dot while a check runs. Complete / Incomplete stay out until discographies exist.
8. "Open artist" is right; the artist page has "Add all missing to Wanted".
9. The nebula isn't coming back (but see open question 32). Followed labels, podcasts and audiobook authors become a Kind filter on the tab, renamed "Following" (5e).

Artist (2g/2h)
10. Yes, the "⋮" is the right home; the title click stays the tracklist too.
11. Yes, as a fourth filter: All · In your library · Missing · Albums.
12. About isn't a tab: it goes in the "…" menu as a dialog (bio, links, Following settings). Tracks and Similar artists as built are fine; Design can draw them if Ross wants them checked.
13. Keep it, worded so it can't read as a total: "14 releases · 9 in your library (132 tracks) · 5 on Wanted".
14. Drop Hide. Merge duplicate artist is real but belongs in Maintenance with preview-then-confirm: BACKLOG, Exploring.

Search and the dialogs (2m–2r)
15. Keep the filter row on phones, scrolling sideways, as built.
16. Right place.
17. No Top result: the library's artist row leads; an artist found only on the metadata service leads its own section.
18. Keep Play and Open. A row with the "Below quality target" tag also gets a "Better copies below" link that jumps to that album's Soulseek row when the search has one; otherwise nothing.

Automations (2i–2l)
19. Keep Done / Failed runs / Typical for now, and have the Wanted search record what each run found (a count on `result_json`), so "Found" can return. The Assistant's explanations want that number too.
20. Paused plus "Run it once now" is enough; no new trigger.
21. One row is fine (3a). On phones the row scrolls sideways and the search folds into an icon button at its end.
22. Wording: "Can't be previewed: Deep Scan decides what to move while it runs. Run now shows you the list before anything moves." Same shape for the duplicate cleaner.
23. After yours with the Built-in filter, as built, and "Built-in" on those cards' schedule line (3a).
24. Plan to retire it: "Open in the full builder" only in the header "…" until the editor covers the pipeline playlist kinds; the block editor drops the step-1 entry now.

Phone and the last preview gaps
25. Into the top bar, so phones have no floating buttons. Notifications merge into the Activity icon (one warning dot, as 1n draws it); help moves to the Settings sheet's Help row and a "?" in the header of pages that have a tour.
26. The title names the worst thing that happens: "Permanently delete 2 files?" whenever any delete is permanent, with the full picture in the lead ("Fixes 4 findings: 2 files deleted for good, 1 moved to the recycle bin, 1 renamed."). "Fix 4 findings?" only when nothing is permanent.
27. Right as built.
28. Fine as a stopgap; the modal steps aside when Removed & refused becomes a tab of the Audiobooks page.

**Dev's build order** (one branch from `integration` each; screenshots back here):

- **(a) The small changes:** answers 2, 7 (the Checking… state), 11, 13, 14 (BACKLOG entry), 18, 22, 23, 25 and 26. The nebula half of 9 waits for open question 32.
- **(b)** Settings → Appearance (5f) with the Lilac rename, and the Following tab's Kind filter (5e).
- **(c)** The player (6a).
- **(d)** Settings → AI (5a) and the Assistant with the block editor (3a–3l). Answers 21 and 24 come with it, and 19 (the Wanted search recording what it found), which the Assistant's explanations need.
- **(e)** Settings → Radio (5b–5d) and Internet radio as a module (4a–4k), with the player's radio mode.

Not built now: answer 5 waits for the pages it hands sections to; 6 and 12 aren't in this round (Ross to say); 1, 3, 4, 8, 10, 15–17, 20, 27 and 28 need no change.

### 2026-10-22: Dev, upstream sync

Upstream's `dev` (Nezreka/SoulSync, release 3.5.9: 77 commits since 20 October) is merged into `sync/upstream-2026-10-22`, with the tidy-up above merged on top. Server changes came in with the fork's behaviour kept beside them; front-end changes to the pages the fork rebuilt were ported into the new pages rather than bringing the old layouts back.

**What came in**

- **First-run setup** rebuilt by upstream as a guided, full-screen React flow in place of the old setup wizard: it looks for servers on the network, checks folders live, saves nothing until its last step, checks every part, and can be finished later. Settings → Advanced → Developer has a Setup preview that saves nothing. Setup check's "Open the setup wizard" opens it.
- **Downloads page** (`/active-downloads`) rebuilt for music and video: art and status on each row, a detail sheet per download, history grouped by day, the Music | Video switch in the page's header.
- **Wishlist**: upstream's nebula groups artists by what's stuck, with an artist panel beside the field; the video wishlist is a React page on `/wishlist?media=movies|tv|youtube`.
- **Settings**: MCP for AI clients and the Lidarr compatible API (both off by default) in Advanced; what new sign-ups start with (side and request limit) in Security; an optional anime folder in video Settings → Downloads; clearer duration-tolerance help. Members can open the video Requests page.
- Fixes in matching, imports, review, playlist sync, collections, audiobooks and video downloads (the merge commit lists them).

**Ported into the fork's pages**

- **Home**: upstream put a "Finish setting up" checklist at the top of the old dashboard. It's on Home under Latest, drawn to the design system: a 14px card, the progress in words ("2 of 5 done") instead of a ring, 44px secondary buttons instead of 32px pills, a 44px hide button, the tick as a 20px box in a 44px target, nothing under 14px. Admins only, as upstream has it. "Finish movies and TV" is left out while the Video module is off.
- **Wanted**: the nebula (⋯ → Show as a nebula) files artists into zones, worst first (Downloaded, then rejected; No match found; Download keeps failing; Still hunting), each stuck zone with its own Retry. Opening an orb opens the artist panel beside the field (a drawer under 1300px, a bottom sheet on phones), which says what went wrong in plain words before it lists the tracks. The panel says Wanted, not the wishlist. Upstream styles the orbs' names, their try counts and the zone headings only inside its own page, so on Wanted they follow the design system: 14px and up, meta at 62% white, a 44px secondary Retry per zone. The panel itself keeps upstream's look (question 32). Each row's "last try:" uses the same plain words ("only ~30s of 3:54 played, so it was thrown out", "the wrong song came back ("Xtal" by Aphex Twin)") instead of the raw log line.
- **Downloads page and module switches**: with the Video module off, the header's switch has no Video side, the hidden video side isn't polled, and `?media=video` says Video is turned off.
- **Preview, then confirm stays**: in upstream's new rows, Delete forever and Empty bin sit in ⋯ menus; for the music bin, the video bin and Clear quarantine they still open the shared preview-then-confirm dialog, and the purge routes still need a plan.
- **Help**: the wishlist help points at Wanted's ⋯ menu.

**Taken as they are**

- The rebuilt Downloads page's look (`downloads-premier.css`): the fork had left `/active-downloads` as it was, so upstream's version replaces it (question 30).
- The setup flow's look (question 31).
- The video wishlist page, reached from the video sidebar's Wishlist row, behind the Video module switch (question 33).
- Modal overlays moved onto `DialogFrame` (podcasts, Sample Studio, Stats, smart delete on the Artist page, Mirrored playlists' source prompt, Maintenance's finding prompts) and upstream's CSS token completion.

**Not ported, and why**

- Upstream's music Wishlist page (hero, stats strip, triage banner, command bar, media tabs): Wanted replaces it, and what it did is already there (How often to try again…, Download everything now…, Removed and skipped tracks…, Remove what's already in your library…, the Not found yet filter, Audiobooks on Wanted).
- Upstream's zoned list view with its why-and-when column: Wanted's own list replaces it, and its rows carry the last try and its time.
- Token swaps in the old Search stylesheets, `automations-overhaul.css` and the old automation tile rules: the fork had deleted them.

**Navigation**

No new rows or pages. The video wishlist uses the video sidebar's existing Wishlist row; the new settings are sections of Settings.

**From the tidy-up**

`wishlist-premier.css` keeps the `.wlp` rules the tidy-up had removed, because upstream's code uses them again: the video wishlist page (its wrapper, hero, command bar, posters, diagnostics and cast) and the zones and artist panel Wanted's nebula now uses. Every other deletion stays: the selectors removed since the upstream merge that could still match are the same ones the tidy-up checked by hand. The tour needs no new steps.

Screenshots (1440×900 and 390×844: Home with the checklist, Wanted's nebula with its zones and the artist panel, the rebuilt Downloads page, the video wishlist) are in the session scratchpad. They aren't in the repo.

### 2026-10-22: Dev, no library chosen

On `fix/library-choice`: no library chosen is now a warning (setup check and its dot), and Home's alert names Standalone and Settings → Connections → Server Connections.

`/status` (and its `status:update` frame) now says `media_server.configured`, from settings alone, so a server that was never set up (a fresh install's default Plex) reads as "No library chosen" on Home's library card, in the Alerts band and in Active Sources, instead of "Disconnected" or "Offline".

### 2026-10-22: Dev, tidy-up after the redesign

On `chore/tidy-after-redesign`: the stylesheet rules the rebuilds left matching nothing, and the guided tour rewritten for today's app.

**Stylesheet rules removed.** Each selector needs a class or id that nothing builds any more: not `index.html`, the static JS, the React source, the templates or the Python. `webui/scripts/css-class-refs.mjs` found most of them; ids, and names it keeps live only through its suffix rules (`.artist-detail-page`, `.filters-container`, `.version-section`), were checked by hand.

| File | Removed | What it styled |
| --- | --- | --- |
| `style.css` | 445 rules, 9 keyframes, 3,349 lines | the old artist page (hero, release cards and their play button, the `.artist-detail-page` block and the comment calling it load-bearing, similar-artist bubbles, top tracks); the sidebar header and footer the shell replaced (brand, logo, sweep, support and version rows, nav icons, breadcrumb); the old Search panel (`#enh-source-row`, the filters panel, results area, top result, dropdown); the dashboard greeting and hero numbers; the old Watchlist and Wishlist pages; the watch-add modal |
| `mobile.css` | 64 rules, 411 lines | the hamburger, overlay and drawer, the drawer header's landscape rules, the old automation tiles, the old Search pieces |
| `dashboard-premier.css` | 24 rules, 154 lines | the greeting and hero numbers |
| `watchlist-premier.css` | 142 rules, 3 keyframes, 1,271 lines | the old Watchlist page |
| `wishlist-premier.css` | 82 rules, 2 keyframes, 303 lines | the old Wishlist page's `.wlp` wrapper (the nebula, the `wlp-` buttons and the audiobook list keep theirs) |

Checked on 26 page and viewport states (Home; the sidebar expanded, as the rail, with Admin and help open, short and in landscape; the phone sheet; Search with results; the Artist page; Automations; Wanted, its nebula and followed labels; Activity; Library; Settings; Maintenance; Discover; Mirrored playlists; the video Home): every element's computed style is the same before and after. The only differences are on the shell's brand row (flex properties on a block, and an `::after` the shell already sets to `content: none`) and the phone sidebar while it's a closed sheet (`display: none`).

Tests that read removed rules lose those checks: `release-card-play-placement.test.ts` is retired; the hamburger-behind-modals checks in `mobile-css-batch2`, `mobile-css-oct13`, `mirrored-modal-mobile` and `mobile-track-modals`, and the hello strip's phone wrap in `dashboard-header.test.tsx`, are gone. The floating-button checks beside them stay.

**Kept on purpose**

- 34 rules that were already dead before the redesign (in `style.css`, `mobile.css`, `dashboard-premier.css`, `chat-overhaul.css` and `sidebar-weather.css`) are upstream's, for its own clean-up series.
- Rules that still match but only make room for the old hamburger: the padding before Settings sub-page titles, the docs menu button, the video Back pill, Discover's chip bar, the Artist Map toolbar. Removing them changes layout, so they're a separate change with screenshots.
- The video and audiobook recycle bins, video repair and the Lossy Converter, which `ux/safe-actions-final` is changing.
- Lookups for elements nothing renders now, so they do nothing: `video-side.js` writing into `.sidebar-header .app-subtitle`, `sidebar-holiday.ts` hanging decorations from `.sidebar-spacer`, and the Element info entry for `.support-button`. For the shell's next change.
- `tests/visual/routes.visual.spec.ts` still waits for `#enhanced-dropdown` in the Search shot; the Search rebuild removed it.

**The guided tour** (`static/helper.js`)

- **Tour of SYNCHRO.S**, the welcome tour Home's ? suggests: 18 steps on a wide screen, 17 on a phone.
    1. Welcome to SYNCHRO.S (Home's header)
    2. The sidebar's groups (on a phone, the tab bar)
    3. The compact rail (wide screens only)
    4. Admin and help (on a phone, the Settings tab)
    5. Search from any page, ⌘K (on a phone, the top bar's search icon)
    6. What's running (on a phone, the Activity icon)
    7. Your targets
    8. Latest
    9. Wanted
    10. Activity
    11. Search: the library and the metadata service as you type, Soulseek on Enter
    12. Three sections, and the metadata picker
    13. One page for every artist (the Artists row; on a phone, the Library tab)
    14. Automations
    15. Preview a run
    16. Runs (on a phone, the runs line)
    17. Setup check (admins)
    18. That's the tour (the ? button)
- **Search** (the field, the types, In your library, Soulseek, the metadata service, recent searches, Browse), **Automations** (filters, the selected card, Preview a run, Runs, New automation) and a new **Artist page** tour (header, Follow and add, tabs, filters, release cards), offered on an artist page.
- Anchors are shell ids and `data-tour` attributes: Home (`home-header`, `home-targets`, `home-latest`), Wanted (`wanted-tabs`), Activity (`activity-controls`), Automations (`automations-filters`, `automation-card`, `automation-preview`, `automation-runs`, `automation-runs-link`, `automation-new`), Setup check (`setup-check`) and the Artist page (`artist-header`, `artist-actions`, `artist-tabs`, `artist-filters`, `artist-releases`). Keep them when those parts are rebuilt; each page's tests check them.
- A step whose anchor isn't on the page (a section that only shows with results, a page the profile can't open) is skipped the way the tour was going, in every tour; before, the step centred itself over the page. The box says Back, Skip tour, Next and Done, sits above the floating buttons, and Escape ends the tour.
- The other page tours (Mirrored playlists, Library, Discover, Stats, Import, Settings, Issues) are unchanged: those pages weren't rebuilt.

Screenshots (1440×900 and 390×844: four welcome-tour steps and an Artist page step; Home, Search, the Artist page, Automations and the sidebar before and after the clean-up) are in the session scratchpad. They aren't in the repo.

### 2026-10-22: Dev, the last preview gaps closed

Built on `ux/safe-actions-final`. Everything that moves or deletes files now shows exactly what it will do and waits for a confirm. It reuses what was there: the plans in `core/library/action_plans.py` (plan id, 15 minutes, single use, 409 `plan_required` / `plan_unknown` / `plan_expired` / `plan_wrong_tool`), `SafeActionDialog` with the danger tone, and the expired state. The routes are in `CONTRACTS.md`.

**What's covered now**

- **Video recycle bin** (Downloads → Video → Review): a row's Delete and Empty bin preview first. "Permanently delete 3 files (30.2 GB)?", "This can't be undone.", tiles Files, Size, Oldest and Newest, each file with where it came from, and the danger "Delete 3 files permanently". An entry restored or replaced since the preview is kept.
- **Audiobook recycle bin** (Audiobooks → Bin → Recycle bin): Delete and "Empty the bin and free the space" do the same, counted in books: "Permanently delete 2 books (1.0 GB)?", each book with all its files. The old `DELETE` routes now need the preview's plan id too. The dialog opens over the Removed & refused modal; Escape closes the dialog, not the modal.
- **Video repair, Approve Selected** (video Tools → Library Maintenance → Findings): previews when the selection includes Watched Cleanup (moves a movie's files to the recycle bin; deletes them for good when recycling is off or the file is outside every library folder) or Naming Conformance (renames). The dialog has a "What happens" column per finding, tiles Findings / Move or delete a file / Deleted for good, the danger button when files leave the library, and "This can't be undone." first when a delete is permanent. A selection that only touches the wishlist, the library record or the download queue runs straight away, as the music side's Fix selected does. The bulk route refuses a file-touching selection without a plan (409 `plan_required`, the preview attached).
- **Lossy Converter, "Keep lossy output only"** (the quality profile option that deletes the lossless original after converting):
    - Convert previews whenever a finding's profile deletes the original, whether it's a group's Convert, Fix selected, an album's Resolve all or a single finding's Convert: "Convert 8 lossless files and delete the originals?", tiles Files to convert / Originals deleted / Space freed ("About 142 MB": the originals' size less the copies', estimated from each track's duration and the bitrate; "Up to …" when a duration is missing), and per file "Converts to MP3-320, then moves the lossless original to the recycle bin". With recycling off it says "permanently delete" and leads with "This can't be undone." Converting while keeping the originals runs straight away.
    - A confirmed plan deletes an original only where its preview said it would. A bulk run without a plan, including the automation path that calls bulk fixes directly, converts and keeps every original. Even with a plan, the original goes only once its copy is checked (below).
    - "Fix all safe" leaves out Converts that delete originals, and the Tools catalogue marks the Lossy Converter as moving files while any profile keeps lossy only, so the page previews it instead of saying "only writes metadata".
    - **Turning the option on asks first.** Ticking it in Settings → Quality opens the shared dialog: "Delete the lossless files after converting?", what happens to new downloads and to files already in the library, and the danger "Delete originals after converting". Nothing saves until it's confirmed; Cancel leaves it off. Turning it off needs no confirm.

**The Lossy Converter's scheduled and automation runs (decision)**

- The Lossy Converter job, whether on its Tools interval, run by hand or from a "Run a maintenance job" automation (Run now included), only scans and raises findings. It never converts or deletes, so there is nothing to preview there. Converting happens from Convert, which previews, as above. This follows the Automations precedent: what moves files goes through the preview when a person runs it.
- The one unattended path that deletes originals is the post-download conversion: every import while "Keep lossy output only" is on. It stays automatic, or the option couldn't work for new downloads. The safest behaviour that keeps it usable:
    - The original is deleted only after a successful, verified conversion: ffmpeg exits 0, and the copy exists, isn't empty, reads as audio and plays as long as the original (within 2 seconds or 2%). A copy that fails the check keeps its original, and the log says why. (Before, a zero exit was enough.)
    - Each original deleted is written down in Activity (Safety, admins): "Lossy copy: lossless original deleted", with the file name, its size and the copy kept in its place.
    - It's deleted for good, not moved to the recycle bin: a lossy-only library would otherwise fill the bin with every lossless download, and the music bin keeps files forever unless told otherwise. The Settings help under the option and the turn-on confirm both say so.
- The Lossy Converter's own Convert, which a person confirms, uses the same check before it deletes, and sends originals to the recycle bin as before (deleted for good only when recycling is off, and the preview says so).

**Still without a preview, and why**

- The recycle bins' age-based auto-delete (music, video, audiobooks): a setting the user chose, left as it is.
- Single-finding fixes, one click on one named finding, on both sides (a lone Clean Up included): the music side's rule, unchanged, and the server's single-fix routes are as they were. The one exception is the Lossy Converter's Convert, whose button doesn't say it deletes anything: the Tools page previews it as a selection of one when its profile deletes the original.
- The post-download lossy conversion: unattended by design, so it is checked and recorded instead (above).
- Upgrade replaces, YouTube retention and dismissed imports still send video files to the video bin, where they can be restored.

**Also changed**

- Activity: the three new tools have their own words ("Empty video recycle bin", "Empty audiobook recycle bin", "Video repair fixes"), and their rows open their own pages.
- In-app help: Video Library Maintenance (approving several at once previews first), the video and audiobook bin API tables, the Lossy Converter's row, Settings → Lossy copy, and the job help for the Lossy Converter, Watched Cleanup (which no longer says "never a hard delete": with recycling off it is one) and Naming Conformance.
- `useAccessibleModal`: a dialog opened over an overlay keeps its own Escape and Tab.
- `SafeActionDialog`'s lead is a `div`, so it can carry a list (the turn-on confirm's three points).

**Questions for Design**

1. Video repair keeps the title "Fix 4 findings?" when some fixes delete for good; the lead starts "This can't be undone." Should the title say "Permanently delete …" whenever any delete is permanent?
2. The turn-on confirm is the shared dialog with three points and no list of files, because nothing is deleted at that moment. Draw it, or is this right?
3. The audiobook bin's dialog opens over the Removed & refused modal. Fine, or should the modal step aside?

Screenshots (1440×900 and 390×844: the video bin, the video bin's expired state, the audiobook bin, video repair with and without recycling, the Lossy Converter with and without recycling, and the turn-on confirm) are in the session scratchpad. They aren't in the repo.

### 2026-10-22: Dev, Search and the Mirror and Quality dialogs

Built on `ux/search-flows` from "Search results" (2m, 2n), "Flows (mirror, quality, failure)" (2o–2r, the 2s failure pattern, 2t for timing) and "Interaction states". The code is in `webui/src/routes/search`, `webui/src/features/mirror` and `webui/src/features/quality`.

**What's built**

- **Search** at `/search?q=pale+harbour&type=albums&files=1`. The query, the type (Everything, Artists, Albums, Tracks) and whether the query was submitted (`files=1`) are in the URL, so back, forward, reload and links work. Typing searches your library and the metadata service once it settles (0.6 s, two characters or more); the first search of a visit is its own history entry and refinements replace it. The field is 48px with a clear button; the types are OptionButtons beside it, under it on a phone.
- **Soulseek is searched only for a submitted query:** Enter, the "Search Soulseek" button, a hand-off (the top bar, chat, the library, the global widget), a recent search or Browse tile, arriving with `?q=` from a link, or back/forward to a submitted search; a type change keeps it. Each Soulseek search holds one of the server's 8 request threads until slskd finishes, and partial words ("pale", "pale har") are bad manners on the network and can get you rate-limited, so searching per pause in typing isn't safe. Until then the section says "Press Enter to search Soulseek for “pale har”" with a secondary "Search Soulseek" button. The stream also sends a keep-alive line every 2 seconds, so a search whose tab has gone frees its thread straight away.
- **Three sections, in this order:**
    - **In your library:** artists, albums and tracks from the library's own searches, each with a status tag (Following, In your library, Below quality target), Play and Open. An album's quality comes from its files against your target. The header counts what was found; "All library results" opens the Library on the same search.
    - **Soulseek** (or whichever download source is set up): streamed over the new `POST /api/search/stream`, with "Still searching · 48 files from 12 users so far", Stop, and "Search again" after a stop. Filters: At your target (the default, from the target's own rules), Any quality, Whole albums, Not in my library, plus Format, Sort and reverse order. Rows are grouped by folder with the best copy first; other copies open under the row. Each row's consequence is in colour: "has the 1 track you're missing", "upgrades your MP3 320 copy", "on your Wanted list", "you have all 12 tracks", "not in your library". Only the first row that completes something you already want gets the primary button ("Download missing" beside "Download all"); everything else is secondary. Every download opens today's chooser (as shared, enriched or tagged by hand), so the download modes are unchanged.
    - **Spotify** (or the connected metadata service): releases, playlists, tracks, artists and labels you don't have yet, with "Add to Wanted" (today's add-to-Wanted modal), "Mirror this playlist", Play or Preview, and links to the artist and label pages. "Showing what you don't have yet · All 8" shows the rest.
- **States:** each section loads, fails and empties on its own. Loading is skeleton rows in the section's shape with a sentence ("Asking Soulseek users for files…"). A failure is the 2s Notice (Try again, Run Setup check for admins) over faded placeholders, and the other sections still answer. Nothing anywhere is the page's empty state: "Nothing found for “…”" with what was searched and one button.
- **Phones** (2n): the field and types stack, Soulseek rows become cards with the consequence on its own line and a full-width button, meta lines shorten, and Everything shows 2, 2 and 1 rows per section.
- **Mirror a playlist** (2o, 2p): Your Spotify playlists or Paste a link; Find a playlist; a radio list where playlists you already mirror are disabled and tagged "Already mirrored"; "Keep it in sync" (on by default); a consequence line with the real counts from a library check of the chosen playlist ("17 tracks will be added to Wanted at FLAC or better, your quality target, and SoulSync starts looking for them now. 3 more tracks are on Wanted already."); and the primary `Mirror "Sunday Mornings"`. It uses today's routes: save the mirror, give it the Auto-Sync schedule the Auto-Sync board makes (every 24 hours), and run its first check. A first check refused because another playlist is being checked (409) is the 2s dialog pattern: the mirror and schedule are kept, a warning says why, and the primary becomes "Start the first check again". A full-screen sheet on phones.
    - Opened from Search ("Mirror this playlist" on a row and in the playlist preview), from Home's Mirrored playlists card and from Home's setup panel. Home's button opens the dialog instead of going to the Sync page.
- **Set a quality target** (2q, 2r): the four presets as cards with "4,512 of 4,980 tracks already meet it" from `GET /api/quality/presets` ("About" for FLAC 24-bit, which is estimated). The consequence panel says what new searches do and what happens to the tracks below the target, naming the real "Apply Quality Upgrades" automation and its schedule. "Upgrade what I already have" shows only when an enabled one can act on it. The footer shows the current target. The primary "Set target to FLAC" saves through the new `PUT /api/quality/target`, which edits the default quality profile the way Settings → Quality does. A 409 (the profile was saved somewhere else meanwhile) fades the cards, says so, and offers "Show the new numbers".
    - Opened from Home's Quality card ("Change target") and the setup panel ("Set a quality target"), for admins; members don't get the button, since the write is admin only.

**Differs from the boards, and why**

- **The Soulseek filters stay on phones**, scrolling sideways. 2n leaves them out, but without them a phone couldn't leave "At your target".
- **The metadata section has a service picker** beside its counts. It's how you reach Deezer, iTunes, Discogs, MusicBrainz and music videos, which today's page searched; "(not set up)" sources open their Settings.
- **A library album below the target shows Play and Open, not Upgrade.** Nothing can upgrade one album from here; the Soulseek section's Upgrade row, or the "Apply Quality Upgrades" automation, does it.
- **A library artist says "9 albums · 93 tracks in your library"**, not "9 of 14 releases": SoulSync doesn't store discographies.
- **Playlist rows on Search don't say "31 of 40" or "you have 31".** Counting needs each playlist's tracks; the Mirror dialog counts the one you pick.
- **Soulseek rows can have a third line:** "Show tracks" (today's expand-a-folder, with a Download on each track) and "1 other copy" (the folder grouping).
- **The Soulseek table has fixed columns** so Quality, Size and User line up; at 721–1040px wide it drops Size.
- **Search's subtitle names the sources** it searched ("Your library, Soulseek and Spotify, in one go.").
- **Mirror a playlist:**
    - It says "Spotify connected" without the account name.
    - Rows say "by ross · 48 tracks" with no "updated 2 days ago": the playlists list doesn't carry either.
    - "You have N" shows on the chosen playlist only; the others would each need their tracks loaded.
    - "Also make a playlist in your library" is left out. The mirror's check already keeps the playlist on your media server in step (its sync step), so there's nothing separate to turn on.
    - "Keep it in sync" says "Checks it every 24 hours", the Auto-Sync default, not "daily at 06:00". The Auto-Sync board can change it.
    - The line ends "SYNCHRO.S starts looking for them now", because the first check runs straight away.
    - Paste a link reads Spotify playlist links (Spotify connected) and Deezer ones; other services are pointed to Add playlist on Mirrored playlists, which reads 12 sources.
- **Set a quality target:**
    - Any lossless reads "FLAC, ALAC, WAV or DSD", not APE: APE isn't a format a quality profile can target, and DSD is.
    - The panel says the automation "adds better copies to Wanted", which is what it does, rather than "replaces the file, keeping tags and play counts".
    - The footer says "saved 14 March 2026": that's when the profile was last saved; SoulSync doesn't record when the target alone changed.
- **The Sync page's own add-playlist sheet is unchanged.** It routes to 12 sources (files, links, services), so swapping in this dialog wouldn't be clean.
- **Searches no longer toast "Search Complete".** The page shows its own status; the activity record stays, without a toast or a "Search Started" line.
- **The old page also searched files only on submit,** and that's kept: the library and the metadata service follow your typing, Soulseek waits for Enter (above).

**Data left out** (nothing in SoulSync to read it from)

- Total releases per artist ("9 of 14").
- How much of a search-result playlist you have, before you pick it.
- The Spotify account name, and when a playlist was last updated.
- An "Upgrade this album" action.

**Today's Search page, feature by feature**

| Old page | Feature | Where it is now |
| --- | --- | --- |
| Search bar | Catalog / Videos / Files modes | All three at once: Spotify (or the chosen service) is its own section, Soulseek is its own section, and music videos are "Music videos (YouTube)" in the service picker |
| Search bar | Service picker (Spotify, iTunes, Deezer, Discogs, MusicBrainz, and the experimental ones you've turned on); "(not set up)" opens Settings | The metadata section's picker, same list |
| Search bar | Pasted link or MusicBrainz ID looks the thing up | Unchanged: a link or ID goes to the lookup, and says so when there's no match |
| Search bar | SoundCloud links search the files | Unchanged: they go to the Soulseek section |
| Results | Filter pills (All, Artists, Albums, Singles & EPs, Tracks, Playlists, Labels) | The type buttons. Singles and EPs are in Albums, named in the meta line. Playlists and labels are in Everything, under "All N" |
| Results | Top result | Left out: the library's artist row leads instead (question 3) |
| Results | Shelves of covers and faces with "Show all" | Rows, with "All N" |
| Results | In library / In wishlist badges | Status tags ("In your library", "On Wanted", "Not in library") |
| Results | Album opens the download-missing modal | The album title, unchanged; "Add to Wanted" beside it |
| Results | Track opens the download search; play or stream preview | The track title, unchanged; Play (owned) or Preview |
| Results | Add a track to a playlist | The playlist button on track rows |
| Results | Playlist preview | The playlist title, plus "Mirror this playlist" in the preview |
| Results | Artist and label pages | Links, unchanged |
| Results | "Served by another source" banner | Notice under the section's heading (`#enh-fallback-banner`) |
| Results | Artist pictures | Unchanged |
| Results | Music videos: download, or request for a profile that asks first | Unchanged, under "Music videos (YouTube)" |
| Idle page | Recent searches (run, remove one, clear all) | Unchanged |
| Idle page | Browse categories | "Browse" tiles (plain tiles: the design system has no gradient washes) |
| Basic search | Its own search box | The one field |
| Basic search | Source chips in hybrid mode | The Soulseek section's source picker |
| Basic search | Type (all, albums, tracks) | Whole albums filter, and the Tracks type |
| Basic search | Format and Sort | Format and Sort, plus reverse order |
| Basic search | Expand a folder, download one of its tracks | "Show tracks", with a Download on each |
| Basic search | Download as shared, enriched, or tagged by hand | Unchanged chooser on every Download |
| Basic search | Message the user who shares it | The user name, unchanged |
| Hand-offs | The global search widget's Soulseek icon (`_searchPageSetQuery`) | Searches for that query, then scrolls to the Soulseek section |
| Hand-offs | Top bar search, chat and the library writing into `#enhanced-search-input` | Unchanged |
| Hand-offs | Download bubbles in `#enhanced-main-results-area` | Unchanged |
| Hand-offs | "Request" instead of "Download" for profiles that ask first | Unchanged |

**For the navigation shell**

- On phones the shell gives the React host 70px of top padding, so the page starts lower than 2n. That's the shell, not this page.
- The help tour (`static/helper.js`) points at the new section ids.

**Questions for Design**

1. **Phone filters:** keep the Soulseek filter row on phones, or hide it as 2n does and offer "Any quality" another way?
2. **Service picker:** is the select beside the metadata section's counts the right place?
3. **Top result:** today's page had one; is the library's artist row enough?
4. **Below-target library albums:** what should their action be, if not Open?

Screenshots (1440×900 and 390×844: Search populated, streaming, typed but not submitted, empty, failure and idle; each dialog's default, selected and failure), with the board renders beside them, are in the session scratchpad. They aren't in the repo.

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
    - Built-in automations: the name, how it starts (on a timer or after an event) and what step 1 does stay as SYNCHRO.S set them; the timing, step 1's options and the follow-ups can change.
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
- The new pages style themselves (a CSS module), so the old page's stylesheet, `webui/static/automations-overhaul.css`, is gone, with its link and its test, and so are the old React card's rules in `automations-redesign.css`. The full builder and the video automations page keep the rest of that file. `mobile.css` still has a few rules for the old cards; they match nothing now.

**Questions for Design**

1. **Runs numbers for the Wanted search:** Done, Failed runs and Typical, or should the Wanted search start keeping what it found on each run so "Found" can return? That's an engine change.
2. **"Only by hand":** worth a real trigger, or is Paused plus "Run it once now" enough?
3. **Filters, group picker and search:** fine on one row above the cards, or would you place them?
4. **Steps that can't be previewed:** is "can't be previewed, because…" plus Run now's own preview the right answer for Deep Scan and the duplicate cleaner?
5. **Built-in automations:** after yours with a Built-in filter, or a section of their own?
6. **The full builder:** keep "Open in the full builder" for what the editor doesn't cover (pipeline playlist kinds), or plan to retire it?

Screenshots (1440×900 and 390×844: list with a selected automation, a paused card, a run's log, the preview dialog, the file-step confirm, the editor, the editor with a preview, loading and failure), with the board renders beside them, are in the session scratchpad. They aren't in the repo.

### 2026-10-21: Dev, Artist page

Built on `ux/artist-page` from "Artist v2" (2g at 1440, 2h at 390), the interaction-state rules (2u) and the failure pattern (2s). The code is in `webui/src/routes/artist-detail` (`-ui/artist-page.tsx` and its neighbours).

**One artist page.** There were three artist screens: the library's artist view and the source-artist view (the same `/artist-detail/<source>/<id>` route, drawn two ways), and the followed-artist panel on Wanted ("About this artist…"). The route stays the one Artist page, so every link, bookmark and the shell's routing land on it without a hop; it now draws one way for everyone, with library-only parts left out for an artist who isn't in the library.

- Search, Discover, Library (artists and the album grid), label pages, Home's rails, Stats, Maintenance findings, Issues, Playlist explorer and Wanted already linked to `/artist-detail/…` and land on the new page.
- Wanted's followed-artist row has no "About this artist…" any more; Open artist lands here. Old `/watchlist?detailId=` and `/wanted?tab=followed&detailId=` links hand over to the Artist page (replacing the history entry). The old panel stays only for an artist whose page can't be opened (matched only on switched-off sources), because it says so and links to the artist's settings.
- `?album=<id>` (the library's album grid, issue fixes) used to open that album in the "Your library" view. It opens the Tracks tab now: admins get the tag, file and match tools with the album open, everyone else the track list scrolled to it. Issue fix buttons land on the same tools.
- Discover's "Your artists" quick look stays a preview inside Discover (it carries the map's Explore and related-artist hops); its "View Discography" opens the Artist page.

**What's built**

- **Header** (2g): art, the "Artist" label, the name, "14 releases · 9 in your library · 5 on Wanted · 132 tracks", the following tag ("Following since March 2025") and "Latest: Tidewater, March 2026 · Spotify · MusicBrainz" with the services SoulSync matched the artist on. Phones (2h): 96px art, "14 releases · 9 in library · 5 wanted", the tag on its own line.
- **Actions:** "Add all missing to Wanted", the Follow / Following toggle (selected style with a check; icon-only on phones) and a "…" menu. While you don't follow the artist, the one-line notice says what following does (desktop, as drawn).
- **Tabs** Releases / Tracks / Similar artists with counts, and **filters** All / Albums / Missing, kept in the URL (`?tab=tracks`, `?show=missing`) so Back steps between them. Arrow keys move between tabs.
- **Release cards** (4 across at 1440, 3 between, 2 on phones): square art, the title (opens the release's tracks: the old card's download modal, where you can pick tracks, download them or add them to Wanted), "2026 · Album · 12 tracks · FLAC", and the state in Wanted's words: In your library, Below quality target, a partly complete album with the 8px bar and "11 of 12 · Searching" (or "· not found yet", or "11 of 12 in your library" with Add to Wanted when nothing of the rest is wanted), Wanted · Searching / Wanted · not found yet, or Add to Wanted on the quiet 2% card. A release still being checked says "Checking your library…".
- **Ordering:** albums (and compilations) newest first, then EPs and singles newest first. **Paging:** "8 of 14 releases · Show all 14" (4 on phones), `?all=true` in the URL.
- **Follow / unfollow** use the existing watchlist routes, optimistically: the button flips at once and flips back with a message if the server says no. Unfollow asks first: "SYNCHRO.S stops checking Pale Harbour for new releases. The 5 things already on Wanted stay there and keep being searched for. Nothing in your library changes."
- **Add to Wanted** uses the Download Discography endpoint the old page used (it adds the tracks you don't have and skips what you own, what's queued and what your release filters leave out). Optimistic: the card reads "Wanted · Searching" at once, and goes back to Add to Wanted, with the reason, for any release that ends up with nothing on Wanted. "Add all missing to Wanted" asks first ("Add 6 releases to Wanted?", with the album/EP split and what's skipped), offers "Choose releases…" (the old chooser), and is the neutral disabled button, with the reason beside it, while the library check runs or when nothing is missing.
- **Tracks tab:** Popular (the metadata source's top ten, or Last.fm's most played; play, Add to Wanted, add to a playlist, "Get these…") and In your library (every track with a file, grouped by release, newest first; play, play next, add to queue, add to a playlist; 50 then Show all). Admins get "Edit tags and files", which opens the old "Your library" tools in place (`?manage=true`), unchanged.
- **Similar artists tab:** MusicMap's neighbours as cards with round avatars, each opening its own Artist page; one without a match on your sources is shown, not linked.
- **Loading, empty and failure:** the header (with the name from the link), tabs and filters stay; "Loading Pale Harbour…" beside card-shaped placeholders; a failed load is a danger Notice ("Couldn't load Pale Harbour", why, "Your library and Wanted are safe; this is a display problem.", Try again, and Run Setup check for admins) over faded, still placeholders. No releases at all is the empty panel ("No releases listed for Pale Harbour", Search for music). A metadata source that didn't answer is a warning Notice ("Showing only what's in your library") instead of the old toast.

**Where the numbers come from**

| Number | Source |
| --- | --- |
| Releases | The discography `GET /api/artist-detail/<id>` returns (the metadata provider's, merged with the library's when the provider fails), under the page's release-type filters. The Releases tab count is the same number. |
| In your library | Releases the library completion stream (`POST /api/library/completion-stream`) reports owned, fully or partly. |
| On Wanted | Releases with at least one of this artist's tracks on Wanted (`/api/wishlist/tracks`, both categories), matched by the album id the track was added with, else by title. "Searching" / "not found yet" follows the Wanted page: not found yet once the most-tried track has had 3+ tries. |
| Tracks | Your library's tracks with a file for this artist (`GET /api/quality/artist/<id>`), or the artist-detail payload's track count until that answers. The Tracks tab count is the same. |
| Below quality target | `GET /api/quality/artist/<id>` (new, `CONTRACTS.md`), joined on the library album the completion stream matched (`library_album_id`, now on each owned result). |
| Following since | The followed row's `date_added` from `/api/watchlist/artists`; following itself from `/api/watchlist/check`. |
| Latest | The newest release date in the discography. |

**Differs from the boards, and why**

1. **Each release card has a quiet "⋮" beside its title** (Tracks and download…, Play, Show in your library, Add to Wanted, Open on MusicBrainz). The old cards had a play button and a MusicBrainz link; the board's card has room for neither.
2. **"Add all missing to Wanted" asks first.** It can add hundreds of tracks that then download on the next search. The dialog also holds "Choose releases…", the old Download Discography chooser.
3. **The "…" menu holds more than the board's three entries** (list below). "Refresh from source" is "Refresh from your media server" (the existing sync, admins, library artists). **"Merge duplicate artist" and "Hide" are left out:** SoulSync has no artist merge and no "hide an artist" (the nearest are moving one album to another artist in the tag tools, and the download blocklist, which is stronger than hiding).
4. **"132 tracks" counts the tracks you have**, not every track of the discography: SoulSync doesn't fetch every release's tracklist for the page. The Tracks tab lists those tracks.
5. **The filters keep the board's three.** The old bar's release types, live / compilations / featured, and "+ Other sources" are in "…" → More filters…. The old "Owned" filter is not anywhere (question 2).
6. **Phones keep the filters** (a sideways-scrolling row under the tabs) and the "…" button beside Follow; 2h draws neither, but both hold things you can't reach otherwise. The not-following notice is left off phones, as drawn.
7. **A partly complete album shows no format in its meta line**, as drawn; an album you have whole does.
8. **Similar artists, Tracks and About aren't drawn**; they follow the evolved rules (rows like Wanted's, cards like the release cards, a 680px dialog).
9. **Appears on and Music videos** sit under the release grid, and **live dates** in About, in their existing look. They show nothing when there's nothing to show.
10. **Width:** at 1440 the content pane is about 1104px (the sidebar takes 256), so cards are about 264px, not the board's 287.
11. **Primary fill** is the computed accent-light (`#46e27d` for the default green), not the board's `#1ed760` stand-in, as on every other page.
12. **The page's own "← Back" button is gone;** the top bar's Back does it.
13. **Phones start 70px below the top bar,** not 2h's 20px: `mobile.css` still pads every `.page` for the old floating menu button. That's the shell's to change (every page has it), so this branch leaves it.

**Kept, and where it went** (old artist page, and Wanted's artist panel)

| Old screen | Feature | Where it is now |
| --- | --- | --- |
| Artist page | Photo, with Deezer and release-cover fallbacks | Header art (same fallbacks) |
| Artist page | Change photo (art picker) | "…" → Change photo… (library artists) |
| Artist page | Provider badges | Header links after "Latest:"; About → Matched on |
| Artist page | Artist Radio | "…" → Play artist radio (library artists) |
| Artist page | Add to Watchlist / Watching, settings pop-in | Follow / Following; "…" → Following settings… once followed; the pop-in's "download what's out" is Add all missing |
| Artist page | Treat as audiobook | "…" → File as audiobooks (hidden while Audiobooks is off) |
| Artist page | Download / Request Discography (choose releases, editions, wishlist + watchlist) | "…" → Choose releases to add…, and "Choose releases…" in the Add all missing dialog (same chooser) |
| Artist page | Enhance Quality | "…" → Find better copies… (same picker) |
| Artist page | Delete Artist (database only) | "…" → Remove from library… (admins; danger confirm that says no file is deleted) |
| Artist page | Report | "…" → Report a problem… |
| Artist page | Genres and Last.fm tags, bio, listeners and plays | "…" → About |
| Artist page | Albums / EPs / Singles completion bars | The counts line, and About ("3 of 5 in your library" per type) |
| Artist page | Format tags | Each card's meta line; About → Formats you have |
| Artist page | Enrichment coverage rings | About (same rings) |
| Artist page | Top tracks (play, playlist, wishlist, download all) | Tracks → Popular |
| Artist page | Wrong match? | "…" → Check matches on each source… (admins, library artists) |
| Artist page | DB Record | "…" → Database record… |
| Artist page | Filters: types, live / non-studio, compilations, featured, + Other sources | "…" → More filters… (MusicBrainz still starts with non-studio hidden, never what you own) |
| Artist page | Filter: All / Owned / Missing | All / Albums / Missing (Owned: question 2) |
| Artist page | View: Discography / Your library (tags, files, matches, bulk edits, reorganize, sync) | Releases tab / Tracks → Edit tags and files (admins), unchanged |
| Artist page | Release card: open (download modal), play, completion overlay, explicit, gap-source badge, MusicBrainz link, watchlist exclusion label | Title (same modal), "⋮" → Play / Open on MusicBrainz, the state tag and bar, "Explicit" in the meta line, "Listed by Deezer only" under it, "Following skips live releases." under a missing release |
| Artist page | Music videos, Appears on | Releases tab, under the grid |
| Artist page | Live dates and setlists | About |
| Artist page | Similar artists bubbles | Similar artists tab |
| Artist page | Back button | Top bar Back |
| Wanted panel | Image, genres, summary | Header, About |
| Wanted panel | Followers, popularity, style, mood, label | About |
| Wanted panel | Last checked, followed since | Header tag, About |
| Wanted panel | Release types followed | "…" → Following settings… |
| Wanted panel | Recent releases | The release grid (the cache the panel read isn't written any more) |
| Wanted panel | View Discography, Settings, Unfollow | The page itself, Following settings…, the Following toggle |
| Wanted panel | Banner image | Left out: the page has no banner (question 3) |

**For the shell**

- The guided tour's artist-page stops point at controls that moved (`#artist-hero-section`, `#library-artist-watchlist-btn`, `#discography-filters` and so on); those steps now centre themselves. The tour's copy describes the old page, so it needs rewriting rather than re-pointing.
- The phone padding in difference 13.
- **The old page's stylesheet block is unused now.** The page has its own CSS module and no longer wears the `.artist-detail-page` class, so the `style.css` rules scoped to it (the hero, the old release cards and their play button, and the rules that hid Artist Radio, Enhance Quality, the enrichment rings and the library view for an artist not in your library) match nothing. Dropping the class was deliberate: the page leaves those library-only parts out itself (`!sourceOnly`, a library artist id), so there's no class-to-stylesheet pairing left to keep. `tests/test_artist_detail_css_hook.py` checks those conditions in the page instead, and its two class-pairing checks are gone. The rules, and the comment above them that calls the class load-bearing, are left for a stylesheet clean-up, along with `webui/src/test/release-card-play-placement.test.ts`, which still reads them. The Tracks tab's "Edit tags and files" view keeps `#enhanced-view-container`, which those tools are styled by.
- A metadata source that didn't answer is a warning Notice on the page, not a toast; `tests/metadata/test_discography_web_integration.py` checks for the Notice.

**Questions for Design**

1. **The release card's "⋮"** (difference 1): is that the right home for Play, the tracklist and MusicBrainz, or should the card do more on click?
2. **The old "Owned" filter:** add "In your library" as a fourth filter, or leave it out?
3. **Tracks, Similar artists and About** aren't drawn; please draw them, and say whether About deserves a tab rather than a dialog (and a banner image).
4. **"132 tracks"** (difference 4): keep it as the library's count, or drop it from the line?
5. **Hide and Merge duplicate artist** need features SoulSync doesn't have; draw them out, or ask for them?

Screenshots (1440×900 and 390×844: following, not following, a partly complete album, loading, failure, the Missing filter, Show all, Tracks, Similar artists, the menu, the unfollow and add-all dialogs), with the board renders beside them, are in the session scratchpad. They aren't in the repo.

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
- **Unfollow asks first:** "SYNCHRO.S stops checking X for new releases. The 5 things already on Wanted stay there and keep being searched for. Nothing in your library changes." The artist panel's remove button goes through the same dialog.
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

**Name.** Ross decided the app keeps the name **SoulSync**: the wordmark reads "SoulSync" and the compact rail's monogram "SS". "Sync.FM" (and "S.FM") from the boards isn't used anywhere; nothing else about naming changed. *(Superseded 2026-10-22: the app is now displayed as **SYNCHRO.S**, Ross's decision; the wordmark reads "SYNCHRO.S". See that day's log entry.)*

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

- Header: "Home", "What you want, what you have, and what SYNCHRO.S is doing about the gap." and a secondary "Search for music".
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
4. Can't search: the footer is the API's sentence ("Soulseek (slskd) didn't answer when SYNCHRO.S last checked, 4 minutes ago, so searches can't run."), not "since 21:15 yesterday, so the last 2 searches were skipped", which isn't recorded. As on 2s, "Not found yet" then counts everything still missing. "Try now" runs the download-source check again and refreshes the card; if it still fails, the card says what the check said. It doesn't start a search. "Run Setup check" shows only to admins, since the setup check is admin-only.
5. The not-set-up Wanted and Quality cards aren't drawn in the grid. Copy written to match the others: "Get the music you want / Add tracks and albums you want. SYNCHRO.S searches for them on a schedule, at the quality you set. [Add to Wanted]" and "Choose the quality you want / Pick a format or bitrate. SoulSync looks for that quality when it downloads, and can upgrade what you already have. [Set a quality target]". Quality is never not set up in practice.
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

**Name:** the handoff renames the app "Sync.FM". Ross decided to keep **SoulSync** for now, so the wordmark reads "SoulSync" (compact monogram "SS") and the Home sentences say SoulSync. Please use SoulSync on new boards. *(Superseded 2026-10-22: the app is now displayed as **SYNCHRO.S**, Ross's decision; use SYNCHRO.S on new boards.)*

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
