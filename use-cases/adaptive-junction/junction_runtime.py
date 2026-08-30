"""Shared SignalEngine + plan apply. Used by REST routes and Agent Kernel tools."""
from __future__ import annotations

import time
from typing import Optional

from database import SessionLocal, init_db
from models import AgentReceived, AgentSent, LatestCounts, TimingPlanPayload
from pipeline import GREEN_POOL, compute_timing_plan, latest_counts_to_queue_lengths
from signal_engine import SignalEngine, cycle_length_s, default_timings
from traffic_sim import simulator
import agent_debug
import persistence as store

engine = SignalEngine(timings=default_timings())
_last_plan_id: Optional[int] = None
_prev_pending: bool = False

SIDE_NAMES = ("north", "east", "west", "south")


def set_last_plan_id(plan_id: int) -> None:
    global _last_plan_id
    _last_plan_id = plan_id


def _build_agent_sent(counts: LatestCounts) -> AgentSent:
    queues = latest_counts_to_queue_lengths(counts)
    return AgentSent(
        counts={s: int(getattr(counts, s) or 0) for s in SIDE_NAMES},
        right_counts={s: int(getattr(counts, f"{s}_right", None) or 0) for s in SIDE_NAMES},
        through_queue_m={s: queues[s]["through"] for s in SIDE_NAMES},
        right_queue_m={s: queues[s]["right"] for s in SIDE_NAMES},
        green_pool_s=GREEN_POOL,
    )


def run_plan_from_counts(
    counts: LatestCounts | None = None,
    trigger: str = "manual",
) -> TimingPlanPayload:
    """Compute timings, persist, queue on the engine. Safe to call from tools or HTTP."""
    global _last_plan_id
    db = SessionLocal()
    started = time.perf_counter()
    try:
        if counts is None:
            counts = store.latest_counts(db, run_id=engine.run_id)
        sent = _build_agent_sent(counts)
        try:
            plan = compute_timing_plan(counts)
        except Exception as exc:
            agent_debug.record(
                trigger=trigger,
                cycle_index=engine.cycle_index,
                duration_ms=(time.perf_counter() - started) * 1000,
                sent=sent,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise
        saved = store.save_timing_plan(db, plan, run_id=engine.run_id, applied=False)
        _last_plan_id = saved.id
        engine.queue_timing_plan(plan)
        agent_debug.record(
            trigger=trigger,
            cycle_index=engine.cycle_index,
            duration_ms=(time.perf_counter() - started) * 1000,
            sent=sent,
            received=AgentReceived(
                straight_s={s: getattr(plan, s).straight_s for s in SIDE_NAMES},
                right_s={s: getattr(plan, s).right_s for s in SIDE_NAMES},
                cycle_total_s=round(cycle_length_s(plan), 1),
                reason=plan.reason,
                llm="pipeline",
            ),
        )
        return plan
    finally:
        db.close()


async def _precompute_next_loop() -> None:
    try:
        run_plan_from_counts(trigger="loop")
    except Exception:
        pass


def on_signal_event(payload: dict) -> None:
    db = SessionLocal()
    try:
        store.save_signal_event(db, payload)
    finally:
        db.close()


async def startup() -> None:
    global _prev_pending
    init_db()
    db = SessionLocal()
    try:
        run = store.create_run(db, name="demo")
        engine.run_id = run.id
        plan = default_timings()
        store.save_timing_plan(db, plan, run_id=run.id, applied=True)
    finally:
        db.close()

    engine.on_event = on_signal_event
    engine.on_precompute = _precompute_next_loop
    simulator.get_run_id = lambda: engine.run_id
    simulator.queue_plan = engine.queue_timing_plan
    simulator.set_last_plan_id = set_last_plan_id
    simulator.on_counts_updated = lambda counts: run_plan_from_counts(counts, trigger="sim")
    _prev_pending = False
    await engine.start()
    await simulator.start()


async def shutdown() -> None:
    await simulator.stop()
    await engine.stop()
