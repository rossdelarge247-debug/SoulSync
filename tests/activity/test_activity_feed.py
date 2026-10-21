"""GET /api/activity's builder (core/activity/feed.py): one newest-first list
over the histories SoulSync already keeps, folded where they are per track,
paged by an exact cursor, with "needs you" worked out from real state."""

from __future__ import annotations

import pytest

from core.activity import feed
from core.activity.feed import CursorError, Viewer
from tests.activity.activity_rows import DAY, HOUR, NOW

ITEM_KEYS = {"id", "time", "kind", "status", "title", "detail", "link", "needs_you"}


def _ids(page):
    return [i["id"] for i in page["items"]]


# ── shape ─────────────────────────────────────────────────────────────────────

def test_an_empty_feed_still_has_every_part(build):
    page = build()
    assert page["items"] == [] and page["needs_you"] == []
    assert page["next_before"] is None
    assert page["counts"] == {"download": 0, "import": 0, "automation": 0, "sync": 0, "safety": 0, "needs_you": 0}
    assert page["running_count"] == 0
    assert page["range"] == "30d" and page["kind"] == "all"
    assert page["since"] == NOW - 30 * DAY and page["generated_at"] == NOW


def test_every_item_has_the_contract_fields(build, rows):
    rows.history(ago=HOUR)
    rows.auto_import(ago=2 * HOUR)
    aid = rows.automation()
    rows.run(aid, ago=3 * HOUR)
    pl = rows.mirrored_playlist()
    rows.mirror_run(pl, ago=4 * HOUR)
    rows.batch(ago=5 * HOUR, failed=2, downloaded=10)
    rows.plan_event(ago=6 * HOUR)
    page = build()
    assert {i["kind"] for i in page["items"]} == {"download", "import", "automation", "sync", "safety"}
    for item in page["items"]:
        assert ITEM_KEYS <= set(item), item
        assert item["status"] in ("running", "ok", "warning", "error", "info")
        assert isinstance(item["time"], int) and item["title"] and item["link"].startswith("/")
        assert not any(k.startswith("_") for k in item)


# ── merging and ordering ──────────────────────────────────────────────────────

def test_items_from_every_source_come_newest_first(build, rows):
    rows.plan_event(ago=6 * HOUR)
    aid = rows.automation()
    rows.run(aid, ago=1 * HOUR)
    rows.history(ago=3 * HOUR)
    rows.auto_import(ago=2 * HOUR)
    times = [i["time"] for i in build()["items"]]
    assert times == sorted(times, reverse=True) and len(times) == 4


def test_tracks_landing_together_fold_into_one_item(build, rows):
    for i in range(5):
        rows.history(title=f"t{i}", ago=HOUR - i * 60)
    rows.history(title="old", artist="Pale Harbour", album="Tidewater", quality="MP3 320kbps",
                 source="YouTube", ago=DAY)
    items = build()["items"]
    assert [i["title"] for i in items] == ["Downloaded 5 tracks", "Downloaded 1 track"]
    assert items[0]["detail"] == "Lantern by Saltmarsh · Soulseek · FLAC"
    assert items[0]["ref"] == {"first_history_id": 1, "last_history_id": 5, "tracks": 5}
    assert items[1]["detail"] == "Tidewater by Pale Harbour · YouTube · MP3"


def test_a_session_breaks_on_a_gap_longer_than_the_session_gap(build, rows):
    gap = feed.SESSION_GAP_SECONDS
    rows.history(ago=HOUR)
    rows.history(ago=HOUR + gap)          # exactly the gap: same session
    rows.history(ago=HOUR + 2 * gap + 1)  # one second more: a new one
    assert [i["ref"]["tracks"] for i in build()["items"]] == [2, 1]


def test_a_session_names_its_albums_sources_and_why(build, rows):
    rows.history(album="A", ago=HOUR, origin="playlist", origin_context="Hot Hits")
    rows.history(album="B", ago=HOUR - 60, origin="playlist", origin_context="Hot Hits", quality="MP3 320kbps")
    item = build()["items"][0]
    assert item["title"] == 'Downloaded 2 tracks for "Hot Hits"'
    assert item["detail"] == "B by Saltmarsh and 1 more · Soulseek · mixed quality"


def test_scanner_review_rows_and_auto_import_rows_are_not_downloads(build, rows):
    rows.history(source="acoustid_scan")
    rows.history(source="Auto-Import")
    assert build()["items"] == []


