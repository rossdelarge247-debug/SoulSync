# Handoff log

Decisions and questions between Design and Dev, newest first. Design's entries come from canvas notes and comments; Dev copies them here with the date and artboard.

## Open questions for Design

1. **Home (`Main.dc.html`):** which four targets matter most on Home, and what does each card do when its target isn't set up yet (no mirrored playlists, nobody followed)? Today's prototype assumes all four are in use.
2. **Activity (`Activity.dc.html`):** how far back the timeline goes by default (today, 7 days?), and whether "Needs you" items stay pinned until they're dealt with.
3. **Navigation (`Nav.dc.html`):** should the module pages (Podcasts, Audiobooks, Chat, Sample Studio) sit in their group (Library, Get music) or in their own "More" group when they're on?
4. **Legacy pages:** the Settings page is still the legacy UI. Should redesigned screens wait for their React rebuild, or should we restyle legacy pages to the evolved rules in place?

## Log

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
