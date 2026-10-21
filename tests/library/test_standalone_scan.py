"""Standalone Deep Scan planner — the #904 data-loss guard.

The scan relocates Transfer files the DB doesn't know about into Staging. With a
path-only diff, an empty/desynced DB makes the WHOLE library look untracked and the
scan moved all of it (reporter lost ~1,500 tracks into Staging). These pin the guard:
a normal batch of new arrivals still moves; an implausibly large untracked share (the
desync signature) or a 'permanent library' opt-out blocks the move instead.
"""

from __future__ import annotations

from core.library.standalone_scan import (
    BLOCK_DESYNC,
    BLOCK_EMPTY_DB,
    BLOCK_LARGE_MOVE,
    BLOCK_NONE,
    BLOCK_TRANSFER_PERMANENT,
    diff_untracked,
    plan_standalone_deep_scan,
)


def _files(prefix, n, start=0):
    return {f"{prefix}/track{i}.flac" for i in range(start, start + n)}


# ── diff_untracked (pure path diff) ──────────────────────────────────────────

def test_diff_basic():
    transfer = {"/m/a.flac", "/m/b.flac", "/m/c.flac"}
    db = {"/m/a.flac", "/m/b.flac"}
    assert diff_untracked(transfer, db) == {"/m/c.flac"}


def test_diff_is_separator_normalized():
    # DB stored a Windows-style path; the on-disk path uses forward slashes → still a match
    transfer = {"/m/Artist/x.flac"}
    db = {"\\m\\Artist\\x.flac"}
    assert diff_untracked(transfer, db) == set()


def test_diff_all_untracked_when_db_empty():
    transfer = _files("/lib", 5)
    assert diff_untracked(transfer, set()) == transfer


# ── plan: normal (move allowed) ──────────────────────────────────────────────

def test_clean_library_not_blocked():
    transfer = _files("/lib", 1000)
    plan = plan_standalone_deep_scan(transfer, transfer)  # all known
    assert plan["untracked"] == set()
    assert plan["move_blocked"] is False
    assert plan["block_reason"] == BLOCK_NONE


def test_normal_new_arrivals_move():
    # DB knows 990; 10 new files dropped in → small share, moves as before
    known = _files("/lib", 990)
    transfer = known | _files("/lib", 10, start=990)
    plan = plan_standalone_deep_scan(transfer, known)
    assert len(plan["untracked"]) == 10
    assert plan["move_blocked"] is False


def test_small_batch_under_floor_moves():
    # A few new files next to a known library (under the absolute floor) aren't second-guessed
    known = _files("/lib", 5)
    transfer = known | _files("/lib", 5, start=5)
    plan = plan_standalone_deep_scan(transfer, known)
    assert len(plan["untracked"]) == 5
    assert plan["move_blocked"] is False


def test_empty_database_needs_confirmation_even_under_the_floor():
    # #904 started from an empty DB. Below the desync floor the move is no longer
    # automatic: it needs an explicit confirmation of the preview.
    transfer = _files("/lib", 5)
    plan = plan_standalone_deep_scan(transfer, set())
    assert len(plan["untracked"]) == 5
    assert plan["move_blocked"] is True
    assert plan["block_reason"] == BLOCK_EMPTY_DB
    assert plan["needs_confirmation"] is True
    confirmed = plan_standalone_deep_scan(transfer, set(), allow_large_move=True)
    assert confirmed["move_blocked"] is False


# ── plan: the #904 guard (move blocked) ──────────────────────────────────────

def test_regression_904_empty_db_full_library_blocks():
    # Empty DB + a real 1,500-track library → 100% untracked → BLOCKED, nothing moved
    transfer = _files("/library", 1500)
    plan = plan_standalone_deep_scan(transfer, set())
    assert len(plan["untracked"]) == 1500
    assert plan["move_blocked"] is True
    assert plan["block_reason"] == BLOCK_DESYNC


def test_majority_untracked_blocks():
    # 600 of 1000 unknown (60%, over the 50% line) → desync, blocked
    known = _files("/lib", 400)
    transfer = known | _files("/lib", 600, start=400)
    plan = plan_standalone_deep_scan(transfer, known)
    assert plan["move_blocked"] is True
    assert plan["block_reason"] == BLOCK_DESYNC


def test_minority_untracked_just_under_threshold_is_not_a_desync():
    # 400 of 1000 unknown (40%, under 50%) → a batch, not a desync. It is over the
    # 25% ratio guard though, so it moves only with explicit confirmation.
    known = _files("/lib", 600)
    transfer = known | _files("/lib", 400, start=600)
    plan = plan_standalone_deep_scan(transfer, known)
    assert plan["block_reason"] == BLOCK_LARGE_MOVE
    assert plan["needs_confirmation"] is True
    assert plan_standalone_deep_scan(transfer, known, allow_large_move=True)["move_blocked"] is False


def test_never_move_blocks_even_small_sets():
    # Permanent-library opt-out: block regardless of fraction
    known = _files("/lib", 990)
    transfer = known | _files("/lib", 10, start=990)
    plan = plan_standalone_deep_scan(transfer, known, never_move=True)
    assert len(plan["untracked"]) == 10
    assert plan["move_blocked"] is True
    assert plan["block_reason"] == BLOCK_TRANSFER_PERMANENT


def test_never_move_with_nothing_untracked_is_not_blocked():
    # Nothing to move → not a "blocked" outcome even with the toggle on
    transfer = _files("/lib", 100)
    plan = plan_standalone_deep_scan(transfer, transfer, never_move=True)
    assert plan["untracked"] == set()
    assert plan["move_blocked"] is False


# ── ratio guard ──────────────────────────────────────────────────────────────

def test_ratio_guard_blocks_a_large_share_without_confirmation():
    # 300 of 1000 (30%) is over the default 25% limit
    known = _files("/lib", 700)
    transfer = known | _files("/lib", 300, start=700)
    plan = plan_standalone_deep_scan(transfer, known)
    assert plan["move_blocked"] is True
    assert plan["block_reason"] == BLOCK_LARGE_MOVE
    assert plan["needs_confirmation"] is True
    assert round(plan["untracked_fraction"], 2) == 0.30


def test_ratio_guard_lets_a_share_under_the_limit_through():
    known = _files("/lib", 800)
    transfer = known | _files("/lib", 200, start=800)  # 20%
    assert plan_standalone_deep_scan(transfer, known)["move_blocked"] is False


def test_ratio_limit_is_configurable():
    known = _files("/lib", 800)
    transfer = known | _files("/lib", 200, start=800)  # 20%
    plan = plan_standalone_deep_scan(transfer, known, max_move_fraction=0.10)
    assert plan["block_reason"] == BLOCK_LARGE_MOVE


def test_confirmation_never_lifts_a_hard_block():
    transfer = _files("/library", 1500)
    plan = plan_standalone_deep_scan(transfer, set(), allow_large_move=True)
    assert plan["block_reason"] == BLOCK_DESYNC
    assert plan["needs_confirmation"] is False
    known = _files("/lib", 990)
    plan = plan_standalone_deep_scan(known | _files("/lib", 10, start=990), known,
                                     never_move=True, allow_large_move=True)
    assert plan["block_reason"] == BLOCK_TRANSFER_PERMANENT
    assert plan["needs_confirmation"] is False
