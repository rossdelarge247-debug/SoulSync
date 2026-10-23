# Backlog

New features Ross wants explored, written up so Design can pick them up. Each entry says what the problem is, what the app can and can't give today, and what Design needs to decide.

**Status:** **Exploring** = still being shaped with Ross · **Ready for Design** = Design can draw it · **Designed** = boards on the canvas, waiting for Ross · **Approved** = Ross approved the boards; Dev builds from them · **Building** = on a branch · **Built** = in `integration` (then it moves to `SCREENS.md`).

| Feature | Status | Entry |
| --- | --- | --- |
| Automation assistant (AI) and a block editor | Built | [below](#automation-assistant-ai-and-a-block-editor) |
| Internet radio with track identification | Built | [below](#internet-radio-with-track-identification) |
| Merge duplicate artist | Exploring | [below](#merge-duplicate-artist) |
| Classic Winamp visualisers (MilkDrop, AVS, bars and scope) | Built (AVS: later spike) | [below](#classic-winamp-visualisers-milkdrop-avs-bars-and-scope) |
| Move your music folders to another drive | Exploring | [below](#move-your-music-folders-to-another-drive) |

---

## Automation assistant (AI) and a block editor

**Status:** Built · raised by Ross, 2026-10-22 · drawn by Design and approved by Ross the same day: `Automation assistant (block editor).dc.html` (3a–3l) and Settings → AI in `Settings AI and Radio.dc.html` (5a). Design's answers are in `HANDOFF.md` (2026-10-22); the build is (d) there. Built on `ux/assistant`: `HANDOFF.md`, "Dev, the Assistant, the block editor and Settings → AI"; the routes are in `CONTRACTS.md`, "The Assistant".

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

**Status:** Built · raised by Ross, 2026-10-22 · drawn by Design and approved by Ross the same day: `Internet radio.dc.html` (4a–4k) and Settings → Radio in `Settings AI and Radio.dc.html` (5b–5d). Design's answers are in `HANDOFF.md` (2026-10-22); the build is (e) there. Built on `ux/radio`: `HANDOFF.md`, "Dev, Internet radio and Settings → Radio"; the routes are in `CONTRACTS.md`, "Internet radio".

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
- **Scan now** (Ross, 22 October): an on-demand "Scan now" that listens to about ten seconds on the server and identifies it: AcoustID first (free), then AudD and/or ACRCloud only when an admin has added that service's key in Settings → Radio. This relaxes "free only" for this one button: paid services are never used by the automatic identification or auto-add. Built on `ux/radio-scan` before Design drew it (`HANDOFF.md`, "Dev, Scan now for radio"; question 58); routes in `CONTRACTS.md`, "Internet radio" → Scan now.

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

---

## Classic Winamp visualisers (MilkDrop, AVS, bars and scope)

**Status:** Built (AVS: later spike) · raised by Ross, 2026-10-22 · drawn by Design on 23 October (`Visuals (Winamp visualisers).dc.html`, 10a–10f) and approved by Ross the same day, with his decisions (auto-cycle Off by default; phones start at Full; presets through npm plus your own folder; AVS not in this phase). Built on `ux/oct23-4`: `HANDOFF.md`, "Dev, phase 4 (the visualisers: MilkDrop and Classic)"; the routes are in `CONTRACTS.md`, "Visuals".

### What was built

- **SYNCHRO.S** (today's 18 visuals), **MilkDrop** and **Classic** (Winamp's 19 bars with falling peaks, and the oscilloscope) as three families in the overlay's panel, with search, favourites per profile, Recent, an Author select, hover preview, the credit, auto-cycle (Off by default), Blend, Quality with the frame-rate guard, and every state on 10d.
- **Presets:** Butterchurn and `butterchurn-presets` are npm dependencies of `webui` (package.json and the lockfile). The build copies the presets out of `node_modules`; nothing is vendored. An admin can add a folder of `.milk` files ("Author - Title.milk"), converted in the browser when one is picked.

### Licences and where the presets come from (Dev checked, 23 October)

- **butterchurn 2.6.7:** MIT (package metadata and `LICENSE`, © 2013–2018 Jordan Berg). Its dependencies `@babel/runtime` and `ecma-proposal-math-extensions` are MIT.
- **butterchurn-presets 2.4.7:** MIT (package metadata and `LICENSE`, © 2013–2018 Jordan Berg); dependencies `babel-runtime`, `core-js` 2, `regenerator-runtime`, `lodash` and `ecma-proposal-math-extensions`, all MIT. The package has no repository field; its source is `github.com/jberg/butterchurn-presets` (the README says only "Presets for the Butterchurn Music Visualizer").
- **Where the presets come from:** they're the MilkDrop community's own `.milk` presets (Geiss, Rovastar, Flexi, Eo.S., Aderrasi, martin, fiShbRaiN, Zylot, $$$ Royal and about 330 more authors), converted to Butterchurn's JSON by Jordan Berg's converter; the repository keeps the original `.milk` files beside the converted ones (`presets/milkdrop/`, `presets/converted/`). The package ships 1,754 converted presets (`presets/converted/`), of which 395 are in its curated packs (base, Extra, Extra2, MD1, Minimal, NonMinimal); the repository also keeps a list of 23 it found broken. Each preset's name is "Author - Title", which is the credit; the authors gave no licence of their own, as with every MilkDrop pack (Winamp's, projectM's), and the MIT notice covers Jordan Berg's packaging and conversion. That's what Design and Ross expected ("MIT packaging of converted classic presets; each preset's name stays its creator's"), so Dev built on it. The app lists all 1,754; a preset that doesn't compile in a browser says "Won't load" and auto-cycle skips it.
- **The converter for your own presets:** `milkdrop-preset-converter` 0.1.2 (MIT, Jordan Berg) with `milkdrop-eel-parser` 0.0.1 (MIT), `milkdrop-preset-utils` 0.1.0 (MIT) and `hlslparser-js` 0.1.1 (MIT, for the shaders). It runs in the browser, loaded only when one of your own is picked.
- **AVS: a later spike, not built.** Winamp's own AVS source is under a licence that doesn't allow reuse. The candidate is Webvs (MIT, unmaintained, partial effects): try about 20 well-known presets and ship only if most render right, fed only from presets the person supplies (never bundled). Until then the AVS family button isn't shown (Ross, 23 October).

### The problem

Ross wants the visualisers Winamp was loved for inside SYNCHRO.S's Visuals overlay: MilkDrop above all, AVS, and Winamp's own little spectrum bars and oscilloscope. The overlay has 18 visuals today, drawn by the app; none is MilkDrop-class.

### What Ross wants

- **Which:** MilkDrop, AVS, and the classic Winamp bars and scope. Not the Winamp skin look: they sit in the design system's overlay.
- **Where:** the Visuals overlay only (the player's "…" → Visuals, or F), alongside the existing visuals. Not the tray, not a page background.
- **Presets:** the huge MilkDrop library with search, not a small curated pack.

### What the app gives today (Dev checked)

- **The Visuals overlay** (`#np-modal-overlay`, `static/media-player-v2.js`): a full-screen canvas, a grid of visuals in its panel, ‹ › to step through them, F to open, V for the next one, the choice remembered per browser.
- **Live audio data:** the player builds one Web Audio graph per page (`static/media-player.js`: a `MediaElementSource` and an analyser), which the existing visuals and the radio level meter read. A new visualiser connects to the same graph; it doesn't open the audio again.
- **No WebGL visuals yet;** everything draws on a 2D canvas.

### Where they come from (all free; licences to confirm before building)

- **MilkDrop:** [Butterchurn](https://www.npmjs.com/package/butterchurn), an MIT-licensed WebGL 2 reimplementation of MilkDrop 2, with [butterchurn-presets](https://www.jsdelivr.com/package/npm/butterchurn-presets) (MIT packaging of converted classic presets; each preset's art and name stay its creator's, and the preset name carries the credit). It plays the original `.milk` community presets, and the big packs run to thousands. It needs WebGL 2; Butterchurn has its own "is it supported" check.
- **AVS:** harder. Winamp's 2024 source release is under a restrictive licence that doesn't allow reuse, so it's out ([context](https://liliputing.com/winamp-source-code-is-now-available-under-a-pretty-restrictive-license/)). A separate JavaScript/WebGL port of AVS and its presets exists in the community, but Dev hasn't confirmed which one or its licence yet. AVS may land later than MilkDrop or with fewer presets.
- **Classic bars and scope:** drawn by the app itself (no licence question), matching Winamp's 75×16 spectrum and oscilloscope look scaled up.

### Constraints for the design

- **Size:** thousands of presets are several MB. Load them on demand (the list and search index first, each preset when picked), never on page load.
- **Performance:** WebGL MilkDrop is heavy on older laptops and phones. Offer a quality setting (resolution scale) and fall back calmly when WebGL 2 isn't there ("This visual needs WebGL 2, which this browser doesn't offer"). Honour "Reduce visual effects" and `prefers-reduced-motion`.
- **Credit:** show each preset's author in the picker and while it plays.
- **Radio:** works the same on radio (the level meter already reads the graph); direct streams that don't allow cross-origin audio give silence to any visual, so those show the "can't read this stream's sound" note.

### States Design needs to draw

- The Visuals panel with three families: SYNCHRO.S's own visuals, MilkDrop, AVS, and Classic (bars and scope).
- The MilkDrop browser: search, categories or authors, favourites, recently used, preview on hover or focus, and how a preset's author is credited.
- Auto-cycle: every N seconds, on track change, or off; "next preset" key; a short blend between presets.
- Playing: the preset name and author briefly on change, then gone; quality setting.
- Loading a preset, a preset that fails to load, WebGL 2 unavailable, reduced motion on.
- Phone: whether MilkDrop is offered there at all, or only the light visuals.

### Questions for Design

1. How do three families sit in the existing panel: tabs, sections, or a family switch?
2. How much of the MilkDrop browser shows at once over a full-screen visual?
3. Where does the preset credit go, and for how long?

### Questions for Ross (later)

- Default for auto-cycle: on track change, or every 30 seconds?
- Offer MilkDrop on phones, or keep phones to the light visuals?

---

## Move your music folders to another drive

**Status:** Exploring · raised by Ross, 2026-10-23

### The problem

The library, downloads and staging folders start on the computer's own disk. When it fills up, or the music should live on an external drive, moving them today means stopping the app, copying by hand, editing the Docker set-up and hoping nothing points at the old place. One slip and Library shows everything missing, downloads land nowhere, or slskd shares an empty folder.

### What Ross wants

A wizard in the app that safely moves the library, downloads and staging to a new folder on a different drive, "magically": pick where, see what will happen, press go, and everything carries on from the new place.

### What the app gives today (Dev checked)

- **Three folder settings:** the download folder (`soulseek.download_path`), the library (`soulseek.transfer_path`) and staging (the auto-import worker's `staging_path`), in Settings → Library → Folders. The database stores library files by path, so a move must rewrite those paths, or keep the paths the app sees unchanged.
- **Docker is the catch.** In the usual set-up the app sees fixed folder names inside its container (`/app/Transfer`, `/app/downloads`, `/app/Staging`); which real folder each one is lives in `docker-compose.yml`, outside the app. A container can't see a new drive or change its own mounts. So either the drive is made visible once (for example the Mac's `/Volumes` mounted into the container) and the wizard moves within it and switches the settings, or the wizard does everything it can, then hands over a short, generated set of steps (or a helper script) for the part outside the container.
- **slskd** shares the library from its own container, so a move must repoint slskd too, then rescan its shares (the rescan after imports, `feat/slskd-rescan`, does the second half).
- **Safe-action pattern:** preview, then confirm, with the recycle bin, already exists (`features/safe-action`); a move fits it.

### Rules for every design

- **Copy, check, then switch; never move first.** Copy everything, verify every file arrived (count and size, optionally a checksum), switch the app over, and keep the old copy until the person says they're happy. Deleting the old copy is a separate, later step.
- **Check before starting:** enough free space on the new drive, the drive's format (warn on exFAT: macOS litters it with hidden `._` files that slskd would share), and that the app can write there.
- **Pause what writes to these folders** while copying (downloads, imports, automations that move files), and say so; resume afterwards.
- **Admin-only.**
- **A drive that's unplugged later** should be noticed and said plainly ("Your library's drive isn't connected"), never shown as an empty library or acted on (no "missing files" clean-up).

### States Design needs to draw

- Choose: the three folders, what each holds and its size, where each goes (one new parent folder, or each separately).
- Checks: space, format, write access; what's wrong and how to fix it.
- The plan: what will be copied, how long it might take, what pauses meanwhile.
- Copying: progress per folder, stoppable (stopping leaves everything as it was).
- Verifying, then switching over.
- The Docker step, when needed: the exact lines to change or a command to run, with a "Check again" button that confirms the app now sees the new place.
- Done: everything working from the new place; "Remove the old copies…" offered, not done.
- Failure at any step: what happened, and that the old folders are untouched.
- Drive not connected (later, on any page).

### Questions for Design

1. Where does it live: Settings → Library → Folders ("Move to another drive…"), Maintenance, or both?
2. One parent folder for all three by default, or each folder chosen separately?
3. How much of the Docker step can be made un-scary for someone who's never edited a file in Terminal?

### Questions for Ross (later)

- Should it also offer moving the app's settings and database (for a move to a new machine), or only the music folders?

