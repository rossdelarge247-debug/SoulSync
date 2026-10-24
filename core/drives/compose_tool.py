"""The Docker step's tool (boards 14c, 14d): adds the drives mount to the
services in ``docker-compose.yml`` that read the music folders, keeps a copy,
restarts, and undoes.

This file runs in two places, so it imports only the standard library:

* SYNCHRO.S serves it inside the helper script (``/api/drives/helper.sh``),
  which runs it with the computer's own ``python3`` (macOS has one once the
  Command Line Tools are installed, step 1 of the Mac guide);
* the app imports its YAML block functions to edit ``slskd.yml`` at the
  switch.

**How it edits YAML.** Not with sed, and not by loading and dumping the file
(that would lose comments, anchors and the person's layout). It reads the
block structure (keys, their indentation, sequences under them) and only ever
*inserts* whole lines: every line already there stays exactly as it was. It
refuses what it can't edit safely (a flow list like ``volumes: [a, b]``, a
service whose keys come from a ``<<:`` merge, tabs) and says to do it by
hand. Before writing, the new file is checked with ``docker compose config``.

Run as a program: ``python3 compose_tool.py [--undo] [--dry-run] [--names]
[--yes] [--platform mac|linux] [--file docker-compose.yml]`` from the folder
that holds the compose file.

**Host hints (``--names``).** Each run that changes the file, or finds it
already done, also writes ``host-paths.json`` into SYNCHRO.S's own settings
folder (the ``./config`` it mounts at ``/app/config``): for each music folder
it mounts (``./music`` for ``/app/Transfer``), keyed by the id in the marker
SYNCHRO.S keeps at the folder's root, the folder's path on this computer,
its volume's name, the OS and the time. SYNCHRO.S shows those names instead
of container paths, and trusts an entry only while the marker id matches.
Nothing is written into the music folders (slskd shares the library's root),
and a ``.synchros-host.json`` an older helper left in one is deleted.
``--names`` writes only that file: no compose change, no restart. A folder
SYNCHRO.S hasn't marked yet, a link, or a mount it can't resolve is skipped
and said. The file is written through a new, uniquely named file renamed
over it, never through a link.

**Which files.** With the default file name, Docker also reads
``docker-compose.override.yml`` (and ``COMPOSE_FILE`` when it's set), so the
tool runs ``docker compose`` without ``-f`` and checks the edit together with
the same files. With ``COMPOSE_FILE`` set it edits the first file listed.
``--file`` names one file and uses only that one.

**Undo.** Each run that changes the file keeps the file as it was in
``docker-compose.before-drives.yml`` and a fingerprint (SHA-256) of the file
it wrote. ``--undo`` puts the copy back only while the file is still exactly
what the helper wrote, so later edits are never lost.
"""

from __future__ import annotations

import hashlib
import json
import os
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import time
from typing import Dict, List, Optional, Sequence, Tuple

BACKUP_NAME = "docker-compose.before-drives.yml"
STATE_NAME = ".docker-compose.drives-helper.json"
OVERRIDE_NAMES = {"docker-compose.yml": ("docker-compose.override.yml", "docker-compose.override.yaml"),
                  "docker-compose.yaml": ("docker-compose.override.yml", "docker-compose.override.yaml"),
                  "compose.yml": ("compose.override.yml", "compose.override.yaml"),
                  "compose.yaml": ("compose.override.yml", "compose.override.yaml")}
COMPOSE_NAMES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
DRIVE_MOUNTS = {"mac": ["/Volumes:/Volumes"], "linux": ["/mnt:/mnt", "/media:/media"]}
SLSKD_CONFIG_TARGET = "/slskd-config"
MUSIC_TARGETS = ("/app/Transfer", "/app/downloads", "/app/Staging")
MUSIC_LABELS = {"/app/Transfer": "Library", "/app/downloads": "Downloads", "/app/Staging": "Staging"}
MARKER_NAME = ".synchros-folder.json"
#: what an older helper wrote inside each music folder; deleted now
LEGACY_HINT_NAME = ".synchros-host.json"
HINTS_NAME = "host-paths.json"
CONFIG_TARGET = "/app/config"
HINT_VERSION = 1
HINTS_MAX_FOLDERS = 64
HINTS_MAX_BYTES = 96 * 1024
_MARKER_ID = re.compile(r"^[0-9a-f]{32}$")
_SMALL = 4096


class Unsupported(ValueError):
    """The file has a shape this tool won't edit; the message says why."""


# ── reading lines ─────────────────────────────────────────────────────────────

_KEY = re.compile(r"""^(?P<key>"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:,\[\]{}&*!|>%@`][^:#]*?|-[^\s][^:#]*?)\s*:(?:\s+(?P<rest>.*))?$""")


def _strip_comment(text: str) -> str:
    """``text`` without a trailing ``# comment`` (one outside quotes)."""
    out = []
    quote = None
    prev = " "
    for ch in text:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
        elif ch in ("'", '"') and prev in " \t[{,:-":
            quote = ch
            out.append(ch)
        elif ch == "#" and prev in " \t":
            break
        else:
            out.append(ch)
        prev = ch
    return "".join(out).rstrip()


class Line:
    __slots__ = ("idx", "raw", "body", "indent", "content")

    def __init__(self, idx: int, raw: str) -> None:
        self.idx = idx
        self.raw = raw
        self.body = raw.rstrip("\r\n")
        stripped = self.body.lstrip(" ")
        if self.body[: len(self.body) - len(stripped)].count("\t") or stripped.startswith("\t"):
            raise Unsupported("The file uses tabs for indentation.")
        self.indent = len(self.body) - len(stripped)
        self.content = "" if stripped.startswith("#") else _strip_comment(stripped)

    @property
    def blank(self) -> bool:
        return self.content == ""


def _lines(text: str) -> List[Line]:
    return [Line(i, raw) for i, raw in enumerate(text.splitlines(keepends=True))]


