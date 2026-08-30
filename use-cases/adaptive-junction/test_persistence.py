"""Checks that save + latest + mark-applied actually work.

Uses a throwaway sqlite file so we don't trash junction.db. Shared models
live in folder 1, so that gets added to the path below.
"""
from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# models.py is Person 1's, one folder up
_FOLDER_1 = Path(__file__).resolve().parent.parent / "1"
sys.path.insert(0, str(_FOLDER_1))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import database as dbmod
from models import SideTiming, TimingPlanPayload
import persistence as store


def test_save_count_and_latest(tmp_path, monkeypatch) -> None:
    # Point the module at a temp db for this test only
    engine = create_engine(f"sqlite:///{tmp_path / 't.db'}", connect_args={"check_same_thread": False})
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    dbmod.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(dbmod, "engine", engine)
    monkeypatch.setattr(dbmod, "SessionLocal", Session)

    db = Session()
    try:
        store.save_vehicle_count(db, side="north", vehicle_count=15, source="manual")
        latest = store.latest_counts(db)
        assert latest.north == 15
    finally:
        db.close()


def test_save_plan_and_mark_applied(tmp_path, monkeypatch) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 't.db'}", connect_args={"check_same_thread": False})
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    dbmod.Base.metadata.create_all(bind=engine)

    plan = TimingPlanPayload(
        north=SideTiming(straight_s=40, right_s=10),
        east=SideTiming(straight_s=30, right_s=8),
        west=SideTiming(straight_s=30, right_s=8),
        south=SideTiming(straight_s=30, right_s=8),
        reason="test",
    )
    db = Session()
    try:
        # should come back unapplied, then we stamp it
        row = store.save_timing_plan(db, plan, applied=False)
        assert row.applied_at is None
        store.mark_plan_applied(db, row.id)
        db.refresh(row)
        assert row.applied_at is not None
    finally:
        db.close()
