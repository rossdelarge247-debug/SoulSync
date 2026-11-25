"""Quarantine explained (design boards 10 and 11).

Ross's quarantine: 2,568 files, 93% held by the integrity check's length leg
("Duration mismatch"), the rest mostly "File too small" stubs, two lossless
density failures and one replacement guard. Pinned here:

* every entry gets one verdict and a sentence, from legacy reason text and from
  structured facts (which win);
* a length-only failure asks AcoustID (and measures whether the file plays to
  the end) before it's quarantined, and is still quarantined;
* the AcoustID re-check: its rate limit, resume, pause, cancel, and the
  snapshot updated as it writes sidecars;
* "Delete all" deletes only what was previewed; "Keep the best of each" keeps
  each song's best and deletes the rest of that song, nothing else.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import types

import pytest

from core.imports import quarantine_bulk as qb
from core.imports import quarantine_recheck as qr
from core.imports import quarantine_verdict as qv
from core.imports.quarantine_index import QuarantineSnapshots, record_from_sidecar


def _dur(actual, expected, longer=None):
    tail = ("runs longer than expected — likely a different version/master or wrong file"
            if (longer if longer is not None else actual > expected)
            else "likely truncated download or wrong file matched")
    return (f"Integrity check failed: Duration mismatch: file is {actual:.1f}s, expected "
            f"{expected:.1f}s (drift {abs(actual - expected):.1f}s > tolerance 3.0s) — {tail}. "
            "If it's the right song, raise Duration tolerance in Settings > Library > "
            "Post-Processing")


def _side(reason, trigger="integrity", **extra):
    return {"quarantine_reason": reason, "trigger": trigger, "expected_track": "Fighting Fire",
            "expected_artist": "Breakage", **extra}


def _kind(reason, **kw):
    return qv.classify(_side(reason, **kw))


# ── the classifier on Ross's patterns ────────────────────────────────────────


@pytest.mark.parametrize("actual, expected, kind", [
    (348.0, 380.0, "right_song"),       # 80–100%: 832 of his
    (304.0, 380.0, "right_song"),       # exactly 80%
    (420.0, 380.0, "right_song"),       # 100–120%: 243
    (456.0, 380.0, "right_song"),       # exactly 120%
    (432.0, 238.0, "longer_version"),   # over 120%: 652
    (215.0, 340.0, "shorter_or_cut"),   # 50–80%: 456
    (190.0, 380.0, "shorter_or_cut"),   # exactly half
    (30.0, 380.0, "cut_off"),           # under 50%: 210
])
def test_legacy_duration_mismatches(actual, expected, kind):
    got, text = _kind(_dur(actual, expected))
    assert got == kind
    assert text and not text.endswith(" ")


def test_the_sentences_say_lengths_in_minutes():
    _k, text = _kind(_dur(30.0, 380.0))
    assert text == "Only 0:30 of a 6:20 song."
    _k, text = _kind(_dur(348.0, 380.0))
    assert text.startswith("Probably the right song, 32 s shorter than Spotify's length")
    assert text.endswith("Not checked yet whether it plays to the end.")
    _k, text = _kind(_dur(432.0, 238.0))
    assert text.startswith("3:14 longer than Spotify's length: probably an extended")
    explained = qv.explain(_side(_dur(348.0, 380.0)), 9_000_000)
    assert (explained["length"], explained["spotify_length"]) == ("5:48", "6:20")


@pytest.mark.parametrize("reason, kind, words", [
    ("Integrity check failed: File too small (0 bytes, minimum 10240) — likely truncated "
     "transfer or empty stub", "broken", "Empty: 0 bytes"),
    ("Integrity check failed: File too small (4096 bytes, minimum 10240) — likely truncated "
     "transfer or empty stub", "broken", "Only 4 KB"),
    ("Integrity check failed: Mutagen could not parse file: can't sync to MPEG frame",
     "broken", "couldn't be read"),
    ("Integrity check failed: Mutagen could not identify file format — likely corrupted or "
     "wrong file extension", "broken", "couldn't be read"),
    ("Integrity check failed: Lossless file holds only 12% of the data its 420s runtime needs "
     "(170kbps) and stops at 31s — a preview clip or truncated download", "other", "lossless"),
    ("Replacement guard: incoming file is far shorter than the library file it would replace "
     "(preview/truncated clip)", "other", "copy already in your library"),
    ("Integrity check failed: Decoded audio is only 30s of an expected 215s (zero-length "
     "header) — a preview clip or truncated download", "cut_off", "Only 0:30 of a 3:35 song."),
    ("Integrity check failed: FLAC decode test failed (bad frame) — damaged audio frames",
     "other", "Damaged lossless"),
])
def test_ross_s_other_patterns(reason, kind, words):
    got, text = _kind(reason)
    assert got == kind
    assert words in text


def test_acoustid_legacy_reasons_name_the_other_song():
    got, text = _kind("Audio mismatch: file identified as 'True (Original Mix)' by 'Monte', "
                      "expected 'Tribes (Original Mix)' by 'Monty'", trigger="acoustid")
    assert got == "different_song"
    assert "“True (Original Mix)” by Monte" in text
    got, text = _kind("Audio mismatch: 'Insomnia' by 'Faithless' — expected artist not found",
                      trigger="acoustid")
    assert got == "different_song" and "Faithless" in text
    got, text = _kind("Version mismatch: expected (original) but file is (live)",
                      trigger="acoustid")
    assert got == "different_song" and "live" in text


def test_structured_facts_win():
    side = _side(_dur(348.0, 380.0), facts={
        "acoustid": {"decision": "pass", "score": 0.97}, "plays_to_end": True,
        "quality": "MP3 320"})
    kind, text = qv.classify(side)
    assert kind == "right_song"
    assert text == ("AcoustID confirms it's the right song, 32 s shorter than Spotify's length. "
                    "Plays to the end.")
    # a confirmed extended mix
    side = _side(_dur(432.0, 238.0), facts={"acoustid": {"decision": "pass"},
                                            "plays_to_end": True})
    assert qv.classify(side)[0] == "longer_version"
    # stops before its header's length: cut off, whatever the ratio
    side = _side(_dur(348.0, 380.0), facts={"plays_to_end": False, "decoded_s": 131.0})
    kind, text = qv.classify(side)
    assert kind == "cut_off" and "2:11" in text
    # AcoustID heard another song
    side = _side(_dur(348.0, 380.0), facts={"acoustid": {"decision": "fail", "title": "True",
                                                          "artist": "Monte"}})
    assert qv.classify(side) == ("different_song", "AcoustID identified it as “True” by Monte: "
                                 "another song.")


def test_the_spotify_length_comes_from_the_context_when_the_reason_has_none():
    side = _side("AcoustID could not confirm the track", trigger="acoustid_unverified",
                 context={"track_info": {"duration_ms": 380_000}},
                 facts={"actual_s": 348.0})
    explained = qv.explain(side)
    assert explained["spotify_length"] == "6:20"


def test_an_odd_sidecar_is_other_never_an_error():
    assert qv.classify({})[0] == "other"
    assert qv.classify({"quarantine_reason": None, "facts": "nonsense"})[0] == "other"


# ── the best try ─────────────────────────────────────────────────────────────


def _record(name, reason, *, group="nm:breakage|fighting fire", size=9_000_000, facts=None,
            trigger="integrity"):
    side = _side(reason, trigger=trigger)
    if facts:
        side["facts"] = facts
    side["context"] = {"track_info": {"id": group}}
    rec = record_from_sidecar(f"{name}.mp3.quarantined", side, size)
    return rec


def test_best_prefers_confirmed_then_quality_then_closest_length():
    a = {"id": "a", "kind": "right_song", "facts": {"quality": "MP3 320", "actual_s": 348,
                                                     "expected_s": 380}}
    b = {"id": "b", "kind": "right_song", "facts": {"quality": "FLAC 16bit/44.1kHz",
                                                     "actual_s": 340, "expected_s": 380}}
    c = {"id": "c", "kind": "right_song", "facts": {"quality": "MP3 128", "actual_s": 380,
                                                     "expected_s": 380,
                                                     "acoustid": {"decision": "pass"}}}
    cut = {"id": "d", "kind": "cut_off", "facts": {"quality": "FLAC 24bit"}}
    stops = {"id": "e", "kind": "right_song", "facts": {"quality": "FLAC 24bit",
                                                         "plays_to_end": False}}
    assert qv.choose_best([a, b, cut, stops]) == "b"      # lossless over 320
    assert qv.choose_best([a, b, c]) == "c"               # confirmed first
    a2 = dict(a, id="a2", facts={**a["facts"], "actual_s": 379})
    assert qv.choose_best([a, a2]) == "a2"                # same quality: closest length
    assert qv.choose_best([cut, stops]) is None


def test_an_acoustid_pass_never_lifts_a_clip_out_of_its_length_band():
    """The review's repro: a 90 s clip AcoustID recognises against a full FLAC.
    It used to be "right song", win best on the confirmation, and keep-best
    deleted the full-length try."""
    def side(actual, expected, facts=None, quality="FLAC 16bit"):
        s = _side(_dur(actual, expected))
        s["context"] = {"_audio_quality": quality}
        if facts:
            s["facts"] = facts
        return s

    clip = side(90, 360, {"plays_to_end": True, "acoustid": {"decision": "pass", "score": 0.9}},
                quality="MP3 320")
    full = side(362, 360)
    kind, text = qv.classify(clip)
    assert kind == "cut_off"
    assert text == "AcoustID recognises the song, but this is only 1:30 of 6:00: a clip or cut off."
    assert qv.classify(full)[0] == "right_song"
    tries = [{"id": "clip", "kind": kind, "facts": qv.explain(clip)},
             {"id": "full", "kind": "right_song", "facts": qv.explain(full)}]
    assert qv.choose_best(tries) == "full"

    # 50–80% confirmed: shorter, and the sentence says AcoustID knows the song
    kind, text = qv.classify(side(200, 360, {"acoustid": {"decision": "pass"}}))
    assert kind == "shorter_or_cut" and text.startswith("AcoustID confirms the song, but it's 56%")
    # the boundaries hold with a confirmation too
    assert qv.classify(side(179, 360, {"acoustid": {"decision": "pass"}}))[0] == "cut_off"
    assert qv.classify(side(180, 360, {"acoustid": {"decision": "pass"}}))[0] == "shorter_or_cut"
    assert qv.classify(side(288, 360, {"acoustid": {"decision": "pass"}}))[0] == "right_song"
    assert qv.classify(side(433, 360, {"acoustid": {"decision": "pass"}}))[0] == "longer_version"


def test_best_needs_four_fifths_of_the_length():
    def t(i, actual, expected=360, **facts):
        return {"id": i, "kind": "right_song",
                "facts": {"actual_s": actual, "expected_s": expected, **facts}}

    # 79% confirmed and lossless loses to an unconfirmed 80% MP3
    assert qv.choose_best([t("short", 284, quality="FLAC 24bit", acoustid={"decision": "pass"}),
                           t("ok", 288, quality="MP3 128")]) == "ok"
    # no length to compare, or only short tries: no best, so no keep-best
    assert qv.choose_best([t("x", None, acoustid={"decision": "pass"})]) is None
    assert qv.choose_best([t("y", 200), t("z", 100)]) is None
    # stops early: never best; unknown completeness is allowed
    assert qv.choose_best([t("a", 360, plays_to_end=False), t("b", 350)]) == "b"


def test_cannot_stat_is_other_not_broken():
    assert _kind("Integrity check failed: Cannot stat file: [Errno 5] Input/output error")[0] == "other"


def test_a_song_view_marks_its_best_and_says_what_the_tries_are():
    tries = [
        _record("20261107_1_a", _dur(348, 380), facts={"quality": "MP3 320"}),
        _record("20261107_2_b", _dur(348, 380), facts={"quality": "MP3 192"}),
        _record("20261107_3_c", _dur(30, 380), facts={"quality": "MP3 128"}),
    ]
    view = qb.song_view("k", tries)
    assert view["best"] == "20261107_1_a"
    verdicts = [t["explained"]["verdict"] for t in view["tries"]]
    assert verdicts == ["best", "right_song", "cut_off"]
    assert view["tries"][0]["explained"]["verdict_label"] == "Best"
    assert view["summary"] == ("Probably the right song in 2 of 3 tries. The best is marked. "
                               "Spotify lists it at 6:20.")


# ── the pipeline asks AcoustID about a length-only failure ──────────────────


def test_a_length_only_failure_asks_acoustid_before_quarantine(tmp_path, monkeypatch):
    import core.imports.pipeline as pipeline
    from core.imports import quarantine_facts
    from core.imports.file_integrity import IntegrityResult

    src = tmp_path / "Fighting Fire.mp3"
    src.write_bytes(b"ID3" + b"\0" * 64)
    order = []

    monkeypatch.setattr(pipeline, "check_audio_integrity", lambda *_a, **_k: IntegrityResult(
        ok=False, reason="Duration mismatch: file is 348.0s, expected 380.0s (drift 32.0s > "
                         "tolerance 3.0s) — likely truncated download or wrong file matched",
        checks={"size_bytes": 67, "actual_length_s": 348.0, "expected_length_s": 380.0,
                "length_check": "mismatch"}))
    monkeypatch.setattr(quarantine_facts, "audio_facts", lambda path, **_k: (
        order.append("measured") or {"actual_s": 348.0, "decoded_s": 348.0,
                                     "plays_to_end": True, "quality": "MP3 320"}))

    class Verifier:
        def quick_check_available(self):
            return True, "ready"

        def verify_audio_file(self, path, title, artist, ctx, expected_duration_s=None):
            order.append(("acoustid", title, artist, expected_duration_s))
            ctx["_acoustid_best_score"] = 0.96
            return types.SimpleNamespace(value="pass"), "matched"

    monkeypatch.setitem(sys.modules, "core.acoustid_verification",
                        types.SimpleNamespace(AcoustIDVerification=Verifier))
    quarantined = []

    def fake_quarantine(fp, ctx, reason, eng, trigger=None, facts=None):
        order.append("quarantined")
        quarantined.append((trigger, facts))
        return str(tmp_path / "q.mp3.quarantined")

    monkeypatch.setattr(pipeline, "move_to_quarantine", fake_quarantine)
    monkeypatch.setattr(pipeline, "_mark_task_quarantined", lambda *a, **k: None)
    monkeypatch.setattr(pipeline, "get_import_track_info", lambda context: {"duration_ms": 380_000})
    runtime = types.SimpleNamespace(automation_engine=None, on_download_completed=None,
                                    web_scan_manager=None, repair_worker=None)
    context = {"track_info": {"name": "Fighting Fire", "artists": [{"name": "Breakage"}],
                              "duration_ms": 380_000},
               "original_search_result": {"title": "Fighting Fire"}, "is_local_import": False}
    pipeline.post_process_matched_download("ctx", context, str(src), runtime)

    assert order[0] == "measured" and order[1][0] == "acoustid" and order[2] == "quarantined"
    assert order[1][1:3] == ("Fighting Fire", "Breakage")
    (trigger, facts), = quarantined
    assert trigger == "integrity"  # still held (Q10)
    assert facts["check"] == "duration" and facts["plays_to_end"] is True
    assert facts["acoustid"]["decision"] == "pass" and facts["acoustid"]["score"] == 0.96
    assert (facts["expected_s"], facts["actual_s"]) == (380.0, 348.0)
    side = _side(_dur(348, 380), facts=facts)
    assert qv.classify(side)[0] == "right_song"


def test_other_integrity_failures_dont_ask_acoustid(tmp_path, monkeypatch):
    import core.imports.pipeline as pipeline
    from core.imports.file_integrity import IntegrityResult

    src = tmp_path / "stub.mp3"
    src.write_bytes(b"")
    monkeypatch.setattr(pipeline, "check_audio_integrity", lambda *_a, **_k: IntegrityResult(
        ok=False, reason="File too small (0 bytes, minimum 10240) — likely truncated transfer "
                         "or empty stub", checks={"size_bytes": 0}))
    asked = []
    monkeypatch.setitem(sys.modules, "core.acoustid_verification", types.SimpleNamespace(
        AcoustIDVerification=lambda: asked.append(True)))
    got = []
    monkeypatch.setattr(pipeline, "move_to_quarantine",
                        lambda fp, ctx, reason, eng, trigger=None, facts=None:
                        got.append(facts) or "q")
    monkeypatch.setattr(pipeline, "_mark_task_quarantined", lambda *a, **k: None)
    runtime = types.SimpleNamespace(automation_engine=None, on_download_completed=None,
                                    web_scan_manager=None, repair_worker=None)
    pipeline.post_process_matched_download("ctx", {"track_info": {}}, str(src), runtime)
    assert asked == []
    assert got == [{"size_bytes": 0}]


def test_plays_to_end():
    from core.imports.quarantine_facts import plays_to_end
    assert plays_to_end(348.0, 347.5) is True
    assert plays_to_end(380.0, 131.0) is False
    assert plays_to_end(380.0, 0) is None
    assert plays_to_end(None, 300) is None


# ── the AcoustID re-check ────────────────────────────────────────────────────


class _Store:
    def __init__(self, state=None):
        self.state = dict(state or {})

    def get(self):
        return dict(self.state)

    def set(self, state):
        self.state = dict(state)


class _Clock:
    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def _folder_with(tmp_path, names):
    folder = tmp_path / "ss_quarantine"
    folder.mkdir(exist_ok=True)
    records = []
    for name in names:
        (folder / f"{name}.mp3.quarantined").write_bytes(b"x" * 20_000)
        side = _side(_dur(348, 380))
        (folder / f"{name}.json").write_text(json.dumps(side), encoding="utf-8")
        records.append(record_from_sidecar(f"{name}.mp3.quarantined", side, 20_000))
    return str(folder), records


def _job(folder, records, answers, *, store=None, clock=None, interval=0.34, lease=None):
    clock = clock or _Clock()
    calls = []

    def check(quarantine_dir, record):
        calls.append((clock.now, record.entry_id))
        answer = answers(record) if callable(answers) else answers
        return {"acoustid": answer} if answer is not None else {}

    job = qr.RecheckJob(qr.RecheckDeps(
        records=lambda: list(records), quarantine_dir=lambda: folder, check=check,
        available=lambda: (True, "ready"), store=store or _Store(), clock=clock,
        sleep=clock.sleep, interval=interval, lease=lease or qr.LocalLease()))
    return job, calls, clock


def test_the_recheck_keeps_to_acoustid_s_rate(tmp_path):
    folder, records = _folder_with(tmp_path, [f"2026110{i}_x" for i in range(6)])
    job, calls, _clock = _job(folder, records, {"decision": "pass"})
    assert job.start()["started"]
    job.wait(5)
    times = [t for t, _ in calls]
    assert len(times) == 6
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert all(gap >= 0.34 - 1e-9 for gap in gaps)
    # never more than three in any one second
    assert all(len([t for t in times if s <= t < s + 1.0]) <= 3 for s in times)
    status = job.status()
    assert (status["status"], status["done"], status["total"], status["confirmed"]) == (
        "done", 6, 6, 6)


def test_the_recheck_counts_its_answers_and_stops_on_a_refused_key(tmp_path, monkeypatch):
    folder, records = _folder_with(tmp_path, ["20261101_a", "20261102_b", "20261103_c",
                                              "20261104_d"])
    answers = {"20261101_a": {"decision": "pass"}, "20261102_b": {"decision": "fail"},
               "20261103_c": {"decision": "skip"}, "20261104_d": {"decision": "error",
                                                                 "invalid_key": True}}
    monkeypatch.setattr(qr, "_current_key", lambda: "abc")
    store = _Store()
    job, calls, _clock = _job(folder, records, lambda r: answers[r.entry_id], store=store)
    job.start()
    job.wait(5)
    status = job.status()
    assert (status["confirmed"], status["different"], status["no_match"]) == (1, 1, 1)
    assert status["status"] == "key_refused" and status["key_refused"] is True
    # a new key: no longer "refused"
    monkeypatch.setattr(qr, "_current_key", lambda: "another")
    assert job.status()["key_refused"] is False


def test_pause_resume_and_cancel(tmp_path):
    folder, records = _folder_with(tmp_path, [f"2026110{i}_x" for i in range(5)])
    gate = threading.Event()
    seen = []

    def answers(record):
        seen.append(record.entry_id)
        if len(seen) == 2:
            job.pause()
            gate.set()
        return {"decision": "pass"}

    job, calls, clock = _job(folder, records, answers)
    real_sleep = clock.sleep

    def sleep(seconds):
        # while paused the job sleeps in small steps: resume after a few
        if job.deps.store.get().get("status") == "paused" and len(clock.slept) > 3:
            job.resume()
        real_sleep(seconds)

    job.deps.sleep = sleep
    job.start()
    assert gate.wait(5)
    job.wait(5)
    assert job.status()["status"] == "done" and len(seen) == 5


def test_cancel_stops_between_files(tmp_path):
    folder, records = _folder_with(tmp_path, [f"2026111{i}_y" for i in range(5)])

    def answers(record):
        if len(calls) == 2:
            job.cancel()
        return {"decision": "pass"}

    job, calls, _ = _job(folder, records, answers)
    job.start()
    job.wait(5)
    assert len(calls) == 2 and job.status()["status"] == "cancelled"


def test_the_recheck_resumes_after_a_restart_where_it_left_off(tmp_path):
    folder, records = _folder_with(tmp_path, [f"2026110{i}_x" for i in range(4)])
    store = _Store({"status": "running", "total": 4, "done": 2, "confirmed": 2})
    # two were answered before the restart: their sidecars say so
    answered = []
    for record in records[:2]:
        side = _side(_dur(348, 380), facts={"acoustid": {"decision": "pass"}})
        answered.append(record_from_sidecar(record.filename, side, 20_000))
    records = answered + records[2:]
    job, calls, _ = _job(folder, records, {"decision": "pass"}, store=store)
    assert job.status()["status"] == "interrupted"
    assert job.start(resume=True)["started"]
    job.wait(5)
    assert [entry for _t, entry in calls] == [r.entry_id for r in records[2:]]
    status = job.status()
    assert (status["done"], status["total"], status["confirmed"], status["status"]) == (
        4, 4, 4, "done")


def test_after_each_file_it_gives_way_as_long_as_the_file_took(tmp_path):
    folder, records = _folder_with(tmp_path, [f"2026110{i}_x" for i in range(4)])
    took = iter([0.2, 3.0, 25.0, 0.5])
    clock = _Clock()

    def answers(record):
        clock.now += next(took)  # the work on this file
        return {"decision": "pass"}

    job, calls, _ = _job(folder, records, answers, clock=clock)
    job.start()
    job.wait(5)
    starts = [t for t, _ in calls]
    # gap = the file's own time + the pause after it (at least 1 s, at most 10 s)
    gaps = [round(b - a, 2) for a, b in zip(starts, starts[1:])]
    assert gaps == [1.2, 6.0, 35.0]


def test_the_recheck_doesnt_decode_unless_the_setting_says(tmp_path, monkeypatch):
    from core.imports import quarantine_facts
    folder, records = _folder_with(tmp_path, ["20261101_a"])
    seen = []
    monkeypatch.setattr(quarantine_facts, "audio_facts",
                        lambda path, decode=True, **_k: seen.append(decode) or {"actual_s": 348.0})
    monkeypatch.setattr(quarantine_facts, "acoustid_facts", lambda *a, **k: None)
    monkeypatch.setattr(qr, "_decode_enabled", lambda: False)
    qr.check_one(folder, records[0])
    monkeypatch.setattr(qr, "_decode_enabled", lambda: True)
    qr.check_one(folder, records[0])
    assert seen == [False, True]
    # without the decode, "plays to the end" stays unknown
    side = json.loads((tmp_path / "ss_quarantine" / "20261101_a.json").read_text())
    assert "plays_to_end" not in side["facts"]
    assert qv.explain(side)["plays_to_end"] is None


def test_no_sidecar_is_written_for_a_file_that_went_meanwhile(tmp_path, monkeypatch):
    from core.imports import quarantine_facts
    folder, records = _folder_with(tmp_path, ["20261101_a"])
    os.remove(os.path.join(folder, records[0].filename))
    os.remove(os.path.join(folder, "20261101_a.json"))
    monkeypatch.setattr(quarantine_facts, "audio_facts", lambda path, **_k: {})
    monkeypatch.setattr(quarantine_facts, "acoustid_facts",
                        lambda *a, **k: {"decision": "pass"})
    qr.check_one(folder, records[0])
    assert os.listdir(folder) == []


def test_only_one_process_runs_the_recheck(tmp_path):
    import sqlite3
    db = str(tmp_path / "lease.db")
    now = [1000.0]
    one = qr.DbLease("host:1", clock=lambda: now[0], connect=lambda: sqlite3.connect(db))
    two = qr.DbLease("host:2", clock=lambda: now[0], connect=lambda: sqlite3.connect(db))
    assert one.acquire() and not two.acquire()
    assert two.held_elsewhere() and not one.held_elsewhere()
    now[0] += 60
    assert one.renew() and not two.acquire()
    # a process that stopped renewing: its lease goes stale and can be taken
    now[0] += qr.LEASE_STALE + 1
    assert two.acquire() and not one.renew()
    two.release()
    assert one.acquire()

    folder, records = _folder_with(tmp_path, ["20261101_a"])
    held = qr.LocalLease()
    held.holder = "someone else"
    job, calls, _ = _job(folder, records, {"decision": "pass"}, lease=held)
    assert job.start() == {"started": False, "reason": "running_elsewhere"}
    assert calls == []


def test_pause_and_cancel_reach_the_job_through_the_stored_state(tmp_path):
    """Another worker's Pause or Cancel only changes the stored state."""
    folder, records = _folder_with(tmp_path, [f"2026110{i}_x" for i in range(4)])
    store = _Store()

    def answers(record):
        if len(calls) == 2:
            store.state["status"] = "cancelled"
        return {"decision": "pass"}

    job, calls, _ = _job(folder, records, answers, store=store)
    job.start()
    job.wait(5)
    assert len(calls) == 2