def _newline(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return bytes(value[1:-1], "utf-8").decode("unicode_escape")
    return value


_PLAIN = re.compile(r"^[A-Za-z0-9_./~$][A-Za-z0-9_./~:=@+$ -]*$")


def scalar(value: str) -> str:
    """``value`` as a YAML scalar: plain when that's unambiguous, else single-quoted."""
    if _PLAIN.match(value) and ": " not in value and " #" not in value and not value.endswith((":", " ")):
        return value
    return "'" + value.replace("'", "''") + "'"


# ── the block structure ───────────────────────────────────────────────────────

class Node:
    """A ``key:`` line and the lines its value spans."""

    def __init__(self, line: Line, key: str, rest: str, end: int, last: int) -> None:
        self.line = line
        self.key = key
        self.rest = rest            # what follows the colon on the key's line
        self.end = end              # index after the block's last line (comments included)
        self.last = last            # index of the block's last content line

    @property
    def indent(self) -> int:
        return self.line.indent


def _block_end(lines: List[Line], start: int, indent: int, *, allow_seq_at_indent: bool) -> Tuple[int, int]:
    """(end, last): the block that starts after line ``start`` holds the
    lines indented more than ``indent`` (and, for a value that's a sequence,
    ``- `` items at the same indent)."""
    last = start
    i = start + 1
    while i < len(lines):
        ln = lines[i]
        if ln.blank:
            i += 1
            continue
        if ln.indent > indent or (allow_seq_at_indent and ln.indent == indent and ln.content.startswith("- ")):
            last = i
            i += 1
            continue
        break
    return last + 1, last


def _children(lines: List[Line], start: int, end: int, *, parent_indent: int) -> List[Node]:
    """The mapping keys directly under a block (lines start+1 .. end)."""
    out: List[Node] = []
    child_indent = None
    i = start + 1
    while i < end:
        ln = lines[i]
        if ln.blank:
            i += 1
            continue
        if ln.indent <= parent_indent and not (ln.indent == parent_indent and ln.content.startswith("- ")):
            break
        if child_indent is None:
            child_indent = ln.indent
        if ln.indent == child_indent:
            m = _KEY.match(ln.content)
            if m and not ln.content.startswith("- "):
                key = _unquote(m.group("key"))
                rest = (m.group("rest") or "").strip()
                block_end, last = _block_end(lines, i, ln.indent, allow_seq_at_indent=True)
                out.append(Node(ln, key, rest, block_end, last))
                i = block_end
                continue
        i += 1
    return out


def top_level(lines: List[Line]) -> List[Node]:
    for ln in lines:
        if not ln.blank and ln.content.startswith(("---", "...")) and ln.idx > 0:
            raise Unsupported("The file holds more than one YAML document.")
    return _children(lines, -1, len(lines), parent_indent=-1)


def find(lines: List[Line], path: Sequence[str]) -> Optional[Node]:
    nodes = top_level(lines)
    node = None
    for key in path:
        node = next((n for n in nodes if n.key == key), None)
        if node is None:
            return None
        nodes = _children(lines, node.line.idx, node.end, parent_indent=node.indent)
    return node


def children_of(lines: List[Line], node: Node) -> List[Node]:
    return _children(lines, node.line.idx, node.end, parent_indent=node.indent)


def seq_items(lines: List[Line], node: Node) -> List[Tuple[int, int, int, str]]:
    """The ``- item`` entries of a block sequence value: (first line index,
    last line index, dash indent, the item's text on its first line)."""
    if node.rest:
        if node.rest.startswith(("[", "{")):
            raise Unsupported(f"“{node.key}” is written on one line ({node.rest}).")
        if node.rest.startswith(("*", "&", "!")):
            raise Unsupported(f"“{node.key}” uses a YAML anchor or tag.")
        raise Unsupported(f"“{node.key}” isn't a list.")
    items = []
    i = node.line.idx + 1
    dash = None
    while i < node.end:
        ln = lines[i]
        if ln.blank:
            i += 1
            continue
        if ln.content.startswith("- ") or ln.content == "-":
            if dash is None:
                dash = ln.indent
            if ln.indent == dash:
                end, last = _block_end(lines, i, ln.indent, allow_seq_at_indent=False)
                items.append((i, last, ln.indent, ln.content[1:].strip()))
                i = end
                continue
        elif dash is None:
            raise Unsupported(f"“{node.key}” isn't a list.")
        i += 1
    return items


def _indent_step(lines: List[Line]) -> int:
    for ln in lines:
        if not ln.blank and ln.indent > 0:
            return ln.indent
    return 2


def _insert(text: str, at: int, new_lines: List[str]) -> str:
    """``text`` with ``new_lines`` inserted before line index ``at``."""
    nl = _newline(text)
    raw = text.splitlines(keepends=True)
    if at > 0 and at == len(raw) and raw and not raw[-1].endswith(("\n", "\r")):
        raw[-1] = raw[-1] + nl
    block = [line + nl for line in new_lines]
    return "".join(raw[:at] + block + raw[at:])


def add_seq_item(text: str, path: Sequence[str], value: str) -> str:
    """``text`` with ``- value`` added to the sequence at ``path`` (made when
    missing, under a parent that must exist)."""
    lines = _lines(text)
    node = find(lines, path)
    step = _indent_step(lines)
    if node is not None:
        items = seq_items(lines, node)
        if items:
            last = items[-1]
            return _insert(text, last[1] + 1, [" " * last[2] + "- " + value])
        return _insert(text, node.line.idx + 1, [" " * (node.indent + step) + "- " + value])
    parent = find(lines, path[:-1]) if len(path) > 1 else None
    if parent is None:
        raise Unsupported(f"There's no “{'.'.join(path[:-1])}” to add to.")
    if parent.rest:
        raise Unsupported(f"“{parent.key}” is written on one line.")
    kids = children_of(lines, parent)
    if any(k.key == "<<" for k in kids):
        raise Unsupported(f"“{parent.key}” takes its keys from a YAML merge (<<:), so adding “{path[-1]}” "
                          "would hide the merged ones.")
    child_indent = kids[0].indent if kids else parent.indent + step
    at = parent.last + 1
    return _insert(text, at, [" " * child_indent + scalar(path[-1]) + ":",
                              " " * (child_indent + step) + "- " + value])


def set_seq(text: str, path: Sequence[str], values: Sequence[str]) -> str:
    """``text`` with the sequence at ``path`` holding exactly ``values``:
    items not wanted are removed, missing ones added; comments between items
    stay. The mapping above it is made when missing."""
    out = text
    lines = _lines(out)
    node = find(lines, path)
    wanted = [str(v) for v in values]
    if node is not None:
        items = seq_items(lines, node)
        keep = []
        drop = []
        for first, last, _dash, item in items:
            if _unquote(item) in wanted and _unquote(item) not in keep:
                keep.append(_unquote(item))
            else:
                drop.append((first, last))
        raw = out.splitlines(keepends=True)
        for first, last in sorted(drop, reverse=True):
            del raw[first:last + 1]
        out = "".join(raw)
        for v in wanted:
            if v not in keep:
                out = add_seq_item(out, path, scalar(v))
        return out
    out = ensure_mapping(out, path[:-1])
    for v in wanted:
        out = add_seq_item(out, path, scalar(v))
    return out


def ensure_mapping(text: str, path: Sequence[str]) -> str:
    """``text`` with block mappings along ``path`` (made at the end of their
    parent when missing)."""
    lines = _lines(text)
    step = _indent_step(lines)
    for depth in range(1, len(path) + 1):
        sub = path[:depth]
        lines = _lines(text)
        if find(lines, sub) is not None:
            continue
        if depth == 1:
            nl = _newline(text)
            body = text if (not text or text.endswith(("\n", "\r"))) else text + nl
            text = body + scalar(sub[0]) + ":" + nl
            continue
        parent = find(lines, sub[:-1])
        assert parent is not None
        if parent.rest:
            raise Unsupported(f"“{parent.key}” is written on one line.")
        kids = children_of(lines, parent)
        indent = kids[0].indent if kids else parent.indent + step
        text = _insert(text, parent.last + 1, [" " * indent + scalar(sub[-1]) + ":"])
    return text


def set_scalar(text: str, path: Sequence[str], value: str) -> str:
    """``text`` with ``path`` set to the scalar ``value``. An existing line is
    rewritten (its comment kept); a missing key is added."""
    lines = _lines(text)
    node = find(lines, path)
    if node is not None:
        if node.end - 1 > node.line.idx and any(not ln.blank for ln in lines[node.line.idx + 1:node.end]):
            raise Unsupported(f"“{node.key}” holds more than one value.")
        body = node.line.body
        colon = body.index(":", node.line.indent + len(node.line.content.split(":")[0]))
        tail = body[colon + 1:]
        comment = ""
        stripped_tail = _strip_comment(tail)
        if len(stripped_tail) < len(tail.rstrip()):
            comment = "  " + tail[len(stripped_tail):].strip()
        ending = node.line.raw[len(node.line.body):]
        raw = text.splitlines(keepends=True)
        raw[node.line.idx] = body[:colon + 1] + " " + scalar(value) + comment + ending
        return "".join(raw)
    text = ensure_mapping(text, path[:-1]) if len(path) > 1 else text
    lines = _lines(text)
    step = _indent_step(lines)
    if len(path) == 1:
        nl = _newline(text)
        body = text if (not text or text.endswith(("\n", "\r"))) else text + nl
        return body + scalar(path[0]) + ": " + scalar(value) + nl
    parent = find(lines, path[:-1])
    kids = children_of(lines, parent)
    indent = kids[0].indent if kids else parent.indent + step
    return _insert(text, parent.last + 1, [" " * indent + scalar(path[-1]) + ": " + scalar(value)])


def delete_scalar(text: str, path: Sequence[str]) -> str:
    """``text`` without the one-line key at ``path`` (and without its parent
    mappings when that leaves them empty). Missing: unchanged."""
    lines = _lines(text)
    node = find(lines, path)
    if node is None:
        return text
    if node.end - 1 > node.line.idx and any(not ln.blank for ln in lines[node.line.idx + 1:node.end]):
        raise Unsupported(f"“{node.key}” holds more than one value.")
    raw = text.splitlines(keepends=True)
    del raw[node.line.idx]
    out = "".join(raw)
    if len(path) > 1:
        parent_lines = _lines(out)
        parent = find(parent_lines, path[:-1])
        if parent is not None and not parent.rest and not children_of(parent_lines, parent) \
                and not any(not ln.blank for ln in parent_lines[parent.line.idx + 1:parent.end]):
            return delete_scalar(out, path[:-1])
    return out


def get_scalar(text: str, path: Sequence[str]) -> Optional[str]:
    node = find(_lines(text), path)
    if node is None or not node.rest:
        return None
    return _unquote(node.rest)


def get_seq(text: str, path: Sequence[str]) -> List[str]:
    lines = _lines(text)
    node = find(lines, path)
    if node is None:
        return []
    return [_unquote(item) for _f, _l, _d, item in seq_items(lines, node)]


# ── docker-compose ────────────────────────────────────────────────────────────

def _split_short_volume(item: str) -> Tuple[str, str]:
    """(source, target) of a short-syntax volume ``src:dst[:mode]``."""
    value = _unquote(item)
    # a Windows source has a drive letter: C:\x:/y
    m = re.match(r"^([A-Za-z]:[\\/][^:]*|[^:]+):([^:]+)(?::[a-z,]+)?$", value)
    if m:
        return m.group(1), m.group(2)
    return "", value


def service_info(text: str) -> List[Dict[str, object]]:
    """Each service: name, image, volumes as (source, target), whether it has
    a merge key, and whether its volumes can be edited here."""
    lines = _lines(text)
    services = find(lines, ["services"])
    if services is None:
        raise Unsupported("There's no “services:” in this file.")
    if services.rest:
        raise Unsupported("“services” is written on one line.")
    out = []
    for svc in children_of(lines, services):
        kids = children_of(lines, svc)
        image = next((_unquote(k.rest) for k in kids if k.key == "image"), "")
        vols_node = next((k for k in kids if k.key == "volumes"), None)
        volumes: List[Tuple[str, str]] = []
        problem = None
        if vols_node is not None:
            try:
                for first, _last, dash, item in seq_items(lines, vols_node):
                    if ":" in item and not re.match(r"^(type|source|target|read_only|bind|volume)\s*:", item):
                        volumes.append(_split_short_volume(item))
                    else:
                        # long syntax: read source/target from the item's lines
                        src = tgt = ""
                        j = first
                        while j < len(lines) and (j == first or lines[j].indent > dash or lines[j].blank):
                            c = lines[j].content[2:] if j == first else lines[j].content
                            m = _KEY.match(c) if c else None
                            if m:
                                k = _unquote(m.group("key"))
                                if k == "source":
                                    src = _unquote(m.group("rest") or "")
                                elif k == "target":
                                    tgt = _unquote(m.group("rest") or "")
                            j += 1
                            if j >= vols_node.end:
                                break
                        volumes.append((src, tgt))
            except Unsupported as exc:
                problem = str(exc)
        env = next((k for k in kids if k.key == "environment"), None)
        out.append({"name": svc.key, "image": image, "volumes": volumes,
                    "merge": any(k.key == "<<" for k in kids), "problem": problem,
                    "has_volumes": vols_node is not None, "has_env": env is not None})
    return out


def _role(svc: Dict[str, object]) -> Optional[str]:
    name = str(svc["name"]).lower()
    image = str(svc["image"]).lower()
    targets = [t for _s, t in svc["volumes"]]  # type: ignore[misc]
    if "slskd" in image or name == "slskd":
        return "slskd"
    for media in ("plex", "jellyfin", "navidrome"):
        if media in image or name == media:
            return media
    if "soulsync" in image or "synchros" in image or any(t in MUSIC_TARGETS for t in targets):
        return "synchros"
    return None


def plan(text: str, platform: str) -> Dict[str, object]:
    """What would change: per service, the lines to add. Never edits."""
    mounts = DRIVE_MOUNTS.get(platform)
    if not mounts:
        raise Unsupported(f"This helper doesn't know {platform}.")
    services = service_info(text)
    app = next((s for s in services if _role(s) == "synchros"), None)
    if app is None:
        raise Unsupported("No service in this file mounts SYNCHRO.S's music folders (/app/Transfer, "
                          "/app/downloads or /app/Staging).")
    music_sources = {src for src, tgt in app["volumes"] if tgt in MUSIC_TARGETS and src}  # type: ignore[misc]
    changes = []
    missing_media = []
    slskd_config_source = None
    for svc in services:
        role = _role(svc)
        shares_music = any(src in music_sources for src, _t in svc["volumes"])  # type: ignore[misc]
        if role is None and not shares_music:
            continue
        if role == "slskd":
            for src, tgt in svc["volumes"]:  # type: ignore[misc]
                if tgt.rstrip("/") == "/app" and src:
                    slskd_config_source = src
        have_targets = {tgt for _s, tgt in svc["volumes"]}  # type: ignore[misc]
        add = [m for m in mounts if m.split(":")[-1] not in have_targets]
        changes.append({"service": svc["name"], "role": role or "music", "add": add,
                        "problem": svc["problem"] or (
                            "its keys come from a YAML merge (<<:)" if svc["merge"] and not svc["has_volumes"] else None)})
    # the slskd config folder goes to SYNCHRO.S once slskd's /app source is known
    if slskd_config_source is None:
        for svc in services:
            if _role(svc) == "slskd":
                for src, tgt in svc["volumes"]:  # type: ignore[misc]
                    if tgt.rstrip("/") == "/app" and src:
                        slskd_config_source = src
    if slskd_config_source:
        app_change = next(c for c in changes if c["service"] == app["name"])
        have = {tgt for _s, tgt in app["volumes"]}  # type: ignore[misc]
        if SLSKD_CONFIG_TARGET not in have:
            app_change["add"].append(f"{slskd_config_source}:{SLSKD_CONFIG_TARGET}")
    roles = {_role(s) for s in services}
    for media in ("plex", "jellyfin", "navidrome"):
        if media not in roles:
            missing_media.append(media)
    return {"app": app["name"], "changes": changes, "slskd_config": slskd_config_source,
            "has_slskd": "slskd" in roles, "missing_media": missing_media,
            "nothing_to_do": all(not c["add"] for c in changes)}


def apply(text: str, the_plan: Dict[str, object]) -> str:
    """``text`` with the plan's lines added (only insertions)."""
    out = text
    for change in the_plan["changes"]:  # type: ignore[union-attr]
        if change["problem"] and change["add"]:
            raise Unsupported(f"“{change['service']}”: {change['problem']}.")
        for line in change["add"]:
            out = add_seq_item(out, ["services", change["service"], "volumes"], scalar(line))
    return out


def diff_lines(before: str, after: str) -> List[str]:
    """The new file with "+ " before each added line (the context the person sees)."""
    old = before.splitlines()
    new = after.splitlines()
    out = []
    i = 0
    for line in new:
        if i < len(old) and old[i] == line:
            out.append("  " + line)
            i += 1
        else:
            out.append("+ " + line)
    return out


# ── host hints (--names) ──────────────────────────────────────────────────────

def _bind_source(src: str, compose_dir: str) -> Optional[str]:
    """A bind mount's source as a path on this computer, or None (a named
    volume lives inside Docker; ${VAR} comes from an .env this tool doesn't read)."""
    if not src or not src.startswith(("/", "./", "../", "~", ".")) or "$" in src:
        return None
    return os.path.normpath(os.path.join(compose_dir, os.path.expanduser(src)))


def _app_service(text: str) -> Dict[str, object]:
    app = next((s for s in service_info(text) if _role(s) == "synchros"), None)
    if app is None:
        raise Unsupported("No service in this file mounts SYNCHRO.S's music folders (/app/Transfer, "
                          "/app/downloads or /app/Staging).")
    return app


def _app_volumes(text: str, extra: Sequence[str] = ()) -> List[Tuple[str, str]]:
    """SYNCHRO.S's service's volumes as (source, target), with the same
    service in ``extra`` (docker-compose.override.yml, COMPOSE_FILE's other
    files) applied on top the way Compose merges them: by target, the later
    file winning. An extra file this tool can't read is left out."""
    app = _app_service(text)
    merged: Dict[str, str] = {}
    for src, tgt in app["volumes"]:  # type: ignore[misc]
        merged[tgt.rstrip("/") or tgt] = src
    for more in extra:
        try:
            svc = next((s for s in service_info(more) if s["name"] == app["name"]), None)
        except Unsupported:
            continue
        for src, tgt in (svc or {}).get("volumes") or []:  # type: ignore[union-attr]
            merged[tgt.rstrip("/") or tgt] = src
    return [(src, tgt) for tgt, src in merged.items()]


def music_mounts(text: str, compose_dir: str, extra: Sequence[str] = ()) -> List[Dict[str, str]]:
    """SYNCHRO.S's music folders as this computer names them: one dict per
    bind mount onto a music target (target, label, source as written, host
    path), or with ``problem`` when the source can't be resolved here."""
    out = []
    for src, tgt in _app_volumes(text, extra):
        target = tgt.rstrip("/")
        if target not in MUSIC_TARGETS:
            continue
        item = {"target": target, "label": MUSIC_LABELS[target], "source": src}
        host = _bind_source(src, compose_dir)
        if host is None:
            item["problem"] = "isn't a folder on this computer the helper can name"
        else:
            item["host_path"] = host
        out.append(item)
    return sorted(out, key=lambda m: MUSIC_TARGETS.index(m["target"]))


def config_folder(text: str, compose_dir: str, extra: Sequence[str] = ()) -> Optional[str]:
    """Where SYNCHRO.S's settings folder (/app/config) is on this computer,
    from its mount; None when the files don't bind-mount it."""
    for src, tgt in _app_volumes(text, extra):
        if tgt.rstrip("/") == CONFIG_TARGET:
            return _bind_source(src, compose_dir)
    return None


# ── one folder's entry: the checks SYNCHRO.S applies too ─────────────────────

ENTRY_KEYS = ("host_path", "volume", "os", "target", "written_at")
ENTRY_OS = ("mac", "linux")
#: control, line-separator and direction characters never go into a name shown on a page
_UNSAFE_TEXT = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]")
_MAX_PATH = 1024
_MAX_VOLUME = 255


