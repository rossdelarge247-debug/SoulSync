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
  | Spotify Green (default) | `#1db954` | `#46e27d` | 11.6:1 |
  | Ocean Blue | `#1d8ab9` | `#46b3e2` | 8.2:1 |
  | Pale Purple (was "Purple") | `#a78bfa` | `#e2d9fd` | 14.6:1 |
  | **Lilac** (was "Boulder Purple") | `#8b5cf6` | `#c2a9fa` | 9.7:1 |
  | Sunset Orange | `#f59e0b` | `#f8bd59` | 11.6:1 |
  | Rose | `#f43f5e` | `#f88c9f` | 8.6:1 |
  | Teal | `#14b8a6` | `#35e9d5` | 12.9:1 |

  **Lilac is the fork's accent** (Ross, 2026-10-22): every board from Design's 22 October session renders in it (`--ss-accent-rgb: 139,92,246; --ss-accent-light-rgb: 194,169,250`), while the earlier boards still show green. Whether it becomes the default for new installs is Ross's to say; until then the default stays Spotify Green. Settings → Appearance (5f, built) shows each preset as a radio card with a 60×40 two-tone swatch (accent | accent-light) and a preview strip of the five things the accent touches: the primary button, a selected row, a link, the focus ring and the played waveform.

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
| `PageHeader` | `components/page-header` | page title, subtitle, actions |
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
| Compact rail | `html[data-sidebar="collapsed"]` | 72px; icons with `title` + `aria-label`; groups become 24px hairlines; counts become 8px dots. Desktop only. |
| Count badge | `.ss-badge` (`.ss-badge--warning`) | 13/600 on a 10% wash, 22px tall, 6px radius; a warning count in the warning colour at 12%. |
| Dot | `.ss-dot--warning`, `.ss-dot--info` | 8px; always with words beside it or for a screen reader (`.ss-sr`). |
| Disclosure ("Admin and help") | `.ss-admin` | A 44px button with `aria-expanded`; its state is kept in `localStorage`. |
| Popover beside the rail | `.ss-admin.is-popover-open .ss-admin-panel` | 256px, `#141416`, 14px radius, `0 20px 60px rgba(0,0,0,.45)`, a 12px title; Escape and a click outside close it and focus returns to its button. |
| Top bar | `#ss-topbar` | 64px (56px on phones): 44px icon buttons, the page name 15/500 (17/600 on phones), the 44px search field (max 520px, 24% border, `kbd` hint), the live link in the info colour with a pulsing 8px dot. |
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

Drawn by Design and approved by Ross on 22 October (`HANDOFF.md`). They move to "Components" or "Patterns already built" when they land.

### Block card (the automation editor, 3b)

