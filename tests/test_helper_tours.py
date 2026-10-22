"""Guided-tour integrity (Kazimir: red dot never clears, boxes detach and
'live in a corner').

Root causes fixed: 28 of 83 tour selectors had rotted through page
redesigns (dead anchors → the popover fell back to nowhere), the anchor
resolve was a single fixed 350ms wait (React pages mount later), and the
helper button's What's New dot only cleared through one specific panel.

This file is the net that keeps tours honest: EVERY tour selector must
resolve to something some renderer actually creates — index.html, a
static JS renderer, or the React source. A redesign that removes an
anchored element now fails here instead of silently stranding the tour.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
_HELPER = (_ROOT / 'webui' / 'static' / 'helper.js').read_text(encoding='utf-8', errors='replace')
_INDEX = (_ROOT / 'webui' / 'index.html').read_text(encoding='utf-8', errors='replace')


def _tour_block() -> str:
    start = _HELPER.index('const HELPER_TOURS = {')
    i = _HELPER.index('{', start)
    depth = 0
    for j in range(i, len(_HELPER)):
        if _HELPER[j] == '{':
            depth += 1
        elif _HELPER[j] == '}':
            depth -= 1
            if depth == 0:
                return _HELPER[i:j + 1]
    raise AssertionError('HELPER_TOURS block not closed')


def _all_frontend_source() -> str:
    """Everything that can create DOM: the shell, the classic JS, the React
    source (dist is built FROM src, so src is the truth)."""
    chunks = [_INDEX]
    for p in (_ROOT / 'webui' / 'static').rglob('*.js'):
        if 'dist' in p.parts or p.name == 'helper.js':
            continue
        chunks.append(p.read_text(encoding='utf-8', errors='replace'))
    src = _ROOT / 'webui' / 'src'
    if src.is_dir():
        for p in src.rglob('*'):
            if p.suffix in ('.tsx', '.ts', '.jsx', '.js', '.html'):
                chunks.append(p.read_text(encoding='utf-8', errors='replace'))
    return '\n'.join(chunks)


# phone variants (phoneSelector) are anchors too: the tab bar, the top bar's icons
_SELECTORS = sorted(set(re.findall(r"[sS]elector:\s*'([^']+)'", _tour_block())))
_SOURCE = _all_frontend_source()


def test_tours_have_selectors():
    assert len(_SELECTORS) > 50     # the tours are substantial; a parse break would zero this


@pytest.mark.parametrize('selector', _SELECTORS)
def test_every_tour_selector_has_a_renderer(selector):
    """Each simple token of the selector must exist somewhere a renderer
    writes it. This is intentionally string-level: it catches deletions and
    renames (the rot), not runtime visibility."""
    checks = []
    for kind, name in re.findall(r'([#.])([\w-]+)', selector):
        if kind == '#':
            checks.append(f'id="{name}"' in _SOURCE or f"id='{name}'" in _SOURCE
                          or f"'{name}'" in _SOURCE or f'"{name}"' in _SOURCE)
        else:
            checks.append(name in _SOURCE)
    for attr, value in re.findall(r'\[(data-tab|data-tour|data-nav-row)="([^"]+)"\]', selector):
        checks.append(f'{attr}="{value}"' in _SOURCE or f"'{value}'" in _SOURCE)
    assert checks and all(checks), f'tour anchor has no renderer: {selector}'


def _page_sections():
    """Split index.html into the shell (sidebar/header/modals) and per-page
    content. Approximate but directional: a page's slice runs to the next
    page div."""
    parts = re.split(r'<div class="page(?:\s[^"]*)?" id="([\w-]+)-page">', _INDEX)
    shell = parts[0]
    pages = {}
    for k in range(1, len(parts) - 1, 2):
        pages[parts[k]] = parts[k + 1]
    return shell, pages


_STEPS = re.findall(r"page:\s*'([\w-]+)',\s*selector:\s*'([^']+)'", _tour_block())


def test_steps_anchor_to_their_own_page_or_the_shell():
    """Boulder's report: the dashboard tour talked about tool cards that MOVED
    to another page — the ids still existed, so the renderer check passed,
    but the elements were invisible on the tour's page and every step showed
    the centered fallback. A static #id anchor that index.html renders must
    live inside the step's own page section or the shell."""
    shell, pages = _page_sections()
    offenders = []
    for page, selector in _STEPS:
        m = re.match(r'^#([\w-]+)$', selector)
        if not m:
            continue
        needle = f'id="{m.group(1)}"'
        if needle not in _INDEX:
            continue        # dynamically rendered (React/JS) — renderer test covers it
        if needle not in shell and needle not in pages.get(page, ''):
            offenders.append(f'{page}: {selector}')
    assert not offenders, f'tour anchors living on the WRONG page: {offenders}'