def test_check_one_writes_the_sidecar_and_the_snapshot_follows(tmp_path, monkeypatch):
    from core.imports import quarantine_facts
    from core.imports import quarantine_index as qi

    folder, records = _folder_with(tmp_path, ["20261101_a"])
    index = QuarantineSnapshots()
    monkeypatch.setattr(qi, "shared_index", lambda: index)
    snap = index.refresh_now(folder)
    assert snap.records[0].entry["explained"]["kind"] == "right_song"
    assert snap.records[0].entry["explained"]["acoustid"] is None

    monkeypatch.setattr(quarantine_facts, "audio_facts",
                        lambda path, **_k: {"plays_to_end": False, "decoded_s": 131.0,
                                            "quality": "MP3 320"})
    monkeypatch.setattr(quarantine_facts, "acoustid_facts",
                        lambda *a, **k: {"decision": "pass", "score": 0.9})
    qr.check_one(folder, snap.records[0])

    side = json.loads((tmp_path / "ss_quarantine" / "20261101_a.json").read_text())
    assert side["facts"]["acoustid"]["decision"] == "pass"
    assert side["quarantine_reason"].startswith("Integrity check failed")  # the rest kept
    # in the snapshot at once, re-classified (it stops early: cut off)
    now = index.peek(folder).records[0].entry["explained"]
    assert now["kind"] == "cut_off" and now["acoustid"]["decision"] == "pass"
    assert not qr.needs_recheck(index.peek(folder).records[0])
    # and the one-song read (the deep link) sees it too
    assert index.fresh_group(folder, "20261101_a")[0].entry["explained"]["kind"] == "cut_off"
    # a later refresh reads the same sidecar
    assert index.refresh_now(folder).records[0].entry["explained"]["kind"] == "cut_off"


