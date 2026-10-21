"""Rows for the Activity and targets tests, written where the real code writes
them and dated relative to a fixed clock."""

from __future__ import annotations

import json

from core.activity.common import utc_text

NOW = 1_792_600_000  # 2026-10-20 ~15:46 UTC
HOUR = 3600
DAY = 86400


class Rows:
    def __init__(self, db):
        self.db = db

    def _run(self, sql, params=()):
        conn = self.db._get_connection()
        try:
            cur = conn.execute(sql, params)
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def history(self, event_type="download", title="t", artist="Saltmarsh", album="Lantern", ago=HOUR,
                quality="FLAC 16bit", source="Soulseek", server=None, origin=None, origin_context=None):
        return self._run(
            "INSERT INTO library_history (event_type, title, artist_name, album_name, quality, download_source, "
            "server_source, origin, origin_context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (event_type, title, artist, album, quality, source, server, origin, origin_context, utc_text(NOW - ago)))

    def auto_import(self, status="completed", ago=HOUR, folder="Lantern", total=3, matched=3, confidence=0.9,
                    error=None):
        return self._run(
            "INSERT INTO auto_import_history (folder_name, folder_path, status, confidence, album_name, artist_name, "
            "total_files, matched_files, error_message, created_at) VALUES (?, ?, ?, ?, 'Lantern', 'Saltmarsh', ?, ?, ?, ?)",
            (folder, f"/import/{folder}", status, confidence, total, matched, error, utc_text(NOW - ago)))

    def automation(self, name="Fill Wanted", action="process_wishlist", profile_id=1, enabled=1, system=0,
                   next_in=None, trigger="schedule", owned_by=None):
        return self._run(
            "INSERT INTO automations (name, enabled, trigger_type, action_type, profile_id, is_system, next_run, owned_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (name, enabled, trigger, action, profile_id, system,
             utc_text(NOW + next_in) if next_in is not None else None, owned_by))

    def run(self, automation_id, status="completed", ago=HOUR, summary="Done", log=None, duration=40):
        finished = NOW - ago
        return self._run(
            "INSERT INTO automation_run_history (automation_id, started_at, finished_at, duration_seconds, status, "
            "summary, log_lines) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (automation_id, utc_text(finished - duration).replace(" ", "T") + "+00:00",
             utc_text(finished).replace(" ", "T") + "+00:00", duration, status, summary,
             json.dumps(log) if log is not None else None))

    def batch(self, name="Lantern", sync_type="album", playlist_id=None, ago=HOUR, total=12, found=12,
              downloaded=12, failed=0, completed=True, profile_id=1, batch_id=None, results=None):
        return self._run(
            "INSERT INTO sync_history (batch_id, playlist_id, playlist_name, source, sync_type, tracks_json, "
            "total_tracks, tracks_found, tracks_downloaded, tracks_failed, started_at, completed_at, profile_id, "
            "track_results) VALUES (?, ?, ?, 'spotify', ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)",
            (batch_id or f"b-{name}-{ago}", playlist_id or f"artist_album_{name}", name, sync_type, total, found,
             downloaded, failed, utc_text(NOW - ago - 60), utc_text(NOW - ago) if completed else None, profile_id,
             json.dumps(results) if results is not None else None))

    def mirrored_playlist(self, name="Sunday Mornings", profile_id=1):
        return self._run(
            "INSERT INTO mirrored_playlists (source, source_playlist_id, name, profile_id) VALUES ('spotify', ?, ?, ?)",
            (f"sp-{name}-{profile_id}", name, profile_id))

    def mirror_run(self, playlist_id, name="Sunday Mornings", status="completed", ago=HOUR, profile_id=1,
                   before=None, after=None, result=None, log=None):
        before = before or {"track_count": 46, "in_library_count": 40, "wishlisted_count": 2}
        after = after or {"track_count": 48, "in_library_count": 40, "wishlisted_count": 4}
        return self._run(
            "INSERT INTO playlist_pipeline_run_history (playlist_id, playlist_name, source, profile_id, "
            "trigger_source, started_at, finished_at, duration_seconds, status, summary, before_json, after_json, "
            "result_json, log_lines) VALUES (?, ?, 'spotify', ?, 'automation', ?, ?, 40, ?, ?, ?, ?, ?, ?)",
            (playlist_id, name, profile_id, utc_text(NOW - ago - 40).replace(" ", "T") + "+00:00",
             utc_text(NOW - ago).replace(" ", "T") + "+00:00", status, status.capitalize(),
             json.dumps(before), json.dumps(after), json.dumps(result or {"status": status}),
             json.dumps(log) if log is not None else None))

    def plan_event(self, tool="duplicate_cleaner", event="expired", ago=HOUR, total=214, size=3_435_973_836,
                   profile_id=1, resolved=False, plan_id=None):
        return self._run(
            "INSERT INTO action_plan_events (plan_id, tool, event, total, total_bytes, counts_json, profile_id, "
            "occurred_at, resolved_at, resolution) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)",
            (plan_id or f"p{ago}{event}{tool}", tool, event, total, size, profile_id, NOW - ago,
             NOW if resolved else None, "previewed_again" if resolved else None))

    def wishlist(self, track_id, profile_id=1, retry_count=0, source_type="manual", source_info=None):
        return self._run(
            "INSERT INTO wishlist_tracks (spotify_track_id, spotify_data, retry_count, profile_id, source_type, "
            "source_info) VALUES (?, '{}', ?, ?, ?, ?)",
            (track_id, retry_count, profile_id, source_type, json.dumps(source_info) if source_info else None))
