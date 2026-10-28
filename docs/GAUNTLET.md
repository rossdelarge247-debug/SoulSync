# The gauntlet

The gauntlet is a stricter CI lane that only risky changes have to pass. The normal checks (`build-and-test.yml`: ruff, the build, the full pytest suite, the web UI's checks) run on every push. The gauntlet runs on top of them when a change touches code that can lose files, damage the database, edit someone's setup, open a hole in sign-in or gating, or talk to the outside world.

It exists because passing every normal check isn't enough for that kind of code: the drive move passed all of them, and an independent review still found two ways it could lose music.

The workflow is `.github/workflows/gauntlet.yml`. Its helper script is `.github/gauntlet/gauntlet.py`.

## Which changes go through it

A change goes through the gauntlet when any file it changes matches a glob in **`.github/gauntlet-paths.txt`**. That file is the only list. CI reads it, and this page doesn't repeat it, so the two can't drift apart. Its areas are:

- **Deletes or moves files:** the drive move (`core/drives/**`), the repair worker and repair jobs, the cleanup and purge automations, library remove, cleanup, duplicates and the recycle bin, library reorganize, the import pipeline's file moves and quarantine, and publishing finished downloads into the library.
- **Database migrations and schema:** `database/**` and the few schema modules outside it.
- **Setup editing:** the compose helper (`core/drives/compose_tool.py`), slskd's config writes (`core/drives/services.py`), settings writes and the setup check.
- **Auth, sessions, profiles and admin gating:** `core/security/**`, the profile context that holds `admin_only`, the login, profile and key routes, the kids guard, and `web_server.py`, which holds the login and launch gates and most `@admin_only` routes.
- **Outbound HTTP:** `core/security/**` (the outbound guard) and the service clients (`core/*_client.py`, the torrent and usenet clients).
- **CI itself:** `.github/**`, so a change to the gauntlet goes through the gauntlet.

The list came from searching the code for `os.remove`, `unlink`, `shutil.rmtree`, `shutil.move`, `os.replace`, `subprocess`, `requests.` and `admin_only`. When you add a module that deletes, moves or overwrites files, changes the schema, or gates access, add it to the list in the same change.

It also runs:

- on a pull request labelled **`gauntlet`**, whatever it touches;
- when started by hand (**Actions → Gauntlet → Run workflow**). Tick *full scan* to judge every line of every risky file against the baselines, not only changed lines. That's useful after regenerating a baseline.

### What "changed" means

- **Pull request:** every file the PR changes, against its merge base with the target branch.
- **Push:** the files changed since the commit before the push. A branch's first push, or a force-push (the old tip is gone or isn't an ancestor), is compared with the branch's merge base with `integration` instead.
- **Run by hand:** against the merge base with `integration`.

When nothing risky changed, the first job says so in its summary ("Nothing risky changed, so the gauntlet's checks are skipped") and the run ends in seconds.

## What it runs

| Job | What it does | Fails when |
|---|---|---|
| **What changed** | Picks the base commit, lists the changed files and matches them against the risky paths. | It can't work out the changes. |
| **Security scan (Bandit)** | Bandit (pinned in the workflow) on the changed Python files outside `tests/`. | A **new High** finding is on a changed line. New Medium findings are warnings. Low is ignored. |
| **Security scan (Semgrep)** | Semgrep (pinned) with the security rules for Python, Flask, requests, JWT, crypto, SQLAlchemy and Jinja, plus secrets, on the changed files outside `tests/`. | A **new Error or Warning** finding is on a changed line. New Info findings are warnings. |
| **Upgrade, migration and disaster-scenario tests** | Step 1: `tests/database` (including the upgrade-from-old-releases tests) and the migration tests outside it. Step 2: `pytest -m gauntlet`, the disaster-scenario tests, in one process. | Any of those tests fails. The second step runs even if the first fails, so both results show. |
| **Gauntlet summary** | One Markdown summary: what triggered the run, which risky files changed, each check's result. | Any check above failed. Use this job as the single required check if one is ever wanted. |

