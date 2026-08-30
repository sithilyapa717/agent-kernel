"""SQLite tables for the junction demo.

Went with a local junction.db so nobody has to stand up Postgres for this.
If you just need to save/load stuff, use persistence.py instead of hitting
these models directly.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, Float, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

DATABASE_URL = "sqlite:///./junction.db"

# SQLite moans if we share the connection across threads. FastAPI + the sim
# can both touch this, so just turn that check off.
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


class SimulationRun(Base):
    """One demo / sim session. Optional, but useful if we run it more than once."""

    __tablename__ = "simulation_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), default="demo")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class VehicleCount(Base):
    """How many cars were on a side at a given moment.

    Camera / sim don't always send the left / straight / right split, so those
    are optional. source is usually "camera" or "simulation".
    """

    __tablename__ = "vehicle_counts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    side: Mapped[str] = mapped_column(String(16))
    vehicle_count: Mapped[int] = mapped_column(Integer, default=0)
    left_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    straight_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    right_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="camera")
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TimingPlan(Base):
    """Person 1's timing plan, flattened into columns so we can query it.

    applied_at stays null until the signal engine actually picks the plan up.
    """

    __tablename__ = "timing_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    north_straight: Mapped[float] = mapped_column(Float)
    north_right: Mapped[float] = mapped_column(Float)
    east_straight: Mapped[float] = mapped_column(Float)
    east_right: Mapped[float] = mapped_column(Float)
    south_straight: Mapped[float] = mapped_column(Float)
    south_right: Mapped[float] = mapped_column(Float)
    west_straight: Mapped[float] = mapped_column(Float)
    west_right: Mapped[float] = mapped_column(Float)
    reason: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    applied_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class SignalEvent(Base):
    """Lamp colour change, for the dashboard / logs."""

    __tablename__ = "signal_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    side: Mapped[str] = mapped_column(String(16))
    phase: Mapped[str] = mapped_column(String(32))
    straight_color: Mapped[str] = mapped_column(String(16))
    right_color: Mapped[str] = mapped_column(String(16))
    left_color: Mapped[str] = mapped_column(String(16))
    elapsed_s: Mapped[float] = mapped_column(Float, default=0.0)
    detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


def init_db() -> None:
    # Call once at startup so the tables actually exist.
    Base.metadata.create_all(bind=engine)


def get_db():
    # FastAPI-style session: always close it even if the request blows up.
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