def clean_path(value: object) -> Optional[str]:
    """A plain absolute POSIX path (no ``.``/``..`` parts, no ``//`` start,
    no control or direction characters), normalised; else None."""
    if not isinstance(value, str) or not value or len(value) > _MAX_PATH or _UNSAFE_TEXT.search(value):
        return None
    if not value.startswith("/") or value.startswith("//"):
        return None
    parts = value.split("/")
    if any(p in (".", "..") for p in parts):
        return None
    return "/" + "/".join(p for p in parts if p)


def clean_volume(value: object) -> Optional[str]:
    if not isinstance(value, str) or _UNSAFE_TEXT.search(value):
        return None
    text = value.strip()
    if not text or len(text) > _MAX_VOLUME or "/" in text:
        return None
    return text


def clean_entry(data: object) -> Optional[Dict[str, object]]:
    """One folder's entry in host-paths.json when it is exactly the schema,
    else None. The helper checks what it writes (and what it keeps) with
    this, and SYNCHRO.S checks what it reads with it, so the two agree."""
    if not isinstance(data, dict) or set(data) != set(ENTRY_KEYS):
        return None
    host_path, target = clean_path(data["host_path"]), clean_path(data["target"])
    volume = clean_volume(data["volume"])
    written_at = data["written_at"]
    if host_path is None or target is None or volume is None or data["os"] not in ENTRY_OS:
        return None
    if type(written_at) is not int or written_at <= 0:
        return None
    return {"host_path": host_path, "volume": volume, "os": data["os"], "target": target,
            "written_at": written_at}


