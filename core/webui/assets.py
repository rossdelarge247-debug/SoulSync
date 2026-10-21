"""WebUI Vite asset helpers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

from utils.logging_config import get_logger as _create_logger

logger = _create_logger("webui.assets")

DEFAULT_WEBUI_VITE_ENTRY = "src/app/main.tsx"
DEFAULT_WEBUI_VITE_BASE = "/static/dist/"
DEFAULT_WEBUI_VITE_DEV_URL = "http://127.0.0.1:5173"
DEFAULT_WEBUI_VITE_DEV_ENV = "SOULSYNC_WEBUI_VITE_DEV"
DEFAULT_WEBUI_VITE_URL_ENV = "SOULSYNC_WEBUI_VITE_URL"

_MANIFEST_CACHE: dict[str, tuple[float | None, dict[str, Any]]] = {}


def get_webui_vite_manifest_path() -> Path:
    """Return the generated Vite manifest path inside the repo."""
    return Path(__file__).resolve().parents[2] / "webui" / "static" / "dist" / ".vite" / "manifest.json"


def clear_webui_vite_manifest_cache() -> None:
    """Clear the in-process manifest cache. Primarily useful for tests."""
    _MANIFEST_CACHE.clear()


def default_static_url_builder(filename: str) -> str:
    """Build a Flask-style static URL without requiring Flask imports."""
    return f"/static/{filename.lstrip('/')}"


def _env_truthy(value: str | None) -> bool:
    return (value or "").lower() in {"1", "true", "yes", "on"}


def _resolve_dev_mode(dev: bool | None) -> bool:
    if dev is not None:
        return bool(dev)
    return _env_truthy(os.environ.get(DEFAULT_WEBUI_VITE_DEV_ENV))


def _resolve_dev_url(dev_url: str | None) -> str:
    if dev_url:
        return dev_url.rstrip("/")
    return os.environ.get(DEFAULT_WEBUI_VITE_URL_ENV, DEFAULT_WEBUI_VITE_DEV_URL).rstrip("/")


def load_webui_vite_manifest(manifest_path: str | Path | None = None) -> dict[str, Any]:
    """Load and cache the generated Vite manifest."""
    path = Path(manifest_path) if manifest_path else get_webui_vite_manifest_path()
    cache_key = str(path)
    manifest_mtime = None
    if path.exists():
        try:
            manifest_mtime = path.stat().st_mtime
        except OSError:
            manifest_mtime = None

    cached = _MANIFEST_CACHE.get(cache_key)
    if cached and cached[0] == manifest_mtime:
        return cached[1]

    if path.exists():
        try:
            with path.open("r", encoding="utf-8") as handle:
                manifest = json.load(handle)
        except Exception as exc:
            logger.warning("Failed to load webui manifest: %s", exc)
            manifest = {}
    else:
        manifest = {}

    _MANIFEST_CACHE[cache_key] = (manifest_mtime, manifest)
    return manifest


def build_webui_vite_assets(
    placement: str = "body",
    *,
    dev: bool | None = None,
    dev_url: str | None = None,
    entry: str = DEFAULT_WEBUI_VITE_ENTRY,
    manifest_path: str | Path | None = None,
    manifest_loader: Callable[[], dict[str, Any]] | None = None,
    static_url_builder: Callable[[str], str] | None = None,
) -> str:
    """Return HTML tags for the WebUI bundle or dev client."""
    if placement not in ("head", "body"):
        return ""

    dev_mode = _resolve_dev_mode(dev)
    vite_url = _resolve_dev_url(dev_url)
    static_url = static_url_builder or default_static_url_builder

    if dev_mode:
        if placement == "head":
            return ""
        base = DEFAULT_WEBUI_VITE_BASE.rstrip("/")
        return "\n".join([
            f'<script type="module" src="{vite_url}{base}/@vite/client"></script>',
            f'<script type="module" src="{vite_url}{base}/{entry.lstrip("/")}"></script>',
        ])

    loader = manifest_loader or (lambda: load_webui_vite_manifest(manifest_path))
    manifest = loader()
    entry_meta = manifest.get(entry)
    if not entry_meta:
        return ""

    if placement == "head":
        chunk_files, css_files = _collect_static_imports(manifest, entry)
        tags = [
            f'<link rel="stylesheet" href="{static_url(f"dist/{css_file}")}">'
            for css_file in css_files
        ]
        # the entry imports these shared chunks statically; preloading them
        # here saves a round trip per level of the import graph
        tags.extend(
            f'<link rel="modulepreload" href="{static_url(f"dist/{chunk_file}")}">'
            for chunk_file in chunk_files
        )
        return "\n".join(tags)

    entry_file = entry_meta.get("file")
    if not entry_file:
        return ""

    return f'<script type="module" src="{static_url(f"dist/{entry_file}")}"></script>'


def _collect_static_imports(manifest: dict[str, Any], entry: str) -> tuple[list[str], list[str]]:
    """The chunk files the entry statically imports (transitively, entry
    excluded) and the CSS of the entry and all of those chunks, without
    duplicates. CSS comes dependencies first, as Vite orders it in the HTML it
    generates itself, so the entry's own rules still win the cascade.

    With route code splitting the entry is no longer the only chunk loaded up
    front. Route chunks (``dynamicImports``) are left out: the router loads them,
    and their CSS, when a route needs them.
    """
    chunk_files: list[str] = []
    css_files: list[str] = []
    seen: set[str] = set()

    def visit(key: str) -> None:
        if key in seen:
            return
        seen.add(key)
        meta = manifest.get(key)
        if not isinstance(meta, dict):
            return
        if key != entry and meta.get("file") and meta["file"] not in chunk_files:
            chunk_files.append(meta["file"])
        for imported in meta.get("imports", []):
            visit(imported)
        for css_file in meta.get("css", []):
            if css_file not in css_files:
                css_files.append(css_file)

    visit(entry)
    return chunk_files, css_files
