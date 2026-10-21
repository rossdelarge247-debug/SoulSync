"""GET /api/health: what the Docker HEALTHCHECK polls instead of rendering "/".

It must answer without a session (the login, launch-PIN and no-profile gates
all let it through), turn 503 when the database stops answering, and say
nothing beyond up or down.
"""

from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.mkdtemp(prefix='soulsync-testdb-health-')
os.environ['DATABASE_PATH'] = os.path.join(_TMP, 'health.db')
os.environ['SOULSYNC_TEST_DB_READY'] = '1'

web_server = pytest.importorskip('web_server')

from core.security.launch_lock import request_is_locked  # noqa: E402
from core.security.login_gate import login_request_is_blocked  # noqa: E402
from core.security.session_profile import no_profile_request_is_blocked  # noqa: E402


@pytest.fixture
def client():
    return web_server.app.test_client()


def _config(monkeypatch, **values):
    real_get = web_server.config_manager.get
    monkeypatch.setattr(web_server.config_manager, 'get',
                        lambda k, d=None: values[k] if k in values else real_get(k, d))


def test_healthy_app_answers_ok_and_nothing_else(client):
    response = client.get('/api/health')

    assert response.status_code == 200
    assert response.get_json() == {'status': 'ok'}
    assert response.headers['Cache-Control'] == 'no-store'


def test_head_works_for_monitors_that_use_it(client):
    assert client.head('/api/health').status_code == 200


def test_unreachable_database_is_503_without_details(client, monkeypatch):
    def broken():
        raise RuntimeError('unable to open database file /secret/path/music_library.db')

    monkeypatch.setattr(web_server, 'get_database', broken)
    response = client.get('/api/health')

    assert response.status_code == 503
    assert response.get_json() == {'status': 'unavailable'}
    assert b'secret' not in response.data


def test_does_not_render_the_page_shell(client, monkeypatch):
    def no_render(*_args, **_kwargs):
        raise AssertionError('health check rendered a template')

    monkeypatch.setattr(web_server, 'render_template', no_render)
    assert client.get('/api/health').status_code == 200


def test_open_while_login_is_required(client, monkeypatch):
    _config(monkeypatch, **{'security.require_login': True})

    assert client.get('/api/health').status_code == 200
    # the gate itself is still on for everything else
    assert client.get('/api/settings').status_code == 401


def test_open_while_the_launch_pin_is_locked(client, monkeypatch):
    _config(monkeypatch, **{'security.require_login': False, 'security.require_pin_on_launch': True})

    assert client.get('/api/health').status_code == 200
    assert client.get('/api/settings').status_code == 401


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
def test_every_gate_lets_the_probe_through(method):
    assert not login_request_is_blocked('/api/health', method, require_login=True, authenticated=False)
    assert not request_is_locked('/api/health', method, require_pin=True, pin_verified=False)
    assert not no_profile_request_is_blocked('/api/health', method)


def test_only_reads_are_open():
    assert login_request_is_blocked('/api/health', 'POST', require_login=True, authenticated=False)
    assert request_is_locked('/api/health', 'POST', require_pin=True, pin_verified=False)
    assert no_profile_request_is_blocked('/api/health', 'POST')
    # and nothing under it
    assert login_request_is_blocked('/api/health/details', 'GET', require_login=True, authenticated=False)