def _read_small(path: str, cap: int) -> Optional[bytes]:
    """A regular file's bytes, read without following a link; None otherwise."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > cap:
            return None
        raw = b""
        while len(raw) <= cap:
            chunk = os.read(fd, cap + 1 - len(raw))
            if not chunk:
                break
            raw += chunk
        return None if len(raw) > cap else raw
    except OSError:
        return None
    finally:
        os.close(fd)


def _read_marker_id(folder: str) -> Optional[str]:
    """The id in the marker SYNCHRO.S keeps at ``folder``, read without
    following a link; None when there's none (or it has no id yet)."""
    raw = _read_small(os.path.join(folder, MARKER_NAME), _SMALL)
    try:
        data = json.loads(raw.decode("utf-8")) if raw is not None else None
    except (UnicodeDecodeError, ValueError):
        return None
    value = data.get("id") if isinstance(data, dict) else None
    return value if isinstance(value, str) and _MARKER_ID.match(value) else None


#: how many entries of a mount's root the helper looks through for a marker one level down
_SUBFOLDER_CAP = 2000


def marked_folders(root: str, target: str) -> List[Tuple[str, str, str]]:
    """The folders SYNCHRO.S marked at a music mount: the mount's root, or
    else its folders one level down (SYNCHRO.S's setting can point inside the
    mount), as (path here, path inside SYNCHRO.S, marker id). Links aren't
    followed."""
    found = _read_marker_id(root)
    if found:
        return [(root, target, found)]
    out = []
    try:
        with os.scandir(root) as entries:
            for i, entry in enumerate(entries):
                if i >= _SUBFOLDER_CAP:
                    break
                try:
                    if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                marker = _read_marker_id(entry.path)
                if marker:
                    out.append((entry.path, target.rstrip("/") + "/" + entry.name, marker))
    except OSError:
        return []
    return sorted(out)


