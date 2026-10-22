# Brief

## What SoulSync is

The interface is displayed as **SYNCHRO.S** (Ross, 2026-10-22): the wordmark, page titles and every sentence that names the app say SYNCHRO.S. Code, Docker images, paths, settings keys and APIs keep the SoulSync names, and "SoulSync" still means the upstream project.

A self-hosted web app, run in Docker at home, that finds, downloads, tags, files and plays music. It downloads mainly from Soulseek (through slskd), and also handles podcasts, audiobooks, video and YouTube. It checks playlists and recommendations against the library you already have, and it can feed Plex, Jellyfin or Navidrome.

It is one dark, full-screen web app. Two codebases share the screen: the legacy UI (`webui/index.html` and `webui/static/*.js`) and a React app (`webui/src`) that is replacing it page by page. New screens are built in React.

## Who uses it

People who run a home server or NAS, collect music, and want their library to fill itself in: get what's missing from playlists and favourite artists, at a quality they choose, without babysitting downloads. They're comfortable with Docker but don't want to read logs.

## What's wrong today

From users (a [Reddit thread](https://www.reddit.com/r/selfhosted/comments/1smnmno/has_anyone_setup_soulsync/) and GitHub issues), in their words where possible:

1. **Too much, in too many places.** 22 sidebar items. Search, Sync, Discover, Explorer and Artists overlap, and there are three different artist screens.
2. **Confusing names.** Wishlist and Watchlist sound the same; "Sync" doesn't say what it does.
3. **Hard to see what it's doing.** You can't see automations run, or why a download failed.
4. **Basic navigation is missing.** There's no browser back button behaviour or routing in parts of the app, and a reload "initializes services" (the reload part is fixed).
5. **Setup is fragile.** Docker folder paths are easy to get wrong, and nothing told you which one (the setup check now does).
6. **"Vibe-coded" look.** Tiny text (70% of font sizes are under 14px), lots of pills, 75 different corner radii, and 1,162 text colours that fail contrast.
7. **Scary tools.** Clean-up tools used to move or delete files in one click (fixed: they preview first).

What people like: it's more reliable than Lidarr at actually getting music.

## What we're aiming for

- **Downloads against targets.** The home screen shows what you want (Wanted, mirrored playlists, followed artists, a quality target), how much you have, and what SYNCHRO.S is doing about the gap.
- **Four groups instead of 22 places:** Get music, Library, Automate, Settings. Optional parts (modules) disappear when turned off.
- **One page per thing:** one artist page, one Wanted page (Wanted + Followed artists), one Activity timeline (downloads, automation runs, imports, problems).
- **Every automation shows its runs,** and can preview a run without changing anything.
- **Safe by default.** Anything that moves or deletes files shows exactly what it will do and waits for a confirm. (Built.)
- **Setup that checks itself,** and says how to fix each problem. (Built.)

## Design direction (decided)

- **Evolve the current look, don't replace it.** Keep the near-black ground, white-wash surfaces, and the user-chosen accent colour (7 presets plus custom). Fix the type sizes, radii, contrast and pills.
- **Dark only** for now.
- Rules in `DESIGN-SYSTEM.md`.

## Constraints

- **Desktop first, phone must work.** Most people use a desktop browser; pages must still work at 390px wide.
- **The accent colour is the user's choice,** so designs must work with any of the 7 presets. Text on an accent fill is dark.
- **Two codebases.** A redesign of a legacy page means rebuilding it in React. Prefer changes that can land page by page.
- **Upstream.** This is a fork of [Nezreka/SoulSync](https://github.com/Nezreka/SoulSync). Big structural changes, like the navigation regroup, are proposals to the maintainers; the canvas is how we show them.