def test_server_scans_and_staging_imports_are_imports(build, rows):
    rows.history(event_type="import", source=None, server="plex", ago=HOUR)
    rows.history(event_type="download", source="Staging", ago=HOUR - 60)
    item = build()["items"][0]
    assert item["kind"] == "import" and item["title"] == "Added 2 tracks to your library"
    assert "Found by the Plex library scan and imported from Staging" in item["detail"]


def test_a_clean_finished_batch_is_left_to_the_tracks_it_landed(build, rows):
    rows.batch(failed=0, completed=True)
    assert build()["items"] == []


# ── ranges ────────────────────────────────────────────────────────────────────

def test_ranges_cut_by_age(build, rows):
    rows.history(ago=HOUR)
    rows.history(ago=3 * DAY)
    rows.history(ago=10 * DAY)
    rows.history(ago=40 * DAY)
    assert len(build(range_key="7d")["items"]) == 2
    assert len(build(range_key="30d")["items"]) == 3


def test_today_starts_at_local_midnight_or_the_callers_since(build, rows):
    rows.history(ago=60)
    rows.history(ago=2 * DAY)
    page = build(range_key="today")
    assert page["since"] == feed.range_start("today", NOW)
    assert len(page["items"]) == 1
    page = build(range_key="today", since=NOW - 3 * DAY)
    assert page["since"] == NOW - 3 * DAY and len(page["items"]) == 2


def test_since_is_never_wider_than_31_days(build):
    assert build(since=0)["since"] == NOW - 31 * DAY


@pytest.mark.parametrize("bad", [{"range_key": "year"}, {"kind": "podcasts"}])
def test_unknown_range_or_kind_is_refused(build, bad):
    with pytest.raises(ValueError):
        build(**bad)


# ── filters ───────────────────────────────────────────────────────────────────

def test_kind_filter_keeps_one_kind_and_counts_stay_whole(build, rows):
    rows.history(ago=HOUR)
    aid = rows.automation()
    rows.run(aid, ago=2 * HOUR)
    rows.plan_event(ago=3 * HOUR)
    page = build(kind="automation")
    assert [i["kind"] for i in page["items"]] == ["automation"]
    assert page["counts"]["download"] == 1 and page["counts"]["safety"] == 1 and page["counts"]["automation"] == 1


def test_needs_you_filter_lists_the_pinned_items(build, rows):
    rows.history(ago=HOUR)
    rows.plan_event(ago=2 * HOUR)
    page = build(kind="needs_you")
    assert _ids(page) == [i["id"] for i in page["needs_you"]] == ["safety:1"]
    assert page["next_before"] is None


def test_download_filter_includes_failed_batches_and_sync_filter_playlists(build, rows):
    rows.batch(name="Lantern", failed=2, downloaded=10, ago=HOUR)
    rows.batch(name="Hot Hits", sync_type="playlist", playlist_id="spotify_pl_1", ago=2 * HOUR)
    assert [i["title"] for i in build(kind="download")["items"]] == ['2 of 12 tracks failed: "Lantern"']
    assert [i["title"] for i in build(kind="sync")["items"]] == ['Synced "Hot Hits"']


# ── paging ────────────────────────────────────────────────────────────────────

def test_paging_walks_everything_once_in_order(build, rows):
    for i in range(4):
        rows.history(ago=HOUR + i * DAY)
    aid = rows.automation()
    for i in range(3):
        rows.run(aid, ago=2 * HOUR + i * DAY)
    rows.plan_event(ago=HOUR)      # same second as the newest download: rank breaks the tie
    everything = _ids(build(limit=200))
    seen, before = [], None
    while True:
        page = build(limit=2, before=before)
        assert len(page["items"]) <= 2
        seen += _ids(page)
        before = page["next_before"]
        if before is None:
            break
    assert seen == everything and len(seen) == 8 and len(set(seen)) == 8


def test_a_folded_session_is_never_split_across_pages(build, rows):
    for i in range(6):
        rows.history(ago=HOUR - i * 30)
    rows.history(ago=DAY)
    first = build(limit=1)
    second = build(limit=1, before=first["next_before"])
    assert first["items"][0]["ref"]["tracks"] == 6
    assert second["items"][0]["ref"]["tracks"] == 1 and second["next_before"] is None