The full test suite isn't repeated here, since sanity-check already runs it. Nor are the web UI's checks: no risky path is under `webui/`, so the gauntlet installs no npm packages. The gauntlet aims to finish in about 10 minutes.

### Baselines: only new findings fail

The upstream code already has findings, so each scanner has a committed baseline of what was there:

- `.github/gauntlet/bandit-baseline.json`
- `.github/gauntlet/semgrep-baseline.json`

Each entry is a file, a rule and the flagged line's text, without the line number, so moving code around doesn't make an old finding look new. Matching counts entries, so a second copy of a baselined line in the same file is still new. Nothing is skipped wholesale: no rule is turned off and no file is left out of a baseline.

A finding fails the gauntlet only when it's **not in the baseline and on a line this change added or edited**. A finding that isn't in the baseline but sits on an untouched line (usually a moved line, or a scanner that reads a file slightly differently) is listed as "not on a changed line" and doesn't fail.

**Regenerating a baseline** (after upgrading Bandit or Semgrep, or changing Semgrep's rule commit or folders, which are pinned at the top of the workflow). Use Python 3.11, as CI does:

```bash
pip install bandit==<BANDIT_VERSION> semgrep==<SEMGREP_VERSION>
SRC="api core database services utils scripts web_server.py wsgi.py beatport_unified_scraper.py"

bandit -q -r $SRC -f json -o /tmp/bandit.json
python .github/gauntlet/gauntlet.py baseline bandit --report /tmp/bandit.json \
  --out .github/gauntlet/bandit-baseline.json --version <BANDIT_VERSION>

# rules: git clone https://github.com/semgrep/semgrep-rules /tmp/rules && git -C /tmp/rules checkout <SEMGREP_RULES_REF>
# web_server.py is left out: Semgrep skips files over 1 MB in CI
semgrep scan --metrics=off --json -o /tmp/semgrep.json \
  $(for d in <SEMGREP_RULE_DIRS>; do echo --config /tmp/rules/$d; done) \
  api core database services utils scripts wsgi.py beatport_unified_scraper.py
python .github/gauntlet/gauntlet.py baseline semgrep --report /tmp/semgrep.json \
  --out .github/gauntlet/semgrep-baseline.json --version <SEMGREP_VERSION> --rules <SEMGREP_RULES_REF>
```

Regenerate on a clean `integration`, never to make a new finding go away. A new finding is fixed, or, if it's a false alarm, marked in the code with a reason (`# nosec B603 - fixed argv, no shell` for Bandit, `# nosemgrep: <rule-id> - why` for Semgrep), which a reviewer can then see.

### Semgrep's rules and limits

- The rules come from [semgrep/semgrep-rules](https://github.com/semgrep/semgrep-rules) at a pinned commit, checked out in the job. That's the source of the registry's `p/python`, `p/flask` and `p/secrets` packs, but needs no semgrep.dev access, no token and no login, and gives the same rules every run. The registry itself (`--config p/python`) is not used.
- Files over 1 MB (`web_server.py`, `database/music_database.py`) are left out of Semgrep; its taint rules take many minutes on them. Bandit still scans them. The job summary names any file it left out.
- Semgrep gives up on a rule after 5 seconds per file, and can't parse a handful of files (it reports them). Its summary lists these; findings there are missed, not failed.

### The disaster-scenario tests

These carry `@pytest.mark.gauntlet` (registered in `pyproject.toml`). Run them locally with `python -m pytest -m gauntlet`.

- **Drive move** (`tests/drives/test_move.py`):
  - **Same folder:** a destination that is the source through another mount is refused, and Remove skips an old file that is its own copy.
  - **Crash during the switch:** any error after the settings switched switches everything back, as do an unreadable slskd.yml at the switch, a refused service and slskd refusing to restart. The copy isn't deleted while the settings point at it, a failure while they point at the new place isn't reported as "nothing switched", and a restart mid-copy reads as stopped.
  - **Edited during the copy:** a stale file at the new place is copied again. Remove skips an old file edited since its copy, even at the same size. Verify finds an old file edited after its copy. Switch back brings home files changed at the new place.
  - **Unplugged:** the drive going away fails cleanly and Carry on finishes.
  - **Deletes only what it should:** Stop and undo deletes only the half-made copy, Remove deletes exactly the checked files, and a copy that went missing keeps its old file.
  - **Left where it is:** Downloads left on the computer from Check's slskd row is never copied, repointed or restarted for.
  - **A folder that stays, inside one that moves:** Downloads or Staging nested in the Library and left out is refused with a Check stop row, never listed by Start's walk, and never deleted by Remove.
  - **A choice during Start:** a choice written while Start lists the files stops the start with nothing copied, and a choice sent while a move runs waits for it and is refused; nothing is left stuck in `copying` without a plan.
  - **slskd's session only while it's needed:** a sign-in that lands after Downloads left the move isn't kept, and a failed move forgets its session; a carry-on refused because the drive is away never signs in.
  - **The same folder by another path:** a folder that stays is recognised inside a moving one even when it's reached through another path to it on disk.
- **The computer's folder names** (the drives helper's hints file, `tests/drives/test_host_paths.py` and `tests/drives/test_move.py`):
  - **No host hint is ever written inside a music folder:** the helper writes the computer's paths only into SYNCHRO.S's settings folder (`config/host-paths.json`), deletes an older helper's `.synchros-host.json` from a music folder (a file or a link, never what the link points at), and a second run adds nothing there.
  - **The hints file is read with the trust rules:** an entry names a folder only while it is keyed by that folder's current marker id, in a regular file (not a link or a folder) under the size cap that is exactly the schema; one bad entry refuses the file.
  - **A forged or mismatched hint is ignored:** an entry for another marker id, an older build's `.synchros-host.json` beside the marker (even a well-formed one), and an entry after SYNCHRO.S marks the folder afresh never name the folder, in the routes or in `to_host`.
  - **A hint never changes what Remove deletes:** trusted or forged, and pointing at a real folder holding files with the same names, Remove deletes exactly the checked old copies at their container paths; the files at the hint's path, the hints file and the marker stay.
  - **SYNCHRO.S can read the file the helper wrote:** run as root, the helper hands `host-paths.json` to the settings' owner (0640); as another user it's 0644; a file SYNCHRO.S can't open is said in the log.
  - **A link planted at the hints file's temporary path isn't followed:** with links planted at the helper's next temporary name and at `host-paths.json` itself, the helper writes through neither; the link's target is unchanged and the file becomes a regular file.
  - **slskd never shares SYNCHRO.S's own files:** a move's slskd.yml edit adds the `.synchros-` share filter once, it matches the marker, the move's note and an older build's hint (and no music), and a switch back keeps it.
  - **The person's own slskd filters are never dropped** (`tests/drives/test_helper.py`, `test_move.py`): filters slskd takes from the environment stay in force when slskd.yml had none (the whole effective list is written, then ours); environment and slskd.yml overlapping never shrinks or reorders the list; with slskd's filters unreadable, listed twice, or overridden above slskd.yml, none are added, the rest of the edit goes ahead and Check says so.
  - **A copied marker never takes the original's name:** a copy of a music folder that kept its marker (elsewhere, or inside the same mount), and a folder whose compose mount has moved since the helper ran, name nothing (in the routes and in `to_host`); a move's forward switch gives the new folder a fresh marker id even when a copied marker is already there, and a switch back keeps the old folder's.
- **The kids guard's ordering:** `tests/test_content_guard_music.py`, and `test_a_clean_only_profile_is_refused_explicit_tracks` in `tests/playback/test_player_api.py`. The step runs them in one process, the playback test first, which is the order that once let an explicit track through.
- **Migration failures** (`tests/database/test_schema_migration_steps.py`): a failed part of a step leaves its marker unwritten and retries, and a step that stops part way is rolled back whole. A failed marker write keeps the step's work. A rebuild that hits a real conflict keeps the old table. A real failure rolls back and flags its parent. A non-atomic step keeps what it did before the failure.

- **Export to Traktor** (`tests/dj/test_traktor.py`; `core/dj/traktor.py` and `api/dj.py` are on the list because the export writes files into a configured folder and the routes save settings and serve files):
  - **XML injection through track names:** a title, artist, album, playlist name and file path full of quotes, `<`, `>`, `&`, `]]>`, a DOCTYPE with an external entity and control characters builds one `.nml` that parses back to exactly one collection entry and one playlist, with each value intact (characters XML can't hold dropped), and no DTD.
  - **An export folder that escapes:** a folder given as `…/../outside` or as a link inside a music folder that leads outside is refused when set and again at the write; a file name with `..`, a slash, a NUL or the wrong suffix is refused; nothing is written outside. A stored export folder swapped for a link that leads out after it was set is refused at the save (409).
  - **No overwrite:** an existing file, a link at the name (even a dangling one) and a folder at the name are never written over without `overwrite`, and a link's target is never touched, even with it; the save route answers 409 `exists` and leaves the file as it was; no temporary file is left behind; without hard links the exclusive create still refuses.
  - **Profile scope:** a member's export of track ids, a playlist or Mixes well with only reaches tracks in their own library scope; another profile's playlist reads as missing; a profile on its own library sees only its tracks.
  - **Looking paths up on disk is bounded:** an export of 1,000 tracks whose stored paths are a media server's looks up at most 50 of them (or for 5 s; the rest are left out as `lookup_limit`), a miss isn't looked up again for 5 minutes, nothing is looked up when nothing could place the result, and a preview through the route asks the resolver at most the budget.
  - **A folder swapped after the check:** the export folder replaced by a link that leads outside, or by another folder, between the check and the write is refused; nothing is written outside or into the other folder.
  - **Asking whether a name is taken only looks:** the preview's `folder.exists_at` (234) checks and opens the export folder as the save does and `lstat`s the name in it: a link at the name counts as taken without its target being looked at, an unsafe name or a folder outside answers nothing, and nothing in the folder changes.
  - **Orphaned temporary files and the no-link path:** temporary export files older than an hour are swept (a fresh one and files that aren't ours stay), and on a file system without hard links a failure leaves neither the claim nor the temporary file.

- **Library → Sets** (`tests/sets/test_sets_routes.py`, `test_sources.py`, `test_steps_and_tracklist.py`, `test_review_fixes.py`; `api/sets.py` and all of `core/sets/**` are on the list because the routes keep per-profile sets, delete a set's rows and read pasted text, the reader parses other sites' text, and the sources talk to MixesDB and Discogs):
  - **Another site's text can't freeze the server:** a 100 KB line of `=`, `[[`, `[[[`, `[http://`, `{{` or `<` in a MixesDB page is read in well under 100 ms (Python's `re` holds the GIL, so a backtracking pattern would stall every request): wiki lines are cut to 1,000 characters, and headings and links are scanned, not matched.
  - **An edit never drops a track that's briefly away:** with a track's file gone for a moment, a rename, a save of the same tracks and a reorder all keep its row and its place in the playlist, and it plays again when the file's back.
  - **A source can't hold a worker:** an answer that trickles a byte at a time is cut off at the whole request's deadline (20 s), and the connection is closed.
  - **Sets are per profile:** another profile's set reads, changes and deletes as a 404, admins included, and the list shows only your own.
  - **A set never points at another profile's track:** a track id outside the caller's library is saved as a plain Missing line, and the view and Swap never show it.
  - **Bodies have a size:** every Sets body is cut off at its cap (413), a body without a Content-Length too.
  - **A paste is data and has a size:** markup, links and control characters come back as plain text; 500 lines, 300 characters a line.
  - **Only fixed hosts are ever asked:** whatever is searched or opened, every request goes to MixesDB's API or Discogs' API (or through the MusicBrainz client, which refuses an id that isn't an MBID); a pasted MixesDB link is read for its page title only, and a link to any other host is search text.
  - **A redirect or a huge answer is a source down:** redirects aren't followed, and an answer over 2 MB is cut off while it streams.
- **Double BPM / Halve BPM** (`tests/dj/test_bpm_override.py`, `tests/database/test_dj_tempo_promotion.py`; the route is in `api/dj.py` and the write in `core/dj/store.py`, both on the list, and `core/sample/tempo.py`, the tempo rule the sweep runs on every file, is added):
  - **Only your own library:** a member's ×2, ÷2 or reset reaches only their own library's tracks; a shared track (everyone's) is an admin's (403 `shared`), another profile's track reads as missing (404 when it's the only one) and is never changed; a profile on its own library can't reach the shared one.
  - **A person's BPM is kept:** a later analysis, a re-analysis of the file and the sweep's grid top-up never undo it; a grid found at the other octave is rescaled to it as it's saved, in one transaction with reading it, so a ×2 or a reset sent during a grid save is never lost (both orders tested); a person's BPM is the one written into the file's tag.
  - **The measured grid is never lost:** every rescale is worked out from it, kept beside the rescaled one; reset puts it back with no decode; ÷2 then ×2 is it exactly.
  - **JSON only, with a size and a rate:** a form or `text/plain` POST is refused, a body over 64 KB is 413, over 500 ids is 400, and a second change within a second is 429.
  - **The upgrade only skips what can't change:** DJ data read at 100–140 BPM, Sample Studio's analyses that fold into it, and grids at 100–140 found from a hint there (and errors, too long, too short) move to the new versions without a decode; everything the new rule can change is analysed again; it runs once; a failure is an ERROR naming the step, rolls back whole and runs again next start.

When you write a test for a new way a change could lose data, tag it `gauntlet` too.

## How to read the results

Open the run (**Actions → Gauntlet**) and read the **Gauntlet summary** job's summary first. Then:

- **Skipped** (the first job's summary says "Nothing risky changed"): no risky files changed. Nothing to do.
- **Bandit or Semgrep failed:** the job's summary has a table of the new findings (file, line, rule, what it means), and each is annotated on the diff. Fix the code, or, if it's a false alarm, add the `nosec`/`nosemgrep` comment with a reason and say so in the HANDOFF entry. "Warnings" and "not on a changed line" tables don't fail the run, but a reviewer should glance at them.
- **Upgrade and migration tests failed:** an old database no longer upgrades cleanly, or the schema steps stopped rolling back. Treat it as a blocker.
- **Disaster-scenario tests failed:** one of the scenarios above can lose or damage data again. Treat it as a blocker.

The reports (`bandit.json`, `semgrep.json` and the list of scanned files) are kept as run artifacts for 7 days.

## What the lead commits to for gauntlet work

CI is half of it. For any change that goes through the gauntlet, the lead (human or agent) also commits to:

1. **An independent review:** by a reviewer who didn't write the change, looking specifically for ways it could lose or damage data and for security holes (missing admin gating, paths that escape their folder, unchecked outbound URLs, secrets in logs).
2. **Findings fixed or answered before merge:** every review finding is fixed, or answered in the change's HANDOFF entry with the reason it stays.
3. **A green gauntlet run before Ross's private build:** the change goes into Ross's private build only after a gauntlet run on its final commit has passed.
4. **Zip notes:** the notes that go with the build say the change went through the gauntlet, with the run's link.