def _tour(name: str) -> str:
    """One tour's entry in HELPER_TOURS, as text."""
    block = _tour_block()
    start = block.index(f"    '{name}': {{")
    nxt = re.search(r"\n    '[\w-]+': \{", block[start + 1:])
    return block[start:start + 1 + nxt.start()] if nxt else block[start:]


def test_welcome_tour_walks_todays_app():
    """The redesign's tour: the navigation (groups, the compact rail, Admin
    and help, ⌘K search, the running link), Home's targets and Latest,
    Wanted, Activity, Search, the one Artist page, Automations with runs and
    Preview a run, and the Setup check, in that order."""
    welcome = _tour('welcome')
    order = ['#app-sidebar .ss-music-nav', '#sidebar-collapse-toggle', '#ss-admin', '#ss-search',
             '#ss-running', '[data-tour="home-targets"]', '[data-tour="home-latest"]',
             '[data-tour="wanted-tabs"]', '[data-tour="activity-controls"]', '#enhanced-search-bar',
             '#app-sidebar [data-nav-row="artists"]', '[data-tour="automation-card"]',
             '[data-tour="automation-preview"]', '[data-tour="automation-runs"]',
             '[data-tour="setup-check"]']
    positions = [welcome.find(f"'{anchor}'") for anchor in order]
    assert -1 not in positions, dict(zip(order, positions))
    assert positions == sorted(positions), 'the welcome tour walks the app in order'
    # phones point at the tab bar and the top bar's icons instead of the sidebar
    for phone in ('#ss-tabbar', '#ss-tabbar [data-tab="settings"]', '#ss-phone-search',
                  '#ss-phone-activity', '[data-tour="automation-runs-link"]'):
        assert f"phoneSelector: '{phone}'" in welcome, phone
    assert "selector: '#sidebar-collapse-toggle', phone: false" in welcome
    assert 'admin: true' in welcome     # the Setup check is admins' only


def test_old_dashboard_tour_is_gone():
    """The old welcome step landed on the workers panel and called the page
    the Music Dashboard; its stops pointed at the old header's tiles and the
    old sidebar sections."""
    block = _tour_block()
    assert "'dashboard': {" not in block
    assert "'first-download': {" not in block
    welcome = _tour('welcome')
    for stale in ('Music Dashboard', '.dashboard-header', '.header-actions', '#watchlist-button',
                  '#wishlist-button', '#library-status-card', '.dash-card--rail', '.listen-hero',
                  '.dash-autom-rows', '#sync-history-cards', '.status-section', '.side-toggle',
                  '#profile-indicator', '.nav-section-label', '.version-button'):
        assert stale not in welcome, f'the welcome tour still points at {stale}'


def test_rebuilt_pages_anchor_to_data_tour_attributes_they_render():
    """Each data-tour anchor a step names is rendered by that step's own page
    (the tours walk the pages in order; an anchor on another page is skipped)."""
    page_dirs = {
        'dashboard': 'dashboard', 'wanted': 'wanted', 'activity': 'activity',
        'search': 'search', 'automations': 'automations', 'setup-check': 'setup-check',
        'artist-detail': 'artist-detail',
    }
    routes = _ROOT / 'webui' / 'src' / 'routes'
    checked = 0
    for page, selector, rest in re.findall(
            r"page:\s*'([\w-]+)',\s*selector:\s*'([^']+)'([^}]*)", _tour_block()):
        anchors = [selector] + re.findall(r"phoneSelector:\s*'([^']+)'", rest)
        for anchor in anchors:
            for value in re.findall(r'\[data-tour="([\w-]+)"\]', anchor):
                src = '\n'.join(p.read_text(encoding='utf-8') for p in (routes / page_dirs[page]).rglob('*.tsx')
                                if '.test.' not in p.name)
                assert f'data-tour="{value}"' in src or f"'{value}'" in src, \
                    f'{page} renders no data-tour="{value}"'
                checked += 1
    assert checked >= 15


