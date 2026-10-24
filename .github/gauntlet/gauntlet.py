#!/usr/bin/env python3
"""Helpers for the gauntlet workflow (.github/workflows/gauntlet.yml).

Standard library only, so it runs before anything is installed. Subcommands:

  base      pick the commit to compare against for this event
  changes   list the changed files and match them against gauntlet-paths.txt
  targets   the changed files a scanner should look at
  triage    compare a Bandit or Semgrep report with its committed baseline
  baseline  write a baseline from a full Bandit or Semgrep report

docs/GAUNTLET.md explains what the gauntlet is and how to read its results.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import subprocess  # nosec B404 - runs git with fixed arguments
import sys
from pathlib import Path

ZERO_SHA = "0" * 40
REPO = Path(__file__).resolve().parents[2]
PATHS_FILE = REPO / ".github" / "gauntlet-paths.txt"

# Files a scanner never looks at: tests (asserts, fixtures, fake tokens),
# lockfiles, and the baselines themselves (they quote the flagged lines).
SCAN_EXCLUDE = [
    "tests/**",
    "webui/package-lock.json",
    "**/*.lock",
    ".github/gauntlet/*-baseline.json",
]

# What fails and what only warns, per tool. Anything else is ignored.
FAIL_LEVELS = {"bandit": {"HIGH"}, "semgrep": {"ERROR", "WARNING"}}
WARN_LEVELS = {"bandit": {"MEDIUM"}, "semgrep": {"INFO"}}


# ── git ──────────────────────────────────────────────────────────────────────

def git(*args: str, check: bool = True) -> str:
    out = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)  # nosec B603 B607
    if check and out.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {out.stderr.strip()}")
    return out.stdout.strip() if out.returncode == 0 else ""


def commit_exists(sha: str) -> bool:
    if not sha or sha == ZERO_SHA:
        return False
    return subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"],  # nosec B603 B607
                          cwd=REPO, capture_output=True).returncode == 0


def is_ancestor(a: str, b: str) -> bool:
    return subprocess.run(["git", "merge-base", "--is-ancestor", a, b],  # nosec B603 B607
                          cwd=REPO, capture_output=True).returncode == 0


def merge_base(a: str, b: str) -> str:
    return git("merge-base", a, b, check=False)


# ── globs ────────────────────────────────────────────────────────────────────

def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """`**` crosses folders, `*` and `?` stay inside one."""
    i, out = 0, []
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def load_paths(path: Path = PATHS_FILE) -> list[tuple[str, str, re.Pattern[str]]]:
    """[(area, glob, regex)] in file order."""
    area, rules = "Other", []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("## "):
            area = line[3:].strip()
            continue
        if not line or line.startswith("#"):
            continue
        rules.append((area, line, glob_to_regex(line)))
    return rules


def match(path: str, rules) -> tuple[str, str] | None:
    for area, glob, rx in rules:
        if rx.match(path):
            return area, glob
    return None


def excluded(path: str) -> bool:
    return any(glob_to_regex(g).match(path) for g in SCAN_EXCLUDE)


# ── base ─────────────────────────────────────────────────────────────────────

def cmd_base(a) -> int:
    """Pick the commit to diff against.

    pull_request: the merge base of the PR's base and head.
    push: the commit before the push, if it's an ancestor of what was pushed;
          a branch's first push (before is all zeros) or a force-push (before
          is gone or not an ancestor) falls back to the merge base with the
          default branch, and failing that the parent commit.
    workflow_dispatch and anything else: the merge base with the default branch.
    """
    head = a.head
    target = f"origin/{a.default_branch}"
    base, why = "", ""
    if a.event == "pull_request" and a.pr_base and commit_exists(a.pr_base):
        base, why = merge_base(a.pr_base, head), "the pull request's merge base"
    elif a.event == "push" and a.before and a.before != ZERO_SHA and commit_exists(a.before) \
            and is_ancestor(a.before, head) and a.before != head:
        base, why = a.before, "the commit before this push"
    if not base:
        mb = merge_base(target, head) if commit_exists(target) else ""
        if mb and mb != git("rev-parse", head):
            note = {"push": " (first push of the branch, or a force-push)"}.get(a.event, "")
            base, why = mb, f"the merge base with {a.default_branch}{note}"
    if not base:
        parent = git("rev-parse", "-q", "--verify", f"{head}^", check=False)
        if parent:
            base, why = parent, "the parent commit"
    if not base:
        base, why = git("hash-object", "-t", "tree", "/dev/null"), "the empty tree (no history)"
    _output({"base": base, "base_reason": why})
    print(f"base {base} ({why})")
    return 0


# ── changes ──────────────────────────────────────────────────────────────────

def changed_files(base: str, head: str) -> list[tuple[str, str]]:
    """[(status, path)] for every file changed between base and head; a rename
    lists both the old and the new path."""
    out = git("diff", "--name-status", "--no-renames", base, head)
    files = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            files.append((parts[0][0], parts[-1]))
    return files


def cmd_changes(a) -> int:
    rules = load_paths()
    files = changed_files(a.base, a.head)
    risky = []
    for status, path in files:
        hit = match(path, rules)
        if hit:
            risky.append({"path": path, "status": status, "area": hit[0], "glob": hit[1]})
    reasons = []
    if risky:
        reasons.append(f"{len(risky)} risky file(s) changed")
    if a.label:
        reasons.append("the pull request is labelled `gauntlet`")
    if a.event == "workflow_dispatch":
        reasons.append("started by hand (workflow_dispatch)")
    run = bool(reasons)
    Path(a.out).write_text(json.dumps({"changed": [p for _, p in files], "risky": risky}, indent=1), encoding="utf-8")
    _output({"run": "true" if run else "false", "reason": "; ".join(reasons) or "nothing risky changed",
             "risky_count": str(len(risky)), "changed_count": str(len(files))})
    lines = [f"## Gauntlet: {'running' if run else 'skipped'}", ""]
    lines.append(f"Compared `{a.base[:12]}` → `{a.head[:12]}` ({a.base_reason}): {len(files)} file(s) changed.")
    lines.append("")
    if run:
        lines.append(f"**Why it runs:** {'; '.join(reasons)}.")
    else:
        lines.append("**Nothing risky changed, so the gauntlet's checks are skipped.** "
                     "None of the changed files match `.github/gauntlet-paths.txt`. "
                     "Label a pull request `gauntlet`, or start the workflow by hand, to run it anyway.")
    if risky:
        lines += ["", "| Risky file | Change | Area | Matched |", "|---|---|---|---|"]
        lines += [f"| `{r['path']}` | {_status(r['status'])} | {r['area']} | `{r['glob']}` |" for r in risky]
    _summary("\n".join(lines))
    print("\n".join(lines))
    return 0


def _status(s: str) -> str:
    return {"A": "added", "M": "modified", "D": "deleted", "T": "type changed"}.get(s, s)


# ── targets ──────────────────────────────────────────────────────────────────

def cmd_targets(a) -> int:
    data = json.loads(Path(a.changes).read_text(encoding="utf-8"))
    if a.all:
        rules = load_paths()
        pool = [p for p in git("ls-files").splitlines() if match(p, rules)]
    else:
        pool = data["changed"]
    out, too_big = [], []
    for p in pool:
        if excluded(p) or not (REPO / p).is_file():
            continue
        if a.python and not p.endswith(".py"):
            continue
        if a.max_bytes and (REPO / p).stat().st_size > a.max_bytes:
            too_big.append(p)
            continue
        out.append(p)
    Path(a.out).write_text("\n".join(out) + ("\n" if out else ""), encoding="utf-8")
    print(f"{len(out)} file(s) to scan")
    if too_big:
        note = (f"Too big for this scanner (over {a.max_bytes:,} bytes), so left out: "
                + ", ".join(f"`{p}`" for p in too_big) + ". Bandit still scans them.")
        print(note)
        _summary(note)
    return 0


# ── findings, fingerprints, changed lines ────────────────────────────────────

def _line_text(path: str, line: int, cache: dict) -> str:
    if path not in cache:
        try:
            cache[path] = (REPO / path).read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            cache[path] = []
    lines = cache[path]
    text = lines[line - 1] if 0 < line <= len(lines) else ""
    return " ".join(text.split())[:240]


def _norm_path(p: str) -> str:
    p = p.replace("\\", "/")
    try:
        p = os.path.relpath(os.path.abspath(p), REPO).replace("\\", "/")
    except ValueError:
        pass
    return p[2:] if p.startswith("./") else p


def read_findings(tool: str, report: Path) -> list[dict]:
    data = json.loads(report.read_text(encoding="utf-8"))
    cache: dict = {}
    found = []
    if tool == "bandit":
        for r in data.get("results", []):
            path = _norm_path(r["filename"])
            found.append({"path": path, "line": int(r["line_number"]), "rule": r["test_id"],
                          "name": r["test_name"], "severity": r["issue_severity"].upper(),
                          "message": r["issue_text"], "text": _line_text(path, int(r["line_number"]), cache)})
    else:
        for r in data.get("results", []):
            path = _norm_path(r["path"])
            line = int(r["start"]["line"])
            rule = r["check_id"].rsplit(".", 1)[-1]
            found.append({"path": path, "line": line, "rule": rule, "name": rule,
                          "severity": r["extra"].get("severity", "INFO").upper(),
                          "message": " ".join(str(r["extra"].get("message", "")).split())[:300],
                          "text": _line_text(path, line, cache)})
    return found


def text_hash(text: str) -> str:
    """The flagged line's text, hashed: the baseline never copies code (or a
    key the code already holds) into another file."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def fingerprint(f: dict) -> tuple[str, str, str]:
    # no line number: a finding keeps its fingerprint when code above it moves
    return f["path"], f["rule"], text_hash(f["text"])


