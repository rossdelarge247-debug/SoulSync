"""Vibe (core/dj/vibe.py; ``POST /api/library/dj/mixes/<id>/vibe``): the AI
re-orders the Mix tab's top 20, through the app's provider, only with track
details, refused when the AI is off for the profile or at its limit, and
counted against the profile's usage. The provider is a fake."""

from __future__ import annotations

import json

import pytest

import api.dj as dj_api
from core.ai.provider import Final, ProviderError, ToolCall
from core.dj import vibe


class FakeStream:
    def __init__(self, final, error=None):
        self._final = final
        self._error = error
        self.closed = False

    def __iter__(self):
        yield ("tick", None)
        if self._error:
            raise self._error

    def final(self):
        return self._final

    def usage_so_far(self):
        return dict(self._final.usage) if self._final else {"input_tokens": 50}

    def close(self):
        self.closed = True


class FakeProvider:
    def __init__(self, order=None, line="Warm and late-night first.", error=None, no_tool=False):
        self.calls = []
        self.order = order
        self.line = line
        self.error = error
        self.no_tool = no_tool

    def factory(self, key, model):
        self.key, self.model = key, model
        return self

    def open_stream(self, *, system, messages, tools, max_tokens):
        self.calls.append({"system": system, "messages": messages, "tools": tools})
        data = json.loads(messages[0]["content"][0]["text"].split("\n", 1)[1])
        order = self.order if self.order is not None else [c["n"] for c in reversed(data["candidates"])]
        calls = [] if self.no_tool else [ToolCall(name="rank_by_feel", input={"order": order, "line": self.line})]
        final = Final(stop_reason="tool_use", tool_calls=calls,
                      usage={"input_tokens": 900, "output_tokens": 40}, model=model_id())
        return FakeStream(final, self.error)


def model_id():
    from core.ai.config import MODELS

    return MODELS["fast"]["id"]


@pytest.fixture
def ai(client, monkeypatch):
    import core.profile_context as profile_context
    import core.settings as settings

    config = settings.config_manager
    config.set("ai.anthropic_api_key", "sk-ant-test-key-123")
    admin = {"on": True}
    monkeypatch.setattr(profile_context, "is_admin_request", lambda: admin["on"])
    provider = FakeProvider()
    monkeypatch.setattr(dj_api, "vibe_provider_factory", provider.factory)
    return {"config": config, "provider": provider, "admin": admin}


def _vibe(client, track="9", **body):
    return client.post(f"/api/library/dj/mixes/{track}/vibe", json=body)


def _usage(sql):
    return [tuple(r) for r in sql("SELECT profile_id, requests, input_tokens, output_tokens FROM ai_usage_profiles")]


def test_the_ai_reorders_the_top_and_usage_is_counted(client, ai, sql):
    res = _vibe(client)
    body = res.get_json()
    assert res.status_code == 200, body
    # the fake answers code's order reversed: Undertow (#3 of six) and so on
    code = [m["id"] for m in client.get("/api/library/dj/mixes/9?rank=mix&limit=20").get_json()["matches"]]
    assert [m["id"] for m in body["matches"]] == list(reversed(code))[:5]
    assert body["vibe"]["line"] == "Warm and late-night first."
    assert body["matches"][0]["reason"]  # code's words stay with each match
    assert _usage(sql) == [(1, 1, 900, 40)]


def test_only_track_details_go_to_the_ai(client, ai, sql):
    sql("UPDATE artists SET genres = '[\"deep house\"]' WHERE name = 'Tidewater'")
    set_id = client.post("/api/sets", json={"name": "Secret Set Name", "kind": "hand",
                                            "tracks": [{"track_id": "1", "state": "owned"}]}).get_json()["id"]
    assert _vibe(client, set_id=set_id).status_code == 200
    call = ai["provider"].calls[0]
    text = json.dumps(call["messages"])
    assert "/m/" not in text and "Secret Set Name" not in text
    data = json.loads(call["messages"][0]["content"][0]["text"].split("\n", 1)[1])
    assert set(data) == {"seed", "candidates", "set_energy_heading"} or set(data) == {"seed", "candidates"}
    assert data["seed"] == {"title": "Night Ferry", "artist": "Tidewater", "album": "Tidewater EP",
                            "genres": ["deep house"], "bpm": 124.0, "key": "8A (A minor)", "energy": 6}
    for c in data["candidates"]:
        assert set(c) <= {"n", "title", "artist", "album", "genres", "bpm", "key", "energy"}
    assert [t["name"] for t in call["tools"]] == ["rank_by_feel"]


