"""Background traffic demand simulator: random arrivals for demos."""
from __future__ import annotations

import asyncio
import random
from typing import Awaitable, Callable, Optional, Union

from database import SessionLocal
from models import LatestCounts
import persistence as store

SIDES = ("north", "east", "south", "west")


class TrafficSimulator:
    """Randomly sets per-side vehicle counts for demos without phones."""

    def __init__(self) -> None:
        self.enabled = True
        self.interval_s = (2.5, 5.0)
        self.max_per_side = 24
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.get_run_id: Optional[Callable[[], Optional[int]]] = None
        self.queue_plan: Optional[Callable] = None
        self.set_last_plan_id: Optional[Callable[[int], None]] = None
        self.on_counts_updated: Optional[Callable[[LatestCounts], Union[None, Awaitable[None]]]] = None

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

    def set_enabled(self, enabled: bool) -> None:
        self.enabled = enabled

    async def _tick_once(self) -> LatestCounts:
        db = SessionLocal()
        try:
            run_id = self.get_run_id() if self.get_run_id else None
            counts = store.latest_counts(db, run_id=run_id)

            targets = random.sample(list(SIDES), k=random.choice([1, 1, 2]))
            changed = False
            for side in targets:
                cur = getattr(counts, side)
                new_val = random.randint(1, min(8, self.max_per_side))
                if cur >= self.max_per_side and random.random() > 0.15:
                    continue
                right = max(0, min(new_val, int(new_val * random.uniform(0.1, 0.35))))
                store.save_vehicle_count(
                    db,
                    side=side,
                    vehicle_count=new_val,
                    right_count=right,
                    source="simulation",
                    run_id=run_id,
                )
                setattr(counts, side, new_val)
                setattr(counts, f"{side}_right", right)
                changed = True

            if changed and self.on_counts_updated:
                result = self.on_counts_updated(counts)
                if asyncio.iscoroutine(result):
                    await result
            return counts
        finally:
            db.close()

    async def _loop(self) -> None:
        await asyncio.sleep(1.0)
        if self.enabled:
            try:
                await self._tick_once()
            except Exception:
                pass
        while self._running:
            lo, hi = self.interval_s
            await asyncio.sleep(random.uniform(lo, hi))
            if not self.enabled:
                continue
            try:
                await self._tick_once()
            except Exception:
                pass


simulator = TrafficSimulator()
