# Design system: the evolved rules

The [SoulSync Design System](https://claude.ai/artifact/KEJdYBxVhnzDPbuPN1DBVK) in Claude Design records today's UI exactly (tokens, components, and an audit of what's wrong). These are the rules new and redesigned screens follow. They keep the look and fix the problems. When Design changes a rule, Dev updates this file.

## Type

System font stack only (`'SF Pro Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, …`). No web fonts.

| Role | Size / weight | Notes |
| --- | --- | --- |
| Page title | 28px / 700 | letter-spacing -0.01em |
| Section heading | 18px / 600 | |
| Card or row title | 15–16px / 600 | |
| Body | 15px / 400 | line-height 1.5 |
| Secondary and meta text | 14px / 400 | the smallest reading size |
| Section label | 12px / 600, uppercase, tracked 0.08em | the only text under 14px |
| Number badge | 13px / 600 | |
| Big number (stat tile) | 24–36px / 700 | |

Weights: 400 body, 500 controls, 600 headings, 700 page titles and big numbers. Today's UI leans on 700–800 everywhere; avoid that.

## Colour

- **Ground:** page `#0c0c0c`, sidebar `#101010`.
- **Surfaces** are white washes: card `rgba(255,255,255,0.04)` with a `0.09` border; hairline `0.08`; control border `0.16`; input and checkbox border at least `0.24`, which meets 3:1.
- **Text:** primary `#ffffff`; secondary `rgba(255,255,255,0.72–0.86)`; meta `0.62`. Never below `0.60`, which keeps 4.5:1 on cards.
- **Accent** is the user's choice. Use the light variant (the accent with +16% HSL lightness, capped at 95%, called `accent-light` in code) for:
    - links and accent text;
    - primary button fills, with **dark text** (`#0b0b0f`), which passes for all 7 presets (white on the accent fails for all of them);
    - focus.

  Selected states use a 14% accent wash with a 45% accent border.

  The presets (Settings → Appearance, `#accent-preset` in `index.html`), with the accent-light the app computes for each and the contrast of `#0b0b0f` on it:

  | Preset | Accent | Accent-light | Dark text on accent-light |
  | --- | --- | --- | --- |
  | **Lilac** (default; was "Boulder Purple") | `#8b5cf6` | `#c2a9fa` | 9.7:1 |
  | Spotify Green | `#1db954` | `#46e27d` | 11.6:1 |
  | Ocean Blue | `#1d8ab9` | `#46b3e2` | 8.2:1 |
  | Pale Purple (was "Purple") | `#a78bfa` | `#e2d9fd` | 14.6:1 |
  | Sunset Orange | `#f59e0b` | `#f8bd59` | 11.6:1 |
  | Rose | `#f43f5e` | `#f88c9f` | 8.6:1 |
  | Teal | `#14b8a6` | `#35e9d5` | 12.9:1 |

  **Lilac is the default accent** (Ross, 2026-10-22): every board from Design's 22 October session renders in it (`--ss-accent-rgb: 139,92,246; --ss-accent-light-rgb: 194,169,250`), while the earlier boards still show green. An install with no accent saved gets Lilac (`DEFAULT_ACCENT` in `core/ui_appearance.py` and `accent.ts`, the `tokens.css` defaults, `init.js`); one that saved a preset, Spotify Green included, keeps it. Spotify's own green stays wherever it marks Spotify itself (service badges, source pills, stats). Lilac's card comes first and says "The default". Settings → Appearance (5f, built) shows each preset as a radio card with a 60×40 two-tone swatch (accent | accent-light) and a preview strip of the five things the accent touches: the primary button, a selected row, a link, the focus ring and the played waveform.

  There is also "Custom" (any hex). On Settings → Appearance it's checked for 4.5:1 dark text on its accent-light, used and saved only when it passes; a hex that fails says so and offers the nearest preset (by hue). The server (`web_server.py`) and `init.js` (`applyAccentColor`) compute the pair; CSS reads them as `--ss-accent-rgb` and `--ss-accent-light-rgb`. The presets, the light shade and the contrast check are in `src/features/settings/accent.ts` for anything else that needs them (Home's quick swatches use it). What's saved is a preset's hex, never its name.
