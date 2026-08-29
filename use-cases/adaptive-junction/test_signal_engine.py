"""Signal engine tests. Adds sibling folder 1 to the path for models.py."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_FOLDER_1 = Path(__file__).resolve().parent.parent / "1"
sys.path.insert(0, str(_FOLDER_1))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from models import SideTiming, TimingPlanPayload
from signal_engine import CYCLE_ORDER, SignalEngine


@pytest.mark.asyncio
async def test_north_green_east_red_at_start() -> None:
    plan = TimingPlanPayload(
        north=SideTiming(straight_s=40, right_s=10),
        east=SideTiming(straight_s=30, right_s=8),
        west=SideTiming(straight_s=25, right_s=6),
        south=SideTiming(straight_s=20, right_s=5),
        reason="test",
    )
    eng = SignalEngine(timings=plan)
    snap = eng.snapshot()
    assert snap.active_side == "north"
    assert snap.sides["north"].lamps.straight == "green"
    assert snap.sides["north"].lamps.right == "green"
    assert snap.sides["east"].lamps.straight == "red"


@pytest.mark.asyncio
async def test_right_goes_red_while_straight_stays_green() -> None:
    plan = TimingPlanPayload(
        north=SideTiming(straight_s=40, right_s=10),
        east=SideTiming(straight_s=30, right_s=8),
        west=SideTiming(straight_s=25, right_s=6),
        south=SideTiming(straight_s=20, right_s=5),
        reason="test",
    )
    eng = SignalEngine(timings=plan)
    await eng.tick(12.0)
    snap = eng.snapshot()
    assert snap.sides["north"].lamps.straight == "green"
    assert snap.sides["north"].lamps.right == "red"


def test_cycle_order() -> None:
    assert CYCLE_ORDER == ["north", "east", "west", "south"]
