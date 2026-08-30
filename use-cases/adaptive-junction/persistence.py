"""Save / load wrappers so the rest of the team doesn't have to write SQLAlchemy.

Person 2 (engine / sim) and Person 5 (routes) should call these rather than
building queries themselves. Models come from Person 1.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import desc
from sqlalchemy.orm import Session

from database import SignalEvent, SimulationRun, TimingPlan, VehicleCount
from models import LatestCounts, TimingPlanPayload


def create_run(db: Session, name: str = "demo") -> SimulationRun:
    """Kick off a new demo session. name is just a label."""
    run = SimulationRun(name=name, started_at=datetime.utcnow())
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def save_vehicle_count(
    db: Session,
    *,
    side: str,
    vehicle_count: int,
    left_count: Optional[int] = None,
    straight_count: Optional[int] = None,
    right_count: Optional[int] = None,
    source: str = "camera",
    run_id: Optional[int] = None,
    recorded_at: Optional[datetime] = None,
) -> VehicleCount:
    """Store a count snapshot. Stamps recorded_at as now if the caller didn't."""
    row = VehicleCount(
        run_id=run_id,
        side=side,
        vehicle_count=vehicle_count,
        left_count=left_count,
        straight_count=straight_count,
        right_count=right_count,
        source=source,
        recorded_at=recorded_at or datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def save_timing_plan(
    db: Session,
    plan: TimingPlanPayload,
    run_id: Optional[int] = None,
    applied: bool = False,
) -> TimingPlan:
    """Unpack Person 1's TimingPlanPayload into our columns."""
    row = TimingPlan(
        run_id=run_id,
        north_straight=plan.north.straight_s,
        north_right=plan.north.right_s,
        east_straight=plan.east.straight_s,
        east_right=plan.east.right_s,
        south_straight=plan.south.straight_s,
        south_right=plan.south.right_s,
        west_straight=plan.west.straight_s,
        west_right=plan.west.right_s,
        reason=plan.reason,
        applied_at=datetime.utcnow() if applied else None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def mark_plan_applied(db: Session, plan_id: int) -> None:
    """Stamp applied_at. Does nothing if it's already set or the id is wrong."""
    row = db.get(TimingPlan, plan_id)
    if row and row.applied_at is None:
        row.applied_at = datetime.utcnow()
        db.commit()


def save_signal_event(db: Session, payload: dict) -> SignalEvent:
    """Log one lamp-state change from the engine."""
    row = SignalEvent(
        run_id=payload.get("run_id"),
        side=payload["side"],
        phase=payload["phase"],
        straight_color=payload["straight_color"],
        right_color=payload["right_color"],
        left_color=payload["left_color"],
        elapsed_s=payload.get("elapsed_s", 0.0),
        detail=payload.get("detail"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def latest_counts(db: Session, run_id: Optional[int] = None) -> LatestCounts:
    """Newest count per side. Pass run_id if you only care about that session."""
    result = LatestCounts()
    for side in ("north", "east", "south", "west"):
        q = db.query(VehicleCount).filter(VehicleCount.side == side)
        if run_id is not None:
            q = q.filter(VehicleCount.run_id == run_id)
        row = q.order_by(desc(VehicleCount.recorded_at)).first()
        if row:
            setattr(result, side, row.vehicle_count)
            setattr(result, f"{side}_right", row.right_count)
            setattr(result, f"{side}_left", row.left_count)
            setattr(result, f"{side}_straight", row.straight_count)
    return result


def recent_counts(db: Session, limit: int = 50) -> list[VehicleCount]:
    """Last N count rows, for the dashboard."""
    return db.query(VehicleCount).order_by(desc(VehicleCount.recorded_at)).limit(limit).all()


def recent_plans(db: Session, limit: int = 20) -> list[TimingPlan]:
    """Last N timing plans, newest first."""
    return db.query(TimingPlan).order_by(desc(TimingPlan.created_at)).limit(limit).all()


def recent_events(db: Session, limit: int = 50) -> list[SignalEvent]:
    """Last N lamp events, same idea as the other recent_* helpers."""
    return db.query(SignalEvent).order_by(desc(SignalEvent.recorded_at)).limit(limit).all()
