"""
green time math. that's it.

8 min loop, N then E then W then S. i only split the green leftover after
yellows. don't let the chatbot invent seconds — everyone should call
compute_timing_plan and leave it alone.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from models import LatestCounts, SideTiming, TimingPlanPayload

APPROACHES = ("north", "east", "west", "south")
MOVEMENTS = APPROACHES

CYCLE_TOTAL = 480.0  # 8 min. don't change unless the real junction does
YELLOW_TIME = 3.0
ALL_RED_TIME = 2.0
TRANSITION_TIME = YELLOW_TIME + ALL_RED_TIME
NUM_PHASES = 4
GREEN_POOL = CYCLE_TOTAL - NUM_PHASES * TRANSITION_TIME  # 460 left for actual green

MIN_GREEN = 30.0  # nobody gets starved even if empty
MAX_GREEN = 210.0  # 3.5 min, one side can't eat the whole loop

PEDESTRIAN_MIN_WALK = 5.0
PEDESTRIAN_CLEARANCE = 4.0
METRES_PER_VEHICLE = 6.0  # demo fudge: 1 car ≈ 6m of queue. good enough for toy cars


@dataclass
class TimelineEvent:
    movement: str
    kind: str  # green | yellow | all_red
    start_s: float
    duration_s: float

    @property
    def end_s(self) -> float:
        return self.start_s + self.duration_s


@dataclass
class PedInterval:
    state: str  # walk | flash | dont_walk
    start_s: float
    duration_s: float


@dataclass
class CyclePlan:
    lengths: Dict[str, float]
    ranked: List[Tuple[str, float]]
    greens: Dict[str, float]
    group_order: Tuple[str, str]
    phase_order: List[str]
    timeline: List[TimelineEvent]
    pedestrians: Dict[str, List[PedInterval]]
    right_lengths: Dict[str, float] = field(default_factory=dict)
    reason: str = ""

    def to_timing_payload(self) -> TimingPlanPayload:
        """right green sits on the front of straight. not extra time. keep forgetting that."""
        sides: Dict[str, SideTiming] = {}
        for side in APPROACHES:
            green = float(self.greens[side])
            total = max(0.0, float(self.lengths.get(side, 0.0)))
            right_len = max(0.0, float(self.right_lengths.get(side, 0.0)))
            if total <= 0:
                right_s = min(green * 0.25, green)
            else:
                right_s = min(green, green * (right_len / total))
            sides[side] = SideTiming(
                straight_s=round(green, 1),
                right_s=round(right_s, 1),
            )
        return TimingPlanPayload(
            north=sides["north"],
            east=sides["east"],
            west=sides["west"],
            south=sides["south"],
            reason=self.reason,
        )


class PairAggregationAgent:
    """just add through + right so i have one number per side."""

    def run(self, lengths: Dict[str, Dict[str, float]]) -> Dict[str, float]:
        for a in APPROACHES:
            if a not in lengths or "through" not in lengths[a] or "right" not in lengths[a]:
                raise ValueError(f"Expected lengths['{a}'] = {{'through': .., 'right': ..}}")

        return {
            a: max(0.0, float(lengths[a]["through"])) + max(0.0, float(lengths[a]["right"]))
            for a in APPROACHES
        }


class SortAgent:
    """shortest → longest. only used in the reason string honestly."""

    def run(self, movement_lengths: Dict[str, float]) -> List[Tuple[str, float]]:
        if set(movement_lengths.keys()) != set(MOVEMENTS):
            raise ValueError(
                f"Expected exactly movements {MOVEMENTS}, got {list(movement_lengths.keys())}"
            )
        return sorted(movement_lengths.items(), key=lambda item: item[1])


class TimeAllocationAgent:
    """split the 460s by how long each queue is. peel off max violators first, then mins."""

    def run(
        self,
        movement_lengths: Dict[str, float],
        green_pool: float = GREEN_POOL,
    ) -> Dict[str, float]:
        if set(movement_lengths.keys()) != set(MOVEMENTS):
            raise ValueError(
                f"Expected exactly movements {MOVEMENTS}, got {list(movement_lengths.keys())}"
            )

        lengths = {k: max(0.0, float(movement_lengths[k])) for k in MOVEMENTS}
        remaining_keys = set(MOVEMENTS)
        remaining_pool = float(green_pool)
        out: Dict[str, float] = {}

        total = sum(lengths.values())
        if total <= 0:
            # empty junction — just split even, still clamp
            share = remaining_pool / len(MOVEMENTS)
            return {k: round(max(MIN_GREEN, min(MAX_GREEN, share)), 1) for k in MOVEMENTS}

        # anyone whose share would blow past MAX — give them max and take them out
        progressed = True
        while progressed and remaining_keys:
            progressed = False
            t = sum(lengths[k] for k in remaining_keys)
            if t <= 0:
                break
            for k in list(remaining_keys):
                raw = remaining_pool * (lengths[k] / t)
                if raw > MAX_GREEN + 1e-9:
                    out[k] = MAX_GREEN
                    remaining_pool -= MAX_GREEN
                    remaining_keys.remove(k)
                    progressed = True
                    break

        # same idea but for people who'd get less than 30s
        progressed = True
        while progressed and remaining_keys:
            progressed = False
            t = sum(lengths[k] for k in remaining_keys)
            n_left = len(remaining_keys)
            for k in list(remaining_keys):
                raw = remaining_pool * (lengths[k] / t) if t > 0 else remaining_pool / n_left
                if raw < MIN_GREEN - 1e-9:
                    out[k] = MIN_GREEN
                    remaining_pool -= MIN_GREEN
                    remaining_keys.remove(k)
                    progressed = True
                    break

        # leftover pool, leftover sides
        t = sum(lengths[k] for k in remaining_keys)
        n_left = len(remaining_keys)
        for k in remaining_keys:
            if t > 0:
                raw = remaining_pool * (lengths[k] / t)
            elif n_left:
                raw = remaining_pool / n_left
            else:
                raw = MIN_GREEN
            out[k] = max(MIN_GREEN, min(MAX_GREEN, raw))

        return {k: round(out[k], 1) for k in MOVEMENTS}


class PhaseSchedulerAgent:
    """order is locked. i don't reshuffle even if west is a parking lot."""

    def run(
        self,
        greens: Dict[str, float],
        movement_lengths: Dict[str, float],
    ) -> Tuple[List[str], Tuple[str, str], List[TimelineEvent]]:
        _ = movement_lengths  # scheduler doesn't care about metres, just the greens
        phase_order = list(APPROACHES)
        group_order = ("n-e", "w-s")  # leftover label, engine doesn't use this

        t = 0.0
        events: List[TimelineEvent] = []
        for mov in phase_order:
            g = float(greens[mov])
            events.append(TimelineEvent(mov, "green", t, g))
            t += g
            events.append(TimelineEvent(mov, "yellow", t, YELLOW_TIME))
            t += YELLOW_TIME
            events.append(TimelineEvent(mov, "all_red", t, ALL_RED_TIME))
            t += ALL_RED_TIME

        return phase_order, group_order, events


