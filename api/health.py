"""GET /api/health - liveness for the Docker HEALTHCHECK and uptime monitors.

The healthcheck used to fetch "/", rendering the whole 1 MB page shell every
30 seconds. This answers from the app without touching the template, and runs
one trivial query so a database the app can no longer open reads as unhealthy.

It is open (every session gate lets it through, see core/security) and says
nothing beyond up or down: no version, paths, error text or service list.
"""

from __future__ import annotations

from contextlib import closing
from typing import Callable

from flask import Blueprint, jsonify

from utils.logging_config import get_logger

logger = get_logger("api.health")

HEALTH_PATH = "/api/health"


def database_responds(get_database: Callable) -> bool:
    try:
        with closing(get_database()._get_connection()) as conn:
            conn.execute("SELECT 1").fetchone()
        return True
    except Exception as exc:
        logger.warning("health check: database did not respond: %s", exc)
        return False


def create_blueprint(*, get_database: Callable) -> Blueprint:
    bp = Blueprint("health", __name__)

    @bp.route(HEALTH_PATH, methods=["GET"])
    def health():
        ok = database_responds(get_database)
        response = jsonify({"status": "ok" if ok else "unavailable"})
        response.status_code = 200 if ok else 503
        response.headers["Cache-Control"] = "no-store"
        return response

    return bp


__all__ = ["HEALTH_PATH", "create_blueprint", "database_responds"]