- An automation is a stack of block cards: one **When**, one **Do** (with "after waiting N minutes"), and up to three **Then**. Each card is a 14px card in a `72px 1fr 44px` grid: a 12px uppercase label column ("WHEN", "DO", "THEN"), the block's settings inline (the selects and fields as before), and a 44px "…" or drag handle.
- Then cards have a drag handle and reorder by dragging (and with the keyboard, through the handle's menu).
- The line under the last Then card reads "Type / to add a follow-up · N of 3 left". Typing "/" there opens a `#141416` menu with Notify, Fire a signal, Run a script (admins only) and Ask the Assistant.
- A draft from the Assistant opens with an info `Notice` at the top saying where it came from; every block it added can be changed or removed like any other.
- The editor shows the engine's shape honestly: no second Do, and a fourth Then isn't offered.

### Assistant panel (3a–3l)

- Opened by "Assistant" in the Automations header. On the list it takes the right column (440px) in place of Runs; in the editor it shares the right column with Preview as two tabs. One conversation follows you between the two. On a phone it's a full-screen sheet.
- Header: the title at 18px, "New chat" and a 44px close. Then the thread: paragraphs labelled "You" and "Assistant". Library text the Assistant quotes (names, run logs) is shown as data, logs in Activity's `<pre>` style.
- **Draft card:** a "Draft ready" info tag, a one-line summary, a "Why this shape" line naming the facts used, a When / Do / Then mini list, then "Open in the editor" (primary on the list), "Preview a run" and "Try again".
- **Composer:** a textarea with a 44px send button; under it the data line "Writes drafts only. Sends … to Anthropic (Settings → AI)." The first time someone uses it, the same sentence shows as a Notice above the thread.
- **States:** Not set up (admins get "Open Settings → AI"; members get a sentence and no composer); Thinking (spinner, what it's reading, Stop); Couldn't build (a warning Notice naming the engine's limit, then a "Nearest I can build" card); provider errors as Notices: a wrong key or offline is danger, out of credit or rate-limited is warning, and the message stays in the composer.
- **Suggestion card on the list:** one at a time at the top of the list, a quiet card with a dashed 16% border, labelled "Suggested by the Assistant", with its reason (always with a number), "Use this" and "Not now".

### Player bar and tray (6a)

One component with two states, remembered per browser like the compact rail; both toggles carry `aria-expanded` pointing at the tray. It replaces the media player's chrome.

- **Bar (default):** 72px, pinned full width along the bottom of the window, under the sidebar as well as the page, on `#101010` with a top hairline. Grid `340px 1fr 400px`, padding 0 24px.
    - Left: a button holding 48px art, the title at 15/500 and "artist · format" as meta; clicking it expands the tray.
    - Centre: Previous, a 44px Pause in accent-light (10px radius, dark glyph), Next; the elapsed time (mono 14, tabular figures), a 28px waveform filling the remaining width, the total time.
    - Right: a volume icon and a 96px slider, a 44px output button, "Up next · N", and a labelled **Expand** button (chevron up, a 44px ghost with a 16% border).
- **Tray:** 360px tall, rising from the bar; the page keeps its width and loses height. Grid `280px 1fr 360px`, gap 32, padding 24 24 20.
    - Left, the record: 112px art, a "Now playing" label, the title at 18/600, the artist as a link, "album · year · track n of m"; a mono readout box (4% fill, 9% border, 10px radius) with Format ("FLAC 24/96 · 2,304 kbps") and Path ("Library → Living room"); the quality tag ("At your target") and "Open album".
    - Centre, the deck: a 72px scrubbable waveform (played bars accent-light, the rest 24% white, 2px gaps, 1px radius); elapsed on the left and remaining on the right (mono, tabular); Shuffle, Previous, a 48px Pause, Next and Repeat (44px square ghosts); then volume (140px) with a "−12 dB" mono readout and the output button ("Living room · AirPlay", 16% border).
    - Right, the list: Up next (count) / Recent as OptionButtons, Clear, and a labelled **Collapse** (chevron down) in the corner; queue rows at 56px in a `20px 40px 1fr auto` grid (grip, 40px art, title with "artist · format" or "podcast · 1.2×", duration in mono) on hairlines, reordered by dragging; a footer "4 of 8 · then the rest of Lantern · Show all". Escape also collapses.
- **Other sources:** radio shows a Live tag instead of the times, the identified track with Add to Wanted (or the In your library tag), and a level meter in place of the waveform (4a, 4b). Podcasts and audiobooks get a speed button ("1.2×"), −15 s / +30 s instead of Previous / Next, and chapter ticks on the waveform.
- **Phone:** a 64px mini bar above the tab bar (art, track · source, the one action, Stop) that opens a `#141416` sheet with the big card, transport, volume, output and Up next or Heard (4i, 4j).

### Station card (radio, 4a)

A 14px card: a 56px logo (6px radius), the name at 16/600, "kind · city", the declared quality as meta (FLAC as a success tag) and a 44px Play. The playing station uses the selected style with a "Playing" tag. Rows of four on the radio home.

## Patterns already built

- **Preview, then confirm** (`features/safe-action`):
    - counts first, a plain sentence saying what happens, then a sample list with "Download the full list";
    - when the preview stops working;
    - Cancel, plus a button that names the action ("Move 214 files");
    - a done state afterwards.

  The dialog is 680px wide, 16px radius, `#17171c`, with 44px footer buttons. Large moves show a warning box (14px radius, 35% border, 7% fill) with an "I checked the list" checkbox. Until it's ticked the confirm is the neutral disabled button, and the footer says why beside it ("Tick "I checked the list" to move the files."). Permanent deletes use `confirmTone="danger"`: dark text on `#f87171`, a title that says "Permanently delete …?" and a first line that says "This can't be undone."

  Turning on a setting that will delete files later (the quality profile's "Keep lossy output only") asks in the same dialog: a question title, "This can't be undone." and a short list of what happens, Cancel and the danger button named for it ("Delete originals after converting"). Nothing saves until it's confirmed. Bulk fixes add a "What happens" column per item; the Lossy Converter's tiles are Files to convert / Originals deleted / Space freed.

  A refused confirm keeps the dialog's title and fades the counts to 50%. A warning Notice says "This preview has expired" (409 `plan_expired`) or "This preview can no longer be used" (other plan codes), with the backend's sentence and "Nothing was moved or deleted."; the footer has Cancel and a primary "Preview again". Any other failure is a danger Notice, "That didn't go through", with Close.
- **Setup check** (`routes/setup-check`): summary tiles, then checks grouped by area with problems first. Anything not OK gets a "How to fix it" box with copyable lines.
- **Radio cards with a swatch** (Settings → Appearance, `static/appearance.css`, `src/shell/appearance.ts`): a 4-up grid (2-up in a narrow pane, swatch above the name on a phone) of 14px cards with a 16% border; each a 60×40 swatch (the accent 40px wide, its light shade 20px, 10px outer radius), the name at 15/600 and a 14px meta line. Selected = 14% accent wash + 45% accent border, with "Selected" in words. `role="radiogroup"` with `role="radio"` cards: one tab stop (the checked card), the arrow keys and Home/End move the choice and the focus together. The odd one out (Custom…) has a dashed border and a dashed "#" swatch until it holds a colour.
- **A Kind row** (Wanted → Following, 5e): under the Show filters, a 14/500 "Kind" label, OptionButtons with counts for each kind, and the sort select at the row's end; on phones it scrolls sideways like the filters. Rows of mixed kinds start their meta line with the kind ("Label · …"); art is round for people and square for everything else, with initials (labels) or an icon (podcasts) when there's no picture.
- **Modules** (Settings → Modules, legacy page restyled in `static/modules.css`): a 14px card; one row per module on hairlines, with a 104 × 44px switch control (10px radius, a round 40 × 24px track inside, "On"/"Off" beside it). Turning one off asks first in a warning box with "Turn off X" and "Keep it on"; afterwards the row says so with a status dot; a restart notice shows when the server says it's needed. Non-admins see a dot and a word, no switch.