# ── bulk actions ─────────────────────────────────────────────────────────────


def _held(tmp_path, specs):
    """specs: (name, reason, group, size, facts)."""
    folder = tmp_path / "ss_quarantine"
    folder.mkdir(exist_ok=True)
    for name, reason, group, size, facts in specs:
        (folder / f"{name}.mp3.quarantined").write_bytes(b"x" * size)
        side = _side(reason, facts=facts or {})
        side["expected_track"] = group
        side["context"] = {"track_info": {"id": group}}
        (folder / f"{name}.json").write_text(json.dumps(side), encoding="utf-8")
    index = QuarantineSnapshots()
    return str(folder), list(index.refresh_now(str(folder)).records)


def _kinds_now(folder):
    return {r.filename: r.entry["explained"]["kind"]
            for r in QuarantineSnapshots().refresh_now(folder).records}


def test_delete_all_deletes_only_what_was_previewed(tmp_path):
    folder, records = _held(tmp_path, [
        ("20261101_cut", _dur(30, 380), "song-a", 2000, None),
        ("20261102_ok", _dur(348, 380), "song-a", 9000, None),
        ("20261103_cut", _dur(20, 200), "song-b", 2000, None),
        ("20261104_grown", _dur(25, 300), "song-c", 2000, None),
    ])
    items = qb.delete_plan_items(folder, records, "cut_off")
    assert qb.plan_counts(items) == {"songs": 3, "files": 3, "bytes": 6000}
    # after the preview: a new cut-off file arrives and another one changes
    (tmp_path / "ss_quarantine" / "20261105_new.mp3.quarantined").write_bytes(b"x" * 2000)
    (tmp_path / "ss_quarantine" / "20261104_grown.mp3.quarantined").write_bytes(b"x" * 3000)
    result = qb.delete_planned(folder, items, _kinds_now(folder))
    left = sorted(os.listdir(folder))
    assert "20261105_new.mp3.quarantined" in left        # not previewed: stays
    assert "20261104_grown.mp3.quarantined" in left      # changed since: stays
    assert "20261104_grown.json" in left                 # and so does its sidecar
    assert "20261102_ok.mp3.quarantined" in left         # another verdict: stays
    assert "20261101_cut.mp3.quarantined" not in left
    assert "20261101_cut.json" not in left               # its sidecar went with it
    assert result["files_removed"] == 2 and result["sidecars_removed"] == 2
    assert result["skipped"] == 1 and result["changed"] == 0
    with pytest.raises(ValueError):
        qb.delete_plan_items(folder, records, "right_song")


