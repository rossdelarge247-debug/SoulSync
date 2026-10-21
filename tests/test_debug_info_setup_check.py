"""/api/debug-info carries the local setup-check summary (core/setup_check.py):
counts by status plus the ids of anything wrong, without the network checks."""

from __future__ import annotations

import pytest


def test_debug_info_carries_the_setup_summary():
    web_server = pytest.importorskip("web_server")
    body = web_server.app.test_client().get("/api/debug-info").get_json()
    summary = body["setup_check"]
    assert set(summary) >= {"status", "summary", "problems", "scope"}
    assert summary["scope"] == "local"
    assert set(summary["summary"]) == {"ok", "warning", "error", "skipped"}
    assert all(p["status"] in ("warning", "error") for p in summary["problems"])


def test_debug_info_survives_a_broken_setup_check(monkeypatch):
    web_server = pytest.importorskip("web_server")
    import core.setup_check as sc

    def boom(*_a, **_k):
        raise RuntimeError("broken")
    monkeypatch.setattr(sc, "debug_summary", boom)
    resp = web_server.app.test_client().get("/api/debug-info")
    assert resp.status_code == 200
    assert resp.get_json()["setup_check"]["status"] == "unknown"
