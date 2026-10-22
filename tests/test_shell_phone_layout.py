"""Layout the navigation shell (webui/static/shell.css) owns around pages.

On phones the top bar is part of the page's flow, not a floating button over
it, so the 70px top padding mobile.css gives every .page for that old button
would leave a gap under the bar; the shell takes it back to the phone gutter.

The floating notification, help and activity buttons sit above everything
(z-index 999999), dialogs included, so they hide while a dialog is open
rather than cover its footer."""

import re

SHELL_CSS = 'webui/static/shell.css'
MOBILE_CSS = 'webui/static/mobile.css'
HTML = 'webui/index.html'


def read(path):
    with open(path, encoding='utf-8') as handle:
        return handle.read()


def media_blocks(css, query):
    """Bodies of every @media block for ``query`` (brace-matched)."""
    bodies = []
    for match in re.finditer(r'@media\s*\(' + re.escape(query) + r'\)\s*\{', css):
        depth, start = 1, match.end()
        for i in range(start, len(css)):
            if css[i] == '{':
                depth += 1
            elif css[i] == '}':
                depth -= 1
                if depth == 0:
                    bodies.append(css[start:i])
                    break
    return bodies


def top_padding(blocks):
    for body in blocks:
        rule = re.search(r'\.ss-main \.page\s*\{([^}]*)\}', body)
        if rule:
            found = re.search(r'padding-top:\s*(\d+)px', rule.group(1))
            if found:
                return int(found.group(1))
    return None


def test_the_shell_loads_after_mobile_css():
    html = read(HTML)
    assert html.index('mobile.css') < html.index('shell.css')


def test_phone_pages_start_at_the_gutter_not_under_an_old_button():
    assert '70px' in read(MOBILE_CSS)
    shell = read(SHELL_CSS)
    assert top_padding(media_blocks(shell, 'max-width: 768px')) == 16
    assert top_padding(media_blocks(shell, 'max-width: 480px')) == 12


def test_the_floating_buttons_step_aside_for_an_open_dialog():
    shell = read(SHELL_CSS)
    rule = re.search(r"body:has\(\[role='dialog'\]\[data-open\]\)\s*:is\(([^)]*)\)\s*\{([^}]*)\}", shell)
    assert rule, 'no rule hides the floating buttons under an open dialog'
    names = {name.strip() for name in rule.group(1).split(',')}
    assert names == {'.notif-bell-btn', '.helper-float-btn', '.activity-float-btn'}
    assert 'visibility: hidden' in rule.group(2)


def test_phones_have_no_floating_buttons():
    """Design, HANDOFF 25: on phones the notifications live in the top bar's
    Activity icon and help in the Settings sheet and the page headers, so the
    floating buttons go at the app's mobile breakpoint; wide screens keep them."""
    shell = read(SHELL_CSS)
    hidden = False
    for body in media_blocks(shell, 'max-width: 768px'):
        body = re.sub(r'/\*.*?\*/', '', body, flags=re.S)
        for rule in re.finditer(r'([^{}]+)\{([^}]*)\}', body):
            names = {name.strip() for name in rule.group(1).split(',')}
            if {'.notif-bell-btn', '.helper-float-btn', '.activity-float-btn'} <= names:
                assert 'display: none !important' in rule.group(2)
                hidden = True
    assert hidden, 'no phone rule hides the floating buttons'
    # outside the phone blocks nothing hides them
    outside = re.sub(r'@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}', '', shell)
    assert not re.search(r'\.notif-bell-btn[^{]*\{[^}]*display:\s*none', outside)


def test_the_phone_activity_icon_opens_the_notifications():
    html = read(HTML)
    start = html.index('id="ss-phone-activity"')
    tag = html[html.rindex('<', 0, start):html.index('>', start)]
    assert tag.startswith('<button') and 'aria-expanded' in tag