def test_before_also_takes_plain_unix_seconds(build, rows):
    rows.history(ago=HOUR)
    rows.history(ago=DAY)
    page = build(before=NOW - 2 * HOUR)
    assert [i["time"] for i in page["items"]] == [NOW - DAY]


def test_a_made_up_cursor_is_refused(build):
    with pytest.raises(CursorError):
        build(before="not-a-cursor!")


def test_limit_is_bounded(build, rows):
    for i in range(3):
        rows.history(ago=HOUR + i * DAY)
    assert len(build(limit=0)["items"]) == 1
    assert len(build(limit=10_000)["items"]) == 3


# ── needs you ─────────────────────────────────────────────────────────────────

def test_imports_waiting_for_you_pin_whatever_their_age(build, rows):
    for status in ("pending_review", "needs_identification", "partial", "failed"):
        rows.auto_import(status=status, folder=status, ago=90 * DAY)
    rows.auto_import(status="completed", ago=HOUR)
    page = build(range_key="7d")
    assert len(page["needs_you"]) == 4 and page["counts"]["needs_you"] == 4
    assert all(i["kind"] == "import" and i["needs_you"] for i in page["needs_you"])
    assert [i["needs_you"] for i in page["items"]] == [False]   # the completed one, in range
    decision = next(i for i in page["needs_you"] if "decision" in i["title"])
    assert decision["detail"] == '90% match to "Lantern" by Saltmarsh. The files stay in the import folder until you choose.'


def test_imports_are_hidden_without_the_import_page(build, rows):
    rows.auto_import(status="pending_review")
    page = build(Viewer(profile_id=2, is_admin=False, can_see_imports=False))
    assert page["needs_you"] == [] and page["items"] == [] and page["counts"]["import"] == 0


def test_a_failed_automation_pins_until_a_later_run_works(build, rows):
    aid = rows.automation(next_in=2 * HOUR)
    rows.run(aid, status="error", summary="Soulseek wasn't reachable", ago=2 * HOUR)
    item = build()["needs_you"][0]
    assert item["title"] == 'Automation "Fill Wanted" failed'
    assert item["detail"] == "Soulseek wasn't reachable. Next run in about 2 hours."
    assert item["retry_at"] == NOW + 2 * HOUR
    rows.run(aid, status="completed", ago=HOUR)
    page = build()
    assert page["needs_you"] == []
    assert [i["status"] for i in page["items"]] == ["ok", "error"]


def test_a_switched_off_automation_does_not_pin(build, rows):
    aid = rows.automation(enabled=0)
    rows.run(aid, status="error", summary="boom")
    page = build()
    assert page["needs_you"] == []
    assert page["items"][0]["detail"] == "boom. It's switched off, so it won't run again until you turn it on."


def test_paused_automations_say_nothing_retries(build, db, rows):
    db.set_metadata("automation_master_music_enabled", "0")
    aid = rows.automation(next_in=HOUR)
    rows.run(aid, status="error", summary="boom")
    assert build()["items"][0]["detail"] == "boom. Automations are paused, so it won't run again until they're back on."


def test_a_failing_system_automation_pins_for_admins_only(build, rows):
    aid = rows.automation(name="Auto-Backup Database", action="backup_database", system=1, profile_id=1)
    rows.run(aid, status="error", summary="disk full")
    assert len(build()["needs_you"]) == 1
    member = build(Viewer(profile_id=2, is_admin=False))
    assert member["needs_you"] == []
    assert [i["title"] for i in member["items"]] == ['Automation "Auto-Backup Database" failed']


def test_a_mirror_that_failed_on_auth_pins_and_other_failures_do_not(build, rows):
    a = rows.mirrored_playlist("A")
    b = rows.mirrored_playlist("B")
    rows.mirror_run(a, name="A", status="error", ago=HOUR,
                    result={"status": "error", "error": "Spotify returned 401 Unauthorized"})
    rows.mirror_run(b, name="B", status="error", ago=HOUR, result={"status": "error", "error": "timed out reading"})
    page = build()
    assert [i["title"] for i in page["needs_you"]] == ['Couldn\'t mirror "A"']
    assert {i["status"] for i in page["items"]} == {"error"}
    rows.mirror_run(a, name="A", status="completed", ago=60)
    assert build()["needs_you"] == []


