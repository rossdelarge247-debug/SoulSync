"""Compact navigation: the 72px rail (#1155, wishx; Shell A, board 1m).

    "The ability to collapse the sidebar down to just the icons (perhaps with a
    mouse-over with the name of the tab when collapsed) would save a lot of
    screen real estate."

The collapse toggle became the navigation shell's compact mode: clicking the
"SYNCHRO.S" wordmark folds the 256px sidebar to a 72px rail, the "S" monogram
expands it again. Behaviour lives in webui/src/shell/nav-shell.ts (tested in
nav-shell.test.ts), the look in webui/static/shell.css. These pin the parts
that span files and that no browser test sees:

**The width has consumers outside the sidebar.** The audio visualiser is
``position: fixed`` at the sidebar's right edge and the page-particles canvas
offsets from it with ``calc(100vw - …)``. They all read ``--sidebar-w``.

**The mode has to be on <html> before the stylesheet resolves.** Applied late,
the sidebar paints at 256px and snaps to 72px, jumping the whole page on every
load. The <head> script and nav-shell.ts share the storage key, which is the
old toggle's, so a sidebar people had collapsed comes back as the rail.

Group labels are the design question compact poses: there is no room for text,
so each label becomes a 24px hairline (the board's separators), and the video
sidebar's folded sections open up there (a folded section has no readable name
on the rail to unfold it by) without losing the saved fold state.
"""

import re

import pytest

STYLE = 'webui/static/style.css'
SHELL_CSS = 'webui/static/shell.css'
HTML = 'webui/index.html'
SHELL_TS = 'webui/src/shell/nav-shell.ts'
INIT = 'webui/static/init.js'

STORAGE_KEY = 'sidebarCollapsed'


def read(path):
    with open(path, encoding='utf-8') as handle:
        return handle.read()


@pytest.fixture(scope='module')
def css():
    return read(STYLE)


@pytest.fixture(scope='module')
def shell_css():
    return read(SHELL_CSS)


@pytest.fixture(scope='module')
def html():
    return read(HTML)


@pytest.fixture(scope='module')
def ts():
    return read(SHELL_TS)


def compact_block(shell_css):
    """The desktop-only compact rules."""
    start = shell_css.index('@media (min-width: 769px) {')
    return shell_css[start:shell_css.index('/* ── phone', start)]


# ── the width is defined once ───────────────────────────────────────────────

def test_the_sidebar_width_is_a_single_variable(css):
    assert '--sidebar-w: 256px;' in css, "the board's 256px has to live in one place"


def test_compact_is_the_boards_72px_rail(css):
    width = int(re.search(r'html\[data-sidebar="collapsed"\]\s*\{[^}]*--sidebar-w:\s*(\d+)px', css).group(1))
    assert width == 72


def test_nothing_still_offsets_from_an_old_width(css):
    """Elements lined up against the sidebar from OUTSIDE it fail silently —
    the visualiser floats mid-page, the particles canvas offsets from nothing.
    Only ``left:`` and ``calc(100vw - …)`` count."""
    offenders = []
    for line_no, line in enumerate(css.splitlines(), 1):
        if re.search(r'(?:^|\s)left:\s*(?:240|256)px', line) or re.search(r'calc\(100vw - (?:240|256)px\)', line):
            offenders.append(f"{line_no}: {line.strip()}")
    assert offenders == [], f"still offsetting from a hardcoded sidebar width: {offenders}"


@pytest.mark.parametrize("selector", ['.sidebar {', '.sidebar-visualizer {', '#page-particles-canvas {'])
def test_every_width_consumer_reads_the_variable(css, selector):
    block = css[css.index(selector):]
    block = block[:block.index('}')]
    assert 'var(--sidebar-w)' in block, f"{selector} must follow the sidebar width"


def test_the_shell_sidebar_sizes_from_the_variable(shell_css):
    """min-width pins a flex item regardless of what ``width`` says — a fixed
    min-width once made the old toggle do visibly nothing."""
    block = shell_css[shell_css.index('#app-sidebar.ss-sidebar {'):]
    block = block[:block.index('}')]
    for prop in ('width', 'min-width', 'max-width'):
        assert re.search(rf'(?:^|\s){prop}:\s*var\(--sidebar-w\);', block), prop
    assert 'flex: 0 0 var(--sidebar-w);' in block


def test_no_layout_animates(css, shell_css):
    """DESIGN-SYSTEM.md: transitions are on colour only; nothing animates layout."""
    assert '--sidebar-collapse-transition: 0s;' in css
    block = shell_css[shell_css.index('#app-sidebar.ss-sidebar {'):]
    assert 'transition: none;' in block[:block.index('}')]


# ── applied before paint ────────────────────────────────────────────────────