def test_a_file_the_recheck_moved_to_another_group_isnt_deleted(tmp_path):
    folder, records = _held(tmp_path, [
        ("20261101_a", _dur(30, 380), "song-a", 2000, None),
        ("20261102_b", _dur(30, 380), "song-b", 2000, None),
    ])
    items = qb.delete_plan_items(folder, records, "cut_off")
    side = tmp_path / "ss_quarantine" / "20261102_b.json"
    data = json.loads(side.read_text())
    # AcoustID heard another song in it since the preview
    data["facts"] = {"acoustid": {"decision": "fail", "title": "Else", "artist": "X"}}
    side.write_text(json.dumps(data))
    result = qb.delete_planned(folder, items, _kinds_now(folder))
    assert result["changed"] == 1 and result["files_removed"] == 1
    assert sorted(os.listdir(folder)) == ["20261102_b.json", "20261102_b.mp3.quarantined"]


def test_keep_the_best_of_each(tmp_path):
    folder, records = _held(tmp_path, [
        ("20261101_a1", _dur(348, 380), "song-a", 3000, {"quality": "MP3 320"}),
        ("20261102_a2", _dur(348, 380), "song-a", 2000, {"quality": "MP3 192"}),
        ("20261103_a3", _dur(30, 380), "song-a", 1000, None),
        ("20261104_b1", _dur(432, 238), "song-b", 5000, {"quality": "FLAC 16bit/44.1kHz"}),
        ("20261105_c1", _dur(30, 200), "song-c", 1000, None),   # nothing to keep
    ])
    items = qb.keep_best_plan_items(records, "right_song")
    assert [(i["title"], i["best"], sorted(o["id"] for o in i["others"])) for i in items] == [
        ("song-a", "20261101_a1", ["20261102_a2", "20261103_a3"])]
    assert qb.keep_best_plan_items(records, "longer_version")[0]["best"] == "20261104_b1"
    assert qb.plan_counts(items) == {"songs": 1, "keep": 1, "delete": 2, "bytes": 3000}

    kept, deleted = [], []
    sizes = {n: os.path.getsize(os.path.join(folder, n)) for n in os.listdir(folder)}
    runner = qb.KeepBestRunner(approve=lambda i: kept.append(i) or True,
                               delete=lambda i: deleted.append(i) or True,
                               size_of=lambda name: sizes.get(name))
    runner.start(items, background=False)
    assert kept == ["20261101_a1"] and sorted(deleted) == ["20261102_a2", "20261103_a3"]
    assert runner.state["status"] == "done" and runner.state["kept"] == 1

    # a best that changed since the preview: that song is left alone
    sizes["20261101_a1.mp3.quarantined"] = 1
    kept.clear(), deleted.clear()
    runner.start(items, background=False)
    assert kept == [] and deleted == [] and runner.state["skipped"] == 1


