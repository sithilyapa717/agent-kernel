"""Sequential 4-way signal cycle: North -> East -> West -> South, 8 minutes total."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from models import (
    LampColor,
    LampState,
    Phase,
    Side,
    SideSignalState,
    SideTiming,
    SignalSnapshot,
    TimingPlanPayload,
)

CYCLE_ORDER: list[Side] = ["north", "east", "west", "south"]
SIDES: list[Side] = ["north", "east", "south", "west"]
YELLOW_S = 3.0
ALL_RED_S = 2.0
AGENT_LEAD_S = 60.0

EventCallback = Callable[[dict], Awaitable[None] | None]
BroadcastCallback = Callable[[SignalSnapshot], Awaitable[None] | None]
PrecomputeCallback = Callable[[], Awaitable[None] | None]


def default_timings() -> TimingPlanPayload:
    try:
        from models import LatestCounts
        from pipeline import compute_timing_plan

        return compute_timing_plan(LatestCounts())
    except ImportError:
        return TimingPlanPayload(
            north=SideTiming(straight_s=30, right_s=8),
            east=SideTiming(straight_s=30, right_s=8),
            south=SideTiming(straight_s=30, right_s=8),
            west=SideTiming(straight_s=30, right_s=8),
            reason="equal default timings (pipeline not on path yet)",
        )


def cycle_length_s(timings: TimingPlanPayload) -> float:
    return sum(getattr(timings, side).straight_s + YELLOW_S + ALL_RED_S for side in CYCLE_ORDER)


def _green_for(timings: TimingPlanPayload, side: Side) -> float:
    return getattr(timings, side).straight_s


def _right_for(timings: TimingPlanPayload, side: Side) -> float:
    return getattr(timings, side).right_s


def _next_side(side: Side) -> Side:
    idx = CYCLE_ORDER.index(side)
    return CYCLE_ORDER[(idx + 1) % len(CYCLE_ORDER)]


@dataclass
class SignalEngine:
    timings: TimingPlanPayload = field(default_factory=default_timings)
    active_side: Side = "north"
    phase: Phase = "green"
    elapsed_s: float = 0.0
    cycle_index: int = 0
    run_id: Optional[int] = None
    pending_timings: Optional[TimingPlanPayload] = None
    _last_tick: float = field(default_factory=time.monotonic)
    _running: bool = False
    _task: Optional[asyncio.Task] = None
    _precompute_started: bool = False
    agent_enabled: bool = False
    on_event: Optional[EventCallback] = None
    on_broadcast: Optional[BroadcastCallback] = None
    on_precompute: Optional[PrecomputeCallback] = None

    def queue_timing_plan(self, plan: TimingPlanPayload) -> None:
        """Hold a plan until the current 8-minute cycle finishes."""
        self.pending_timings = plan

    def apply_pending_now(self) -> bool:
        if self.pending_timings is None:
            return False
        self.timings = self.pending_timings
        self.pending_timings = None
        return True

    def _phase_duration(self) -> float:
        if self.phase == "green":
            return _green_for(self.timings, self.active_side)
        if self.phase == "yellow":
            return YELLOW_S
        return ALL_RED_S

    def _cycle_elapsed(self) -> float:
        t = 0.0
        for side in CYCLE_ORDER:
            g = _green_for(self.timings, side)
            if side == self.active_side:
                if self.phase == "green":
                    return t + self.elapsed_s
                if self.phase == "yellow":
                    return t + g + self.elapsed_s
                return t + g + YELLOW_S + self.elapsed_s
            t += g + YELLOW_S + ALL_RED_S
        return t

    def _cycle_remaining(self) -> float:
        return max(0.0, cycle_length_s(self.timings) - self._cycle_elapsed())

    def _lamp_for_side(self, side: Side) -> LampState:
        left_color: LampColor = "orange"
        idle = LampState(straight="red", right="red", left=left_color)

        if side == self.active_side:
            right_s = _right_for(self.timings, side)
            green_s = _green_for(self.timings, side)
            if self.phase == "green":
                right: LampColor = "green" if self.elapsed_s < right_s else "red"
                return LampState(straight="green", right=right, left=left_color)
            if self.phase == "yellow":
                right = "yellow" if right_s >= green_s - 1e-6 else "red"
                return LampState(straight="yellow", right=right, left=left_color)
            return idle

        if side == _next_side(self.active_side) and self.phase in ("yellow", "all_red"):
            return LampState(straight="yellow", right="red", left=left_color)

        return idle

    def _remaining_for(self, side: Side) -> tuple[float, float]:
        if self.phase != "green" or side != self.active_side:
            return 0.0, 0.0
        rem_s = max(0.0, _green_for(self.timings, side) - self.elapsed_s)
        rem_r = max(0.0, _right_for(self.timings, side) - self.elapsed_s)
        return rem_s, rem_r

    def snapshot(self) -> SignalSnapshot:
        sides: dict[str, SideSignalState] = {}
        for side in SIDES:
            rem_s, rem_r = self._remaining_for(side)
            sides[side] = SideSignalState(
                lamps=self._lamp_for_side(side),
                remaining_straight_s=round(rem_s, 2),
                remaining_right_s=round(rem_r, 2),
            )
        return SignalSnapshot(
            active_side=self.active_side,
            phase=self.phase,
            elapsed_s=round(self.elapsed_s, 2),
            phase_remaining_s=round(max(0.0, self._phase_duration() - self.elapsed_s), 2),
            cycle_index=self.cycle_index,
            cycle_elapsed_s=round(self._cycle_elapsed(), 2),
            cycle_remaining_s=round(self._cycle_remaining(), 2),
            timings=self.timings,
            sides=sides,
            pending_plan=self.pending_timings is not None,
            agent_enabled=self.agent_enabled,
            run_id=self.run_id,
        )

    async def _emit_event(self, detail: str = "") -> None:
        lamps = self._lamp_for_side(self.active_side)
        payload = {
            "side": self.active_side,
            "phase": self.phase,
            "straight_color": lamps.straight,
            "right_color": lamps.right,
            "left_color": lamps.left,
            "elapsed_s": self.elapsed_s,
            "detail": detail or f"{self.active_side} {self.phase}",
            "run_id": self.run_id,
        }
        if self.on_event:
            result = self.on_event(payload)
            if asyncio.iscoroutine(result):
                await result

    async def _broadcast(self) -> None:
        if self.on_broadcast:
            result = self.on_broadcast(self.snapshot())
            if asyncio.iscoroutine(result):
                await result

    def _maybe_request_next_loop_plan(self) -> None:
        if not self.agent_enabled:
            return
        if self._precompute_started or self._cycle_remaining() > AGENT_LEAD_S:
            return
        self._precompute_started = True
        if not self.on_precompute:
            return

        async def _run() -> None:
            try:
                result = self.on_precompute()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass

        asyncio.create_task(_run())

    async def _transition(self) -> None:
        if self.phase == "green":
            self.phase = "yellow"
            self.elapsed_s = 0.0
            await self._emit_event(f"{self.active_side} yellow")
            return
        if self.phase == "yellow":
            self.phase = "all_red"
            self.elapsed_s = 0.0
            await self._emit_event(f"{self.active_side} all-red")
            return

        nxt = _next_side(self.active_side)
        wrapping = nxt == CYCLE_ORDER[0]
        if wrapping:
            if self.pending_timings is not None:
                self.timings = self.pending_timings
                self.pending_timings = None
            self.cycle_index += 1
            self._precompute_started = False
        self.active_side = nxt
        self.phase = "green"
        self.elapsed_s = 0.0
        await self._emit_event(f"{self.active_side} green")

    async def tick(self, dt: float | None = None) -> SignalSnapshot:
        now = time.monotonic()
        if dt is None:
            dt = now - self._last_tick
        self._last_tick = now
        self.elapsed_s += dt

        while self.elapsed_s >= self._phase_duration():
            overflow = self.elapsed_s - self._phase_duration()
            await self._transition()
            self.elapsed_s = overflow

        self._maybe_request_next_loop_plan()

        snap = self.snapshot()
        await self._broadcast()
        return snap

    async def _loop(self) -> None:
        self._last_tick = time.monotonic()
        await self._emit_event("engine started")
        while self._running:
            await self.tick()
            await asyncio.sleep(0.1)

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def reset(self, timings: TimingPlanPayload | None = None) -> None:
        self.timings = timings or default_timings()
        self.pending_timings = None
        self.active_side = CYCLE_ORDER[0]
        self.phase = "green"
        self.elapsed_s = 0.0
        self.cycle_index = 0
        self._precompute_started = False
        self._last_tick = time.monotonic()