def test_made_up_and_repeated_numbers_are_ignored(client, ai):
    ai["provider"].order = [2, 2, 99, -1, "x", True, 1]
    body = _vibe(client, limit=20).get_json()
    code = [m["id"] for m in client.get("/api/library/dj/mixes/9?rank=mix&limit=20").get_json()["matches"]]
    assert [m["id"] for m in body["matches"]] == [code[1], code[0]] + code[2:]


def test_apply_order():
    items = [{"id": str(i)} for i in range(4)]
    assert [i["id"] for i in vibe.apply_order(items, [4, 1])] == ["3", "0", "1", "2"]
    assert [i["id"] for i in vibe.apply_order(items, None)] == ["0", "1", "2", "3"]


@pytest.mark.gauntlet
def test_the_ai_off_or_at_its_limit_is_refused_and_not_counted(client, ai, sql):
    ai["config"].set("ai.anthropic_api_key", "")
    res = _vibe(client)
    assert res.status_code == 403 and res.get_json()["code"] == "not_configured"
    ai["config"].set("ai.anthropic_api_key", "sk-ant-test-key-123")
    ai["admin"]["on"] = False
    res = _vibe(client)
    assert res.status_code == 403 and res.get_json()["code"] == "members_not_allowed"
    ai["config"].set("ai.who_can_use", "everyone")
    ai["config"].set("ai.monthly_cap_usd", 1.0)
    sql("INSERT INTO ai_usage (month, requests, cost_usd) VALUES (strftime('%Y-%m', 'now'), 3, 2.5)")
    res = _vibe(client)
    assert res.status_code == 403 and res.get_json()["code"] == "cap_reached"
    assert "budget" in res.get_json()["error"]
    assert ai["provider"].calls == []
    assert _usage(sql) == []


@pytest.mark.gauntlet
def test_a_member_may_when_everyone_may(client, ai, sql):
    ai["admin"]["on"] = False
    ai["config"].set("ai.who_can_use", "everyone")
    client.state["profile"] = 2
    assert _vibe(client).status_code == 200
    assert _usage(sql) == [(2, 1, 900, 40)]


def test_provider_errors_are_said_and_counted(client, ai, sql):
    ai["provider"].error = ProviderError("rate_limited", "Anthropic asked us to slow down.")
    res = _vibe(client)
    assert res.status_code == 429 and res.get_json()["code"] == "rate_limited"
    assert _usage(sql)[0][1] == 1
    ai["provider"].error = None
    ai["provider"].no_tool = True
    res = _vibe(client)
    assert res.status_code == 502 and res.get_json()["code"] == "provider_error"


def test_a_bad_key_is_recorded(client, ai):
    ai["provider"].error = ProviderError("bad_key", "Anthropic refused the key.")
    assert _vibe(client).status_code == 502
    assert ai["config"].get("ai.key_state") == "refused"


@pytest.mark.gauntlet
def test_busy_and_body_cap(client, ai):
    taken = [vibe._slots.acquire(blocking=False) for _ in range(vibe.MAX_AT_ONCE)]
    try:
        res = _vibe(client)
        assert res.status_code == 429 and res.get_json()["code"] == "busy"
    finally:
        for got in taken:
            if got:
                vibe._slots.release()
    res = client.post("/api/library/dj/mixes/9/vibe", json={"pad": "x" * 5000})
    assert res.status_code == 413
    assert ai["provider"].calls == []


def test_not_your_library(client, ai):
    assert _vibe(client, track="20").status_code == 404
    assert ai["provider"].calls == []


# ── after the gauntlet review ─────────────────────────────────────────────────

@pytest.mark.gauntlet
@pytest.mark.parametrize("data, content_type", [
    ("set_id=1&wide=true", "application/x-www-form-urlencoded"),
    ("", "text/plain"),
    ('{"set_id": 1}', "text/plain"),
    ("null", "application/json"),
    ("[1, 2]", "application/json"),
])
def test_m1_only_a_json_object_is_taken(client, ai, sql, data, content_type):
    """M1: a cross-site form or text/plain POST needs no preflight; it must
    never reach the provider (each request spends AI usage)."""
    res = client.post("/api/library/dj/mixes/9/vibe", data=data, content_type=content_type)
    assert res.status_code == 400 and res.get_json()["error"] == "Send it as JSON"
    assert ai["provider"].calls == []
    assert _usage(sql) == []


