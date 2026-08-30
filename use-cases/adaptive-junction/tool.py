"""
Tools the junction_advisor agent can call.

Note: we never let the LLM make up green-light numbers itself - all the
actual math comes from Person 1's compute_timing_plan(). These functions
just wrap that and handle reading/writing session state.

Session keys used: junction.counts, junction.last_plan, junction.junction_name
"""
from __future__ import annotations

import json
from typing import Any, Optional

from models import LatestCounts
from pipeline import compute_timing_plan

SESSION_COUNTS_KEY = "junction.counts"
SESSION_PLAN_KEY = "junction.last_plan"
SESSION_NAME_KEY = "junction.junction_name"

_FALLBACK: dict[str, Any] = {}


def _cache():
    try:
        from agentkernel.core import ToolContext

        return ToolContext.get().session.get_non_volatile_cache()
    except Exception:
        return None


def _get(key: str, default: Any = None) -> Any:
    cache = _cache()
    if cache is not None:
        return cache.get(key, default)
    return _FALLBACK.get(key, default)


def _set(key: str, value: Any) -> None:
    cache = _cache()
    if cache is not None:
        cache.set(key, value)
    else:
        _FALLBACK[key] = value


def _counts_from_session() -> LatestCounts:
    raw = _get(SESSION_COUNTS_KEY) or {}
    if isinstance(raw, LatestCounts):
        return raw
    return LatestCounts(**{k: v for k, v in raw.items() if k in LatestCounts.model_fields})


def record_queue_counts(
    north: int = 0,
    east: int = 0,
    west: int = 0,
    south: int = 0,
    north_right: Optional[int] = None,
    east_right: Optional[int] = None,
    west_right: Optional[int] = None,
    south_right: Optional[int] = None,
    junction_name: str = "demo-junction",
) -> str:
    # Stash whatever counts the operator just told us, so the next tool
    # call (compute_junction_plan) has something to work with.
    payload = {
        "north": int(north),
        "east": int(east),
        "west": int(west),
        "south": int(south),
        "north_right": north_right,
        "east_right": east_right,
        "west_right": west_right,
        "south_right": south_right,
    }
    _set(SESSION_COUNTS_KEY, payload)
    _set(SESSION_NAME_KEY, junction_name)
    return json.dumps({"stored": payload, "junction": junction_name})


def compute_junction_plan() -> str:
    # Pulls the counts we stored earlier and runs them through the real
    # allocator. Not something the model calculates itself - it just reports
    # what compute_timing_plan() returns.
    counts = _counts_from_session()
    plan = compute_timing_plan(counts)
    plan_dict = plan.model_dump()
    _set(SESSION_PLAN_KEY, plan_dict)

    try:
        import junction_runtime

        junction_runtime.run_plan_from_counts(counts, trigger="slack_or_cli")
    except Exception:
        pass

    return json.dumps(plan_dict)


def get_current_plan() -> str:
    # Just hands back whatever plan we computed last, if there is one.
    plan = _get(SESSION_PLAN_KEY)
    if not plan:
        return json.dumps({"error": "no plan yet - call record_queue_counts then compute_junction_plan"})
    return json.dumps(plan)


def get_junction_status() -> str:
    # Once Person 5's runtime is merged in, this gives a live snapshot of
    # which light is on. Until then it just says so.
    try:
        import junction_runtime

        snap = junction_runtime.engine.snapshot()
        return snap.model_dump_json()
    except Exception:
        return json.dumps({"status": "runtime not wired", "hint": "merge folder 5 then restart server.py"})


def get_plan_history(limit: int = 5) -> str:
    # Pulls the last few plans out of the database (Person 3's table) so we
    # can answer 'what happened before'. Falls back to session memory if
    # the DB isn't available for some reason.
    try:
        from database import SessionLocal
        import persistence as store

        db = SessionLocal()
        try:
            rows = store.recent_plans(db, limit=limit)
            return json.dumps(
                [
                    {
                        "id": r.id,
                        "north_straight": r.north_straight,
                        "east_straight": r.east_straight,
                        "west_straight": r.west_straight,
                        "south_straight": r.south_straight,
                        "reason": r.reason,
                        "applied_at": r.applied_at.isoformat() if r.applied_at else None,
                    }
                    for r in rows
                ]
            )
        finally:
            db.close()
    except Exception:
        return json.dumps({"session_last_plan": _get(SESSION_PLAN_KEY), "db": "unavailable"})
