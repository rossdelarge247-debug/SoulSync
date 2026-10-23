"""Every path a person picks or types for the drive move, checked.

A target folder must:

* be an absolute path of printable characters, with no ``..`` part;
* resolve (with every link that exists along it followed) to a place under
  one of the drives folders, and below the drive itself, never the drives
  folder;
* not reach outside its drive through a link (the resolved path is compared,
  not the typed one);
* not be inside SYNCHRO.S's own code, data, config or log folders, and not
  inside (or around) one of the folders being moved.

:func:`validate_target` answers the resolved path or raises
:class:`PathRefused` with a sentence a person can act on.
"""

from __future__ import annotations

import os
from typing import Iterable, List, Optional, Sequence

MAX_LENGTH = 1024


class PathRefused(ValueError):
    """A path that can't be used; ``str(exc)`` is the sentence to show."""


def _inside(path: str, root: str) -> bool:
    path = os.path.normpath(path)
    root = os.path.normpath(root)
    if path == root:
        return True
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def resolve_existing(path: str) -> str:
    """``path`` with every existing part resolved (links followed) and the
    parts that don't exist yet joined on unchanged."""
    path = os.path.normpath(path)
    missing: List[str] = []
    probe = path
    while not os.path.lexists(probe):
        parent, name = os.path.split(probe)
        if parent == probe:
            break
        missing.append(name)
        probe = parent
    real = os.path.realpath(probe)
    for name in reversed(missing):
        real = os.path.join(real, name)
    return real


def protected_folders(extra: Iterable[str] = ()) -> List[str]:
    """SYNCHRO.S's own folders: the code, the config and database folders,
    the logs, the container's data folder."""
    out = set()
    try:
        from core.settings import config_manager
        out.add(str(config_manager.config_path.parent))
        out.add(str(config_manager.database_path.parent))
        out.add(str(config_manager.base_dir))
    except Exception:  # noqa: BLE001,S110 - tests run without a config manager
        pass
    for p in ("/app/data", "/app/config", "/app/logs", "/app/database"):
        out.add(p)
    for p in extra:
        if p:
            out.add(p)
    return sorted(os.path.realpath(p) for p in out if p)


def validate_target(raw: object, *, roots: Sequence[str], protected: Iterable[str] = (),
                    moving: Iterable[str] = ()) -> str:
    """The resolved target folder for ``raw``, or :class:`PathRefused`."""
    if not isinstance(raw, str) or not raw.strip():
        raise PathRefused("Choose a folder on the drive.")
    text = raw.strip()
    if len(text) > MAX_LENGTH:
        raise PathRefused("That folder's path is too long.")
    if any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise PathRefused("That folder's name has characters SYNCHRO.S can't use.")
    if not text.startswith("/"):
        raise PathRefused("Write the folder's full path, starting with /.")
    parts = [p for p in text.split("/") if p]
    if any(p in ("..", ".") for p in parts):
        raise PathRefused("Write the folder's path without “..” in it.")
    if not roots:
        raise PathRefused("SYNCHRO.S can't see any drives yet.")
    resolved = resolve_existing(text)
    real_roots = [os.path.realpath(r) for r in roots]
    root = next((r for r in real_roots if _inside(resolved, r)), None)
    if root is None:
        raise PathRefused("That folder isn't on a drive SYNCHRO.S can see. Pick one of the drives above.")
    rel = os.path.relpath(resolved, root)
    if rel in (".", ""):
        raise PathRefused("Choose a drive, then a folder on it.")
    # the typed path must lead to the same drive it resolves to: a link that
    # jumps from one drive to another (or out of the drives folder) is refused
    typed_root = next((r for r in roots if _inside(os.path.normpath(text), os.path.normpath(r))), None)
    if typed_root is None or os.path.realpath(typed_root) != root:
        raise PathRefused("That folder leads somewhere else through a link. Choose the folder itself.")
    typed_drive = os.path.normpath(text)[len(os.path.normpath(typed_root)):].strip("/").split("/")[0]
    if os.path.realpath(os.path.join(typed_root, typed_drive)) != os.path.join(root, rel.split(os.sep)[0]):
        raise PathRefused("That folder leads somewhere else through a link. Choose the folder itself.")
    for p in protected:
        if _inside(resolved, p) or _inside(p, resolved):
            raise PathRefused("That's where SYNCHRO.S keeps its own files. Choose another folder.")
    for p in moving:
        if not p:
            continue
        real = os.path.realpath(p)
        if _inside(resolved, real):
            raise PathRefused("That folder is inside one of the folders being moved. Choose a folder outside them.")
        if _inside(real, resolved):
            raise PathRefused("One of the folders being moved is inside that folder. Choose another.")
    return resolved


def within(path: str, root: str) -> bool:
    """Whether ``path`` (resolved) is ``root`` or under it (resolved)."""
    return _inside(os.path.realpath(path), os.path.realpath(root))


def safe_join(root: str, rel: str) -> Optional[str]:
    """``root/rel`` when ``rel`` is a plain relative path that stays under
    ``root`` (no absolute part, no ``..``); else None."""
    if not rel or rel.startswith("/") or "\x00" in rel:
        return None
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    joined = os.path.join(root, *parts)
    if not _inside(os.path.normpath(joined), os.path.normpath(root)):
        return None
    return joined


__all__ = ["PathRefused", "protected_folders", "resolve_existing", "safe_join", "validate_target", "within"]