# ── the endpoints ────────────────────────────────────────────────────────────


@pytest.fixture
def client(tmp_path, monkeypatch):
    from flask import Flask

    import api.quarantine as quarantine_api
    import api.quarantine_explained as explained
    import core.imports.quarantine_index as qi
    import core.profile_context as profile_context

    folder, _records = _held(tmp_path, [
        ("20261101_a1", _dur(348, 380), "song-a", 3000, {"quality": "MP3 320"}),
        ("20261102_a2", _dur(348, 380), "song-a", 2000, None),
        ("20261103_cut", _dur(30, 380), "song-a", 1000, None),
        ("20261104_x", "Integrity check failed: File too small (0 bytes, minimum 10240) — x",
         "song-b", 10, None),
    ])
    index = QuarantineSnapshots()
    index.refresh_now(folder)
    monkeypatch.setattr(qi, "shared_index", lambda: index)
    monkeypatch.setattr(quarantine_api, "_get_quarantine_dir", lambda: folder)
    monkeypatch.setattr(quarantine_api, "config_manager",
                        types.SimpleNamespace(get=lambda k, d=None: d))
    monkeypatch.setattr(explained, "_acoustid_state",
                        lambda: {"available": False, "reason": "No AcoustID API key configured",
                                 "refused": False, "working": False,
                                 "settings_url": explained.SETTINGS_URL})
    monkeypatch.setattr("core.imports.quarantine_library.annotate_quarantine_library",
                        lambda *a, **k: None)
    monkeypatch.setattr(qr, "_shared", qr.RecheckJob(qr.RecheckDeps(
        records=lambda: list(index.peek(folder).records), quarantine_dir=lambda: folder,
        store=_Store(), lease=qr.LocalLease())))
    admin = {"on": True}
    monkeypatch.setattr(profile_context, "is_admin_request", lambda: admin["on"])
    app = Flask(__name__)
    app.register_blueprint(explained.bp)
    c = app.test_client()
    c.admin = admin
    c.folder = folder
    return c


