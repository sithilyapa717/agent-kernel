# Quick sanity checks for the tools. Doesn't touch OpenAI at all - just
# makes sure the numbers match what the pipeline actually computes.
from __future__ import annotations

import json
import sys
from pathlib import Path

_FOLDER_1 = Path(__file__).resolve().parent.parent / "1"
sys.path.insert(0, str(_FOLDER_1))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pipeline import compute_timing_plan
from models import LatestCounts
import tool as tools


def test_record_and_compute_matches_pipeline() -> None:
    tools._FALLBACK.clear()
    tools.record_queue_counts(north=30, east=2, west=2, south=2, north_right=6)
    raw = json.loads(tools.compute_junction_plan())
    expected = compute_timing_plan(LatestCounts(north=30, east=2, west=2, south=2, north_right=6))
    assert raw["north"]["straight_s"] == expected.north.straight_s
    assert raw["north"]["straight_s"] > raw["east"]["straight_s"]
    assert "N" in raw["reason"]


def test_get_current_plan_after_compute() -> None:
    tools._FALLBACK.clear()
    tools.record_queue_counts(north=15, east=2, west=1, south=4)
    tools.compute_junction_plan()
    current = json.loads(tools.get_current_plan())
    assert "north" in current
    assert current["reason"]


def test_status_without_runtime() -> None:
    status = json.loads(tools.get_junction_status())
    assert status.get("status") == "runtime not wired" or "active_side" in status
