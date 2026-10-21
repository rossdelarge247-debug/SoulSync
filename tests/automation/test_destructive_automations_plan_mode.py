"""Automations that move or delete files run in plan mode unless they were
explicitly configured to act.

A scheduled run has no fresh preview behind it, so by default it reports
exactly what it WOULD move/delete and touches nothing. Only the action's
``confirm`` switch ("Act without a preview") lets it act. Automations people
built before the switch existed keep acting (one-time migration); seeded ones
that nobody chose do not.
"""

from __future__ import annotations

import json
import os
import threading

import pytest

from core.automation import blocks
from core.automation.handlers.database_update import auto_deep_scan_library
from core.automation.handlers.download_cleanup import auto_full_cleanup
from core.automation.handlers.duplicate_cleaner import auto_run_duplicate_cleaner
from core.automation.handlers.library_cleanup import auto_library_cleanup
from core.automation.handlers.maintenance import auto_clear_quarantine
from core.automation_engine import PLAN_GATE_MIGRATION_KEY, PLAN_GATED_ACTIONS, AutomationEngine
from database.music_database import MusicDatabase
from tests.automation.test_handler_library_cleanup import _build_deps, _deps_for


def _snapshot(root):
    return sorted(os.path.relpath(os.path.join(d, f), root)
                  for d, _dirs, files in os.walk(root) for f in files)


# ── library_cleanup / clear_quarantine / full_cleanup ───────────────────────


def test_library_cleanup_without_the_switch_reports_and_deletes_nothing(tmp_path):
    deps, lines, qfile, binned = _deps_for(tmp_path, keep_days=7)
    before = _snapshot(tmp_path)

    out = auto_library_cleanup({'_automation_id': 1}, deps)

    assert _snapshot(tmp_path) == before
    assert out['mode'] == 'plan'
    assert out['removed'] == 0
    assert out['would_remove_quarantine'] == 1       # bad.flac
    assert out['would_purge_recycle'] == 1           # 30 days old, past the 7-day window
    assert any('Nothing was deleted' in (line.get('log_line') or '') for line in lines)


def test_library_cleanup_preview_honours_the_keep_window(tmp_path):
    deps, _lines, _qfile, binned = _deps_for(tmp_path, keep_days=60)
    out = auto_library_cleanup({}, deps)
    assert out['would_purge_recycle'] == 0            # 30 days < 60 days
    assert binned.exists()


def test_library_cleanup_with_the_switch_acts(tmp_path):
    deps, _lines, qfile, binned = _deps_for(tmp_path, keep_days=7)
    out = auto_library_cleanup({'confirm': True}, deps)
    assert out['removed'] == 2 and not qfile.exists() and not binned.exists()


def test_clear_quarantine_without_the_switch_keeps_everything(tmp_path):
    deps, _lines, qfile, _binned = _deps_for(tmp_path)
    out = auto_clear_quarantine({}, deps)
    assert out == {'status': 'completed', 'mode': 'plan', 'removed': '0', 'would_remove': '1'}
    assert qfile.exists()
    assert auto_clear_quarantine({'confirm': True}, deps)['removed'] == '1'
    assert not qfile.exists()


def test_the_gated_http_purges_leave_the_automation_switch_working(tmp_path):
    """Empty recycle bin and Clear quarantine over HTTP now need a preview
    plan. The automations never went through those routes: plan mode still
    reports and keeps everything, and the switch still lets them delete."""
    from flask import Flask

    import api.deleted_files as df_api
    import api.quarantine as q_api

    deps, _lines, qfile, binned = _deps_for(tmp_path, keep_days=0)
    cfg = deps.config_manager
    q_api.configure(config_manager_=cfg, docker_resolve_path_=lambda p: p,
                    serve_audio_file_with_range=None, audio_mime_types={},
                    post_process_matched_download=None,
                    post_process_matched_download_with_verification=None,
                    download_orchestrator_getter=lambda: None, matching_engine_getter=lambda: None)
    df_api.configure(config_manager_=cfg, docker_resolve_path_=lambda p: p)
    app = Flask(__name__)
    app.register_blueprint(q_api.bp)
    app.register_blueprint(df_api.create_blueprint())
    http = app.test_client()

    assert http.post('/api/quarantine/clear').status_code == 409
    assert http.post('/api/deleted-files/purge', json={'all': True}).status_code == 409
    assert qfile.exists() and binned.exists()

    plan = auto_library_cleanup({}, deps)
    assert plan['mode'] == 'plan' and plan['would_remove'] == 2
    assert qfile.exists() and binned.exists()

    acted = auto_library_cleanup({'confirm': True}, deps)
    assert acted['removed'] == 2
    assert not qfile.exists() and not binned.exists()