class PedestrianAgent:
    """walk when the parallel through is green. rights = don't walk, they cut across."""

    _WALK_WITH = {
        "north": ("east", "west"),
        "south": ("east", "west"),
        "east": ("north", "south"),
        "west": ("north", "south"),
    }

    def run(self, timeline: List[TimelineEvent]) -> Dict[str, List[PedInterval]]:
        cycle_end = timeline[-1].end_s if timeline else CYCLE_TOTAL
        greens = {e.movement: e for e in timeline if e.kind == "green"}
        out: Dict[str, List[PedInterval]] = {a: [] for a in APPROACHES}

        for movement, crosswalks in self._WALK_WITH.items():
            slot = greens.get(movement)
            if slot is None:
                continue
            if slot.duration_s >= PEDESTRIAN_MIN_WALK + PEDESTRIAN_CLEARANCE:
                walk_s = slot.duration_s - PEDESTRIAN_CLEARANCE
                flash_s = PEDESTRIAN_CLEARANCE
            elif slot.duration_s >= PEDESTRIAN_MIN_WALK:
                walk_s = slot.duration_s
                flash_s = 0.0
            else:
                continue
            for cw in crosswalks:
                out[cw].append(PedInterval("walk", slot.start_s, walk_s))
                if flash_s > 0:
                    out[cw].append(PedInterval("flash", slot.start_s + walk_s, flash_s))

        for cw in APPROACHES:
            out[cw] = _fill_dont_walk(out[cw], cycle_end)
        return out