# ── engine contracts ──────────────────────────────────────────────────────────

def test_anchor_resolution_retries_instead_of_one_fixed_wait():
    assert 'function _resolveTourTarget' in _HELPER
    # the step's anchor for this screen (a phone has its own, see _tourStepView)
    assert '_resolveTourTarget(view.selector' in _HELPER
    # visibility gate: a hidden element is NOT an anchor
    assert 'offsetParent !== null' in _HELPER
    # the old blind render-after-350ms path is gone
    assert '_renderTourStep(tour, step), 350' not in _HELPER


def test_popover_reanchors_on_resize_and_cleans_up():
    assert '_tourRepositionHandler' in _HELPER
    assert "window.addEventListener('resize', _tourRepositionHandler)" in _HELPER
    assert '_removeTourReposition()' in _HELPER.split('function removeTourOverlay')[1][:300]


def test_whats_new_dot_clears_from_the_version_modal_too():
    js = (_ROOT / 'webui' / 'static' / 'downloads.js').read_text(encoding='utf-8', errors='replace')
    body = js.split('async function showVersionInfo')[1]
    assert 'soulsync_helper_version_seen' in body


def test_the_dead_selectors_stay_dead():
    # the six anchors the redesigns orphaned — never reference them again
    block = _tour_block()
    for dead in ('#enh-results-container', '#retag-tool-card', '.import-page-header',
                 '.import-page-refresh-btn', '.import-page-staging-bar', '.import-page-tab-bar',
                 # the search overhaul took the input wrapper out (Sept 2026)
                 '.enhanced-search-input-wrapper',
                 # the redesign (Oct 2026): the old artist page, the old automations
                 # page, the old sidebar sections and the dashboard header
                 '#artist-hero-section', '#library-artist-watchlist-btn', '#discography-filters',
                 '#automations-stats', '.auto-new-btn', '#auto-section-hub', '#automations-list-view',
                 '.nav-section-label', '.dashboard-header'):
        assert dead not in block, f'{dead} is a dead anchor'


def test_a_missing_anchor_skips_the_step_instead_of_centring_it():
    # the old fallback centred the box over the page with copy about a
    # control that wasn't there; now the tour moves on the way it was going
    assert 'function _skipTourStep' in _HELPER
    show = _HELPER.split('function showTourStep')[1].split('\nfunction ')[0]
    assert 'if (!target && view.selector)' in show and '_skipTourStep()' in show
    # a page that is already up gets a short wait before the skip
    assert 'navigating ? 12 : 3' in show


def test_tours_fit_phones_and_profiles():
    assert 'function _tourIsPhone' in _HELPER and '(max-width: 768px)' in _HELPER
    assert 'phoneSelector' in _HELPER.split('function _tourStepView')[1][:400]
    assert 'step.admin' in _HELPER.split('function _tourStepsFor')[1][:400]
    # the artist tour needs an artist: offered on the artist page only
    assert "onlyOn: 'artist-detail'" in _tour('artist')


def test_the_tour_can_always_be_left():
    nav = _HELPER.split('function _renderTourStep')[1].split('\nfunction ')[0]
    assert '>Skip tour</button>' in nav and 'onclick="dismissTour()"' in nav
    keydown = _HELPER.split("if (e.key === 'Escape') {")[1][:300]
    assert keydown.index('dismissTour()') < keydown.index('dismissHelperPopover()')
    # the box sits above the floating bell, activity and help buttons (999999)
    css = (_ROOT / 'webui' / 'static' / 'style.css').read_text(encoding='utf-8')
    rule = css.split('.helper-tour-popover {')[1].split('}')[0]
    assert int(re.search(r'z-index:\s*(\d+)', rule).group(1)) > 999999
    assert '.helper-popover-arrow.arrow-bottom' in css