def test_a_mirror_whose_sync_phase_failed_on_auth_is_a_pinned_warning(build, rows):
    pl = rows.mirrored_playlist()
    rows.mirror_run(pl, result={"status": "completed", "sync_errors": "1", "error": "Sync failed: token expired"})
    page = build()
    item = page["items"][0]
    assert item["status"] == "warning"
    assert item["detail"] == "Sync failed: token expired. 2 new tracks · 40 of 48 in your library · 4 on Wanted"
    assert [i["id"] for i in page["needs_you"]] == [item["id"]]


def test_zero_sync_errors_is_a_clean_run(build, rows):
    pl = rows.mirrored_playlist()
    rows.mirror_run(pl, result={"status": "completed", "sync_errors": "0", "discovery_error": ""})
    assert build()["items"][0]["status"] == "ok"


def test_a_mirror_run_says_what_changed(build, rows):
    pl = rows.mirrored_playlist()
    rows.mirror_run(pl)
    item = build()["items"][0]
    assert item["title"] == 'Mirrored "Sunday Mornings"'
    assert item["detail"] == "Spotify · 2 new tracks · 40 of 48 in your library · 4 on Wanted · 40 s"


def test_failed_tracks_nothing_will_retry_pin_the_batch(build, rows):
    results = [{"source_track_id": "s1", "status": "not_found", "download_status": "not_found"},
               {"source_track_id": "s2", "status": "found", "download_status": "failed"},
               {"source_track_id": "s3", "status": "found", "download_status": "completed"}]
    rows.batch(name="Lantern", failed=2, downloaded=1, total=3, results=results, ago=40 * DAY)
    page = build(range_key="7d")
    assert page["items"] == []
    item = page["needs_you"][0]
    assert item["status"] == "error" and item["title"] == '2 of 3 tracks failed: "Lantern"'
    assert item["detail"] == "1 wasn't found, 1 failed to download. They aren't on Wanted, so nothing will try them again."


def test_failed_tracks_on_wanted_are_retried_so_they_do_not_pin(build, rows):
    aid = rows.automation(name="Auto-Process Wishlist", next_in=30 * 60)
    results = [{"source_track_id": "s1", "status": "not_found", "download_status": "not_found"}]
    rows.batch(name="Lantern", failed=1, downloaded=11, results=results)
    rows.wishlist("s1")
    page = build()
    assert page["needs_you"] == []
    item = page["items"][0]
    assert item["status"] == "warning"
    assert item["detail"] == ("1 wasn't found. They're on Wanted. Next search in 30 minutes "
                              "(Auto-Process Wishlist).")
    assert aid


def test_a_wanted_cycle_that_found_nothing_never_pins(build, rows):
    rows.batch(name="Wishlist", sync_type="wishlist", playlist_id="wishlist", failed=5, downloaded=0, total=5)
    page = build()
    assert page["needs_you"] == []
    assert page["items"][0]["title"] == "Wanted search: 5 tracks not found this time"


def test_an_expired_preview_pins_until_previewed_again_or_dismissed(build, db, rows):
    rows.plan_event(ago=HOUR)
    item = build()["needs_you"][0]
    assert item["title"] == "Duplicate cleaner preview expired"
    assert item["detail"] == "Nothing was changed. Preview again to recycle 214 duplicate files (3.2 GB)."
    assert item["ref"]["tool"] == "duplicate_cleaner"
    rows.plan_event(ago=2 * HOUR, resolved=True)
    page = build()
    assert len(page["needs_you"]) == 1
    resolved = page["items"][-1]
    assert resolved["status"] == "info" and resolved["detail"] == "Nothing was changed; it was previewed again."


def test_a_confirmed_preview_is_information(build, rows):
    rows.plan_event(event="confirmed", tool="recycle_bin_purge", total=418, size=5_476_083_302)
    item = build()["items"][0]
    assert item["status"] == "info" and item["needs_you"] is False
    assert item["title"] == "Empty recycle bin: preview confirmed"
    assert item["detail"] == "You confirmed the preview to delete 418 files for good (5.1 GB)."


# ── scoping ───────────────────────────────────────────────────────────────────