def _fill_dont_walk(intervals: List[PedInterval], cycle_end: float) -> List[PedInterval]:
    # pad the gaps so each crosswalk has a full cycle of states
    filled: List[PedInterval] = []
    t = 0.0
    for iv in sorted(intervals, key=lambda x: x.start_s):
        if iv.start_s > t + 1e-9:
            filled.append(PedInterval("dont_walk", t, iv.start_s - t))
        filled.append(iv)
        t = iv.start_s + iv.duration_s
    if t < cycle_end - 1e-9:
        filled.append(PedInterval("dont_walk", t, cycle_end - t))
    return filled


class PriorityAgentPipeline:
    def __init__(self) -> None:
        self.agg = PairAggregationAgent()
        self.sort = SortAgent()
        self.alloc = TimeAllocationAgent()
        self.sched = PhaseSchedulerAgent()
        self.ped = PedestrianAgent()

    def run(
        self,
        lengths: Dict[str, Dict[str, float]],
        green_pool: float = GREEN_POOL,
    ) -> CyclePlan:
        movement_lengths = self.agg.run(lengths)
        ranked = self.sort.run(movement_lengths)
        greens = self.alloc.run(movement_lengths, green_pool=green_pool)
        phase_order, group_order, timeline = self.sched.run(greens, movement_lengths)
        pedestrians = self.ped.run(timeline)
        right_lengths = {a: max(0.0, float(lengths[a]["right"])) for a in APPROACHES}

        ranked_txt = ", ".join(f"{name} {metres:.0f}m" for name, metres in ranked)
        green_txt = ", ".join(f"{m} {greens[m]:.0f}s" for m in phase_order)
        reason = (
            f"8-min loop N→E→W→S. "
            f"Phase greens: {green_txt}. "
            f"Ranked queues (short→long): {ranked_txt}."
        )
        return CyclePlan(
            lengths=movement_lengths,
            ranked=ranked,
            greens=greens,
            group_order=group_order,
            phase_order=phase_order,
            timeline=timeline,
            pedestrians=pedestrians,
            right_lengths=right_lengths,
            reason=reason,
        )


_pipeline = PriorityAgentPipeline()


def latest_counts_to_queue_lengths(counts: LatestCounts) -> Dict[str, Dict[str, float]]:
    """phones send cars, paper wants metres. if they gave right count, through = total - right."""
    out: Dict[str, Dict[str, float]] = {}
    for side in APPROACHES:
        total = max(0, int(getattr(counts, side) or 0))
        right_n = getattr(counts, f"{side}_right", None)
        through_n = getattr(counts, f"{side}_straight", None)
        if through_n is not None:
            through_n = max(0, int(through_n))
        elif right_n is not None:
            through_n = max(0, total - max(0, int(right_n)))
        else:
            through_n = total
        if right_n is None:
            right_n = 0
        else:
            right_n = max(0, int(right_n))
        out[side] = {
            "through": through_n * METRES_PER_VEHICLE,
            "right": right_n * METRES_PER_VEHICLE,
        }
    return out


def compute_timing_plan(
    counts: LatestCounts,
    cycle_green_budget: float = GREEN_POOL,
) -> TimingPlanPayload:
    """the function everyone else should hit. no api, no llm, just numbers."""
    lengths = latest_counts_to_queue_lengths(counts)
    cycle = _pipeline.run(lengths, green_pool=cycle_green_budget)
    return cycle.to_timing_payload()
