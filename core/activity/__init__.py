"""The Activity feed: one time-ordered list of what SoulSync did and what needs you.

``feed`` merges the histories that are already recorded (library history,
auto-import, download batches, playlist mirror runs, automation runs) with the
preview-then-confirm outcomes ``safety_log`` records. ``GET /api/activity``
(api/activity.py) serves it.
"""