def added_lines(base: str, head: str, paths: list[str]) -> dict[str, set[int]]:
    out: dict[str, set[int]] = collections.defaultdict(set)
    if not paths:
        return out
    diff = git("diff", "-U0", "--no-color", "--no-renames", base, head, "--", *paths)
    current = None
    for line in diff.splitlines():
        if line.startswith("+++ "):
            current = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@") and current:
            m = re.match(r"@@ -\S+ \+(\d+)(?:,(\d+))? @@", line)
            if m:
                start, count = int(m.group(1)), int(m.group(2) or 1)
                out[current].update(range(start, start + count))
    return out


# ── baseline ─────────────────────────────────────────────────────────────────

def cmd_baseline(a) -> int:
    found = [f for f in read_findings(a.tool, Path(a.report))
             if f["severity"] in FAIL_LEVELS[a.tool] | WARN_LEVELS[a.tool] and not excluded(f["path"])]
    # "line" is where it was when the baseline was made, for a reader; matching
    # uses path, rule and the hash of the line's text.
    entries = sorted(({"path": f["path"], "rule": f["rule"], "severity": f["severity"], "line": f["line"],
                       "hash": text_hash(f["text"])} for f in found),
                     key=lambda e: (e["path"], e["line"], e["rule"]))
    counts = collections.Counter(e["severity"] for e in entries)
    doc = {
        "tool": a.tool,
        "version": a.version,
        "rules": a.rules or None,
        "generated_at_commit": git("rev-parse", "HEAD"),
        "note": "Findings that were already in the code when this baseline was made. The gauntlet fails only "
                "on findings that aren't here. Regenerate as described in docs/GAUNTLET.md; never hand-edit "
                "entries out to silence a new finding.",
        "counts": dict(sorted(counts.items())),
        "findings": entries,
    }
    # one finding per line, so a regenerated baseline reads as a short diff
    head = json.dumps({k: v for k, v in doc.items() if k != "findings"}, indent=1, ensure_ascii=False)
    rows = ",\n".join("  " + json.dumps(e, ensure_ascii=False) for e in entries)
    text = head[:-2] + ',\n "findings": [\n' + rows + "\n ]\n}\n"
    json.loads(text)
    Path(a.out).write_text(text, encoding="utf-8")
    print(f"{len(entries)} finding(s) baselined: {dict(counts)}")
    return 0


