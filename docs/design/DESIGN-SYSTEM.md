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
  | Purple | `#a78bfa` | `#e2d9fd` | 14.6:1 |
  | Boulder Purple | `#8b5cf6` | `#c2a9fa` | 9.7:1 |
  | Sunset Orange | `#f59e0b` | `#f8bd59` | 11.6:1 |
  | Rose | `#f43f5e` | `#f88c9f` | 8.6:1 |
  | Teal | `#14b8a6` | `#35e9d5` | 12.9:1 |

  There is also "Custom" (any hex). The server (`web_server.py`) and `init.js` (`applyAccentColor`) compute the pair; CSS reads them as `--ss-accent-rgb` and `--ss-accent-light-rgb`.
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

## Patterns already built

- **Preview, then confirm** (`features/safe-action`):
    - counts first, a plain sentence saying what happens, then a sample list with "Download the full list";
    - when the preview stops working;
    - Cancel, plus a button that names the action ("Move 214 files");
    - a done state afterwards.

  The dialog is 680px wide, 16px radius, `#17171c`, with 44px footer buttons. Large moves show a warning box (14px radius, 35% border, 7% fill) with an "I checked the list" checkbox. Until it's ticked the confirm is the neutral disabled button, and the footer says why beside it ("Tick "I checked the list" to move the files."). Permanent deletes use `confirmTone="danger"`: dark text on `#f87171`, a title that says "Permanently delete …?" and a first line that says "This can't be undone."

  A refused confirm keeps the dialog's title and fades the counts to 50%. A warning Notice says "This preview has expired" (409 `plan_expired`) or "This preview can no longer be used" (other plan codes), with the backend's sentence and "Nothing was moved or deleted."; the footer has Cancel and a primary "Preview again". Any other failure is a danger Notice, "That didn't go through", with Close.
- **Setup check** (`routes/setup-check`): summary tiles, then checks grouped by area with problems first. Anything not OK gets a "How to fix it" box with copyable lines.
- **Modules** (Settings → Modules, legacy page restyled in `static/modules.css`): a 14px card; one row per module on hairlines, with a 104 × 44px switch control (10px radius, a round 40 × 24px track inside, "On"/"Off" beside it). Turning one off asks first in a warning box with "Turn off X" and "Keep it on"; afterwards the row says so with a status dot; a restart notice shows when the server says it's needed. Non-admins see a dot and a word, no switch.