def test_the_overview(client):
    body = client.get("/api/quarantine/explained/overview").get_json()
    assert body["ready"] and body["files"] == 4 and body["songs"] == 2
    groups = {g["kind"]: g for g in body["groups"]}
    assert [g["kind"] for g in body["groups"]] == ["right_song", "cut_off", "broken"]
    assert groups["right_song"]["files"] == 2 and groups["right_song"]["songs"] == 1
    assert groups["right_song"]["example"]["length"] == "5:48"
    assert groups["right_song"]["example"]["spotify_length"] == "6:20"
    assert body["acoustid"]["working"] is False
    assert body["acoustid"]["settings_url"] == "/settings?tab=connections"
    assert body["recheck"]["pending"] == 4


def test_songs_and_one_song(client):
    body = client.get("/api/quarantine/explained/songs?kind=cut_off").get_json()
    assert body["total"] == 1
    song = body["songs"][0]
    assert song["best"] == "20261101_a1"
    # the best first, then the other likely keeps, then the rest
    assert [t["explained"]["verdict"] for t in song["tries"]] == ["best", "right_song", "cut_off"]
    assert song["tries"][1]["explained"]["text"] == "Same length as the best."
    one = client.get("/api/quarantine/explained/song?entry=20261102_a2").get_json()["song"]
    assert len(one["tries"]) == 3 and one["best"] == "20261101_a1"
    assert client.get("/api/quarantine/explained/song?entry=gone").get_json()["song"] is None
    assert client.get("/api/quarantine/explained/songs?kind=nope").status_code == 400