def volume_name(path: str, platform: str) -> str:
    """What this computer calls the disk ``path`` is on: the drive's name
    under /Volumes, else (on a Mac) what ``diskutil`` says, "Macintosh HD"
    when it can't; on Linux the mount point's name, or "this computer's disk"
    for the root."""
    if platform == "mac":
        parts = path.split("/")
        if len(parts) > 2 and parts[1] == "Volumes" and parts[2]:
            return parts[2]
        try:
            proc = subprocess.run(["diskutil", "info", "-plist", path], stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, timeout=10)
            if proc.returncode == 0:
                name = plistlib.loads(proc.stdout).get("VolumeName")
                if isinstance(name, str) and name.strip():
                    name = name.strip()
                    # the system's data volume is "Macintosh HD - Data"; Finder says "Macintosh HD"
                    return name[: -len(" - Data")] if name.endswith(" - Data") else name
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        return "Macintosh HD"
    probe = path
    while probe and probe != "/" and not os.path.ismount(probe):
        probe = os.path.dirname(probe)
    if not probe or probe == "/":
        return "this computer's disk"
    return os.path.basename(probe) or "this computer's disk"


def _existing_entries(path: str) -> Tuple[Dict[str, Dict[str, object]], int]:
    """The entries already in the hints file that still pass ``clean_entry``
    (kept for folders this run doesn't name, such as a move's old folders),
    and how many were dropped for failing it."""
    raw = _read_small(path, HINTS_MAX_BYTES)
    try:
        data = json.loads(raw.decode("utf-8")) if raw is not None else None
    except (UnicodeDecodeError, ValueError):
        return {}, 0
    folders = data.get("folders") if isinstance(data, dict) and data.get("v") == HINT_VERSION else None
    if not isinstance(folders, dict):
        return {}, 0
    keep, dropped = {}, 0
    for key, value in folders.items():
        entry = clean_entry(value)
        if isinstance(key, str) and _MARKER_ID.match(key) and entry is not None:
            keep[key] = entry
        else:
            dropped += 1
    return keep, dropped


