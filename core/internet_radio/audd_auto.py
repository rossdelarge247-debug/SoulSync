"""Automatic AudD: the step after the automatic fingerprint, only when needed.

The hub asks this only for a clip the relay already captured for the
automatic fingerprint (``RadioHub.wants_clip`` / ``submit_clip``, the same
relay audio Scan now's tap rides on), and only when all of these hold
(:meth:`core.internet_radio.hub.RadioHub.audd_needed`):

- the station is watched: someone is playing it, or a profile has auto-add on;
- the station isn't naming the track: its feed and its stream title are
  empty, missing or generic (a show, the station's name, an advert);
- the free AcoustID fingerprint answered "no match".

Then :class:`AutoAudd` adds its own rules, in this order:

- Settings → Radio: ``radio.audd_auto`` on, ``radio.audd_auto_daily_cap``
  above 0, and an AudD token saved;
- not stopped for today: AudD refused the token or said there are no requests
  left (``radio_scan_keys``, the Scan now card's Refused / No requests left)
  at an answer since local midnight. A new token, or a later answer from AudD
  (a Scan now or a Test that it accepted), clears that;
- pacing, per station: at least :data:`STATION_GAP_SECONDS` since its last
  automatic request, and one request per track window. A window ends when the
  stream's title changes, or after :data:`WINDOW_MAX_SECONDS` on a station
  whose title never changes (many unnamed stations send no titles at all);
- the daily cap: each request is counted before it's sent
  (:func:`core.internet_radio.store.claim_audd_auto`), so the cap is never
  passed; it resets at local midnight. Scan now by hand never counts here.

Every request goes through Scan now's AudD call
(:func:`core.internet_radio.scan_providers.audd`, the outbound guard's
``guarded_json``). The token is never logged or returned. Each request is
also counted in Scan now's month usage for AudD, as a scan's is.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple

from core.internet_radio import scan_providers as providers
from core.internet_radio import settings as radio_settings
from core.internet_radio import store
from utils.logging_config import get_logger

logger = get_logger("internet_radio.audd_auto")

STATION_GAP_SECONDS = 180    # at least this long between automatic requests on a station
WINDOW_MAX_SECONDS = 600     # a station whose title never changes: a new window this often
STOP_STATES = ("bad_key", "out_of_credit")


class AutoAudd:
    def __init__(self, *, get_database: Callable[[], Any], config: Any,
                 ask: Optional[Callable[[str, str], providers.ProviderResult]] = None,
                 clock: Callable[[], float] = time.time):
        self.get_database = get_database
        self.config = config
        self._ask = ask or providers.audd
        self.clock = clock
        self._lock = threading.Lock()
        # station id -> (when its last automatic request went, the window it was in)
        self._last: Dict[str, Tuple[float, int]] = {}

    def reset(self) -> None:
        with self._lock:
            self._last.clear()

    # ── what Settings → Radio shows ──────────────────────────────────────────

    def stopped_today(self, db, now: Optional[float] = None) -> Optional[str]:
        """``bad_key`` or ``out_of_credit`` when AudD said so since local midnight."""
        now = self.clock() if now is None else now
        try:
            row = store.scan_key_states(db).get("audd") or {}
        except Exception as exc:  # noqa: BLE001 - unknown reads as not stopped; the cap still holds
            logger.debug("AudD key state unreadable: %s", exc)
            return None
        if row.get("state") in STOP_STATES and (row.get("state_at") or 0) >= store.day_start(now):
            return str(row["state"])
        return None

    def status(self, db) -> Dict[str, Any]:
        """``{on, daily_cap, used_today, ready, stopped}`` for the Scan now card."""
        cfg = radio_settings.read(self.config)
        now = self.clock()
        try:
            used = store.audd_auto_used(db, now)
        except Exception as exc:  # noqa: BLE001
            logger.debug("automatic AudD count unreadable: %s", exc)
            used = 0
        cap = cfg["audd_auto_daily_cap"]
        stopped = self.stopped_today(db, now)
        if stopped is None and cap > 0 and used >= cap:
            stopped = "cap_reached"
        return {"on": bool(cfg["audd_auto"]) and cap > 0, "daily_cap": cap, "used_today": used,
                "ready": bool(radio_settings.audd_token(self.config)), "stopped": stopped}

    # ── the request ──────────────────────────────────────────────────────────

    def why_not(self, db, station_id: str, window: int, now: float) -> Optional[str]:
        """Why no request may go now, or None when one may."""
        cfg = radio_settings.read(self.config)
        if not cfg["identification"]:
            return "identification_off"
        if not cfg["audd_auto"] or cfg["audd_auto_daily_cap"] <= 0:
            return "off"
        if not radio_settings.audd_token(self.config):
            return "no_token"
        if self.stopped_today(db, now):
            return "stopped"
        with self._lock:
            last = self._last.get(station_id)
        if last is not None:
            at, last_window = last
            if now - at < STATION_GAP_SECONDS:
                return "paced"
            if last_window == window and now - at < WINDOW_MAX_SECONDS:
                return "same_window"
        return None

    def identify(self, station_id: str, path: str, window: int) -> Optional[providers.ProviderResult]:
        """AudD's answer for the clip at ``path``, or None when no request
        went (switched off, stopped, paced, capped)."""
        db = self.get_database()
        now = self.clock()
        reason = self.why_not(db, station_id, window, now)
        if reason is not None:
            logger.debug("automatic AudD skipped for %s: %s", station_id, reason)
            return None
        cap = radio_settings.read(self.config)["audd_auto_daily_cap"]
        with self._lock:
            # the window is spent whether or not the cap lets the request go,
            # so a capped station isn't asked again every few seconds
            self._last[station_id] = (now, window)
        try:
            if not store.claim_audd_auto(db, cap, now):
                logger.debug("automatic AudD skipped for %s: today's cap is reached", station_id)
                return None
        except Exception as exc:  # noqa: BLE001 - an uncountable request isn't sent
            logger.debug("automatic AudD not counted, not sent: %s", exc)
            return None
        try:
            result = self._ask(path, radio_settings.audd_token(self.config))
        except Exception:  # noqa: BLE001 - a broken call is an error, never a crash
            logger.exception("automatic AudD broke")
            result = providers.ProviderResult(provider="audd", status="error", error="provider_error",
                                              message=providers.error_words("audd", "provider_error"))
        self._record(db, result, now)
        return result

    def _record(self, db, result: providers.ProviderResult, now: float) -> None:
        try:
            if result.status != "error" or result.error != "offline":
                store.bump_scan_usage(db, "audd", found=result.matched, now=now)
            if result.status != "error":
                store.record_scan_key_answer(db, "audd", "ok", now)
            elif result.error in STOP_STATES:
                # stops automatic AudD for the rest of the day; the card shows Refused / No requests left
                store.record_scan_key_answer(db, "audd", result.error, now)
        except Exception as exc:  # noqa: BLE001 - a count, not a reason to fail
            logger.debug("automatic AudD usage not recorded: %s", exc)
        if result.status == "error":
            logger.info("automatic AudD: %s", result.error)  # the kind only, never the token


__all__ = ["AutoAudd", "STATION_GAP_SECONDS", "WINDOW_MAX_SECONDS"]
