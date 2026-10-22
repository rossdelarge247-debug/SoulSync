# Backlog

New features Ross wants explored, written up so Design can pick them up. Each entry says what the problem is, what the app can and can't give today, and what Design needs to decide.

**Status:** **Exploring** = still being shaped with Ross · **Ready for Design** = Design can draw it · **Designed** = boards on the canvas, waiting for Ross · **Approved** = Ross approved the boards; Dev builds from them · **Building** = on a branch · **Built** = in `integration` (then it moves to `SCREENS.md`).

| Feature | Status | Entry |
| --- | --- | --- |
| Automation assistant (AI) and a block editor | Approved | [below](#automation-assistant-ai-and-a-block-editor) |
| Internet radio with track identification | Approved | [below](#internet-radio-with-track-identification) |
| Merge duplicate artist | Exploring | [below](#merge-duplicate-artist) |

---

## Automation assistant (AI) and a block editor

**Status:** Approved · raised by Ross, 2026-10-22 · drawn by Design and approved by Ross the same day: `Automation assistant (block editor).dc.html` (3a–3l) and Settings → AI in `Settings AI and Radio.dc.html` (5a). Design's answers are in `HANDOFF.md` (2026-10-22); the build is (d) there.

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

### Settled with Ross

- Settings → AI shows usage (requests, an estimated cost from token counts, drafts saved) and an optional monthly cap that stops the Assistant only.
- The default model is the faster, cheaper one; the best one is a click away.

### Design's questions for Dev, answered from the code

- **A streamed chat route that returns drafts in the body `POST /api/automations/preview` takes:** doesn't exist yet; proposed in `CONTRACTS.md`, "Needs building". It streams over a plain HTTP response (server-sent events). The app runs one gunicorn worker with 8 threads and an open stream holds one, so at most two Assistant streams run at once and a third is told to wait. Every draft is checked against `blocks_for_scope('music')` and `needs_admin()` (`core/automation/blocks.py`, `core/automation/api.py`) before it's sent, so a draft can always be previewed and members never get admin-only steps.
- **A set-up status route for "Not set up" and the error states:** doesn't exist yet; `GET /api/ai/status` is proposed in `CONTRACTS.md`. The key is stored with the app's other encrypted secrets (`core/settings.py` encrypts them at rest and `redacted_config()` masks them on read).
- **Plain-language labels on `GET /api/automations/blocks`:** yes. Every trigger, action and notification has a `label` and a `description` (for example "Schedule" / "Run on a timer interval"), and every setting has its own `label`. The Assistant can use them as they are.
- **Wanted items' added date:** yes, `wishlist_tracks.date_added` (and `last_attempted`), already in the Wanted payload (`core/wishlist/service.py`).
- **An automation's paused-since:** no. `automations` has `enabled` and `updated_at`, and `updated_at` changes on every edit. It needs a `paused_at` column, set when an automation is turned off and cleared when it's turned on.
- **"Not now" stored per profile:** nothing general exists (Activity's dismiss is only for expired previews). It needs a small table: profile, the suggestion's key, and when it was dismissed.
- **What each Wanted search found (HANDOFF 19):** the run's `result_json` exists, but the run ends before its batches finish (they run in the background), so the found count has to be written back to the run row when the batches complete. Built with (d).
- **Settings → AI:** drawn since (5a).

---

## Internet radio with track identification

**Status:** Approved · raised by Ross, 2026-10-22 · drawn by Design and approved by Ross the same day: `Internet radio.dc.html` (4a–4k) and Settings → Radio in `Settings AI and Radio.dc.html` (5b–5d). Design's answers are in `HANDOFF.md` (2026-10-22); the build is (e) there, after the player (c).

### The problem

Good radio is one of the best ways to find music, but what you hear is gone the moment it ends. You have to catch the track name, search for it later, and add it by hand. Ross wants the best free stations inside SoulSync, with whatever's playing identified and one click from Wanted.

### What Ross wants

- **An Internet radio area** with built-in picks of high-quality free stations in four kinds: **electronic** (house, techno, ambient, downtempo, leftfield), **world**, **eclectic tastemakers**, and **jazz, soul and funk**. Plus a search across a large free directory.
- **Now playing, identified:** the artist and title of what's on, matched to your library: "In your library" or "Add to Wanted".
- **Adding to Wanted both ways:** one click per track by default, plus an optional **auto-add switch per station** that sends everything identified on it to Wanted (skipping what you already have).
- **Heard on radio:** a running list of identified tracks, so you can add them later.
- **Favourite stations,** including your own stream links.
- **Lossless where offered:** prefer FLAC or high-bitrate streams when a station has them, and show each stream's quality.
- **Tracklists after shows** for stations that publish them, with Add to Wanted on each line.
- **Radio in automations:** a new trigger such as "a track I don't have was played on a favourite station".
- Free only: no paid services.

### What the app gives today (Dev checked)

- **No internet radio.** "Library Radio" and Discover's "Recommended Stations" play tracks from your own library; this is a separate thing and needs a name that doesn't clash ("Internet radio", "Stations"…).
- **A player that keeps playing between pages** (the app's media player): radio should use it, so a station keeps going while you browse.
- **Add to Wanted from an artist and title** already exists (Search uses it), with the "already in your library?" check (`POST /api/enhanced-search/library-check`) and the quality target.
- **Track identification tools** are installed: Chromaprint (`fpcalc`), ffmpeg and AcoustID, used today to identify whole downloaded files.
- **Module switches** exist, so radio can be a module people turn off.

### Where stations and track names come from (all free)

- **Built-in picks:** a curated list Dev maintains, e.g. SomaFM, Radio Paradise (including lossless FLAC streams), FIP and its genre channels (Electro, Groove, Monde, Jazz), KEXP, NTS, Worldwide FM, dublab. Many publish what's playing now, and some publish tracklists after shows.
- **The Radio Browser directory:** about 50,000 community-listed stations, searchable by genre, country, codec and bitrate, with no account or key.
- **Identification, in order:** (1) the station's own now-playing information, the most accurate; (2) the artist and title many streams send alongside the audio; (3) a fingerprint fallback with the tools already installed. Expect gaps: DJ mixes, talk and live sessions often won't be identified, and the design should say "Not identified" calmly rather than guess.

### Constraints for the design

- **Identification lags a little.** Station data and fingerprints arrive a few seconds to a minute after a track starts. "Now playing" needs a "Listening…" state and a short history.
- **Auto-add needs guards:** skip anything already in the library or on Wanted, never add the same track twice, and show what it added (Activity already records what happens). A daily limit per station is worth considering.
- **Streams and safety:** the server reads stream titles (browsers can't) and, when needed, relays the audio. It only does this for stations from the built-in list, the directory or a link an admin added, only for audio, and only while someone is listening.
- **Quality labels** come from what the station declares (codec, bitrate); a stream can be lower than it claims.

### States Design needs to draw

- The radio home: built-in picks by kind, favourites, search.
- A station playing: now playing (identified / Listening… / Not identified), In your library or Add to Wanted, the auto-add switch, stream quality, Heard on radio.
- A show's tracklist after broadcast.
- Search results from the directory, with quality and country.
- Adding your own stream link.
- A station that's offline or won't play, and identification switched off or unavailable.
- Phone: playing and adding from the player, and the Heard list.

### Questions for Design

1. Where does radio live in the navigation: Get music, Library, or its own row? And its name, since "Library Radio" already exists.
2. How much of now playing sits in the persistent player versus the radio page?
3. How does the auto-add switch read, so people understand it can fill Wanted?
4. Does "Heard on radio" belong on the radio page, in Activity, or both?

### Settled with Ross

- Auto-add is limited to 50 a day per station (Settings → Radio can change it).
- Radio doesn't count towards Home.
- "Library Radio" is now "Shuffle your library" (Ross, 22 October; built with the player).

### Design's questions for Dev, answered from the code

- **Stations, directory search, now playing, Heard, auto-add, tracklists, admin-added links:** none of it exists; all proposed in `CONTRACTS.md`, "Needs building". What's there to build on: Chromaprint (`fpcalc`) and AcoustID (`acoustid.api_key` in settings, used by `core/metadata/manual.py`); the "already in your library?" check (`POST /api/enhanced-search/library-check`); adding to Wanted from an artist and title, as Search does; module switches (`core/modules.py`).
- **A radio mode for the player:** the player (`static/media-player.js`) plays a URL through one `<audio>` element, so a station can play there. Most streams need the server in between: browsers can't read the titles a stream sends, and many streams are plain `http` or don't allow other sites. The server relays a station only while someone is listening. Each relay holds one of the server's 8 threads, so relays are capped (two at once to start) and an `https` stream that allows it plays directly, with titles taken from the station's own now-playing feed.
- **Fetching links safely:** the server fetches only stations from the built-in list, the directory, or an admin's link; it refuses private and link-local addresses (the guard chat's link previews use, `api/chat.py`), passes on only audio, and never follows a redirect to a private address.
- **An Activity kind for auto-add roll-ups:** the feed's kinds are `download`, `import`, `automation`, `sync`, `safety` (`core/activity/feed.py`); this adds `radio`, one item per station per hour.
- **The radio trigger for the When block:** a new trigger in `core/automation/blocks.py`, "A track I don't have played on a favourite station", fired by the now-playing watcher. It shows in the block editor through `GET /api/automations/blocks` like any other.
- **Settings → Radio:** drawn since (5b–5d). Setup check gains rows for `fpcalc` and the AcoustID key.

---

## Merge duplicate artist

**Status:** Exploring · from Design's answer to HANDOFF question 14, 2026-10-22, agreed by Ross

### The problem

The same artist can end up as two library artists (different spellings, a "The", a featuring credit). The artist page's "…" menu had "Merge duplicate artist" on the board, but SoulSync has no artist merge.

### What it would be

A Maintenance tool, not an artist-page action, because it rewrites files' metadata: pick the artist to keep and the one to fold in, preview what changes (tracks retagged, albums moved, followed and Wanted entries repointed), then confirm, like the other preview-then-confirm tools (`features/safe-action`).

### What the app gives today

- Moving one album to another artist in the tag tools.
- Preview-then-confirm plans (`core/library/action_plans.py`) for anything that moves or rewrites files.

### Next

Dev to check how artists are keyed across the library, Wanted and Following before Design draws it.