def test_full_cleanup_leaves_the_quarantine_alone_without_the_switch(tmp_path):
    deps, _lines, qfile, _binned = _deps_for(tmp_path)
    deps = _build_deps(config_manager=deps.config_manager, get_staging_path=lambda: str(tmp_path / 'none'),
                       sweep_empty_download_directories=lambda: 0)
    out = auto_full_cleanup({}, deps)
    assert qfile.exists()
    assert out['quarantine_removed'] == '0'
    assert any('preview only' in step for step in out['steps'])


# ── duplicate cleaner ───────────────────────────────────────────────────────


class _Executor:
    def __init__(self, state, finish):
        self.state = state
        self.finish = finish
        self.calls = []

    def submit(self, fn, *args, **kwargs):
        self.calls.append((args, kwargs))
        self.finish(self.state, kwargs)


def _dup_deps(finish):
    state = {'status': 'idle'}
    executor = _Executor(state, finish)
    deps = _build_deps(get_duplicate_cleaner_state=lambda: state, duplicate_cleaner_lock=threading.Lock(),
                       duplicate_cleaner_executor=executor, run_duplicate_cleaner=lambda **k: None)
    return deps, executor


@pytest.fixture()
def no_sleep(monkeypatch):
    import core.automation.handlers.duplicate_cleaner as mod
    monkeypatch.setattr(mod.time, 'sleep', lambda _s: None)


def test_duplicate_cleaner_automation_previews_by_default(no_sleep):
    def finish(state, kwargs):
        state.update(status='finished', duplicates_found=4, deleted=0, files_scanned=40,
                     plan_id='p1', plan={'total_bytes': 4 * 1024 * 1024})
    deps, executor = _dup_deps(finish)

    out = auto_run_duplicate_cleaner({'_automation_id': 9}, deps)

    assert executor.calls == [((), {'confirm': False})]
    assert out['mode'] == 'plan'
    assert out['files_deleted'] == 0
    assert out['would_remove'] == 4 and out['would_free_mb'] == 4.0
    assert out['plan_id'] == 'p1'


def test_duplicate_cleaner_automation_acts_only_with_the_switch(no_sleep):
    def finish(state, kwargs):
        state.update(status='finished', duplicates_found=4, deleted=4, files_scanned=40,
                     space_freed=1024 * 1024, refused=0)
    deps, executor = _dup_deps(finish)

    out = auto_run_duplicate_cleaner({'confirm': True}, deps)

    assert executor.calls == [((), {'confirm': True})]
    assert 'mode' not in out
    assert out['files_deleted'] == 4


# ── deep scan ───────────────────────────────────────────────────────────────


def _deep_deps(report):
    state = {'status': 'idle'}
    submitted = []

    class _Exec:
        def submit(self, fn, *args, **kwargs):
            submitted.append(kwargs)
            state['deep_scan_moves'] = report
            state['status'] = 'finished'

    lines = []
    deps = _build_deps(get_db_update_state=lambda: state, db_update_executor=_Exec(),
                       update_progress=lambda _aid, **kw: lines.append(kw))
    return deps, submitted, lines


@pytest.fixture()
def no_db_sleep(monkeypatch):
    import core.automation.handlers.database_update as mod
    monkeypatch.setattr(mod.time, 'sleep', lambda _s: None)