- **Status:** success `#4ade80`, warning `#fbbf24`, danger `#f87171`, info `#38bdf8`, neutral 86% white on a 6% wash. Tags use the colour at 12% as the background and the colour as the text, with an 8px dot. Status always comes with a word, and an icon where there's room.
- **Grounds:** dialogs `#17171c`, note cards and popovers `#141416`, the scrim behind a dialog `#0a0c11`, sample-table headers in a dialog `#1d1d23`.
- No gradient washes, no left-border accent cards, no emoji.

## Shape and space

- **Radii:** 6px tags, 10px controls and buttons, 14px cards, 16px dialogs. Circles only for avatars and status dots. No pill-shaped statuses or option buttons.
- **Touch targets:** at least 44px tall for buttons, switches, nav items and row actions. The shared `Button` size `lg` is 44px; use it for page and dialog actions.
- **Spacing:** cards pad 20–24px; gaps 8, 12, 16 or 24px; page gutter 40px on desktop, **12px on phones** (the app's shared page padding).
- **Layout:** pages are fluid, max content width about 1200px; sidebar plus content wrap to one column on phones; wide tables scroll inside their own box.

## Tokens

`webui/static/tokens.css` is the one global `:root`, loaded first by `index.html`, so the legacy sheets and the React CSS modules read the same values. The design system's tokens are the `--ss-*` names:

| Group | Tokens |
| --- | --- |
| Accent | `--ss-accent-rgb`, `--ss-accent-light-rgb` (comma triples for `rgba(var(--x), a)`) |
| Ground | `--ss-ground-page`, `--ss-ground-sidebar`, `--ss-ground-dialog`, `--ss-ground-note`, `--ss-ground-scrim`, `--ss-ground-table-head` |
| Surfaces | `--ss-surface-card`, `--ss-surface-card-border`, `--ss-surface-quiet`, `--ss-hairline`, `--ss-control-fill`, `--ss-control-fill-hover`, `--ss-control-border`, `--ss-input-fill`, `--ss-input-border`, `--ss-input-border-hover`, `--ss-hover-wash`, `--ss-row-hover` |
| Text | `--ss-text`, `--ss-text-secondary` (0.86), `--ss-text-tertiary` (0.72), `--ss-text-meta` (0.62), `--ss-text-on-accent` (`#0b0b0f`) |
| Status | `--ss-success`, `--ss-info`, `--ss-warning`, `--ss-danger` (each with an `-rgb` triple), `--ss-neutral`, `--ss-neutral-fill` |
| States | `--ss-selected-fill`, `--ss-selected-border`, `--ss-focus-ring`, `--ss-focus-offset`, `--ss-focus-offset-inset`, `--ss-input-focus-border`, `--ss-input-error-border`, `--ss-disabled-fill`, `--ss-disabled-border`, `--ss-disabled-text`, `--ss-pressed-opacity`, `--ss-pressed-opacity-primary` |
| Radii | `--ss-radius-tag` 6, `--ss-radius-control` 10, `--ss-radius-card` 14, `--ss-radius-dialog` 16 |
| Spacing | `--ss-gutter` 40, `--ss-gutter-phone` 12 |
| Motion | `--ss-motion` (120ms, 0 under `prefers-reduced-motion`), `--ss-ease`, `--ss-transition`, `--ss-live-pulse` (1.6s, with the `ss-live-pulse` keyframes) |

The older names in the same file (`--accent-rgb`, `--white-a*`, `--radius-*`) stay for the rules that already read them.

## Interaction states

Every control follows these. Transitions are 120ms ease on background, border and opacity only (`--ss-transition`); nothing animates layout, and `prefers-reduced-motion` turns the transitions, the live-dot pulse and the switch knob stretch off.

| State | Rule | Notes |
| --- | --- | --- |
| Hover | +6% white wash | A filled secondary goes 6% → 10%; a 4% row or card goes to 8%. The primary button drops to 92% opacity instead. |
| Focus (keyboard) | `:focus-visible` only: `outline: 2px solid` accent-light, `outline-offset: 2px` | Inside list rows the offset is `-2px`, so the rounded list doesn't clip it. Never shows on a mouse click. |
| Focus (inputs) | The border turns accent-light at 60%; no outline, no glow | Inputs show focus whatever the pointer, because you type into them. |
| Pressed | Hover plus 92% opacity (primary 84%) | No translate, no scale. The switch knob stretches to 22px, the one bit of motion. |
| Selected | 14% accent wash, 45% accent border | `aria-pressed`, `aria-selected` or `aria-current`. |
| Disabled | Neutral, at full opacity: the primary goes to a 6% fill, 16% border and 62% text; secondary and option buttons to 3% / 10% / 62% | **Never a faded accent.** Write the reason beside it, and use `aria-disabled` (not `disabled`) where the reason must stay focusable. |
| Input error | Danger border at 60%, the message under the field in `#f87171` at 14px | |
| Status tags | Never react to hover | They aren't interactive, even inside a hovered row. |

In React: `Button`'s `disabledReason` does the disabled rule in one prop (neutral style, `aria-disabled`, the reason rendered right after the button and linked with `aria-describedby`); `FormField`'s `error` marks its control invalid. Links are accent-light and underline on hover; they're never disabled (hide the action instead).

## Loading, empty and failure

- **Loading** says so in words beside the spinner ("Loading your list…", "Loading the last 7 days…"), as a live region, then shows placeholders in the content's real shape (rows of art, title, meta line and tag; a timeline's day label and rows). The page header, tabs and filters stay in place and usable. `LoadingState` + `SkeletonList`.
- **Empty** keeps the page header and controls in place. A card with an 18px title, two sentences (what the list is for, then how things get onto it) and one primary action, at most one secondary. No illustration. `EmptyState variant="panel"`.
- **Failure** is one pattern everywhere: a `Notice` with a `title`, in the colour of the problem. Danger means "this didn't work", warning "this is fine but needs a step from you". The title says what didn't happen, the sentence says why and whether anything is at risk, and the one or two actions that help sit beside it. A page that couldn't load keeps its header and tabs, and shows faded placeholders (`SkeletonList faded`) behind the Notice. Never show an error code alone.