def test_batches_and_mirrors_are_the_profiles_own(build, rows):
    rows.batch(name="Mine", failed=1, downloaded=0, profile_id=2, ago=HOUR)
    rows.batch(name="Admin's", failed=1, downloaded=0, profile_id=1, ago=2 * HOUR)
    rows.batch(name="Legacy", failed=1, downloaded=0, profile_id=None, ago=3 * HOUR)
    pl = rows.mirrored_playlist("Theirs", profile_id=1)
    rows.mirror_run(pl, name="Theirs", profile_id=1)
    member = Viewer(profile_id=2, is_admin=False)
    assert [i["title"] for i in build(member)["items"]] == ['1 of 12 tracks failed: "Mine"']
    admin_titles = [i["title"] for i in build()["items"]]
    assert '1 of 12 tracks failed: "Legacy"' in admin_titles and 'Mirrored "Theirs"' in admin_titles
    assert '1 of 12 tracks failed: "Mine"' not in admin_titles


def test_automation_runs_follow_the_automations_list(build, rows):
    mine = rows.automation(name="Mine", profile_id=2)
    theirs = rows.automation(name="Theirs", profile_id=3)
    rows.run(mine, ago=HOUR)
    rows.run(theirs, ago=HOUR)
    titles = [i["title"] for i in build(Viewer(profile_id=2))["items"]]
    assert titles == ['Automation "Mine" ran']


def test_preview_outcomes_are_admins_or_the_previewers(build, rows):
    rows.plan_event(profile_id=2, ago=HOUR)
    rows.plan_event(profile_id=None, ago=2 * HOUR)
    assert len(build()["items"]) == 2
    assert [i["id"] for i in build(Viewer(profile_id=2))["items"]] == ["safety:1"]
    assert build(Viewer(profile_id=3))["items"] == []


def test_library_history_is_shared(build, rows):
    rows.history()
    assert len(build(Viewer(profile_id=5))["items"]) == 1


# ── automations shown ─────────────────────────────────────────────────────────

def test_quiet_rules_for_automation_runs(build, rows):
    housekeeping = rows.automation(name="Clean Search History", action="clean_search_history", system=1)
    scan = rows.automation(name="Auto-Scan Watchlist", action="scan_watchlist", system=1)
    pipeline = rows.automation(name="Sync Hot Hits", action="playlist_pipeline")
    mine = rows.automation(name="Mine", action="search_and_download")
    rows.run(housekeeping, ago=HOUR)
    rows.run(scan, ago=2 * HOUR)
    rows.run(pipeline, ago=3 * HOUR)
    rows.run(mine, status="skipped", ago=4 * HOUR)
    rows.run(mine, ago=5 * HOUR)
    rows.run(housekeeping, status="error", summary="locked", ago=6 * HOUR)
    titles = [i["title"] for i in build()["items"]]
    assert titles == ['Automation "Auto-Scan Watchlist" ran', 'Automation "Mine" ran',
                      'Automation "Clean Search History" failed']


def test_video_automations_stay_on_the_video_side(build, rows):
    vid = rows.automation(name="Video thing", action="video_scan_library")
    rows.run(vid, status="error")
    assert build()["items"] == []


def test_logs_are_fetched_on_demand(build, db, rows):
    aid = rows.automation()
    run = rows.run(aid, log=[{"type": "info", "text": "start"}])
    quiet = rows.run(aid, ago=2 * HOUR)
    page = build()
    by_id = {i["id"]: i for i in page["items"]}
    assert by_id[f"automation:{run}"]["has_log"] is True and by_id[f"automation:{quiet}"]["has_log"] is False
    assert "log_lines" not in by_id[f"automation:{run}"]
    assert feed.get_log(db, Viewer(profile_id=1), f"automation:{run}") == [{"type": "info", "text": "start"}]
    assert feed.get_log(db, Viewer(profile_id=9), f"automation:{run}") is None
    assert feed.get_log(db, Viewer(profile_id=1), "automation:999") is None
    assert feed.get_log(db, Viewer(profile_id=1), "lh:1") is None


# ── running ───────────────────────────────────────────────────────────────────

def test_a_live_batch_is_running_with_progress(build, rows):
    rows.batch(name="Wishlist", sync_type="wishlist", playlist_id="wishlist", completed=False, batch_id="live-1",
               ago=60)
    live = {"live-1": {"phase": "downloading", "profile_id": 1, "total": 3, "done": 2, "failed": 0}}
    page = build(live_batches=live)
    item = page["items"][0]
    assert item["status"] == "running" and item["title"] == "Downloading 3 tracks for Wanted"
    assert item["detail"] == "2 of 3 done"
    assert page["running_count"] == 1