def remove_stale_temp(config: str) -> int:
    """Delete ``host-paths.json.*.tmp`` an interrupted run left in the
    settings folder (a file or a link, never what a link points at)."""
    gone = 0
    try:
        names = os.listdir(config)
    except OSError:
        return 0
    for name in names:
        if not (name.startswith(HINTS_NAME + ".") and name.endswith(".tmp")):
            continue
        path = os.path.join(config, name)
        try:
            st = os.lstat(path)
            if stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
                os.unlink(path)
                gone += 1
        except OSError:
            continue
    return gone


def settings_owner(config: str) -> Optional[Tuple[int, int]]:
    """Who owns SYNCHRO.S's settings (config.json when it's there, else the
    folder): SYNCHRO.S runs as that user (PUID), so it must be able to read
    the hints file."""
    for path in (os.path.join(config, "config.json"), config):
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode):
            return st.st_uid, st.st_gid
    return None


def hints_file_access(config: str) -> Tuple[Optional[Tuple[int, int]], int]:
    """(owner to set, mode) for host-paths.json in ``config``. Run as root
    (``sudo sh drives-helper.sh``), the file is given to the settings' owner;
    then, or when this user already is that owner, 0640 (SYNCHRO.S reads it
    as its owner); otherwise 0644, so SYNCHRO.S running as another user can
    still read it (config.json is no tighter)."""
    want = settings_owner(config)
    euid = os.geteuid() if hasattr(os, "geteuid") else None
    if want is not None and euid == 0:
        return want, 0o640
    if want is not None and euid == want[0]:
        return None, 0o640
    return None, 0o644


def write_hints_file(path: str, entries: Dict[str, Dict[str, object]]) -> None:
    """``path`` (host-paths.json), atomically: a new, uniquely named file
    (``mkstemp`` opens it with O_EXCL, so a link planted at the name is never
    followed), then renamed over the old one (a rename replaces a link rather
    than writing through it), owned and moded so SYNCHRO.S can read it
    (``hints_file_access``). A failed write deletes its temporary file."""
    st = None
    try:
        st = os.lstat(path)
    except OSError:
        pass
    if st is not None and stat.S_ISDIR(st.st_mode):
        raise OSError(f"{HINTS_NAME} is a folder")
    newest = sorted(entries.items(), key=lambda kv: -int(kv[1].get("written_at") or 0))[:HINTS_MAX_FOLDERS]
    body = {"v": HINT_VERSION, "folders": dict(newest)}
    owner, mode = hints_file_access(os.path.dirname(path) or ".")
    _write_atomic(path, (json.dumps(body, ensure_ascii=False, indent=1) + "\n").encode("utf-8"), mode=mode,
                  prefix=HINTS_NAME + ".", owner=owner)


def remove_legacy_hint(folder: str) -> bool:
    """Delete an older helper's ``.synchros-host.json`` from a music folder
    (a file or a link, never what a link points at; a folder of that name
    stays). True when one went."""
    target = os.path.join(folder, LEGACY_HINT_NAME)
    try:
        st = os.lstat(target)
    except OSError:
        return False
    if not (stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)):
        return False
    try:
        os.unlink(target)
        return True
    except OSError:
        return False


def write_host_hints(text: str, compose_dir: str, platform: str, *, extra: Sequence[str] = (),
                     clock=time.time) -> List[Dict[str, str]]:
    """Name each music folder in SYNCHRO.S's settings folder; what happened
    to each, in words (and a last row for the file itself, or for older
    entries dropped, when there's something to say)."""
    results: List[Dict[str, str]] = []
    entries: Dict[str, Dict[str, object]] = {}
    for m in music_mounts(text, compose_dir, extra):
        label = m["label"]
        if m.get("problem"):
            results.append({"label": label, "ok": "", "words": f"{m['source']} {m['problem']}"})
            continue
        root = m["host_path"]
        if os.path.islink(root):
            results.append({"label": label, "ok": "", "words": f"{root} is a link, so it was left alone"})
            continue
        if not os.path.isdir(root):
            results.append({"label": label, "ok": "", "words": f"{root} isn't a folder here"})
            continue
        remove_legacy_hint(root)
        found = marked_folders(root, m["target"])
        if not found:
            results.append({"label": label, "ok": "",
                            "words": f"{root} isn't one of SYNCHRO.S's folders (no SYNCHRO.S marker in it or "
                                     "one level down)"})
            continue
        for folder, target, marker in found:
            remove_legacy_hint(folder)
            entry = clean_entry({"host_path": folder, "volume": volume_name(folder, platform), "os": platform,
                                 "target": target, "written_at": int(clock())})
            if entry is None:
                results.append({"label": label, "ok": "",
                                "words": f"{folder!r} or its drive's name has characters SYNCHRO.S won't show "
                                         "(a line break, a direction mark, a / in the name, or a // start)"})
                continue
            entries[marker] = entry
            results.append({"label": label, "ok": "1", "words": f"{folder} (on {entry['volume']})"})
    if not entries:
        return results
    config = config_folder(text, compose_dir, extra)
    why = None
    if config is None:
        why = f"there's no bind mount for SYNCHRO.S's settings folder ({CONFIG_TARGET}) in the file"
    elif os.path.islink(config) or not os.path.isdir(config):
        why = f"{config} isn't a folder here (or is a link)"
    else:
        path = os.path.join(config, HINTS_NAME)
        remove_stale_temp(config)
        kept, dropped = _existing_entries(path)
        try:
            write_hints_file(path, {**kept, **entries})
        except OSError as exc:
            why = f"couldn't write {path} ({exc.strerror or exc})"
        else:
            if dropped:
                results.append({"label": "Older names", "ok": "1",
                                "words": f"{dropped} that SYNCHRO.S wouldn't show were left out"})
    if why:
        for r in results:
            r["ok"] = ""
        results.append({"label": "SYNCHRO.S's settings folder", "ok": "", "words": why})
    return results


