"""Gunicorn server hooks for SoulSync (gunicorn.conf.py, gunicorn.dev.conf.py).

Under gunicorn the worker owns SIGINT/SIGTERM: web_server installs no signal
handlers of its own there, so the app's shutdown (stop workers, save state)
runs from these hooks instead.

- ``post_worker_init`` starts a watcher that begins the shutdown as soon as
  the worker is told to stop. Waiting for the exit alone is not enough: an
  open Socket.IO connection keeps the worker draining until
  ``graceful_timeout``, and the master then kills it mid-cleanup.
- ``worker_exit`` runs the shutdown as the worker exits, or waits for the one
  the watcher started, so the process never exits halfway through it.
"""

from __future__ import annotations

import os
import sys
import threading
import time

_STOP_POLL_SECONDS = 0.5


def _shutdown_app(worker) -> None:
    # Never import web_server here: only a worker that loaded the app has
    # anything to stop. The worker_exit hook also runs in the master when it
    # reaps a worker, which the pid check skips.
    web_server = sys.modules.get("web_server")
    if web_server is None or worker.pid != os.getpid():
        return
    web_server.shutdown_runtime_services()


def post_worker_init(worker) -> None:
    def watch_for_stop():
        while worker.alive:
            time.sleep(_STOP_POLL_SECONDS)
        _shutdown_app(worker)

    threading.Thread(
        target=watch_for_stop, name="soulsync-shutdown-watch", daemon=True
    ).start()


def worker_exit(server, worker) -> None:
    _shutdown_app(worker)
