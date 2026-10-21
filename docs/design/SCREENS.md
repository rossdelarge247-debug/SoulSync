# Screens

Every screen we're designing or have built. Artboards are files on the [SoulSync Prototypes](https://claude.ai/artifact/MtjZJfCp3xgtnXFurAdXQa) canvas. Code paths are under `webui/`.

**Status:** **Built** = in `integration` · **Building** = on a branch · **Approved** = ready to build · **Proposed** = on the canvas, waiting for Ross · **Idea** = not drawn yet.

| Screen | Status | Artboard | Code today | Notes |
| --- | --- | --- | --- | --- |
| Setup check | Built | `SetupCheck.dc.html` | `src/routes/setup-check` | Sidebar entry next to Settings, for admins. First-run steps show until the setup wizard is finished. |
| Preview, then confirm (Maintenance) | Built | `SafeAction.dc.html` | `src/features/safe-action`, `src/routes/tools` | Duplicate cleaner, Deep Scan (25% limit), repair group fixes, Dashboard deep scan, automations. |
| Settings → Modules | Built | none | `static/` settings, `src/features/modules` | On/off for Video, Podcasts, Audiobooks, Chat & Arcade, Sample Studio. All on by default. |
| Fix selected, Empty recycle bin, Clear quarantine | Built | `SafeAction.dc.html` (same pattern) | `src/features/safe-action` (`permanent-delete-flow.tsx`), Repair findings | Permanent deletes use the danger-styled confirm and say "This can't be undone". |
| Home: downloads against targets | Built | `Main v2 (target not set up).dc.html`, `Main (390).dc.html`, `Flows` 2s (card failure) | `src/routes/dashboard` (`-home.*.ts`, `-ui/home/`) | On `/dashboard`. Targets from `GET /api/targets/summary`, Latest from `GET /api/activity`. The old dashboard's sections sit under "Library and system" until Design places them (`HANDOFF.md`, "Dev, Home page"). The Mirror and Quality dialogs are a later branch. |
| Automations with run history | Proposed | `Automation.dc.html` | `src/routes/automations` | Rules written as steps; "Preview a run"; run log per run. |
| Navigation: 4 groups (Shell A) | Built | `Nav v2 (Shell A).dc.html` (1m, 1n) | `index.html` sidebar, `src/shell/nav-shell.ts`, `src/shell/nav-routes.ts`, `static/shell.css` | Sidebar, compact rail, phone tab bar and sheets. The app keeps the name SoulSync. A proposal for the upstream maintainers too. Dev's placements for pages the board doesn't show are questions in `HANDOFF.md`. |
| Top bar (back, page name, search, activity) | Built | `Nav v2 (Shell A).dc.html` (1m, 1n) | `index.html` `#ss-topbar`, `src/shell/nav-shell.ts` | Back / forward, the page name, one search field (⌘K), the live "N running" link. The running count comes from `GET /api/activity/status` (`CONTRACTS.md`). |
| One artist page | Proposed | `Artist.dc.html` | `src/routes/artist-detail` and legacy library views | Replaces three artist screens. |
| Wanted and Followed artists | Built | `Wanted v3 (populated).dc.html`, `Wanted v2 (empty and loading).dc.html`, `Wanted (390).dc.html` | `src/routes/wanted` (`/wishlist` and `/watchlist` redirect there) | One page, two tabs. What it does beyond the boards is in its "…" menus; see `HANDOFF.md`. |
| Activity | Built | `Activity v3 (populated).dc.html`, `Activity v2 (empty and loading).dc.html` | `src/routes/activity` (`/activity`) | One timeline over `GET /api/activity` with Needs you pinned, filters and range in the URL, logs on demand, live while something runs. `/active-downloads` stays as it is; running downloads link to it. The sidebar row comes with `ux/shell-a`. |
| Clearer names across the app | Idea | none | everywhere | Wishlist/Watchlist → Wanted/Following, Sync → Mirrored playlists, Tools → Maintenance. |

When a screen changes status, Dev updates this table and adds a line to `HANDOFF.md`.