def test_the_state_is_applied_in_head_before_the_stylesheet(html):
    head = html[:html.index('</head>')]
    assert STORAGE_KEY in head, "the state must be read in <head>"
    assert "setAttribute('data-sidebar', 'collapsed')" in head
    assert html.index(STORAGE_KEY) < html.index('style.css'), "must run before --sidebar-w resolves"


def test_the_admin_fold_is_applied_before_paint_too(html, ts):
    head = html[:html.index('</head>')]
    assert "localStorage.getItem('ssNavAdminOpen')" in head
    assert "setAttribute('data-admin-open', 'true')" in head
    assert "ADMIN_OPEN_KEY = 'ssNavAdminOpen'" in ts


def test_the_early_script_cannot_break_the_page(html):
    """It runs before everything; localStorage is blocked outright in some
    embedded browsers."""
    head = html[:html.index('</head>')]
    at = head.index(f"localStorage.getItem('{STORAGE_KEY}')")
    block = head[at - 200:at + 400]
    assert 'try {' in block and 'catch (e)' in block


def test_both_sides_agree_on_the_storage_key(html, ts):
    assert STORAGE_KEY in html and f"COMPACT_KEY = '{STORAGE_KEY}'" in ts


# ── the toggle ──────────────────────────────────────────────────────────────

def test_the_wordmark_is_the_toggle(html):
    """It lives in the sidebar, not in Settings: a spatial preference you
    change while looking at the thing. The monogram expands it again."""
    brand = html[html.index('class="sidebar-header ss-brand"'):html.index('class="sidebar-scroll ss-nav-scroll"')]
    assert 'id="sidebar-collapse-toggle"' in brand
    assert '<span class="ss-wordmark-name" role="img" aria-label="SYNCHRO.S">SYNCHRO.S</span>' in brand
    assert '<span class="ss-monogram" aria-hidden="true">S</span>' in brand
    assert 'aria-label="Collapse navigation"' in brand


def test_the_toggle_is_a_plain_two_state_flip(ts):
    assert 'setCompact(!isCompact())' in ts


def test_expanded_carries_no_attribute(ts):
    assert "html.removeAttribute('data-sidebar')" in ts


def test_the_state_survives_a_reload_and_blocked_storage(ts):
    assert "writeStore(COMPACT_KEY, compact ? '1' : null)" in ts
    store = ts[ts.index('function writeStore'):ts.index('function stripBase')]
    assert 'try {' in store and 'catch' in store


def test_the_old_toggle_code_is_gone(html):
    assert 'toggleSidebarCollapsed()' not in html
    assert read(INIT).count('function setSidebarCollapsed') == 0


# ── compact: the design question ────────────────────────────────────────────

def test_compact_hides_the_labels_and_keeps_the_icons(shell_css):
    block = compact_block(shell_css)
    labels = block[block.index("html[data-sidebar='collapsed'] #app-sidebar .ss-label {"):]
    labels = labels[:labels.index('}')]
    # off screen, still the rows' names for a screen reader
    assert 'clip-path: inset(50%);' in labels and 'display: none' not in labels
    assert '.ss-icon' not in labels


def test_a_group_label_becomes_a_hairline_not_a_nameless_control(shell_css):
    block = compact_block(shell_css)
    rule = block[block.index("html[data-sidebar='collapsed'] #app-sidebar .ss-group-label,"):]
    rule = rule[:rule.index('}')]
    assert 'width: 24px;' in rule
    assert 'border-top: 1px solid rgba(255, 255, 255, 0.12);' in rule
    assert 'pointer-events: none;' in rule, "an unreadable control must not be clickable"


def test_folded_video_sections_open_up_on_the_rail(shell_css):
    block = compact_block(shell_css)
    assert "html[data-sidebar='collapsed'] #app-sidebar .nav-item-hidden { display: flex !important; }" in block


def test_the_saved_section_state_is_not_destroyed(ts):
    """Compact overrides the rendering only; expanding brings back exactly the
    sections that were folded."""
    assert 'navSections' not in ts


def test_rail_icons_get_their_names_as_title_and_aria_label(ts):
    body = ts[ts.index('function syncRailLabels'):ts.index('function setCompact')]
    assert "setOwnedAttr(el, 'title'" in body
    assert "setOwnedAttr(el, 'aria-label'" in body
    # and only while compact on a desktop: the labels are visible otherwise
    assert 'const rail = isCompact() && !isPhone();' in body
    assert "setOwnedAttr(el, 'title', null)" in body


def test_compact_stands_down_on_phones(css, shell_css):
    """The phone layout has the tab bar, which is already the compact form;
    the rail rules are desktop-only and the width falls back."""
    assert "html[data-sidebar='collapsed']" not in shell_css[shell_css.index('/* ── phone ─'):]
    mobile = css[css.index('@media (max-width: 768px) {\n    html[data-sidebar="collapsed"]'):]
    assert '--sidebar-w: 256px;' in mobile[:mobile.index('}\n}')]