def _hints_quietly(text: str, home: str, platform: str, extra: Sequence[str] = ()) -> List[Dict[str, str]]:
    """The hints, as part of a normal run: a problem here never stops it."""
    try:
        return write_host_hints(text, home, platform, extra=extra)
    except Exception as exc:  # noqa: BLE001 - the names are a nicety
        _say(f"(Couldn't write your folders' names for SYNCHRO.S: {exc}.)")
        return []


def _extra_texts(folder: str, files: Sequence[str]) -> List[str]:
    """The text of the files Docker reads with the edited one (an override,
    COMPOSE_FILE's others); one that can't be read is left out."""
    out = []
    for name in files:
        try:
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                out.append(f.read())
        except (OSError, UnicodeDecodeError):
            continue
    return out


def _say_hints(results: List[Dict[str, str]]) -> None:
    if not results:
        return
    _say("Your folders' names on this computer, for SYNCHRO.S to show:")
    for r in results:
        _say(f"  {r['label']}: {r['words']}" if r["ok"] else f"  {r['label']}: not written: {r['words']}")


# ── the program ───────────────────────────────────────────────────────────────

def _say(msg: str = "") -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def _ask(question: str) -> bool:
    try:
        with open("/dev/tty", "r+") as tty:
            tty.write(question)
            tty.flush()
            answer = tty.readline()
    except OSError:
        sys.stdout.write(question)
        sys.stdout.flush()
        answer = sys.stdin.readline()
    return answer.strip().lower() in ("y", "yes")


