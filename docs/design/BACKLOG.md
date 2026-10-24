# Backlog

New features Ross wants explored, written up so Design can pick them up. Each entry says what the problem is, what the app can and can't give today, and what Design needs to decide.

**Status:** **Exploring** = still being shaped with Ross · **Ready for Design** = Design can draw it · **Designed** = boards on the canvas, waiting for Ross · **Approved** = Ross approved the boards; Dev builds from them · **Building** = on a branch · **Built** = in `integration` (then it moves to `SCREENS.md`).

| Feature | Status | Entry |
| --- | --- | --- |
| Automation assistant (AI) and a block editor | Built | [below](#automation-assistant-ai-and-a-block-editor) |
| Internet radio with track identification | Built | [below](#internet-radio-with-track-identification) |
| Merge duplicate artist | Exploring | [below](#merge-duplicate-artist) |
| Classic Winamp visualisers (MilkDrop, AVS, bars and scope) | Built (AVS: later spike) | [below](#classic-winamp-visualisers-milkdrop-avs-bars-and-scope) |
| Move your music folders to another drive | Built | [below](#move-your-music-folders-to-another-drive) |
| AudD on every track change | Exploring | [below](#audd-on-every-track-change) |
| DJ area: BPM, key and mixing (Traktor Pro 3) | Exploring (stage 1: Building; stage 2a: Built) | [below](#dj-area-bpm-key-and-mixing-traktor-pro-3) |
| Famous mixes and AI set suggestions | Ready for Design | [below](#famous-mixes-and-ai-set-suggestions) |
| Lyrics centre stage, timed to the words | Ready for Design (step 2: Exploring) | [below](#lyrics-centre-stage-timed-to-the-words) |

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

**Status:** Built · raised by Ross, 2026-10-23 · drawn by Design the same afternoon (`Move to another drive.dc.html`, 14a–14t) and approved by Ross: music folders only (settings and the database stay; moving to a new computer would be its own flow), the Docker step once and up front as one pasted helper command. Built on `feat/drive-move`: `HANDOFF.md`, "Dev, Move your music to another drive"; the routes are in `CONTRACTS.md`, "Your music's drives".

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

---

## AudD on every track change

**Status:** Exploring · raised by Ross, 2026-10-23, alongside automatic AudD (`HANDOFF.md`, "Dev, AudD listens automatically when the station doesn't say")

### The problem

Automatic AudD (built on `feat/audd-auto`) asks AudD only when a watched station doesn't name the track and the free AcoustID fingerprint didn't know it, up to a daily cap (100 by default). Stations that name their tracks are never checked, and a station that names them wrongly, late or loosely (a show's title, a DJ's own spelling) stays as it says.

### What the app gives today (Dev checked)

- **The step is there:** the hub already captures a clip from the relay for the automatic fingerprint and can ask AudD with it (`core/internet_radio/audd_auto.py`), with pacing per station and a daily cap counted before each request.
- **Only while the relay plays it:** clips come from the relay, so a station is checked only while someone plays it through SYNCHRO.S. Auto-add stations nobody is playing would need their own listener.

### The cost

**One AudD request per track, per station watched.** A music station plays roughly 12 to 20 tracks an hour, so one station played for a working day is 100 to 160 requests, and a station on auto-add around the clock could be 300 to 480 a day. That spends a paid plan's monthly allowance in days, and passes today's cap of 100 within hours.

### Questions for Ross

1. A higher cap: what daily cap (or monthly budget) would you be comfortable with? The field allows up to 1,000 today.
2. Per-station opt-in: should "AudD on every track change" be a switch on each station (its page or Settings → Radio's auto-add list) rather than for every station, so only the stations you care most about spend requests?

---

## DJ area: BPM, key and mixing (Traktor Pro 3)

**Status:** Exploring · raised by Ross, 2026-10-23 · **stage 1 is Building** on `feat/dj-stage1` (`HANDOFF.md`, "Dev, DJ stage 1"; routes in `CONTRACTS.md`, "DJ data"). **Stage 2a (Export to Traktor) is Built** on `feat/dj-traktor-export` from boards 21a and 21b (`HANDOFF.md`, "Dev, DJ stage 2a (Export to Traktor)"; routes in `CONTRACTS.md`, "Export to Traktor"); it needs a check in Traktor Pro 3 on Ross's Mac before it's called done. Stages 2b, 2c and 3 follow Design's Phase D order (direction approved by Ross, 24 October).

### The problem

Ross DJs with **Traktor Pro 3** on a Mac. His music lives in SYNCHRO.S, but nothing there says a track's tempo or key, so building a set means analysing everything again in Traktor, and SYNCHRO.S can't answer "what mixes well with this?". The two libraries drift apart: playlists made in SYNCHRO.S don't reach Traktor, and Traktor's cue points, beat grids and ratings never come back.

### What Ross wants, in three stages

1. **Stage 1 (Building): BPM, key and energy for the whole library.**
   - Work out BPM, musical key (shown in **Camelot** notation, 8A, with the musical name, A minor, as its title) and an energy level (1–10) for every track, in the background.
   - Write BPM and key into the files' own tags so Traktor, Mixxx, Rekordbox and Serato read them.
   - Library filters and sorting by BPM range and key.
   - A **"Mixes well with…"** list per track: the same key, a neighbouring key on the Camelot wheel (±1) or the relative major/minor, at a similar BPM (±6%, half and double time allowed).
2. **Stage 2 (later): Traktor Pro 3 integration,** in this order:
   - **(a) Export** (Built, 24 October: "Export to Traktor…" on a playlist's "…", Tracks' selection bar and the Mixes panel's foot; Settings → Library → Traktor Pro 3) playlists, "Mixes well with" sets and recent additions as Traktor `.nml` playlist files, for Traktor's Import Playlist. The paths in the file must be the ones **the Mac sees** (for example `/Volumes/Music/…` or `/Users/ross/Music/…`), not the container's (`/app/Transfer/…`), so the export needs a container-to-Mac path mapping (the drive move's work on host paths may give it).
   - **(b) Read `collection.nml`** (Traktor's own library file) **read-only**, to bring in cue points, beat grids, ratings, play counts and Traktor's own BPM and key.
   - **(c) Maybe two-way sync later,** only while Traktor is closed (it rewrites `collection.nml` on quit and would overwrite a change), with a backup of the file on every write.
3. **Stage 3 (Design exploration): a DJ area in the browser:** two decks with waveforms, sync, a crossfader, EQ and cues, plus a harmonic "next track" helper, all on Web Audio.

### Licence

**Mixxx is GPL, so none of its code can come into SYNCHRO.S** (MIT). Interop is through files only: tags in the audio files, and Traktor's `.nml` (an XML format Traktor documents by example; reading and writing it is our own code). Analysis is SYNCHRO.S's own (librosa, already used by Sample Studio).

### What stage 1 gives (Dev built)

- **The analysis is Sample Studio's,** extended rather than duplicated: one decode gives BPM, key (Krumhansl–Kessler profiles on the chroma, with a confidence) and now energy (the RMS level of the track's loudest half plus onset density, `core/sample/energy.py`). A track analysed in one is ready in the other.
- **Values kept with their source:** a BPM or key already in the file's tags wins, then the BPM the metadata source gave at import (Beatport, Deezer, Tidal), then analysis. Energy is analysis only.
- **Gentle on a laptop:** one track at a time at low CPU priority, resting between tracks, waiting while a download or an import runs and while the library's drive is unplugged. Activity shows it as a Library job with progress and Stop.
- **Tags:** only filled where a file has none, unless Ross turns on replacing them. An uncertain key is never written.
- **Library:** a **Tracks** page (its own sidebar row after Albums) with BPM, key and energy columns, a BPM range, a key filter ("and keys that mix") and sort by BPM; BPM and key on Listening history's, the Artist page's and Search's track rows; **Mixes well with…** in a track's "…" menu.
- **Settings → Library:** "Work out BPM, key and energy" (on), "Write BPM and key into the files' tags" (off) and "Also replace a BPM or key already in a file" (off).

### Questions for Design

1. **DJ data in Library:** stage 1 draws BPM and key as plain meta ("124 BPM · 8A") and Tracks as a table with three number columns, with no board. Should key carry colour (DJ software colours the Camelot wheel), should energy be a number, a bar or dots, and should BPM and key show on Albums' and the Artist page's rows more prominently?
2. **Where Tracks lives:** its own sidebar row after Albums (built), a tab beside Albums and Genres, or a "DJ" area of its own once stage 3 exists?
3. **The "Mixes well with…" panel:** built as a 680 dialog listing matches with how each mixes ("Same key · +1.6%", "Relative major", "+1 on the wheel", "half time") and Play next / Add to playlist. Should it be a side panel that stays open while you play, show the Camelot wheel itself, or offer "Make a playlist from these" (which stage 2's export would then carry to Traktor)?
4. **A browser DJ area (stage 3):** what could it look like at 1440 and on a phone: two decks with waveforms, sync, crossfader, EQ and cues, and a harmonic "next track" helper beside them? What's the smallest useful first version (one deck plus a cue-able "next track" preview)?
5. **Traktor export (stage 2a):** where does it live: a "Send to Traktor" on a playlist's "…", on the Mixes well with panel, a Settings → Traktor card with the Mac's music path and the export folder, or all three?

### Questions for Ross

1. **Tag overwrite policy:** stage 1 only fills missing BPM and key and never replaces what another app wrote, and writing tags is **off** until you turn it on. Should writing be on by default, and do you want SYNCHRO.S's values over Traktor's when they disagree?
2. **Energy scale:** 1–10 from loudness and how busy the track is, relative like Mixed In Key's. Is that the scale you'd use, or would you rather have Traktor's or Rekordbox's rating, or none at all?
3. **Traktor's analysis:** when stage 2b reads `collection.nml`, should Traktor's BPM and key win over SYNCHRO.S's (they're the ones your beat grids use)?

---

## Famous mixes and AI set suggestions

**Status:** Ready for Design · raised by Ross, 2026-10-24 · direction approved by Ross the same day. It builds on the DJ area (BPM, key and energy from stage 1, the Mixes panel, Export to Traktor from stage 2a) and on Settings → AI (`core/ai`, with its per-profile usage limits). Dev suggests building it into the set planner, Phase D's next step after Export to Traktor, so a famous mix, a suggested set and a hand-built set are the same thing: a tracklist you edit, save as a mix and export.

### The problem

Building a set from a big library is slow: SYNCHRO.S knows each track's BPM, key and energy, but it can't answer "which of my tracks would make a warm, building 90 minutes?" or "how much of that classic mix do I already own?".

### What Ross wants

1. **Famous mixes.** Find a well-known mix (a DJ's Essential Mix, a Fabric or Global Underground CD), match its tracklist against the library and show what's owned, owned in another version, and missing. From there: save it as a mix, export it to Traktor, or add the missing tracks to Wanted.
2. **Set suggestions.** Describe a set in words ("90 minutes, deep and warm, building to peak time, ending melodic"; "Sunday afternoon, like Peggy Gou"; "a warm-up before a techno headliner, 122–126 BPM") and get a draft tracklist from the library.
3. **Later: "more like this mix".** Fill the gaps in a half-owned famous mix with owned tracks of matching key, BPM, energy and style.

### Where tracklists come from (Ross agreed, 24 October)

- **MixesDB** (a community wiki of DJ mixes, strong on classic and radio mixes): read through its wiki API. Dev checks its terms before building.
- **MusicBrainz and Discogs** for released mix CDs (Fabric, Global Underground, DJ-Kicks). MusicBrainz is already used; Discogs needs a free token in Settings → Connections.
- **Paste a tracklist** from anywhere. The AI tidies the text into artist and title lines, so this always works.
- **Not 1001Tracklists:** it has no public API and its terms forbid scraping.

### Who does what

- **The AI judges taste.** It reads the brief and picks candidate tracks using what it knows about the DJ or style named, plus each track's genres, artist, year and the profile's listening history. Only track details (titles, artists, genres, BPM, key, energy) go to the AI, never audio, and each request counts against the profile's AI usage like the assistant's.
- **SYNCHRO.S orders the set itself.** Plain code, not the AI, puts the picks in order: compatible keys from one track to the next (the Camelot rules "Mixes well with" already uses), small BPM steps, and the energy shape asked for. The AI is unreliable at this kind of number-matching; code gets it right every time and can explain each step.
- **Matching a tracklist to the library** is plain code too (artist and title with "feat." and remix spellings normalised, MusicBrainz ids where both sides have them); the AI only cleans up pasted text.

### What Design needs to draw

1. **Famous mixes:** search or paste, then the match. Each line is owned, a different version (which one), or missing, with "You own 14 of 22", Save as mix, Export to Traktor and Add missing to Wanted.
2. **The set brief:** a free-text box plus optional dials (length, BPM range, energy shape, which music to draw from, e.g. a genre, a playlist or the whole library). Draw it as a few chips or presets, not a long form.
3. **The draft set:**
   - each transition marked smooth (compatible key, small BPM step) or a jump, with why;
   - an energy graph across the set;
   - a short line from the AI on why it chose the set;
   - swap any track for one of a few suggested alternatives, reorder by hand, lock a track before asking again;
   - Save as mix, Export to Traktor.
4. **States:**
   - AI not set up: famous mixes still work, set suggestions say how to turn the AI on;
   - the AI's usage limit reached;
   - BPM, key and energy still being worked out for part of the library: say how much and order by what's known;
   - nothing in the library fits the brief;
   - a tracklist source can't be reached.
5. **Phone and 1440,** as with the rest of the DJ area.

### Questions for Design

1. Is this part of the set planner (Dev's suggestion) or a page of its own in the DJ area?
2. How should "a different version" read: the version name alone, or a choice to use it or add the right one to Wanted?
3. How much of the AI's reasoning belongs on screen: one line per set, a line per track, or both, with the per-track lines behind a tap?

### Settled with Ross

- 24 October: yes to both parts, and to the tracklist sources above (MixesDB, MusicBrainz and Discogs, paste a tracklist).

---

## Lyrics centre stage, timed to the words

**Status:** Ready for Design (step 1) · step 2 Exploring · raised by Ross, 2026-10-24 · direction approved by Ross the same day.

### The problem

SYNCHRO.S already has timed lyrics, but they sit in a side panel of the expanded player. Ross wants them as a presentable option in the visuals area, centre stage over the visualiser, with the word being sung picked out live.

### What the app gives today (Dev checked)

- **Line-timed lyrics** from LRCLIB (free; `core/lyrics_client.py`), or from an `.lrc` or `.txt` file beside the track. `POST /api/lyrics/fetch` answers `{synced, plain, source}`: `synced` is LRC text with a `[mm:ss.xx]` start per line, `plain` is untimed text.
- They're shown in the expanded player's lyrics panel (`np-lyrics-panel`, `static/media-player-v2.js`). They're hidden for spoken audio and radio.
- LRCLIB times **lines, not words**. Word timings exist only in "Enhanced LRC" files (`<mm:ss.xx>` before each word), which are rare.

### Step 1: lyrics in the visuals area

- **A Lyrics layer** in the visuals area. The chosen visualiser (MilkDrop, spectrum, artwork) keeps running behind it, a little dimmed.
- The current line is large and centred; the previous line fades out above and the next waits below.
- **A sweep across the line as it's sung:**
  - With Enhanced LRC (from a file or LRCLIB), it follows each word's real time.
  - Otherwise SYNCHRO.S estimates: it spreads the line's time across its syllables. This is close on most songs but not exact on held notes or fast rap, and the design shouldn't promise exactness.
- **Controls:**
  - tap a line to jump there;
  - "lyrics early or late" nudge (remembered per track);
  - text size;
  - lyrics on or off over the visuals;
  - lyrics only (no visualiser);
  - full screen.
- **Fallbacks:**
  - plain untimed lyrics scroll gently with the track's progress;
  - no lyrics found or an instrumental says so quietly;
  - radio and spoken audio stay as today.
- **Timing:** the highlight allows for the browser's output delay, so words land with the audio.

### Step 2 (Exploring): true word timing, worked out by SYNCHRO.S

- When a track has lyrics but no word timings, an open-source speech-alignment model lines each known word up with the audio.
- It runs in the background, gently, like the BPM analysis.
- The result is saved as an Enhanced LRC file beside the track, so other players can use it too.
- **Costs:**
  - a model download of about 1–2 GB;
  - on a Mac in Docker (no GPU), around a minute a track;
  - separating the vocals first improves accuracy but roughly doubles the time.

  These numbers are estimates until a trial.
- **Scope:** opt-in per album or playlist, or "tracks I play often", not the whole library.
- Before choosing a model, Dev checks its licence (some alignment models are for non-commercial use only) and tries it on a handful of Ross's albums.
- **Not Musixmatch:** it has word timing, but it's a paid service whose terms rule this out.

### What Design needs to draw (step 1)

1. The lyrics layer over each visualiser (MilkDrop, spectrum, artwork), at 1440, full screen and on a phone (390), in portrait and landscape.
2. The line layout (current, previous, next) and the word sweep, both real and estimated. Should estimated timing look any different?
3. The controls: where they live, and how they hide while lyrics play.
4. The states:
   - loading;
   - line-timed;
   - word-timed;
   - plain untimed;
   - none found;
   - instrumental;
   - an `.lrc` file beside the track that's being used.
5. For step 2 later: how a track or album shows "word timing being worked out", and where the opt-in lives (an album's "…", Settings → Library).

### Questions for Design

1. Is the lyrics layer a visualiser of its own (picked like MilkDrop), or an overlay switched on over whichever visualiser is playing?
2. How much should the visualiser dim behind the words, and does the artwork mode need its own treatment?
3. On a phone, does the lyrics layer replace the expanded player's artwork, or sit below it?

### Settled with Ross

- 24 October: yes to step 1, and to trying step 2 on a few albums before building it for real.