## Icons

Feather-style line icons, 24px viewBox, stroke 1.8 (nav) to 2 (controls), round caps and joins, drawn in `currentColor`. Icon-only buttons need an `aria-label`.

## Components that exist in React

Use these before drawing new ones. Paths are under `webui/src/`.

| Component | Where | Notes |
| --- | --- | --- |
| `PageHeader` | `components/page-header` | page title, subtitle, actions; `help="<page id>"` adds the phone's "?" |
| `PageHelpButton`, `TitleWithHelp` | `components/page-header` | the phone's "?" for a page with a tour (Navigation shell pieces below); `TitleWithHelp` wraps a page's own title with it |
| `Button`, `FormField`, `TextInput`, `TextArea`, `Select`, `Checkbox`, `Switch`, `RangeInput`, `OptionCard(Group)`, `OptionButton(Group)`, `FormError`, `FormActions` | `components/form` | Follow the interaction states above. Button primary is dark text on `accent-light`; size `lg` is 44px; `disabledReason` writes why it's disabled. `Select size="lg"` is the 44px select. `OptionButton` is the 44px option, tab or filter (10px radius). |
| `StatusTag` | `components/primitives` | the status for new work: dot + word, `tone`, `live` for a slow pulse. Also exported from `features/safe-action`. |
| `Notice` | `components/primitives` | with `title` (and `actions`) it's the failure / attention box; without, the compact note |
| `LoadingState`, `SkeletonList`, `Spinner`, `Skeleton` | `components/primitives` | loading in words, then placeholders in the content's shape |
| `EmptyState` | `components/primitives` | `variant="panel"` with `title`, `description`, `hint`, `actions` is the design-system empty state; the default is the older centred line |
| `Badge` | `components/primitives` | a pill; use `StatusTag` for statuses in new work |
| `DialogFrame`, `DialogHeader`, `DialogBody`, `DialogFooter` | `components/dialog` | accessible modal; 44px close button |
| `SafeActionDialog`, `GuardBox` | `features/safe-action` | preview, then confirm, for anything that moves or deletes files |

## Navigation shell pieces

The shell is legacy markup (it has to paint before any script runs), so these aren't React components; reuse their classes and tokens rather than drawing new ones. Markup in `index.html`, behaviour in `src/shell/nav-shell.ts`, look in `static/shell.css`.