def test_bulk_delete_through_the_endpoints(client):
    preview = client.post("/api/quarantine/explained/bulk/preview",
                          json={"kind": "broken", "action": "delete"}).get_json()
    assert (preview["files"], preview["songs"]) == (1, 1) and preview["plan_id"]
    assert preview["sample"][0]["name"] == "20261104_x.mp3.quarantined"
    # the plan is for deleting: it can't be spent as a keep-best
    wrong = client.post("/api/quarantine/explained/bulk/confirm",
                        json={"plan_id": preview["plan_id"], "action": "keep_best"})
    assert wrong.status_code == 409
    done = client.post("/api/quarantine/explained/bulk/confirm",
                       json={"plan_id": preview["plan_id"], "action": "delete"}).get_json()
    assert done["files_removed"] == 1
    assert not os.path.exists(os.path.join(client.folder, "20261104_x.mp3.quarantined"))
    # single use
    again = client.post("/api/quarantine/explained/bulk/confirm",
                        json={"plan_id": preview["plan_id"], "action": "delete"})
    assert again.status_code == 409
    bad = client.post("/api/quarantine/explained/bulk/preview",
                      json={"kind": "right_song", "action": "delete"})
    assert bad.status_code == 400


def test_the_recheck_needs_a_working_acoustid(client, monkeypatch):
    monkeypatch.setattr(qr._shared.deps, "available", lambda: (False, "No key"))
    res = client.post("/api/quarantine/explained/recheck", json={"action": "start"})
    assert res.status_code == 409 and res.get_json()["code"] == "acoustid_unavailable"