@pytest.mark.gauntlet
def test_l1_a_failure_before_the_call_gives_the_slot_back(client, ai, monkeypatch):
    """L1: whatever fails once a slot is taken, the slot is given back."""
    import core.ai.config as ai_config

    def broken(_config):
        raise RuntimeError("settings unreadable")

    monkeypatch.setattr(ai_config, "model_key", broken)
    for _ in range(vibe.MAX_AT_ONCE + 1):
        assert _vibe(client).status_code == 502
    taken = [vibe._slots.acquire(blocking=False) for _ in range(vibe.MAX_AT_ONCE)]
    try:
        assert all(taken)
    finally:
        for got in taken:
            if got:
                vibe._slots.release()


@pytest.mark.gauntlet
def test_l1_the_assistants_slot_is_given_back_too(db, monkeypatch):
    import core.ai.config as ai_config
    from core.ai import assistant

    monkeypatch.setattr(ai_config, "model_key", lambda _c: (_ for _ in ()).throw(RuntimeError("x")))
    req = assistant.AssistantRequest(message="hi", profile_id=1, is_admin=True)
    for _ in range(assistant.MAX_STREAMS + 1):
        with pytest.raises(RuntimeError):
            list(assistant.run(req, database=db, config=object(), blocks={}))
    taken = [assistant._slots.acquire(blocking=False) for _ in range(assistant.MAX_STREAMS)]
    try:
        assert all(taken)
    finally:
        for got in taken:
            if got:
                assistant._slots.release()


@pytest.mark.parametrize("order, expected", [
    ([float("inf"), 2], ["1", "0", "2", "3"]),
    ([float("nan"), "1e999", 10 ** 400, 2.5, -1, 0, 3], ["2", "0", "1", "3"]),
    (["2", 4.0, {"n": 1}, None], ["1", "3", "0", "2"]),
])
def test_l4_numbers_that_are_not_finite_whole_numbers_in_range_are_ignored(order, expected):
    items = [{"id": str(i)} for i in range(4)]
    assert [i["id"] for i in vibe.apply_order(items, order)] == expected


def test_l4_an_infinite_order_from_the_ai_is_no_error(client, ai):
    ai["provider"].order = [float("inf"), 10 ** 400, 1]
    res = _vibe(client)
    assert res.status_code == 200


@pytest.mark.parametrize("raw, shown", [
    ("Warm  and\nlate-night\tfirst.", "Warm and late-night first."),
    ("Deep ‮edis​ first", "Deep edis first"),
    ("x" * 400, "x" * vibe.MAX_LINE),
    ("See https://evil.example for more", ""),
    ("Visit www.example.com", ""),
    ("Write to someone@example.com", ""),
    ("ftp://files", ""),
    ("Then try evil.com for more", ""),
    ("EVIL.COM has the rest", ""),
    ("see mixes.example.co.uk", ""),
    ("night-ferry.club", ""),
    ("Warm first, 124.5 BPM, e.g. Night Ferry. Then up.", "Warm first, 124.5 BPM, e.g. Night Ferry. Then up."),
    ("Ends at 8A.", "Ends at 8A."),
    (None, ""),
    (42, ""),
])
def test_l3_the_ais_note_is_cleaned_and_drops_links(raw, shown):
    assert vibe.clean_line(raw) == shown


@pytest.mark.parametrize("raw", [
    "Then will.i.am lifts it", "Mr.Oizo into Pt.II", "Builds energy.Then drops", "Into Vol.II next",
    "St.Germain vibes", "Keeps it deep (Sasha vs.Digweed)", "BPM 124.Steady", "Ends at 8A.Then 9A",
    "e.g. Night Ferry", "U.K. garage", "No.1 hit", "track.mp3 is the one", "a hard 4x4.Groove",
])
def test_l_d_ordinary_text_with_dots_is_kept(raw):
    assert vibe.clean_line(raw) == raw


@pytest.mark.parametrize("raw", [
    "Then evil.com", "EVIL.COM next", "EVIL.cOm/x", "evil\uff0ecom", "evil\u3002com", "evil\uff61com",
    "evil[.]com", "evil(.)com", "evil.c\u200bom", "xn--80ak6aa92e.com", "mixes.example.co.uk",
])
def test_l_d_domains_in_any_spelling_are_dropped(raw):
    assert vibe.clean_line(raw) == ""


def test_l3_a_note_with_a_link_is_not_sent_to_the_page(client, ai):
    ai["provider"].line = "Play these, then visit www.example.com"
    assert _vibe(client).get_json()["vibe"]["line"] == ""