def test_deep_scan_automation_runs_moves_in_plan_mode_by_default(no_db_sleep):
    deps, submitted, lines = _deep_deps({'mode': 'preview', 'would_move': 12, 'moved': 0,
                                         'block_reason': ''})
    out = auto_deep_scan_library({'_automation_id': 3}, deps)
    assert submitted == [{'confirm_moves': False}]
    assert out['staging_moves_mode'] == 'preview'
    assert out['staging_would_move'] == 12 and out['staging_moved'] == 0
    assert any('Nothing was moved' in (line.get('log_line') or '') for line in lines)


def test_deep_scan_automation_with_the_switch_may_move(no_db_sleep):
    deps, submitted, _lines = _deep_deps({'mode': 'moved', 'would_move': 3, 'moved': 3, 'block_reason': ''})
    out = auto_deep_scan_library({'confirm': True}, deps)
    assert submitted == [{'confirm_moves': True}]
    assert out['staging_moved'] == 3 and out['staging_would_move'] == 0


# ── the builder exposes the switch, off by default ──────────────────────────


@pytest.mark.parametrize('action', sorted(PLAN_GATED_ACTIONS))
def test_every_gated_action_has_the_switch_off_by_default(action):
    block = next(b for b in blocks.ACTIONS if b['type'] == action)
    field = next(f for f in block.get('config_fields', []) if f['key'] == 'confirm')
    assert field['type'] == 'checkbox' and field['default'] is False


# ── one-time migration: existing opt-ins keep acting ────────────────────────


@pytest.fixture()
def engine(tmp_path):
    db = MusicDatabase(str(tmp_path / 'automations.db'))
    eng = AutomationEngine(db)
    eng._running = True
    eng.schedule_automation = lambda automation_id: None
    return eng, db


def _cfg(db, aid):
    return json.loads(db.get_automation(aid)['action_config'] or '{}')


def test_migration_keeps_user_built_automations_acting(engine):
    eng, db = engine
    mine = db.create_automation('Nightly dedupe', 'schedule', '{"interval": 1, "unit": "days"}',
                                'run_duplicate_cleaner', '{}')
    mine_off = db.create_automation('Old purge', 'schedule', '{}', 'clear_quarantine', '{}', enabled=False)
    chose_no = db.create_automation('Careful', 'schedule', '{}', 'library_cleanup', '{"confirm": false}')
    other = db.create_automation('Wishlist', 'schedule', '{}', 'process_wishlist', '{}')

    eng.ensure_system_automations()

    assert _cfg(db, mine)['confirm'] is True
    assert _cfg(db, mine_off)['confirm'] is True
    assert _cfg(db, chose_no)['confirm'] is False          # an explicit choice is kept
    assert 'confirm' not in _cfg(db, other)
    # seeded rows nobody chose stay in plan mode
    for action in ('deep_scan_library', 'full_cleanup', 'library_cleanup'):
        row = db.get_system_automation_by_action(action)
        assert 'confirm' not in json.loads(row['action_config'] or '{}'), action


def test_migration_honours_a_switched_on_weekly_cleanup(engine):
    eng, db = engine
    eng.ensure_system_automations()                          # seeds Weekly Cleanup OFF
    db.set_metadata(PLAN_GATE_MIGRATION_KEY, '')             # pretend this is the upgrade boot
    row = db.get_system_automation_by_action('library_cleanup')
    db.toggle_automation(row['id'])                          # the user had switched it on

    eng.ensure_system_automations()

    assert _cfg(db, row['id'])['confirm'] is True


def test_migration_runs_once(engine):
    eng, db = engine
    eng.ensure_system_automations()
    later = db.create_automation('New dedupe', 'schedule', '{}', 'run_duplicate_cleaner', '{}')
    eng.ensure_system_automations()
    assert 'confirm' not in _cfg(db, later)                 # never flipped behind the user's back
