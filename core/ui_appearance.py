"""Pure decisions for UI-appearance defaults.

Kept here (importable, no Flask/config coupling) so the rules are unit-testable in
isolation; web_server does only the request/config plumbing around them.

Worker orbs are a blurred 60fps canvas — the main remaining Firefox lag source after
the #935 sweep. So for a FIRST-TIME user (no saved preference) we default them OFF on
Firefox and ON everywhere else: a smooth first impression where it's needed, full
polish where the browser handles it. An explicit saved choice ALWAYS wins — this only
picks the default when the user hasn't chosen.
"""

from __future__ import annotations

import re
from typing import Any, Optional

# The accent an install gets when it has never saved one: Lilac (Ross, 2026-10-22).
# Its accent-light is #c2a9fa. webui/src/features/settings/accent.ts (DEFAULT_ACCENT),
# static/init.js and static/tokens.css carry the same value.
DEFAULT_ACCENT = '#8b5cf6'


def is_firefox_user_agent(user_agent: Optional[str]) -> bool:
    """True when a User-Agent string is Firefox.

    Used ONLY to pick a performance-friendly default — never to gate functionality —
    so a spoofed or unusual UA simply gets the default and the user can toggle. Chrome,
    Edge, Safari, Opera, Brave do not carry 'firefox' in their UA; Firefox does
    ('… Gecko/… Firefox/<ver>')."""
    return 'firefox' in str(user_agent or '').lower()


def resolve_worker_orbs_default(explicit: object, is_firefox: bool) -> bool:
    """Whether worker orbs should be on.

    ``explicit`` is the saved config value: ``True``/``False`` when the user has chosen,
    ``None`` when unset. An explicit choice always wins; when unset, default OFF on
    Firefox (perf) and ON elsewhere.
    """
    if explicit is None:
        return not is_firefox
    return explicit is not False


# ── the accent colour ────────────────────────────────────────────────────────
#
# The install's accent (``ui_appearance.accent_preset`` / ``accent_color``, set
# by an admin in Settings → Appearance) is the default; each profile may pick
# its own (``profiles.accent_color``, NULL = use the install's). Same sums as
# webui/src/features/settings/accent.ts: the light shade is +16% HSL
# lightness capped at 95%, and a custom accent must give dark text (#0b0b0f)
# 4.5:1 on that shade.

TEXT_ON_ACCENT = '#0b0b0f'
MIN_CONTRAST = 4.5
_HEX6 = re.compile(r'^[0-9a-f]{6}$')
_HEX3 = re.compile(r'^[0-9a-f]{3}$')


def normalise_hex(value: Any) -> Optional[str]:
    """'#8B5CF6', '8b5cf6' or '#85f' -> '#8b5cf6'; anything else -> None."""
    if not isinstance(value, str):
        return None
    raw = value.strip().lstrip('#').lower()
    if _HEX6.match(raw):
        return f'#{raw}'
    if _HEX3.match(raw):
        return '#' + ''.join(c * 2 for c in raw)
    return None


def _rgb(hex_color: str):
    clean = normalise_hex(hex_color) or DEFAULT_ACCENT
    return tuple(int(clean[i:i + 2], 16) for i in (1, 3, 5))


def accent_light(hex_color: str) -> str:
    """The accent's light shade, as applyAccentColor computes it."""
    r, g, b = (v / 255 for v in _rgb(hex_color))
    mx, mn = max(r, g, b), min(r, g, b)
    lightness = (mx + mn) / 2
    hue = sat = 0.0
    if mx != mn:
        d = mx - mn
        sat = d / (2 - mx - mn) if lightness > 0.5 else d / (mx + mn)
        if mx == r:
            hue = ((g - b) / d + (6 if g < b else 0)) / 6
        elif mx == g:
            hue = ((b - r) / d + 2) / 6
        else:
            hue = ((r - g) / d + 4) / 6
    light_l = min(lightness + 0.16, 0.95)
    if sat == 0:
        v = round(light_l * 255)
        return '#%02x%02x%02x' % (v, v, v)

    def h2r(p, q, t):
        if t < 0:
            t += 1
        if t > 1:
            t -= 1
        if t < 1 / 6:
            return p + (q - p) * 6 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p + (q - p) * (2 / 3 - t) * 6
        return p

    q = light_l * (1 + sat) if light_l < 0.5 else light_l + sat - light_l * sat
    p = 2 * light_l - q
    return '#%02x%02x%02x' % (round(h2r(p, q, hue + 1 / 3) * 255), round(h2r(p, q, hue) * 255),
                              round(h2r(p, q, hue - 1 / 3) * 255))


def _luminance(hex_color: str) -> float:
    def ch(v):
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = _rgb(hex_color)
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast_ratio(a: str, b: str) -> float:
    la, lb = _luminance(a), _luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def accent_passes(hex_color: str) -> bool:
    """Dark text on the accent's light shade reaches 4.5:1 (what buttons need)."""
    clean = normalise_hex(hex_color)
    return bool(clean) and contrast_ratio(TEXT_ON_ACCENT, accent_light(clean)) >= MIN_CONTRAST


def install_accent(get: Any) -> str:
    """The install's accent from config (``get(key, default)``): a preset's hex,
    or 'custom' and the custom hex. Anything unreadable is the default."""
    preset = get('ui_appearance.accent_preset', DEFAULT_ACCENT)
    if str(preset or '').strip().lower() == 'custom':
        return normalise_hex(get('ui_appearance.accent_color', DEFAULT_ACCENT)) or DEFAULT_ACCENT
    return normalise_hex(preset) or DEFAULT_ACCENT


def effective_accent(profile_accent: Any, install: str) -> str:
    """The profile's own pick when it has one, else the install's."""
    return normalise_hex(profile_accent) or normalise_hex(install) or DEFAULT_ACCENT


__all__ = ['is_firefox_user_agent', 'resolve_worker_orbs_default', 'DEFAULT_ACCENT', 'normalise_hex',
           'accent_light', 'contrast_ratio', 'accent_passes', 'install_accent', 'effective_accent']