def _compose_cmd() -> Optional[List[str]]:
    for cmd in (["docker", "compose"], ["docker-compose"]):
        try:
            if subprocess.run(cmd + ["version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                return cmd
        except OSError:
            continue
    return None


def _f_args(files: Sequence[str]) -> List[str]:
    out: List[str] = []
    for f in files:
        out += ["-f", f]
    return out


def _validate(cmd: List[str], folder: str, files: Sequence[str]) -> Optional[str]:
    """None when ``docker compose config`` reads the files together, else its words."""
    proc = subprocess.run(cmd + _f_args(files) + ["config", "-q"], cwd=folder, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True)
    return None if proc.returncode == 0 else (proc.stdout or "").strip()[-600:]


def _restart(cmd: List[str], folder: str, files: Optional[Sequence[str]]) -> bool:
    """``docker compose up -d``: with ``-f`` only for ``--file``; otherwise
    Docker reads its own set (the override file, ``COMPOSE_FILE``)."""
    _say("Restarting SYNCHRO.S and the services that changed (about a minute)…")
    return subprocess.run(cmd + (_f_args(files) if files else []) + ["up", "-d"], cwd=folder).returncode == 0


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_atomic(path: str, data: bytes, mode: Optional[int] = None, prefix: str = ".drives-",
                  owner: Optional[Tuple[int, int]] = None) -> None:
    """Write ``path`` through a new, uniquely named file (never through a
    link) renamed over it; ``owner`` (uid, gid) is set on the new file
    before the rename (the helper run as root)."""
    if mode is None:
        try:
            mode = os.stat(path).st_mode & 0o7777
        except OSError:
            mode = None
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=prefix, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
            if owner is not None:
                os.fchown(f.fileno(), owner[0], owner[1])
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_state(path: str) -> Dict[str, str]:
    try:
        if os.path.islink(path):
            return {}
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _compose_files(folder: str, args: List[str]) -> Tuple[Optional[str], List[str], bool]:
    """(the file to edit, the files Docker reads with it, whether to pass -f)."""
    if "--file" in args:
        name = args[args.index("--file") + 1]
        return name, [name], True
    env = os.environ.get("COMPOSE_FILE", "").strip()
    if env:
        sep = os.environ.get("COMPOSE_PATH_SEPARATOR") or os.pathsep
        files = [f for f in env.split(sep) if f.strip()]
        if files:
            return files[0], files, False
    name = next((n for n in COMPOSE_NAMES if os.path.isfile(os.path.join(folder, n))), None)
    if name is None:
        return None, [], False
    overrides = [o for o in OVERRIDE_NAMES.get(name, ()) if os.path.isfile(os.path.join(folder, o))]
    return name, [name] + overrides[:1], False


def _guess_platform() -> str:
    return "mac" if sys.platform == "darwin" else "linux"


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    undo = "--undo" in args
    dry = "--dry-run" in args
    yes = "--yes" in args
    names = "--names" in args
    platform = _guess_platform()
    if "--platform" in args:
        platform = args[args.index("--platform") + 1]
    folder = os.getcwd()
    name, files, use_f = _compose_files(folder, args)
    from_env = bool(os.environ.get("COMPOSE_FILE", "").strip()) and "--file" not in args
    if not name or not os.path.isfile(os.path.join(folder, name)):
        if from_env:
            _say(f"COMPOSE_FILE is set to {os.environ.get('COMPOSE_FILE')}, but there's no {name} in {folder}.")
            _say("Run this where those files are, or unset COMPOSE_FILE. Nothing changed.")
            return 2
        _say(f"There's no docker-compose.yml in {folder}.")
        _say("Go to the folder SYNCHRO.S was installed in (the one with docker-compose.yml), then paste again.")
        return 2
    path = os.path.join(folder, name)
    home = os.path.dirname(path)
    backup = os.path.join(home, BACKUP_NAME)
    state_path = os.path.join(home, STATE_NAME)
    restart_files = files if use_f else None
    if names and not undo:
        # only the host hints: no compose change, no Docker, no restart
        if platform not in ("mac", "linux"):
            _say(f"--names works on a Mac or Linux, not {platform}. Nothing changed.")
            return 7
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
            extra = _extra_texts(folder, files[1:])
            if dry:
                for m in music_mounts(text, home, extra):
                    _say(f"  {m['label']}: would name {m.get('host_path') or m['source']}")
                config = config_folder(text, home, extra)
                _say(f"  in {os.path.join(config, HINTS_NAME)}" if config
                     else f"  but there's no bind mount for {CONFIG_TARGET} to write them in")
                return 0
            results = write_host_hints(text, home, platform, extra=extra)
        except (Unsupported, UnicodeDecodeError) as exc:
            _say(f"The helper can't read {name}: {exc}. Nothing changed.")
            return 7
        if not results:
            _say(f"No service in {name} mounts SYNCHRO.S's music folders from this computer. Nothing changed.")
            return 0
        _say_hints(results)
        _say("Done. SYNCHRO.S shows these names within a minute." if any(r["ok"] for r in results)
             else "Nothing was written.")
        return 0 if any(r["ok"] for r in results) else 13
    cmd = None if dry else _compose_cmd()
    if not dry and cmd is None:
        _say("Docker isn't answering here. Start Docker Desktop, then paste the command again.")
        return 3

    if undo:
        if not os.path.isfile(backup) or os.path.islink(backup):
            _say(f"There's no {BACKUP_NAME} here, so there's nothing to put back.")
            return 4
        with open(backup, "rb") as f:
            original = f.read()
        with open(path, "rb") as f:
            now = f.read()
        state = _read_state(state_path)
        if state.get("file") != os.path.basename(name) or state.get("wrote") != _sha256(now):
            _say(f"{name} has changed since the helper edited it, so --undo won't put {BACKUP_NAME} back over")
            _say("those changes. Nothing changed. Compare the two files and copy back what you want by hand.")
            return 12
        if dry:
            _say(f"Would put {BACKUP_NAME} back as {name} and restart.")
            return 0
        if not yes and not _ask(f"Put {BACKUP_NAME} back as {name} and restart? (y/n) "):
            _say("Nothing changed.")
            return 1
        _write_atomic(path, original)
        for leftover in (backup, state_path):
            try:
                os.unlink(leftover)
            except OSError:
                pass
        if not _restart(cmd, folder, restart_files):
            _say(f"{name} is back as it was, but Docker couldn't restart. Run: docker compose up -d")
            return 5
        _say(f"Done. {name} is back as it was. Go back to SYNCHRO.S.")
        return 0

    with open(path, "rb") as f:
        raw = f.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        _say(f"{name} isn't plain text SYNCHRO.S can read. Nothing changed.")
        return 6
    try:
        the_plan = plan(text, platform)
        new_text = apply(text, the_plan)
    except Unsupported as exc:
        _say(f"The helper can't change {name} safely: {exc}")
        if from_env and len(files) > 1:
            _say(f"COMPOSE_FILE is set, and the helper edits only its first file ({name}).")
        _say("Nothing changed. Add the lines by hand instead (SYNCHRO.S shows them under “See the lines it adds”).")
        return 7
    if the_plan["nothing_to_do"]:
        _say(f"{name} already lets SYNCHRO.S see your drives. Nothing to change.")
        if not dry:
            _say_hints(_hints_quietly(text, home, platform, _extra_texts(folder, files[1:])))
        return 0

    _say(f"In {path}, the helper will add:")
    _say("")
    for change in the_plan["changes"]:  # type: ignore[union-attr]
        for line in change["add"]:
            _say(f"  {change['service']}:  + - {line}")
    if len(files) > 1:
        _say("")
        _say(f"Docker reads it together with {', '.join(files[1:])}; the helper checks them together.")
    missing = [m for m in the_plan["missing_media"] if m == "plex"]  # type: ignore[union-attr]
    if missing:
        _say("")
        _say("Plex isn't in this file, so it isn't changed. If Plex runs on this computer itself, it sees")
        _say("your drives already; if it runs somewhere else, add its folder by hand.")
    _say("")
    _say(f"A copy of the file as it is now is kept as {BACKUP_NAME}.")
    if dry:
        _say("")
        for line in diff_lines(text, new_text):
            if line.startswith("+ "):
                _say(line)
        return 0
    if not yes and not _ask("Go ahead? (y/n) "):
        _say("Nothing changed.")
        return 1

    data = new_text.encode("utf-8")
    fd, tmp_path = tempfile.mkstemp(dir=home, prefix=".docker-compose.drives-new.", suffix=".yml")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        tmp_rel = os.path.relpath(tmp_path, folder)
        problem = _validate(cmd, folder, [tmp_rel] + list(files[1:]))
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    if problem:
        _say("Docker didn't accept the changed file, so nothing was changed:")
        _say(problem)
        return 8
    # this run's "before", and a fingerprint of what it writes, so --undo can
    # tell whether the file was edited since
    _write_atomic(backup, raw, mode=0o644)
    _write_atomic(state_path, json.dumps({"file": os.path.basename(name), "wrote": _sha256(data)}).encode("utf-8"),
                  mode=0o644)
    _write_atomic(path, data)
    _say(f"Changed {path}")
    _say_hints(_hints_quietly(text, home, platform, _extra_texts(folder, files[1:])))
    if not _restart(cmd, folder, restart_files):
        _say("The file is changed, but Docker couldn't restart. Run: docker compose up -d")
        _say("To undo: sh drives-helper.sh --undo")
        return 9
    _say("Done. Go back to SYNCHRO.S.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
