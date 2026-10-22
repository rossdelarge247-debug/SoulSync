"""the page shell's pre-paint accent must actually render.

a formatter once split `{{ initial_accent_rgb }}` into `{ { initial_accent_rgb } }`
across lines. jinja doesn't see that as a tag, so every page shipped the literal
text as the css value. admins never noticed (settings re-apply the accent
right after load); a member can't read /api/settings, so with nothing in
localStorage they got an app with no accent at all (found sept 25 2026 in a
live smoke of the profile rebuild).
"""

from __future__ import annotations

import os
import re
import tempfile

import pytest

_TMP = tempfile.mkdtemp(prefix='soulsync-testdb-appearance-')
os.environ['DATABASE_PATH'] = os.path.join(_TMP, 'a.db')
os.environ['SOULSYNC_TEST_DB_READY'] = '1'


def test_the_template_tags_are_whole():
    html = open('webui/index.html', encoding='utf-8').read()
    for var in ('initial_accent_rgb', 'initial_accent_light_rgb', 'initial_accent_neon_rgb'):
        assert '{{ %s }}' % var in html, var


web_server = pytest.importorskip('web_server')


def test_the_shell_ships_real_accent_numbers():
    body = web_server.app.test_client().get('/').get_data(as_text=True)
    m = re.search(r'--accent-rgb:\s*([^;]+);', body)
    assert m and re.fullmatch(r'\d{1,3}, \d{1,3}, \d{1,3}', m.group(1).strip()), m and m.group(1)


# ── Lilac is the default accent (Ross, 2026-10-22) ──

def test_a_fresh_config_is_lilac():
    from core.settings import ConfigManager
    from core.ui_appearance import DEFAULT_ACCENT

    assert DEFAULT_ACCENT == '#8b5cf6'
    defaults = ConfigManager.__new__(ConfigManager)._get_default_config()
    assert defaults['ui_appearance']['accent_preset'] == '#8b5cf6'
    assert defaults['ui_appearance']['accent_color'] == '#8b5cf6'
    # only the accent: the other appearance flags keep "unset" meaning their own default
    assert set(defaults['ui_appearance']) == {'accent_preset', 'accent_color'}


def _context_with(monkeypatch, saved):
    def fake_get(key, default=None):
        node = saved
        for part in key.split('.'):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    monkeypatch.setattr(web_server.config_manager, 'get', fake_get)
    return web_server._initial_appearance_context()


def test_nothing_saved_ships_lilac(monkeypatch):
    ctx = _context_with(monkeypatch, {})
    assert ctx['initial_accent_color'] == '#8b5cf6'
    assert ctx['initial_accent_rgb'] == '139, 92, 246'
    assert ctx['initial_accent_light_rgb'] == '194, 169, 250'


def test_a_saved_preset_is_kept(monkeypatch):
    ctx = _context_with(monkeypatch, {'ui_appearance': {'accent_preset': '#1db954'}})
    assert ctx['initial_accent_color'] == '#1db954'
    assert ctx['initial_accent_light_rgb'] == '70, 226, 125'  # #46e27d


def test_a_broken_saved_value_falls_back_to_lilac(monkeypatch):
    ctx = _context_with(monkeypatch, {'ui_appearance': {'accent_preset': 'custom',
                                                        'accent_color': 'nope'}})
    assert ctx['initial_accent_color'] == '#8b5cf6'