# ── triage ───────────────────────────────────────────────────────────────────

def cmd_triage(a) -> int:
    tool = a.tool
    targets = [p for p in Path(a.targets).read_text(encoding="utf-8").splitlines() if p]
    found = [f for f in read_findings(tool, Path(a.report)) if not excluded(f["path"])]
    found = [f for f in found if f["severity"] in FAIL_LEVELS[tool] | WARN_LEVELS[tool]]
    baseline = json.loads(Path(a.baseline).read_text(encoding="utf-8"))
    base_counts = collections.Counter((e["path"], e["rule"], e["hash"]) for e in baseline["findings"])
    changed = None if a.all_lines else added_lines(a.base, a.head, sorted({f["path"] for f in found}))

    def on_changed_line(f: dict) -> bool:
        return changed is None or f["line"] in changed.get(f["path"], set())

    groups: dict[tuple, list[dict]] = collections.defaultdict(list)
    for f in found:
        groups[fingerprint(f)].append(f)
    new, drift, known = [], [], 0
    for fp, items in groups.items():
        items.sort(key=lambda f: (not on_changed_line(f), f["line"]))
        extra = max(0, len(items) - base_counts.get(fp, 0))
        known += len(items) - extra
        for f in items[:extra]:
            (new if on_changed_line(f) else drift).append(f)
    failing = [f for f in new if f["severity"] in FAIL_LEVELS[tool]]
    warning = [f for f in new if f["severity"] in WARN_LEVELS[tool]]

    for f in failing:
        print(f"::error file={f['path']},line={f['line']},title={tool} {f['rule']}::{f['message']}")
    for f in warning:
        print(f"::warning file={f['path']},line={f['line']},title={tool} {f['rule']}::{f['message']}")

    title = {"bandit": "Bandit", "semgrep": "Semgrep"}[tool]
    scope = "every risky file, every line" if a.all_lines else "changed lines"
    lines = [f"## {title}", "",
             f"Scanned {len(targets)} file(s); {len(found)} finding(s) at the levels the gauntlet reads, "
             f"{known} already in the baseline. New findings are judged on {scope}.", ""]
    if failing:
        lines.append(f"**Failed: {len(failing)} new finding(s) at {'/'.join(sorted(FAIL_LEVELS[tool]))}.**")
    else:
        lines.append(f"**Passed: no new {'/'.join(sorted(FAIL_LEVELS[tool]))} findings.**")
    lines += _table("New findings that fail the gauntlet", failing)
    lines += _table(f"Warnings (new {'/'.join(sorted(WARN_LEVELS[tool]))} findings; they don't fail)", warning)
    lines += _table("Not on a changed line and not in the baseline (they don't fail; usually a moved line or a "
                    "rule update; regenerate the baseline if they persist)", drift)
    _summary("\n".join(lines))
    print("\n".join(lines))
    _output({"failing": str(len(failing)), "warnings": str(len(warning)), "drift": str(len(drift)),
             "scanned": str(len(targets))})
    return 1 if failing else 0