def test_the_new_endpoints_are_admin_only(client):
    client.admin["on"] = False
    for method, url in [("get", "/api/quarantine/explained/overview"),
                        ("get", "/api/quarantine/explained/songs"),
                        ("get", "/api/quarantine/explained/song?entry=x"),
                        ("post", "/api/quarantine/explained/bulk/preview"),
                        ("post", "/api/quarantine/explained/bulk/confirm"),
                        ("post", "/api/quarantine/explained/bulk/cancel"),
                        ("get", "/api/quarantine/explained/recheck")]:
        assert getattr(client, method)(url).status_code == 403, url


def test_the_list_entries_carry_their_verdict(tmp_path):
    """/api/quarantine/list only gains a field."""
    from core.imports.quarantine import list_quarantine_entries
    folder, _ = _held(tmp_path, [("20261101_a1", _dur(348, 380), "song-a", 3000, None)])
    entry = list_quarantine_entries(folder)[0]
    assert entry["reason"].startswith("Integrity check failed")
    assert entry["trigger"] == "integrity"
    assert entry["explained"]["kind"] == "right_song"
    assert entry["explained"]["length"] == "5:48"


def test_a_page_of_songs_lists_the_folder_zero_times(client, monkeypatch):
    """The annotation reads each entry's sidecar by name: no folder listing
    per entry (the review's probe counted one per try)."""
    import core.imports.quarantine_library as qlib
    # the real annotation (the fixture stubbed it), on the fixture's folder
    monkeypatch.undo()
    import api.quarantine as quarantine_api
    import api.quarantine_explained as explained
    import core.imports.quarantine_index as qi
    import core.profile_context as profile_context
    folder = client.folder
    for i in range(30):
        name = f"20261120_{i:04d}_s"
        with open(os.path.join(folder, f"{name}.mp3.quarantined"), "wb") as f:
            f.write(b"x" * 100)
        with open(os.path.join(folder, f"{name}.json"), "w") as f:
            json.dump(_side(_dur(348, 380), context={"track_info": {"id": f"t{i}", "name": f"S{i}"}},
                            expected_track=f"S{i}"), f)
    index = QuarantineSnapshots()
    index.refresh_now(folder)
    monkeypatch.setattr(qi, "shared_index", lambda: index)
    monkeypatch.setattr(quarantine_api, "_get_quarantine_dir", lambda: folder)
    monkeypatch.setattr(quarantine_api, "config_manager",
                        types.SimpleNamespace(get=lambda k, d=None: d))
    monkeypatch.setattr(profile_context, "is_admin_request", lambda: True)
    monkeypatch.setattr(qlib, "_library_paths", lambda database, config: [])
    monkeypatch.setattr(qlib, "_presence", lambda *a, **k: ("missing", None))
    calls = {"listdir": 0, "scandir": 0}
    real_listdir, real_scandir = os.listdir, os.scandir

    def counting_listdir(*a, **k):
        calls["listdir"] += 1
        return real_listdir(*a, **k)

    def counting_scandir(*a, **k):
        calls["scandir"] += 1
        return real_scandir(*a, **k)

    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(explained.bp)
    monkeypatch.setattr(os, "listdir", counting_listdir)
    monkeypatch.setattr(os, "scandir", counting_scandir)
    body = app.test_client().get("/api/quarantine/explained/songs?limit=25").get_json()
    monkeypatch.setattr(os, "listdir", real_listdir)
    monkeypatch.setattr(os, "scandir", real_scandir)
    assert len(body["songs"]) == 25
    assert all(t["library_status"] == "missing" for s_ in body["songs"] for t in s_["tries"])
    assert calls == {"listdir": 0, "scandir": 0}


def test_a_bulk_keep_is_the_approve_route_s_keep(client, monkeypatch):
    """The owning task is completed through the verification wrapper and a
    retry still searching for the track is cancelled."""
    import api.quarantine as quarantine_api
    import api.quarantine_explained as explained

    tasks = {
        "t-owner": {"status": "failed", "batch_id": "b1", "quarantine_entry_id": "20261101_a1"},
        "t-retry": {"status": "searching", "_quarantine_retry": True,
                    "track_info": {"name": "song-a"}},
    }
    wrapped, plain = [], []

    def wrapper(key, ctx, path, task_id, batch_id):
        wrapped.append((task_id, batch_id, ctx.get("_skip_quarantine_check")))
        tasks[task_id]["status"] = "completed"

    monkeypatch.setattr(quarantine_api, "download_tasks", tasks)
    monkeypatch.setattr(quarantine_api, "tasks_lock", threading.Lock())
    monkeypatch.setattr(quarantine_api, "docker_resolve_path", lambda p: p)
    monkeypatch.setattr(quarantine_api, "config_manager",
                        types.SimpleNamespace(get=lambda k, d=None: str(os.path.dirname(client.folder))))
    monkeypatch.setattr(quarantine_api, "_post_process_matched_download_with_verification", wrapper)
    monkeypatch.setattr(quarantine_api, "_post_process_matched_download",
                        lambda *a: plain.append(a))
    # the sidecar names the track the retry is searching for
    side = os.path.join(client.folder, "20261101_a1.json")
    data = json.load(open(side))
    data["context"]["track_info"]["name"] = "song-a"
    json.dump(data, open(side, "w"))

    assert explained._approve_entry("20261101_a1") is True
    assert wrapped == [("t-owner", "b1", "all")] and plain == []
    assert tasks["t-owner"]["status"] == "completed"
    assert tasks["t-retry"]["status"] == "cancelled"
    # the plan deletes the song's other tries; the approve itself removed none
    assert os.path.exists(os.path.join(client.folder, "20261102_a2.mp3.quarantined"))
