# Screens

Every screen we're designing or have built. Artboards are files on the [SoulSync Prototypes](https://claude.ai/artifact/MtjZJfCp3xgtnXFurAdXQa) canvas. Code paths are under `webui/`.

**Status:** **Built** = in `integration` · **Building** = on a branch · **Approved** = ready to build · **Proposed** = on the canvas, waiting for Ross · **Idea** = not drawn yet.

| Screen | Status | Artboard | Code today | Notes |
| --- | --- | --- | --- | --- |
| Setup check | Built | `SetupCheck.dc.html` | `src/routes/setup-check` | Sidebar entry next to Settings, for admins. First-run steps show until the setup wizard is finished. |
| Preview, then confirm (Maintenance) | Built | `SafeAction.dc.html` | `src/features/safe-action`, `src/routes/tools` | Duplicate cleaner, Deep Scan (25% limit), repair group fixes, Dashboard deep scan, automations. |
| Settings → Modules | Built | none | `static/` settings, `src/features/modules` | On/off for Video, Podcasts, Audiobooks, Chat & Arcade, Sample Studio. All on by default. |
| Fix selected, Empty recycle bin, Clear quarantine | Built | `SafeAction.dc.html` (same pattern) | `src/features/safe-action` (`permanent-delete-flow.tsx`), Repair findings | Permanent deletes use the danger-styled confirm and say "This can't be undone". |
| Home: downloads against targets | Proposed | `Main.dc.html` | `src/routes/dashboard` | Needs a backend summary of targets: see `CONTRACTS.md`. |
| Automations with run history | Proposed | `Automation.dc.html` | `src/routes/automations` | Rules written as steps; "Preview a run"; run log per run. |
| Navigation: 4 groups | Proposed | `Nav.dc.html`, `Sidebar.dc.html` | `index.html` sidebar | A proposal for the upstream maintainers too. |
| Top bar (back, breadcrumb, search, activity) | Proposed | `TopBar.dc.html` | none | Shared by every page in the prototypes. |
| One artist page | Proposed | `Artist.dc.html` | `src/routes/artist-detail` and legacy library views | Replaces three artist screens. |
| Wanted and Followed artists | Building (`ux/wanted-page`) | `Wanted v3 (populated).dc.html`, `Wanted v2 (empty and loading).dc.html`, `Wanted (390).dc.html` | `src/routes/wanted` (`/wishlist` and `/watchlist` redirect there) | One page, two tabs. What it does beyond the boards is in its "…" menus; see `HANDOFF.md`. |
| Activity | Proposed | `Activity.dc.html` | `src/routes/active-downloads` | One timeline. Needs a backend activity feed: see `CONTRACTS.md`. |
| Clearer names across the app | Idea | none | everywhere | Wishlist/Watchlist → Wanted/Following, Sync → Mirrored playlists, Tools → Maintenance. |

When a screen changes status, Dev updates this table and adds a line to `HANDOFF.md`.