def _table(title: str, rows: list[dict]) -> list[str]:
    if not rows:
        return []
    out = ["", f"### {title}", "", "| File | Line | Rule | Severity | What |", "|---|---|---|---|---|"]
    for f in sorted(rows, key=lambda f: (f["path"], f["line"]))[:100]:
        msg = f["message"].replace("|", "\\|")
        out.append(f"| `{f['path']}` | {f['line']} | `{f['rule']}` {f['name'] if f['name'] != f['rule'] else ''} "
                   f"| {f['severity']} | {msg} |")
    if len(rows) > 100:
        out.append(f"| … | | | | {len(rows) - 100} more |")
    return out


# ── plumbing ─────────────────────────────────────────────────────────────────

def _output(values: dict[str, str]) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for k, v in values.items():
            fh.write(f"{k}={v}\n")


def _summary(text: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("base")
    b.add_argument("--event", required=True)
    b.add_argument("--head", default="HEAD")
    b.add_argument("--before", default="")
    b.add_argument("--pr-base", default="")
    b.add_argument("--default-branch", default="integration")
    b.set_defaults(fn=cmd_base)

    c = sub.add_parser("changes")
    c.add_argument("--base", required=True)
    c.add_argument("--base-reason", default="")
    c.add_argument("--head", default="HEAD")
    c.add_argument("--event", default="")
    c.add_argument("--label", action="store_true")
    c.add_argument("--out", required=True)
    c.set_defaults(fn=cmd_changes)

    t = sub.add_parser("targets")
    t.add_argument("--changes", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--python", action="store_true")
    t.add_argument("--all", action="store_true", help="every tracked file matching the risky paths")
    t.add_argument("--max-bytes", type=int, default=0, help="leave out files bigger than this")
    t.set_defaults(fn=cmd_targets)

    tr = sub.add_parser("triage")
    tr.add_argument("tool", choices=["bandit", "semgrep"])
    tr.add_argument("--report", required=True)
    tr.add_argument("--baseline", required=True)
    tr.add_argument("--targets", required=True)
    tr.add_argument("--base", default="")
    tr.add_argument("--head", default="HEAD")
    tr.add_argument("--all-lines", action="store_true", help="judge every line, not only changed ones")
    tr.set_defaults(fn=cmd_triage)

    bl = sub.add_parser("baseline")
    bl.add_argument("tool", choices=["bandit", "semgrep"])
    bl.add_argument("--report", required=True)
    bl.add_argument("--out", required=True)
    bl.add_argument("--version", default="")
    bl.add_argument("--rules", default="")
    bl.set_defaults(fn=cmd_baseline)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
