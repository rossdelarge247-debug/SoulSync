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
| DJ area: BPM, key and mixing (Traktor Pro 3) | Building (stage 1: Built; stage 2a: Built) | [below](#dj-area-bpm-key-and-mixing-traktor-pro-3) |
| Famous mixes and AI set suggestions | Sets 1: Built · Sets 2: Ready for Dev | [below](#famous-mixes-and-ai-set-suggestions) |
| Lyrics centre stage, timed to the words | Ready for Design (step 2: Exploring) | [below](#lyrics-centre-stage-timed-to-the-words) |
| Star tracks and mix sets | Built (Mix tab: Built) | [below](#star-tracks-and-mix-sets) |
| Versions and remixes beside Up next | Ready for Design | [below](#versions-and-remixes-beside-up-next) |
| Auto-mix: beat-matched transitions in Up next | Built (stages A–C); Between tracks (33e) and 302's rule: Building | [below](#auto-mix-beat-matched-transitions-in-up-next) |
| Data visualiser: the decoded audio as numbers and bits | Ready for Design | [below](#data-visualiser-the-decoded-audio-as-numbers-and-bits) |
| Privacy: a VPN for Soulseek and torrents, and a privacy check | Building (VPN file, guide and Privacy card on `feat/privacy-vpn`) | [below](#privacy-a-vpn-for-soulseek-and-torrents-and-a-privacy-check) |
| Reach SYNCHRO.S from anywhere with Tailscale | Exploring | [below](#reach-synchros-from-anywhere-with-tailscale) |
| DJ now: a compact DJ mode in the playing panel | Drawn (E1 chosen) | [below](#dj-now-a-compact-dj-mode-in-the-playing-panel) |
| Analyse on demand, with progress | Built | [below](#analyse-on-demand-with-progress) |
| A playlist into a set for mixing (Order for mixing) | Ready for Design | [below](#a-playlist-into-a-set-for-mixing-order-for-mixing) |

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

**Status:** Exploring · raised by Ross, 2026-10-23 · **stage 1 is Built** (from `feat/dj-stage1`, then phase B2 as drawn) (`HANDOFF.md`, "Dev, DJ stage 1"; routes in `CONTRACTS.md`, "DJ data"). **Stage 2a (Export to Traktor) is Built** on `feat/dj-traktor-export` from boards 21a and 21b (`HANDOFF.md`, "Dev, DJ stage 2a (Export to Traktor)"; routes in `CONTRACTS.md`, "Export to Traktor"); it needs a check in Traktor Pro 3 on Ross's Mac before it's called done. Stages 2b, 2c and 3 follow Design's Phase D order (direction approved by Ross, 24 October).

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

**Status:** Sets 1: Building on `feat/sets-1` (`HANDOFF.md`, "Dev, Sets 1 of 24 October"; routes in `CONTRACTS.md`, "Sets") · Sets 2 (the AI's parts) after Dev's answers 240–246 · drawn by Design (`Sets (famous mixes, set suggestions).dc.html` 22a–22i, `Sets states.dc.html` 22j–22s) and approved by Ross 24 October · raised by Ross, 2026-10-24 · direction approved by Ross the same day. It builds on the DJ area (BPM, key and energy from stage 1, the Mixes panel, Export to Traktor from stage 2a) and on Settings → AI (`core/ai`, with its per-profile usage limits). Dev suggests building it into the set planner, Phase D's next step after Export to Traktor, so a famous mix, a suggested set and a hand-built set are the same thing: a tracklist you edit, save as a mix and export.

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

1. **Famous mixes:** search or paste, then the match. Each line is owned, a different version (which one), or missing, with "You own 14 of 22", Save as mix set, Export to Traktor and Add missing to Wanted.
2. **The set brief:** a free-text box plus optional dials (length, BPM range, energy shape, which music to draw from, e.g. a genre, a playlist or the whole library). Draw it as a few chips or presets, not a long form.
3. **The draft set:**
   - each transition marked smooth (compatible key, small BPM step) or a jump, with why;
   - an energy graph across the set;
   - a short line from the AI on why it chose the set;
   - swap any track for one of a few suggested alternatives, reorder by hand, lock a track before asking again;
   - Save as mix set, Export to Traktor.
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

---

## Star tracks and mix sets

**Status:** Stars and mix sets: Building · raised by Ross, 2026-10-24 · direction and defaults approved by Ross the same day · drawn by Design as `Stars and mix sets.dc.html` (28a–28g) and placed in `DJ area map (six briefs).dc.html` (24a), approved by Ross 2026-10-26 · built on `feat/stars-mix-sets`: `HANDOFF.md`, "Dev, stars and mix sets of 26 October"; the routes are in `CONTRACTS.md`, "Stars" and "Sets". Mix tab: Building · drawn by Design as `Mix tab.dc.html` (29a–29d), approved by Ross 2026-10-26 · built on `feat/mix-tab`: `HANDOFF.md`, "Dev, the Mix tab of 26 October"; the routes are in `CONTRACTS.md`, "The Mix tab".

### The problem

Ross wants to star tracks and add them to mix sets from anywhere in the interface, as long as the track is in the library and its file is downloaded.

Today:
- **No track stars.** SYNCHRO.S keeps only liked artists and albums pulled from Spotify (`liked_artists_pool`, `liked_albums_pool`).
- **No saved sets.** The DJ "Mixes" panel only suggests "Mixes well with…".
- **Playlists** (`/api/user-playlists`) are plain lists.

### What Ross wants

1. **Stars**
   - One tap on any track row and in the player: Library, Tracks, album and artist pages, Search, Listening history, Mixes well with, playlists, now playing.
   - Only for tracks in the library with their file present. Elsewhere the star isn't shown at all, rather than shown disabled.
   - **Per profile.**
   - **A plain star**, not a 1–5 rating.
   - **Kept in SYNCHRO.S only**: not synced to Plex or Jellyfin.
   - A **Starred** view in Library with the Tracks page's BPM, key and energy filters, plus a "Starred" filter wherever tracks are browsed.
   - **S** stars or unstars the playing track.
   - Export to Traktor writes a starred track as Traktor's top rating (`RANKING="255"` in the `.nml`).
2. **Mix sets**
   - **"Add to mix set…"** in every track's "…", in the player and in the multi-select bar. It picks an existing set or makes a new one, with the same downloaded-only rule.
   - **A mix set is an ordered DJ set:**
     - BPM, key and energy per track;
     - each transition marked smooth or a jump, with why;
     - an energy graph;
     - drag to reorder;
     - an optional note per track ("mix out at the breakdown");
     - Export to Traktor.
   - **Per profile.** "Share with the family" may come later.
   - **One home for sets:** a famous mix matched to the library, an AI-suggested set and a hand-built set are all mix sets (see "Famous mixes and AI set suggestions").

### The expanded player's Mix tab (added 24 October, approved by Ross)

The expanded player gets a **Mix** tab beside Lyrics and Details. On a phone it's a swipe-up sheet: Lyrics · Mix · Set. The tab does three jobs.

1. **This track,** always in the header:
   - key chip, BPM and energy meter, and the star;
   - "Not analysed yet · Analyse it now" (the Mixes panel's existing `POST /api/library/dj/start {track_id}`).
2. **Mixes well with:** the top 5 for the playing track, refreshed on each track change.
   - **Each match says why:** "Same key · +2% BPM · energy ↑1".
   - **Ranking, all in code:**
     - harmonic match and BPM (today's rules);
     - the energy direction of the working set;
     - not played recently;
     - skipping tracks already in the set;
     - a boost for starred tracks;
     - style closeness from genres and artists.
   - **"Vibe" (optional, off by default):** the AI re-ranks the top 20 for feel, and it counts against the profile's AI usage.
   - **Per match:**
     - **Play next**;
     - **Add to set**;
     - **More like this** (that track's own matches, for browsing a chain);
     - **Preview** only once there's a second audio output (headphone preview via `setSinkId`, DJ stage 3). Until then there's no preview, and the playing track is never cut.
3. **The working set:** "Working on: Sunday Set", one per profile, kept until changed, picked or started from here.
   - **A set strip:** the set's last few tracks, then the playing track, with smooth/jump marks and a small energy line.
   - **The main button:** "Add to Sunday Set", which becomes "✓ Added · #7".
   - **"Suggest from":**
     - **Now playing** (browsing);
     - **End of set** (building: matches follow the set's last track, so a set can be planned while something else plays).
   - **While a set is playing:** "Track 4 of 12", the next track with its transition mark, and a warning when an edit made a jump.

**Keys:** S stars the playing track, A adds it to the working set, N plays the top match next, and M opens the Mix tab.

**Edge cases:**
- **Matches come only from the library with files present,** so every suggestion is playable.
- **Radio:** if the track on air is identified and is in the library, the Mix tab works for it (hear it on a station, mix from your own collection); otherwise the tab is hidden, as now.
- **Podcasts and spoken audio:** no Mix tab.

**Server changes:**
- `GET /api/library/dj/mixes/<track_id>` gains:
  - `set_id` (skip the set's tracks and follow its energy direction);
  - a starred boost;
  - recently played;
  - `limit` (default 5 for the tab).
- A per-profile working-set setting.

**Draw:** the Mix tab at 1440, full screen and on a phone: header, matches, working set and strip. States:
- no working set yet;
- the playing track isn't analysed;
- no matches;
- Vibe on and thinking;
- the AI is off or at its limit;
- playing a set;
- radio with an identified library track.

### Constraints

- "Downloaded" means the track's file is present now. A starred track whose file later goes missing keeps its star and shows as missing in the Starred view and in sets, never silently dropped.
- The star must be the same control everywhere: legacy pages (`webui/static`) and React pages (`webui/src`) alike.
- Adding a track to a set never moves or copies the file.

### What Design needs to draw

1. **The star:**
   - on a track row: resting, hover, starred;
   - in the now-playing bar and the expanded player;
   - on a phone (touch size; does it live in the row or the "…"?).
2. **"Add to mix set…":**
   - the picker: recent sets first, a search field, "New mix set";
   - the multi-select version;
   - the toast with Open it.
3. **The Starred view** in Library.
4. **A mix set's page:**
   - the ordered list with BPM, key and energy;
   - transition marks;
   - energy graph;
   - notes;
   - reorder;
   - Export to Traktor;
   - phone layout.
5. **Where mix sets live:** in the DJ area beside the Mixes panel, in Library beside playlists, or both.
6. **States:**
   - a track in a set whose file has gone missing;
   - a track whose BPM, key and energy are still being worked out;
   - an empty set;
   - adding a track that's already in the set.

### Questions for Design

1. Does the star sit in every row, or appear on hover with only starred rows showing it at rest?
2. Where do mix sets live in the sidebar?
3. Should adding a track already in a set offer "add again" (some sets repeat a track) or just say it's there?

### Settled with Ross

- 24 October:
  - yes to both;
  - stars stay in SYNCHRO.S, not synced to Plex or Jellyfin;
  - stars and mix sets are per profile;
  - a plain star, not a 1–5 rating.

---

## Versions and remixes beside Up next

**Status:** Ready for Design · raised by Ross, 2026-10-24 · direction approved by Ross the same day.

### What Ross wants

Beside Up next, show the other versions of a track that exist: remixes, extended, dub, radio edit, VIP, live. Show which of them are owned and which aren't, and make swapping and fetching easy.

### Where the data comes from

1. **The library itself first.** Owned versions are grouped by artist plus a normalised title, with the version words ("Original Mix", "Extended Mix", "Radio Edit", "VIP", "Dub", "Remix", "Live") parsed out, and MusicBrainz ids where present.
2. **MusicBrainz (the backbone):** its recording relationships (remix of, edit of, live version of, remixer). It's free and open, and already used.
3. **Discogs:** "Remix by" credits and releases with several versions, strong on vinyl and dance. A free token goes in Settings → Connections.
4. **Beatport:** SYNCHRO.S already reads Beatport's public pages (`core/beatport/`, inherited from upstream) for charts and BPM. It's the best catalogue for mix versions, so it's worth using, but there's no public API: the pages can change, and reading them isn't plainly within Beatport's terms. **Treat it as a bonus source; nothing depends on it.**
5. **Deezer and Tidal search** (already connected) fill the gaps.

Results are cached per track, then refreshed in the background.

### What's shown

A **Versions** panel beside Up next (and in a track's "…" → Versions), for example "You own 2: Original, Extended · 5 more known".

Each version shows:
- its name;
- the remixer;
- its length;
- BPM and key where known;
- its source.

Actions:
- **Swap in**, for an owned version: replaces the queued or set entry.
- **Play**, for an owned version.
- **Add to Wanted**, for one that isn't owned.

**"Prefer extended mixes"** (Settings → Library, DJ): when queuing or adding to a mix set, the extended version is used if it's owned.

### What Design needs to draw

- The Versions panel beside Up next at 1440, and on a phone as a sheet.
- The "…" → Versions entry.
- The swap-in confirmation.
- States:
  - none known;
  - looking it up;
  - a source unreachable;
  - only owned versions;
  - versions found that aren't owned.

### Questions for Design

1. Is Versions a tab beside Up next, or a small badge on each queued track ("3 versions") that opens it?
2. How is the source shown? Quietly per row, or not at all?

### Settled with Ross

- 24 October: yes. Beatport may be used, as a bonus source only.

---

## Auto-mix: beat-matched transitions in Up next

**Status:** Auto-mix: Built (stages A–C; analysis on demand built from `feat/analyse-now`); **Building** on `feat/step2-names` (step 2 of Design's 27 October order: Between tracks in Settings → Library → DJ and the small control, the glossary, Design's 302 as the planner's one rule; `HANDOFF.md`, "Dev, step 2 (Between tracks, the names, 302's rule) of 28 October") · raised by Ross, 2026-10-24 · direction approved by Ross the same day · drawn by Design as `Auto-mix (Up next, decks).dc.html` (26a–26j) and approved by Ross. Built in three stages: **A**, the server's analysis and the pair planner, on `feat/automix-a` (`HANDOFF.md`, "Dev, auto-mix stage A of 27 October"; routes in `CONTRACTS.md`, "Auto-mix stage A"); **B**, the browser's two-deck engine with time-stretch, on `feat/automix-b` (`HANDOFF.md`, "Dev, auto-mix stage B of 27 October"; `CONTRACTS.md`, "Auto-mix stage B"; heard at `/automix-lab`, admins, `?lab=1`); **C**, auto-mix itself (the chips, Mix now, the setting, the handover view, Smart crossfade, a set played as a mix), on `feat/automix-c` (`HANDOFF.md`, "Dev, auto-mix stage C of 27 October"; `CONTRACTS.md`, "Auto-mix stage C"). Decks (21e, 26j: watching auto-mix drive the decks, taking over, Hand back) comes after. **Built with DJ stage 3's decks**, which use the same engine: two decks with EQ and effects on Web Audio. Auto-mix is that engine driven automatically, so the decks come first and auto-mix sits on top. Mix sets then play as a continuous mix.

### What Ross wants

In Up next, mix into the next track instead of just crossfading:
- on command ("Mix now");
- or automatically;
- in a chosen style: long, short, aggressive and so on.

### How it works (proven: Apple Music's AutoMix, djay's Automix and Mixxx's Auto DJ do versions of it; signal processing, not AI)

**Analysis, server side.** This extends DJ stage 1's analysis and is stored with BPM, key and energy:
- the beat grid and downbeats;
- phrase boundaries (8, 16 and 32 bars);
- sections (intro, outro, breakdown, drop) from structure analysis;
- the "mixable" intro and outro regions;
- loudness (ReplayGain is already there).

Dev picks the libraries after checking their licences: some beat and structure models are for non-commercial use only, and some analysis libraries are AGPL.

**Playback, in the browser:**
- two decks on Web Audio;
- the incoming track's tempo matched with a time-stretch library (SoundTouch for the web; licence to check), or with a plain speed change when the gap is under about 3%;
- downbeats phase-aligned;
- EQ, filter and echo automated on the bar with scheduled `AudioParam` changes.

**Styles:**
- **Long blend:** 32 bars, gradual EQ handover.
- **Short blend:** 8 bars.
- **Bass swap.**
- **Cut**, on the one.
- **Echo out**: the safe choice for key clashes and big tempo gaps.
- **Filter sweep.**
- **Drop swap**: the incoming drop over the outgoing breakdown.

**Auto** picks a style for each pair:
- compatible key and close BPM: a long blend;
- a key clash: a short cut or echo out;
- a big tempo gap: echo out.

### In Up next

- **A transition chip between each pair** ("Blend · 32 bars"). Tap it to change the style or length.
- **Mix now:** "Mixing into the next track in 6 bars…", starting on the next phrase, with Cancel.
- **The setting** (player settings): **Off / Smart crossfade / DJ mix.**
- **Fallback:** a pair that can't be beat-matched crossfades plainly, and says so ("Couldn't beat-match: crossfading").
- **In a mix set,** each transition's style is saved with the set.

### Honest limits (for the design to reflect)

- **Excellent on 4/4 electronic music** with clean intros and outros.
- **Weak on:**
  - live drums, tempo drift and rubato;
  - BPM gaps over about 8%;
  - big genre jumps.
- **Phones:** browsers can suspend Web Audio when the screen locks, especially on iPhone. Best on a computer or with the screen on; to be tested before it's promised.

### What Design needs to draw

- The transition chips in Up next, at 1440 and on a phone.
- The style picker.
- Mix now, counting down and while mixing: both tracks' progress and a small view of the handover.
- The setting.
- The fallback notice.
- A track that's still being analysed (its chip waits).
- Transitions in a mix set's page.
- How auto-mix sits with DJ stage 3's decks: watching the decks while auto-mix drives them.

### Questions for Design

1. Should the chips always show in Up next, or only when DJ mix is on?
2. While mixing, does the player show both tracks (two mini decks) or keep a single now-playing with a handover bar?
3. How does a person take over mid-mix (grab the crossfader on the decks)?

### Settled with Ross

- 24 October: yes to both the transitions and the styles, built with the DJ stage 3 decks.
- 27 October: **no crossfading at all** ("we either mix auto or manual or nothing"). Between tracks becomes **Off / Auto mix**; Smart crossfade leaves the interface. A pair that can't be beat-matched quietly uses echo out or a cut, or plays straight on, and nothing says "crossfade".
- 27 October: tracks are analysed **on demand** when they're added where they'll be mixed (a set, the working set, Up next with DJ mix on, Play as a mix, the lab, DJ now), with a small progress bar and a line naming the step. Members can ask for their own tracks.
- 27 October: yes to a mix report export and to the side-by-side view (now "DJ now", below).

## DJ now: a compact DJ mode in the playing panel

**Status:** Drawn, E1 chosen by Ross (27 October): the tray's third mode, Now playing · Mix · DJ (`DJ now (Brief E, options).dc.html`, 35a–35q, 36a–36b; HANDOFF, "Design's Briefs A–E and answers 260–324, and Ross's yes"); built as step 5 of Design's 27 October order · raised by Ross, 2026-10-27 · **laptop and desktop only** (nothing on the phone) · Design's Brief E (`HANDOFF.md`, "UX review of the DJ features, and Briefs A–E"). It replaces the separate Decks plan: full Decks (21e, 26j) is DJ now expanded, built on auto-mix's engine (stage B).

### The problem

Auto-mix runs out of sight. You can't see the two tracks side by side, which sections will be blended, or whether the beats are locked, so a mix that falls back to a cut or plays straight on looks the same as a good one (UX-12). Choosing what comes next means leaving the player, and taking over means a separate Decks page that isn't built yet.

### What Ross wants

From the playing panel, without leaving what's playing:
1. Drag another track into the panel, or pick from candidates (Mixes well with, the working set, other sets, playlists, starred, the AI).
2. See both tracks' waveforms and data together: sections, beat grids locked, and the blend zone.
3. Let auto-mix run it, or tweak it live: crossfader, EQ, filters and effects.
4. Expand it into full Decks.

No crossfade style (auto, manual or nothing).

### What the app gives today (Dev checked)

- The engine (stage B): two decks with time-stretch, EQ, filter and echo lanes, driven by the pair planner's plan. Windows, not whole tracks; a per-profile decode cap.
- The handover view in the tray while a mix runs (stage C): both tracks, two lanes on one ruler, Back and Finish now.
- The plan per pair (`/api/library/dj/plan`): the blend window, the style, the bass swap bar and why a pair can't be beat-matched.
- Mixes well with's ranking, sets, the working set and stars.

### Questions for Design

Brief E in `HANDOFF.md` holds the states to draw.

**Where it lives is open (Ross, 27 October: "I want options").** Brief E's options in `HANDOFF.md`:
- **E1:** a mode of the playing panel.
- **E2:** Ross's set builder / mix explorer rail, pulled down from the top of Tracks, Albums and Artists, with a Build row for assembling a mix or adding to a set, A and B transport rows synced on the grid, and B's sections dragged against A's and locked.
- Any others Design proposes.

Whichever wins replaces the docked Mixes panel and the working-set strip, so there are fewer places to mix, not more.

---

---

## Data visualiser: the decoded audio as numbers and bits

**Status:** Ready for Design · raised by Ross, 2026-10-24 · direction approved by Ross the same day.

### What Ross wants

Beside or under the track's spectrum (EQ) in the player, a view of the data that becomes the sound.

### What's real (Dev checked)

- The browser decodes the file (FLAC, MP3 and so on) into samples: 44,100 or more per second per channel, each between −1 and +1. That stream is what reaches the speakers.
- The visualisers already tap it through Web Audio's `AnalyserNode`, which hands over a block of the latest samples (up to 32,768) about 60 times a second: a true slice of the real data each frame, not every sample.
- **Step 1 shows exactly that.** It's cheap: the same tap the spectrum uses.
- **Later, maybe:** the compressed file's own bytes (frame headers and blocks). The browser decodes internally, so this needs a separate fetch of the file lined up with the play position by byte offset. It's approximate, so it would be an extra only if step 1 lands well.

### What it shows (step 1)

- **Sample columns:**
  - live left and right values, scrolling in mono;
  - hex (`0x3A7F`) or decimal;
  - silence reads `0x0000`.
- **Bits:**
  - each sample as a row of 16 or 24 lit or unlit bits, showing the bit depth at work (the high bits light only on peaks);
  - a 24-bit file shows 24, a 16-bit file 16.
- **Readout:**
  - format, sample rate, bit depth, channels;
  - bitrate decoded and bitrate on disk;
  - a live count of samples played.

  The format details come from the library's own data for the file.
- **As a layer:** the numbers fill the background, and the spectrum or scope draws over them. It also works as a visualiser mode of its own ("Data").
- **Radio and lossy streams:** the same, with the stream's format in the readout.

### Constraints

- Cheap on a laptop: text rendered on a canvas, not thousands of DOM nodes, and the frame rate dropped when the tab is hidden.
- Respect reduced-motion: freeze to a slow refresh.

### What Design needs to draw

- The Data mode at 1440, full screen and on a phone.
- The layer under the spectrum, and under the scope.
- Hex vs decimal.
- The bits view.
- The readout.
- How it looks in silence, in a loud passage, and for a mono file.

### Questions for Design

1. Is Data a mode of its own, a layer switch on the spectrum and scope, or both?
2. How much of the screen do the numbers take before it stops being readable and becomes texture? Is texture the point?
3. Should the accent colour or a terminal green carry it?

### Settled with Ross

- 24 October: yes to step 1, as a mode and a layer; the file-bytes view only later, if wanted.

---

## Privacy: a VPN for Soulseek and torrents, and a privacy check

**Status:** Building · raised by Ross, 2026-10-26 · Ross approved Proton VPN with port forwarding, for both Soulseek and torrents, on 28 October · built on `feat/privacy-vpn` (`HANDOFF.md`, "Dev, privacy (VPN for Soulseek and torrents, the privacy check) of 28 October"; routes in `CONTRACTS.md`, "Privacy check"; the card in `SCREENS.md`; the guide is `Support/VPN.md`).

### What's built (28 October)

- **The VPN files,** opt-in (a `COMPOSE_FILE` line in `.env`): `docker-compose.vpn.yml`, Gluetun v3.41.3 with Proton VPN over WireGuard and NAT-PMP port forwarding, slskd inside Gluetun's network; and for torrents `docker-compose.vpn-qbittorrent.yml` (a new qBittorrent) or `docker-compose.vpn-qbittorrent-existing.yml` (the one already in the compose file); Gluetun's firewall as the kill switch; slskd's own Gluetun integration (slskd 0.25+) following the forwarded port and signing out of Soulseek while the VPN is down; Gluetun's port command for qBittorrent. Secrets go in `.env` (`vpn.env.example`), which git ignores.
- **Not covered by the VPN:** YouTube (yt-dlp), usenet, indexer searches and SYNCHRO.S's own `.torrent` fetches, the streaming services, metadata, and Transmission, Deluge or aria2 unless put behind Gluetun by hand (`Support/VPN.md`, "What the VPN doesn't cover").
- **The Privacy card** in Setup check, and four Privacy rows in the full run once it's set up: is the VPN up, which address peers see (compared with the home one only if the person turns that on), the forwarded port and whether slskd and the torrent client listen on it, and the kill switch. Without port forwarding it says "Connected, no forwarded port: downloads work but fewer people can reach you".
- **DNS** goes through Gluetun's own resolver (DNS over TLS, through the tunnel), so slskd's look-ups don't leak either.
- **Not yet:** torrent seeding off unless behind the VPN (item 3), the VPN state on the slskd tile and in Activity (Design's question), keys encrypted with a key the person holds (item 4).

### The problem (Dev's assessment, 26 October)

- **Soulseek (slskd)** is unencrypted. Every peer sees the home IP address and the Soulseek username, the Soulseek server sees every search, and the ISP can see the traffic.
- **Torrents,** if used, show the IP to the whole swarm, and SYNCHRO.S can seed.
- **Encrypted and private enough:** Usenet (SSL to the provider).
- **Encrypted but tied to Ross's own accounts:** the streaming-service downloaders (Tidal, Qobuz, Deezer, Amazon, HTTPS), which a VPN doesn't change; YouTube, SoundCloud and Bandcamp (HTTPS); and the metadata look-ups (HTTPS).
- **SYNCHRO.S itself:**
  - It serves plain HTTP on 8008, which is fine on the home network but must never be opened to the internet. See the Tailscale entry.
  - Keys and tokens are kept unencrypted in the settings folder.

### What Ross wants

As much security and anonymity as the setup allows, starting with the peer-to-peer traffic. The VPN will be **Proton VPN**, or Malwarebytes if it offers port forwarding.

Dev's note: as far as Dev knows, Malwarebytes Privacy VPN doesn't offer port forwarding. Proton VPN does on paid plans, on its P2P servers. Check both before choosing.

### What it would be

1. **A VPN container (Gluetun) for slskd and any torrent client,** in the compose file and the Mac guide:
   - only slskd's (and the torrent client's) traffic goes through the VPN;
   - **a kill switch:** if the VPN drops, slskd loses its connection instead of using the home IP;
   - **port forwarding** from the VPN provider (Gluetun supports Proton's), so Soulseek can still accept connections;
   - slskd's listening port follows the forwarded port, which can change.
2. **A privacy row in Setup check:**
   - Compare slskd's public IP, seen from inside its container, with SYNCHRO.S's own. Say plainly when slskd isn't behind the VPN.
   - Show whether the kill switch holds, whether the forwarded port is open, and whether torrent seeding is on.
3. **Defaults and advice:**
   - torrent seeding off unless behind the VPN;
   - a Soulseek username that isn't used elsewhere;
   - DNS through the VPN (no leaks).
4. **Later, maybe:** keys and tokens encrypted at rest, with a key the person holds.

### Honest limits

- A VPN hides the home IP from peers and the ISP. It doesn't make Soulseek anonymous: the username stays the same over time.
- The streaming services always know it's Ross.

### Questions

- ~~**For Ross:** Proton VPN or Malwarebytes, once port forwarding is checked?~~ **Settled with Ross, 28 October:** Proton VPN with port forwarding, for Soulseek and torrents.
- **For Ross (28 October):** which Proton plan (port forwarding needs Plus or higher; until then `PORT_FORWARDING=false`)? Which torrent client, if any (the VPN file ships qBittorrent; Transmission and Deluge get the check but set their port by hand)?
- **For Design:** the Privacy card was built without boards, in the Setup check style; questions 368–373 in `HANDOFF.md`. Where else the VPN state shows (the slskd tile, Activity) is 371.

---

## Reach SYNCHRO.S from anywhere with Tailscale

**Status:** Exploring · raised by Ross, 2026-10-26.

### What Ross wants

Once SYNCHRO.S and slskd move to the **new media centre** at home, reach them from his phone or laptop anywhere in the world. That means listening, browsing, adding to Wanted and checking downloads, without opening anything to the internet.

### What it would be

- **Tailscale:** a private network between Ross's own devices. Install it on the media centre and on the phone and laptop, and SYNCHRO.S is reachable at a private address (or a name like `synchros.<tailnet>.ts.net`) from anywhere, with no ports opened on the router.
- **HTTPS:** through Tailscale's own certificates (`tailscale serve`), so the browser has a padlock and the phone can install SYNCHRO.S as a web app.
- **slskd's own interface** is reachable the same way when needed.
- **Works with the VPN:** Tailscale carries remote access, and the VPN carries Soulseek traffic. The guide must set them up so they don't fight (e.g. Gluetun only wraps slskd, and Tailscale runs on the host). As built (`feat/privacy-vpn`), Gluetun wraps only slskd and qBittorrent; SYNCHRO.S, its port 8008 and the host are untouched, so Tailscale on the host reaches SYNCHRO.S as before.
- **Playing on the phone away from home:** streaming quality may need a lower setting on mobile data. Check the player's quality options work over Tailscale.
- **A guide** for the media centre (its OS isn't known yet), the iPhone or Android app, and the laptop.

### Questions

- **Settled with Ross, 26 October:** the media centre runs **macOS**, and the phone is **Android**. The guide covers Tailscale on macOS (Dev picks the macOS variant that keeps running with nobody logged in, which matters on a media centre, and checks how it reaches Docker Desktop's containers), the Android app, and the laptop. SYNCHRO.S is installed on Android as a web app from Chrome.
- **For Design** (once it's Ready): does SYNCHRO.S need to show "you're connected from away" anywhere, for example to suggest a lower streaming quality?

---

## Analyse on demand, with progress

**Status:** Built · raised by Ross, 2026-10-27 · built on `feat/analyse-now` (`HANDOFF.md`, "Dev, analyse on demand of 27 October"; routes in `CONTRACTS.md`, "Analyse on demand"; the interim indicator in `DESIGN-SYSTEM.md`, "Analysis progress").

### The problem

The DJ sweep works through the whole library in its own order, gently, so a track Ross needs now (just added to a set, queued with Auto mix, open in the Mix tab) could wait hours behind thousands of others, and nothing said where it was.

### What Ross wants

- A track that isn't analysed (no BPM, key and energy, or no beat grid at the current `GRID_VERSION`) jumps the queue when it's added to a mix set or the working set, queued in Up next with Auto mix (or Play as a mix), opened in the Mix tab, picked in the auto-mix lab, or asked for with "Analyse these" (Tracks' selection, an album, a playlist, a set). If the sweep isn't running it starts for them. Gentle as ever: one track at a time, low CPU priority, the usual rests; asked-for tracks don't wait for downloads or imports, but do wait while the library's drive is away, saying so.
- Every profile, for its own library's tracks, with a limit (200 in line a profile, one request a second).
- Visible progress: each track's step and percentage (reading the audio, the tempo, the key, the energy, writing tags, the beat grid, phrases and sections), its place in line, or what it waits for; a small bar and a line of text wherever such a track shows. Done tracks fill in by themselves.

### Questions for Design

333–339 in `HANDOFF.md`: the final indicator, where it lives on each surface, and the words (338 and 339 are answered by Design's 302 and 308).

---

## A playlist into a set for mixing (Order for mixing)

**Status:** Ready for Design · raised by Ross, 2026-10-27 · direction and defaults approved by Ross the same day ("hell yeaaah"). Built with Sets 2, after DJ now (step 5 of Design's 27 October order), since it shares Swap and the AI's parts.

### The problem

A Spotify playlist (or any playlist) is in the order someone liked, not an order that mixes. Turning it into a set means analysing every track, then reordering by hand for keys, tempo and energy, then finding replacements for the pairs that never fit.

### What Ross wants

One flow from a playlist's "…": **Make a set for mixing**.
1. **Import:** the playlist becomes a set, matched against the library.
2. **Analyse:** tracks without DJ data or a beat grid are queued (analysis on demand, Brief A's indicator).
3. **Order for mixing:** SYNCHRO.S suggests a better order for harmonic mixing, tempo and an energy shape, and says why.
4. **Optimise:** swaps for the pairs that still clash; optionally ask the AI.
5. **Mix it:** Play as a mix, or open it in DJ now.

### What the app gives today (Dev checked)

- **Playlists are mirrored** from Spotify (and Tidal, Deezer, YouTube, local) into SYNCHRO.S, so the flow reads the stored copy: no extra Spotify calls, and it works while Spotify is throttled.
- **Matching a tracklist against the library** and **Want the missing** (famous mixes, Sets 1).
- **Analyse these** on a playlist's "…" (analysis on demand, `feat/analyse-now`).
- **Sets:** steps marked Smooth/Jump with their reason, the energy graph, Lock, Move, Export to Traktor, Save as a set, Play as a mix (Sets 1, stars and sets, auto-mix stage C).
- **Swap** with alternatives that fit both neighbours, and the AI's Ask again (Sets 2, approved, not built).
- **The pair planner** (auto-mix stage A), which says whether two tracks beat-match and how.

### What's new

1. **Order for mixing:** a code-driven optimiser (no AI needed). It orders the tracks so each step is as smooth as possible (key on the Camelot wheel, tempo, energy) and the set follows a chosen energy shape. Locked rows stay where they are (pin an opener or a closer). For up to a couple of hundred tracks it should answer in a second or two (a heuristic search, not an exhaustive one). A tempo octave counts as compatible (87 ↔ 174) once the drum and bass BPM fix lands.
2. **Energy shapes:** Build up · Peak in the middle · Waves · Keep the energy level (Dev's suggestion; Design to name and draw them).
3. **Before and after:** the playlist's order beside the suggestion, with the counts ("14 jumps → 3 jumps"), both energy curves, and each move explained ("Static Bloom after Night Ferry: 8A → 9A, same tempo"). **Use this order**, **Keep mine**, or take changes one at a time.
4. **What it can't fix:** "These two always clash: swap one?" with Swap's suggestions, and "Ask the AI for a better fit" where the AI is on.
5. **Then mix it:** Play as a mix, or open it in DJ now.

### Defaults (Ross, 27 October)

- **The playlist is never changed.** The set is a copy; "Save this order as a new playlist" is offered.
- **Missing tracks** keep their place, greyed out, with Want it; they're skipped when it plays.
- **Members** can do it with their own playlists, for tracks in their own library.

### States Design needs to draw

1. The entry: the playlist's "…" and its header ("Make a set for mixing"), and on a set's page ("Order for mixing").
2. Importing and matching ("You own 41 of 48"), the missing ones with Want it.
3. Analysing before it can order: Brief A's indicator for the set ("12 of 48 aren't ready to mix · Analyse them now"), ordering what's ready meanwhile, or waiting.
4. The energy-shape picker.
5. Before and after at 1440: both orders, both curves, the counts, the reasons; Use this order, Keep mine, one at a time; Undo.
6. Clashes left: the swap prompt with Swap's suggestions; the AI's line, thinking, and off.
7. Locked rows held while the rest moves.
8. Done: the set with its new order, Play as a mix and Open in DJ now.
9. The phone (390): the before and after as one list with a toggle.
10. A playlist of 300 or more tracks (a limit, or ordering a chosen part).

### Questions for Design

1. Is "Order for mixing" a step in the import, or a tool on any set (both)?
2. The names of the energy shapes, and whether a person can draw their own curve.
3. How a person takes some suggested moves and not others without losing track.

