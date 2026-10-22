# Backlog

New features Ross wants explored, written up so Design can pick them up. Each entry says what the problem is, what the app can and can't give today, and what Design needs to decide.

**Status:** **Exploring** = still being shaped with Ross · **Ready for Design** = Design can draw it · **Designed** = boards on the canvas, waiting for Ross · **Building** = on a branch · **Built** = in `integration` (then it moves to `SCREENS.md`).

| Feature | Status | Entry |
| --- | --- | --- |
| Automation assistant (AI) and a block editor | Ready for Design | [below](#automation-assistant-ai-and-a-block-editor) |

---

## Automation assistant (AI) and a block editor

**Status:** Ready for Design · raised by Ross, 2026-10-22

### The problem

Building an automation means knowing which of 45 triggers, 34 actions and 8 notification types to pick and how to set each one. People know what they want ("when an artist I follow releases something, get it in FLAC and tell me on Telegram") but not how to say it in the builder, and they don't know what's worth automating in the first place.

### What Ross wants

An enhanced area in Automations with two halves that work together:

1. **A Notion-style editor.** An automation is a stack of blocks: when, do, then. Type "/" to add a block, drag to reorder the follow-up steps, set each block's options inline. It works without AI.
2. **An assistant you talk to,** in a Notion AI-like dialogue, that can:
   - **Describe it, get a draft:** turn a sentence into a ready-to-review automation.
   - **Suggest:** offer automations worth having, based on what's actually happening in the library.
   - **Explain and fix:** say what an automation does in plain words, or why a run failed and what to change.
   - **How-to help:** answer questions about automations and SoulSync.

The assistant uses **a cloud model with Ross's own API key** (start with Anthropic's Claude; other providers can come later).

### What the app gives today (Dev checked)

- **A machine-readable parts list:** `GET /api/automations/blocks` returns every trigger, action and notification with its settings. The assistant builds only from these, so a draft can always run.
- **Drafts can be previewed:** `POST /api/automations/preview` dry-runs an unsaved automation (`CONTRACTS.md`, "Automations: Preview a run"). The assistant's draft can show what it would do before anyone saves it.
- **Context the assistant can read:** your automations and their run history and logs (`/api/automations/<id>/history`, `/api/activity/log/<id>`), what needs you (`/api/activity`), your targets (`/api/targets/summary`), Wanted and followed-artist numbers, the quality target, which modules are on, and setup check results.
- **Recipes** for common automations already exist (Automations "…" → Recipes and guides): a starting point for suggestions.
- **No AI anywhere yet** (only subtitle transcription), so the connection is new: an AI section in Settings, admin-only, with the API key stored encrypted like the app's other secrets.

### What the engine can and can't express

An automation is one trigger, one action (with an optional wait before it), then up to three follow-up steps that can only notify, fire a signal or run a script. Several actions in a row ("search, then tag, then notify") aren't possible today. The block editor should show this shape honestly: one "When", one "Do", up to three "Then". A longer chain would need engine work; flag it if a design depends on it.

### Rules for every design

- **The assistant only writes drafts.** A draft opens in the editor; the person previews and saves it themselves. The assistant never saves, runs, or sends a test notification on its own.
- **Admin-only steps stay admin-only:** scripts, clean-ups, backups. The assistant doesn't offer them to members.
- **Say where data goes.** The first time someone uses the assistant, one plain line says that their automation details and the library facts it uses are sent to the AI provider set up in Settings.
- **Show its working.** A draft or suggestion says why ("23 tracks have been on Wanted for over a month without being found"), and every block it adds can be changed or removed like any other.
- **Text from the library is data, not instructions.** Track names, playlist names and run logs go to the model only as information; what comes back is checked against the parts list before it's shown.

### States Design needs to draw

- Not set up: no API key yet. One sentence and a button to Settings → AI (admins), or "Ask an admin to set this up" (members).
- Thinking, with a way to stop.
- A draft ready: the blocks, a one-line summary, "Preview a run", "Open in the editor", "Try again".
- A draft the assistant couldn't build (asked for something the engine can't do): it says what's missing and offers the nearest thing it can build.
- Suggestions: a short list with the reason for each, "Use this" (makes a draft) and "Not now".
- Explain: for a saved automation, and for a failed run (from its log).
- Provider errors: wrong key, out of credit, rate-limited, offline. Each says what happened in plain words, and nothing is lost.
- Phone: the dialogue and the editor must both work at 390px wide.

### Questions for Design

1. Where does it live: an "Assistant" tab beside the Automations list, a panel inside the editor, or both?
2. How does the block editor sit next to today's editor (2k/2l)? Does it replace it, or is it a mode?
3. How do suggestions appear: in the assistant only, or also as a card on the Automations list or on Home?
4. Should the assistant be able to look across the whole app ("why is Wanted so full?") or stay within Automations for the first version?

### Questions for Ross (later)

- A monthly spending cap or usage display in Settings → AI?
- Which model by default: the best answers, or the cheaper, faster one?
