"""Pipeline tests — Person 1 only (no signal engine, no LLM)."""
from __future__ import annotations

from models import LatestCounts
from pipeline import (
    GREEN_POOL,
    MAX_GREEN,
    MIN_GREEN,
    PairAggregationAgent,
    compute_timing_plan,
    latest_counts_to_queue_lengths,
)


def test_pair_aggregation_sums_through_and_right() -> None:
    agg = PairAggregationAgent()
    movements = agg.run(
        {
            "north": {"through": 40, "right": 10},
            "south": {"through": 12, "right": 25},
            "east": {"through": 8, "right": 3},
            "west": {"through": 9, "right": 1},
        }
    )
    assert movements["north"] == 50
    assert movements["east"] == 11
    assert movements["west"] == 10
    assert movements["south"] == 37


def test_empty_counts_split_green_pool() -> None:
    out = compute_timing_plan(LatestCounts())
    greens = (
        out.north.straight_s
        + out.east.straight_s
        + out.west.straight_s
        + out.south.straight_s
    )
    assert abs(greens - GREEN_POOL) < 2.0
    for side in (out.north, out.east, out.west, out.south):
        assert MIN_GREEN <= side.straight_s <= MAX_GREEN


def test_reason_mentions_n_e_w_s_loop() -> None:
    out = compute_timing_plan(LatestCounts())
    assert "N" in out.reason and "E" in out.reason
    assert "W" in out.reason and "S" in out.reason
    assert "8-min" in out.reason


def test_busy_north_gets_more_green() -> None:
    busy = compute_timing_plan(LatestCounts(north=30, east=2, west=2, south=2))
    assert busy.north.straight_s > busy.east.straight_s
    assert busy.north.straight_s > busy.west.straight_s
    assert busy.north.straight_s > busy.south.straight_s
    assert MIN_GREEN <= busy.east.straight_s <= MAX_GREEN


def test_latest_counts_to_queue_lengths_uses_right_split() -> None:
    lengths = latest_counts_to_queue_lengths(
        LatestCounts(north=10, north_right=4, east=0, west=0, south=0)
    )
    assert lengths["north"]["right"] == 4 * 6.0
    assert lengths["north"]["through"] == 6 * 6.0