| Piece | Where | Notes |
| --- | --- | --- |
| Sidebar and its rows | `#app-sidebar`, `.ss-item`, `.ss-group-label` | 256px on `#101010`; 44px rows (48px in a sheet), 20px icon, 15/500 at 86% white; selected = 14% accent wash + 45% border with `aria-current="page"`; 12px group labels. A row keeps `.nav-button` and `data-page` so profile gating and the module guard reach it. |
| Sidebar foot | `.ss-nav-bottom` | Pinned under a hairline, three rows at most: "Admin and help", "Switch to Video" (while the Video module is on) and the profile row (avatar and name; it opens the profile menu with Switch to, Edit my profile, Profile & account and Sign out). Nothing else: Connections, What's new and Support SoulSync are in "Admin and help" only. The opt-in weather line can follow the profile. |
| Compact rail | `html[data-sidebar="collapsed"]` | 72px; icons with `title` + `aria-label`; groups become 24px hairlines; counts become 8px dots. Desktop only. |
| Count badge | `.ss-badge` (`.ss-badge--warning`) | 13/600 on a 10% wash, 22px tall, 6px radius; a warning count in the warning colour at 12%. |
| Dot | `.ss-dot--warning`, `.ss-dot--info` | 8px; always with words beside it or for a screen reader (`.ss-sr`). |
| Disclosure ("Admin and help") | `.ss-admin` | A 44px button with `aria-expanded`; its state is kept in `localStorage`. Its 8px dot lights (warning) for a Setup check problem or a service that's down, and (info) for an update, so folding it hides none of them; the words are on the row inside and in the button's screen-reader note. |
| Connections row | `.ss-connections` (in "Admin and help") | A dot per service (success, danger, warning for a paused Spotify), names for screen readers. A service that's set up but not connected says so under "Connections" in the warning colour at 14px: "Plex is down", "Plex and Soulseek are down", "3 services are down". A media server that was never set up isn't down. |
| Popover beside the rail | `.ss-admin.is-popover-open .ss-admin-panel` | 256px, `#141416`, 14px radius, `0 20px 60px rgba(0,0,0,.45)`, a 12px title; Escape and a click outside close it and focus returns to its button. |
| Top bar | `#ss-topbar` | 64px (56px on phones): 44px icon buttons, the page name 15/500 (17/600 on phones), the 44px search field (max 520px, 24% border, `kbd` hint), the live link in the info colour with a pulsing 8px dot. Phones: back, the page name, Search and the Activity icon. |
| Activity icon (phones) | `#ss-phone-activity` | A 44px button that carries the notifications too: one warning dot for something that needs you or a notification you haven't seen, and a name that says both ("Activity and notifications, 1 needs you, 3 new notifications"). It opens the notifications panel docked under the top bar (12px from each side, `aria-expanded`, Escape closes it), which starts with 48px rows to Activity ("2 running · 1 needs you") and, while the media server reports live streams, Server activity. |
| Page help (phones) | `.ss-page-help`, `.ss-page-title-row` | A 44px "?" (help-circle icon, 16% border, 10px radius) beside the title of a page with a tour: by the field on Search, where the title is hidden, and by the header's buttons on Library. It opens the help menu under it with the page's tour first. Hidden on wide screens. The Settings sheet's Help row opens the same menu above the tab bar, with "Help pages" at its end. |
| No floating buttons on phones | `.notif-bell-btn`, `.helper-float-btn`, `.activity-float-btn` | At 768px and under they're gone (the Activity icon and the page help replace them); wide screens keep them, and they hide while a dialog is open. |
| Tab bar | `#ss-tabbar` | Phones: 64px on `#101010`, five equal tabs with a 22px icon and a 12/600 uppercase label; the open or current tab in accent-light. |
| Bottom sheet | `html[data-sheet] #app-sidebar` | Phones: the sidebar itself, filtered to one group, above the tab bar on `#141416` with a 16px top radius, a 36×4 handle and a 12px title; 48px rows. Opens from a tab (`aria-expanded`, `aria-controls`); the same tab, Escape or a tap outside closes it, and focus goes back to the tab. |

A page builder's loading and empty states, for example:

```tsx
{query.isPending ? (
  <LoadingState label="Loading your list…" />
) : query.isError ? (
  <>
    <Notice tone="danger" role="alert" title="Couldn't load your list"
      actions={<Button size="lg" onClick={() => query.refetch()}>Try again</Button>}>
      SoulSync didn't answer. Your list is safe; this is a display problem.
    </Notice>
    <SkeletonList rows={2} faded />
  </>
) : rows.length === 0 ? (
  <EmptyState variant="panel" title="Nothing wanted yet"
    description="Add tracks or albums you want and SoulSync looks for them on every scheduled search."
    hint="You can add from Search, from a playlist, or from an artist page."
    actions={<Button variant="primary" size="lg">Search for music</Button>} />
) : (
  <List rows={rows} />
)}
```

## Approved patterns, not built yet (Design, 2026-10-22)

None right now: the station card is built (below).

Drawn by Design and approved by Ross on 22 October (`HANDOFF.md`). They move to "Components" or "Patterns already built" when they land.


## Patterns already built

- **Block card** (the automation editor, 3b, 3l; `routes/automations/-ui/editor-fields.tsx` `BlockCard`, `DoBlock`, `ThenBlock`, and `-ui/block-editor.tsx`): an automation is a stack of 14px cards, one **When**, one **Do** ("after waiting N minutes" beside the action) and up to three **Then**, each a `72px 1fr 44px` grid: the 12px uppercase label (`--ss-text-meta`, 0.08em tracking), the settings inline, and the "⋮" on Then cards. Then cards carry a grip under the label: drag it to reorder (the card under it gets the selected wash), or press it for Move up / Move down. The dashed line under the last Then reads "Type / to add a follow-up · N of 3 left"; "/" opens a `--ss-ground-note` menu (Notify, Fire a signal, Run a script for admins, then Ask the Assistant under a hairline) that narrows as you type and works with the arrows, Enter and Escape. On a phone the line is a button and the label sits above the settings. At three Thens the line says "Three follow-ups is the most an automation can have. Remove one to add another." A draft from the Assistant opens under an info Notice. Members aren't offered admin-only actions in the Do list, the menu or a Then.
- **Assistant panel** (3a, 3c–3k; `routes/automations/-ui/assistant-panel.tsx`, `-ui/suggestion-card.tsx`): opened by "Assistant" in the Automations header (and the editor's). On the list it takes the Runs column at 440px; in the editor it shares the right column with Preview as two tabs; on a phone it's a full-screen `role="dialog"` sheet that Escape closes. Header: title, "New chat", 44px close. The thread labels "You" (with where it was asked from) and "Assistant" in the 12px uppercase style; a quoted run log uses Activity's `<pre>`. The draft card (`--ss-ground-note`) has a "Draft ready" info tag, the summary at 15/600, "Why this shape", any notes in warning colour, a When / Do / Then list, then "Open in the editor" (primary on the list; "Put it in the editor" in the editor, which asks before replacing changes), "Preview a run" and "Try again". The composer is a textarea with a 44px send button and the data line under it ("Writes drafts only. Sends … to Anthropic (Settings → AI)."; "Drafts only · sent to Anthropic (Settings → AI)" on a phone). States: checking; not set up (admins get "Open Settings → AI", members a sentence, no composer); admins only; first use (the data sentence with "Got it", remembered per profile); thinking (spinner, what it's reading, Stop); stopped ("Stopped. Nothing was changed."); couldn't build (warning Notice, then "Nearest I can build" with "Use the nearest"); suggestions (cards with "Use this" and "Not now"); errors as Notices, danger for a refused key, offline or an unknown failure, warning for no credit, rate limits, the monthly cap and busy, with the message back in the composer.
- **Suggestion card** (top of the Automations list): one at a time, a quiet card with a dashed 16% border, "Suggested by the Assistant" in the 12px label style, the title at 16/600, the reason, then "Use this" and "Not now". Only while the Assistant can be used.
- **Station card** (radio, 4a; `routes/radio/-ui/parts.tsx` `StationCard`, `-ui/radio.module.css`): a 14px card in rows of four (three under 1180px): a 56px logo tile (6px radius; the station's https logo, else up to four letters, `logo_text` in the station list or its initials), the name at 16/600, "kind · city" (a link says "Your link · added by ross"), then the declared quality as meta (FLAC as a success StatusTag) and a 44px Play. The playing station takes the selected style (14% accent wash, 45% border) with a live "Playing" tag in place of the quality. The whole card links to the station's page; Play stops the click. On a phone Favourites become 68px rows (logo, name and line, Play) and the kinds scroll sideways at 176px.
- **Radio in the player** (4a, 4i, 4j; `src/shell/player-radio.ts`, `radio-session.ts`, `static/player.css` "radio"): the seam's Live tag and level meter (24 bars, 48 in the deck), then the identified track ("Harbour Light", "Pale Harbour · identified 40 s ago") right-aligned, and ONE action: the primary Add to Wanted or the In your library tag (success). Station (an accent text link) and a 44px Stop on the right replace Up next, the output button and Expand; there's no Pause. The bar's left button opens the station's page. Phone: the mini bar shows "track · artist" over "station · Live · not in your library" with Add and Stop; the sheet is the station card (4j): name, Live, Station page, a 200px art tile, Now playing, Add to Wanted (full width), the auto-add switch (turning it on goes to the station's confirm), Stop, volume and "Heard on NTS 1 today · 14 ›".
- **Player bar and tray (6a)** (`webui/index.html` `#media-player`, `static/player.css`, `src/shell/player.ts` with `player-state.ts` and `player-output.ts`; playback stays in `static/media-player.js`, the visuals, EQ, speed, A-B loop, lyrics, details and settings in `static/media-player-v2.js`). One component with two states, remembered per browser (`localStorage` `ssPlayerExpanded`) and set as `html[data-player="bar"|"tray"]`, which gives `--ss-player-h` (72px or 360px; 64px on a phone). Every toggle carries `aria-expanded` and `aria-controls="ss-player-tray"`; Escape closes an open menu first, then collapses. Nothing playing, no player: the attribute goes and the page has the full height.
    - **Bar:** 72px, pinned full width along the bottom of the window under the sidebar and the page (both end above it), `#101010` with a top hairline. Grid `340px 1fr 400px`, padding 0 24px. Left: one button with 48px art, the title at 15/500 and "artist · format" ("Pale Harbour · FLAC 24/96"); it expands the tray. Centre: Previous, a 44px Pause in accent-light (`rgb(var(--ss-accent-light-rgb))`, 10px radius, dark glyph), Next, elapsed (mono 14, tabular), a 28px waveform, total. Right: mute and a 96px volume slider, the output button (only when the browser has somewhere else to send the sound), "Up next · N" (opens the tray on Up next) and a labelled 44px **Expand** ghost.
    - **Tray:** 360px, the page keeps its width and loses height. Grid `280px 1fr 360px`, gap 32, padding 24 24 20. The record: 112px art, "Now playing", the title at 18/600, the artist as a link, "album · year · track n of m"; the mono readout (Format "FLAC 24/96 · 2,304 kbps", Path "Library → This device"); the quality tag ("At your target" success, "Below your target" warning, "30-second preview", "Downloading") with "Open album" and the record's "…" menu. The deck: a 72px waveform (played bars accent-light, the rest 24% white, 2px gaps), elapsed and remaining, Shuffle, Previous, a 48px Pause, Next, Repeat; volume (140px) with "−12 dB" and the output button. The list: Up next (count) / Recent as OptionButtons, Clear and a labelled **Collapse**; queue rows 56px in `20px 40px 1fr auto` (grip, art, title with "artist · format", duration and row actions), dragged to reorder; the foot "8 up next · from Lantern · then playback stops · Show all". Lyrics, Track details and Player settings open in the same column from the "…" menu.
    - **The waveform is a slider** (`role="slider"`, "Position", values in seconds and words, "1 minute 42 seconds of 4 minutes 36 seconds"): arrows move 5 s, Page Up/Down 30 s, Home/End the ends; dragging shows the time under the pointer. The running time isn't announced: a focused slider changes its values only when someone moves it.
    - **The "…" menu** holds what the old player's utility row held: Add to playlist, Report a problem, Lyrics (with "Synced"), Track details, Speed, Sleep timer, Crossfade library tracks, Equalizer, A–B loop, Add similar tracks when the queue ends (the old radio mode), Download missing queue tracks, Clear played tracks, Visuals, Player settings, Keyboard shortcuts, Stop and clear the queue. Menus are `#141416`, 14px radius, 44px rows.
    - **Source kinds** (`data-source` on the player; `sourceView()` in `player-state.ts`): library and stream as above; podcasts and audiobooks get the speed button ("1.2×"), −15 s / +30 s in place of Previous / Next, and chapter ticks on the waveform; radio shows a Live tag in place of the times, a level meter in place of the waveform, and one action slot (empty until the radio build fills it).
    - **Phone (≤768px):** a 64px mini bar on the tab bar (`#141416`, art, "title · artist", "source · format", one action: Next, or +30 s for spoken word, and Play/Pause) that opens the tray as a `#141416` sheet (`html[data-player-sheet]`, a dialog that keeps focus inside, Close, Escape). The sheet isn't remembered.
    - **Visuals** (the old theater, `#np-modal-overlay`): the full-screen visualizer with its own transport and drawer, opened from the "…" menu or F.
- **Preview, then confirm** (`features/safe-action`):
    - counts first, a plain sentence saying what happens, then a sample list with "Download the full list";
    - when the preview stops working;
    - Cancel, plus a button that names the action ("Move 214 files");
    - a done state afterwards.

  The dialog is 680px wide, 16px radius, `#17171c`, with 44px footer buttons. Large moves show a warning box (14px radius, 35% border, 7% fill) with an "I checked the list" checkbox. Until it's ticked the confirm is the neutral disabled button, and the footer says why beside it ("Tick "I checked the list" to move the files."). Permanent deletes use `confirmTone="danger"`: dark text on `#f87171`, a title that says "Permanently delete …?" and a first line that says "This can't be undone."

  Turning on a setting that will delete files later (the quality profile's "Keep lossy output only") asks in the same dialog: a question title, "This can't be undone." and a short list of what happens, Cancel and the danger button named for it ("Delete originals after converting"). Nothing saves until it's confirmed. Bulk fixes add a "What happens" column per item, and a title that names the worst thing that happens: "Permanently delete 2 files?" whenever any delete is permanent, with the full picture in the lead ("This can't be undone. Fixes 4 findings: 2 files deleted for good, 1 moved to the recycle bin, 1 renamed."), and "Fix 4 findings?" only when nothing is permanent; the Lossy Converter's tiles are Files to convert / Originals deleted / Space freed.

  A refused confirm keeps the dialog's title and fades the counts to 50%. A warning Notice says "This preview has expired" (409 `plan_expired`) or "This preview can no longer be used" (other plan codes), with the backend's sentence and "Nothing was moved or deleted."; the footer has Cancel and a primary "Preview again". Any other failure is a danger Notice, "That didn't go through", with Close.
- **Setup check** (`routes/setup-check`): summary tiles, then checks grouped by area with problems first. Anything not OK gets a "How to fix it" box with copyable lines.
- **Radio cards with a swatch** (Settings → Appearance, `static/appearance.css`, `src/shell/appearance.ts`): a 4-up grid (2-up in a narrow pane, swatch above the name on a phone) of 14px cards with a 16% border; each a 60×40 swatch (the accent 40px wide, its light shade 20px, 10px outer radius), the name at 15/600 and a 14px meta line. Selected = 14% accent wash + 45% accent border, with "Selected" in words. `role="radiogroup"` with `role="radio"` cards: one tab stop (the checked card), the arrow keys and Home/End move the choice and the focus together. The odd one out (Custom…) has a dashed border and a dashed "#" swatch until it holds a colour.
- **A Kind row** (Wanted → Following, 5e): under the Show filters, a 14/500 "Kind" label, OptionButtons with counts for each kind, and the sort select at the row's end; on phones it scrolls sideways like the filters. Rows of mixed kinds start their meta line with the kind ("Label · …"); art is round for people and square for everything else, with initials (labels) or an icon (podcasts) when there's no picture.
- **Modules** (Settings → Modules, legacy page restyled in `static/modules.css`): a 14px card; one row per module on hairlines, with a 104 × 44px switch control (10px radius, a round 40 × 24px track inside, "On"/"Off" beside it). Turning one off asks first in a warning box with "Turn off X" and "Keep it on"; afterwards the row says so with a status dot; a restart notice shows when the server says it's needed. Non-admins see a dot and a word, no switch.
