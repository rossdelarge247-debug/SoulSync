"""Erasing books from the audiobook recycle bin only happens against a fresh
preview plan.

POST /api/audiobooks/library/recycle/purge-preview lists what would be erased
for good (count, size, oldest and newest date, a sample) and erases nothing;
/library/recycle/purge (and the older DELETE forms) erase exactly that plan's
entries, given its plan_id, and answer 409 with a code without one. The keep
window's own purge is the user's setting and is not touched here.
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest
from flask import Flask

from api.audiobooks import create_audiobooks_blueprint
from core.audiobook_recycle import AUDIOBOOK_RECYCLE_PURGE_TOOL, discard, list_bin
from core.library.action_plans import plan_store


@pytest.fixture
def env(tmp_path):
    root = tmp_path / "audiobooks"
    root.mkdir()
    manager = MagicMock()
    manager.get.side_effect = lambda key, default=None: {
        "library.audiobooks_path": str(root),
        "audiobooks.recycle_deletes": True,
        "audiobooks.recycle_keep_days": 7,
    }.get(key, default)
    app = Flask(__name__)
    app.register_blueprint(create_audiobooks_blueprint())
    plan_store.clear()
    with patch("core.settings.config_manager", manager):
        yield root, app.test_client()
    plan_store.clear()


def _binned(root, name, files=2):
    folder = root / name
    folder.mkdir(parents=True)
    for index in range(files):
        (folder / f"{index + 1:02d}.mp3").write_bytes(b"x" * 100)
    outcome = discard(str(folder))
    assert outcome["ok"] and outcome["moved_to"]
    return outcome["moved_to"].rsplit("/", 1)[-1]


def _preview(client, body):
    r = client.post("/api/audiobooks/library/recycle/purge-preview", json=body)
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def test_the_preview_counts_books_and_bytes_and_erases_nothing(env):
    root, client = env
    _binned(root, "Andy Weir/Project Hail Mary", files=3)
    _binned(root, "Ursula Le Guin/The Dispossessed", files=2)

    plan = _preview(client, {"all": True})

    assert plan["success"] is True and plan["plan_id"]
    assert plan["tool"] == AUDIOBOOK_RECYCLE_PURGE_TOOL
    assert plan["files"] == 2 and plan["total_bytes"] == 500
    assert plan["oldest"] and plan["newest"]
    assert {i["name"] for i in plan["sample"]} == {"Project Hail Mary", "The Dispossessed"}
    assert all(i["path"] for i in plan["sample"])                 # where each would go back to
    assert plan["recycle_enabled"] is True
    assert len(list_bin()) == 2


def test_a_fresh_plan_erases_exactly_its_books(env):
    root, client = env
    a = _binned(root, "A/Book One")
    b = _binned(root, "B/Book Two")
    plan = _preview(client, {"all": True})
    late = _binned(root, "C/Book Three")

    r = client.post("/api/audiobooks/library/recycle/purge", json={"plan_id": plan["plan_id"]})

    assert r.status_code == 200
    body = r.get_json()
    assert sorted(body["purged"]) == sorted([a, b]) and body["freed_bytes"] == 400
    assert [e["name"] for e in list_bin()] == [late]


def test_a_book_that_changed_since_the_preview_is_kept(env):
    root, client = env
    a = _binned(root, "A/Book One")
    b = _binned(root, "B/Book Two")
    plan = _preview(client, {"all": True})
    (root / ".deleted" / b / "bonus.mp3").write_bytes(b"more")

    body = client.post("/api/audiobooks/library/recycle/purge", json={"plan_id": plan["plan_id"]}).get_json()

    assert body["purged"] == [a] and body["skipped"] == [b]


def test_choosing_books_previews_and_erases_only_those(env):
    root, client = env
    a = _binned(root, "A/Book One")
    b = _binned(root, "B/Book Two")
    plan = _preview(client, {"names": [a]})
    assert plan["files"] == 1 and plan["sample"][0]["entry"] == a

    client.post("/api/audiobooks/library/recycle/purge", json={"plan_id": plan["plan_id"]})

    assert [e["name"] for e in list_bin()] == [b]


@pytest.mark.parametrize("method,path,body", [
    ("post", "/api/audiobooks/library/recycle/purge", {}),
    ("delete", "/api/audiobooks/library/recycle", None),
    ("delete", "/api/audiobooks/library/recycle/NAME", None),
])
def test_without_a_plan_nothing_is_erased(env, method, path, body):
    root, client = env
    a = _binned(root, "A/Book One")

    r = getattr(client, method)(path.replace("NAME", a), json=body)

    assert r.status_code == 409 and r.get_json()["code"] == "plan_required"
    assert [e["name"] for e in list_bin()] == [a]


def test_the_delete_forms_take_the_same_plan(env):
    root, client = env
    a = _binned(root, "A/Book One")
    plan = _preview(client, {"names": [a]})
    r = client.delete(f"/api/audiobooks/library/recycle/{a}", json={"plan_id": plan["plan_id"]})
    assert r.status_code == 200 and r.get_json()["purged"] == [a]


def test_unknown_expired_and_wrong_tool_plans_are_refused(env):
    root, client = env
    a = _binned(root, "A/Book One")
    url = "/api/audiobooks/library/recycle/purge"

    assert client.post(url, json={"plan_id": "nope"}).get_json()["code"] == "plan_unknown"
    other = plan_store.create("video_recycle_purge", [{"entry": "x"}])
    wrong = client.post(url, json={"plan_id": other.plan_id})
    assert wrong.status_code == 409 and wrong.get_json()["code"] == "plan_wrong_tool"
    plan = _preview(client, {"all": True})
    plan_store.peek(plan["plan_id"], AUDIOBOOK_RECYCLE_PURGE_TOOL).expires_at = time.time() - 1
    expired = client.post(url, json={"plan_id": plan["plan_id"]})
    assert expired.status_code == 409 and expired.get_json()["code"] == "plan_expired"
    assert [e["name"] for e in list_bin()] == [a]


def test_a_plan_is_spent_by_its_purge(env):
    root, client = env
    _binned(root, "A/Book One")
    plan = _preview(client, {"all": True})
    url = "/api/audiobooks/library/recycle/purge"
    assert client.post(url, json={"plan_id": plan["plan_id"]}).status_code == 200
    again = client.post(url, json={"plan_id": plan["plan_id"]})
    assert again.status_code == 409 and again.get_json()["code"] == "plan_unknown"


def test_an_empty_bin_has_nothing_to_confirm_and_a_scope_is_needed(env):
    _root, client = env
    assert _preview(client, {"all": True})["plan_id"] is None
    assert client.post("/api/audiobooks/library/recycle/purge-preview", json={}).status_code == 400


def test_the_preview_route_is_not_mistaken_for_a_restore(env):
    """POST /library/recycle/<name> restores a book; the preview and purge
    paths are their own routes, not books called "purge-preview"."""
    root, client = env
    a = _binned(root, "A/Book One")
    _preview(client, {"all": True})
    assert client.post("/api/audiobooks/library/recycle/purge", json={}).status_code == 409
    assert [e["name"] for e in list_bin()] == [a]