def test_a_batch_that_never_finished_says_so(build, rows):
    rows.batch(name="Lantern", completed=False, batch_id="gone")
    item = build()["items"][0]
    assert item["status"] == "warning" and "stopped before it finished" in item["title"]


def test_running_count_spans_batches_automations_and_imports(build, rows):
    aid = rows.automation(name="Mine")
    rows.auto_import(status="processing", ago=60)
    rows.auto_import(status="processing", ago=2 * DAY)   # cut off long ago: not running
    page = build(live_batches={"x": {"profile_id": 1, "total": 1, "done": 0},
                               "y": {"profile_id": 7, "total": 1, "done": 0}},
                 running_automations={aid: {"status": "running", "started_at": "2026-10-20T15:40:00+00:00",
                                            "phase": "Searching", "progress": 40}})
    assert page["running_count"] == 3
    live = next(i for i in page["items"] if i["id"] == f"automation-live:{aid}")
    assert live["status"] == "running" and live["detail"] == "Searching · 40%"
    stale = [i for i in page["items"] if i["kind"] == "import" and i["status"] == "warning"]
    assert len(stale) == 1


def test_counts_cover_the_range_per_kind(build, rows):
    rows.history(ago=HOUR)
    rows.history(ago=DAY)
    rows.history(event_type="import", source=None, server="plex", ago=2 * DAY)
    rows.auto_import(ago=3 * DAY)
    rows.batch(failed=1, downloaded=11, ago=4 * DAY)
    pl = rows.mirrored_playlist()
    rows.mirror_run(pl, ago=5 * DAY)
    rows.plan_event(ago=6 * DAY)
    rows.plan_event(ago=40 * DAY)
    counts = build(range_key="7d")["counts"]
    assert counts == {"download": 3, "import": 2, "automation": 0, "sync": 1, "safety": 1, "needs_you": 2}


# ── the badge poll ────────────────────────────────────────────────────────────

def _status(db, viewer=None, **kw):
    kw.setdefault("now", NOW)
    kw.setdefault("live_batches", {})
    kw.setdefault("running_automations", {})
    return feed.build_status(db, viewer or Viewer(profile_id=1, is_admin=True), **kw)


def test_the_status_agrees_with_the_feed(build, db, rows):
    aid = rows.automation(next_in=HOUR)
    rows.run(aid, status="error", summary="boom", ago=40 * DAY)       # outside every range, still needs you
    rows.auto_import(status="pending_review", ago=HOUR)
    rows.auto_import(status="processing", ago=60)
    rows.plan_event(ago=HOUR)
    pl = rows.mirrored_playlist()
    rows.mirror_run(pl, status="error", result={"status": "error", "error": "401 Unauthorized"})
    results = [{"source_track_id": "s1", "status": "not_found", "download_status": "not_found"}]
    rows.batch(failed=1, downloaded=11, results=results)
    live = {"b": {"profile_id": 1, "total": 2, "done": 1}}
    page = build(range_key="today", live_batches=live)
    status = _status(db, live_batches=live)
    assert status == {"running_count": page["running_count"], "needs_you_count": page["counts"]["needs_you"],
                      "generated_at": NOW}
    assert status["needs_you_count"] == 5 and status["running_count"] == 2


def test_the_status_follows_the_same_visibility(db, rows):
    rows.auto_import(status="failed")
    rows.plan_event(profile_id=1)
    sysauto = rows.automation(name="Auto-Backup Database", action="backup_database", system=1)
    rows.run(sysauto, status="error")
    assert _status(db)["needs_you_count"] == 3
    member = Viewer(profile_id=2, is_admin=False, can_see_imports=False)
    assert _status(db, member)["needs_you_count"] == 0


def test_the_count_is_exact_past_the_pinned_lists_cap(build, db, rows):
    for i in range(feed.NEEDS_YOU_LIMIT + 10):
        rows.auto_import(status="needs_identification", folder=f"f{i}", ago=HOUR + i)
    page = build()
    assert len(page["needs_you"]) == feed.NEEDS_YOU_LIMIT
    assert page["counts"]["needs_you"] == feed.NEEDS_YOU_LIMIT + 10
    assert _status(db)["needs_you_count"] == feed.NEEDS_YOU_LIMIT + 10
