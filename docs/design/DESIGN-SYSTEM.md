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
- **Accent** is the user's choice. Use the light variant (the accent with +16% HSL lightness, called `accent-light` in code) for:
    - links and accent text;
    - primary button fills, with **dark text** (`#0b0b0f`), which passes for all 7 presets (white on the accent fails for all of them);
    - focus.

  Selected states use a 14% accent wash with a 45% accent border.
- **Status:** success `#4ade80`, warning `#fbbf24`, danger `#f87171`, info `#38bdf8`. Tags use the colour at 12% as the background and the colour as the text. Status always comes with a word, and an icon where there's room.
- No gradient washes, no left-border accent cards, no emoji.

## Shape and space

- **Radii:** 6px tags, 10px controls and buttons, 14px cards, 16px dialogs. Circles only for avatars and status dots. No pill-shaped statuses or option buttons.
- **Touch targets:** at least 44px tall for buttons, switches and nav items.
- **Spacing:** cards pad 20–24px; gaps 8, 12, 16 or 24px; page gutter 40px on desktop, 16px on phones.
- **Layout:** pages are fluid, max content width about 1200px; sidebar plus content wrap to one column on phones; wide tables scroll inside their own box.

## Icons

Feather-style line icons, 24px viewBox, stroke 1.8 (nav) to 2 (controls), round caps and joins, drawn in `currentColor`. Icon-only buttons need an `aria-label`.

## Components that exist in React

Use these before drawing new ones. Paths are under `webui/src/`.

| Component | Where | Notes |
| --- | --- | --- |
| `PageHeader` | `components/page-header` | page title, subtitle, actions |
| `Button`, `FormField`, `TextInput`, `TextArea`, `Select`, `Checkbox`, `Switch`, `RangeInput`, `OptionCard(Group)`, `OptionButton(Group)`, `FormError`, `FormActions` | `components/form` | Button primary is already dark text on `accent-light` |
| `Badge`, `Notice`, `Spinner`, `Skeleton`, `EmptyState` | `components/primitives` | `Badge` is a pill; use `StatusTag` for statuses in new work |
| `DialogFrame`, `DialogHeader`, `DialogBody`, `DialogFooter` | `components/dialog` | accessible modal |
| `SafeActionDialog`, `StatusTag`, `GuardBox` | `features/safe-action` | preview, then confirm, for anything that moves or deletes files |

## Patterns already built

- **Preview, then confirm** (`features/safe-action`):
    - counts first, a plain sentence saying what happens, then a sample list with "Download the full list";
    - when the preview stops working;
    - Cancel, plus a button that names the action ("Move 214 files");
    - a done state afterwards.

  Large moves show a warning box with an "I checked the list" checkbox that unlocks the button.
- **Setup check** (`routes/setup-check`): summary tiles, then checks grouped by area with problems first. Anything not OK gets a "How to fix it" box with copyable lines.
- **Modules** (Settings → Modules): one row per module with a labelled switch ("On"/"Off" beside the colour). Turning one off asks first and says what disappears.
