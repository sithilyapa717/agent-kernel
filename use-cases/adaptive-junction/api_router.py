"""Junction REST + WebSocket routes. Mounted on Agent Kernel RESTAPI with empty prefix."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from database import get_db
from models import (
    AgentDecisionOut,
    DepartIn,
    EnabledToggle,
    LatestCounts,
    TimingPlanPayload,
    VehicleCountIn,
)
from signal_engine import default_timings
import persistence as store
import track_store
import agent_debug
from junction_runtime import engine, run_plan_from_counts, set_last_plan_id
from traffic_sim import simulator

router = APIRouter()
ws_clients: set[WebSocket] = set()
_ws_lock = asyncio.Lock()
_prev_pending = False


async def broadcast_snapshot(snap) -> None:
    global _prev_pending
    from junction_runtime import _last_plan_id

    if _prev_pending and not snap.pending_plan and _last_plan_id is not None:
        db = next(get_db())
        try:
            store.mark_plan_applied(db, _last_plan_id)
        finally:
            db.close()
    _prev_pending = snap.pending_plan
    dead: list[WebSocket] = []
    data = snap.model_dump()
    async with _ws_lock:
        clients = list(ws_clients)
    for ws in clients:
        try:
            await ws.send_json({"type": "snapshot", "data": data})
        except Exception:
            dead.append(ws)
    if dead:
        async with _ws_lock:
            for ws in dead:
                ws_clients.discard(ws)


engine.on_broadcast = broadcast_snapshot


@router.get("/api/health")
def health():
    return {"ok": True}


@router.get("/api/signal")
def get_signal():
    return engine.snapshot()


@router.post("/api/counts")
async def post_count(body: VehicleCountIn, db: Session = Depends(get_db)):
    row = store.save_vehicle_count(
        db,
        side=body.side,
        vehicle_count=body.vehicle_count,
        left_count=body.left_count,
        straight_count=body.straight_count,
        right_count=body.right_count,
        source=body.source,
        run_id=engine.run_id,
        recorded_at=body.timestamp,
    )
    if body.source == "camera" or body.tracks is not None:
        track_store.set_tracks(body.side, body.tracks)
    elif body.source in ("manual", "clear"):
        track_store.clear_tracks(body.side)
    return row


@router.post("/api/counts/depart")
async def post_depart(body: DepartIn, db: Session = Depends(get_db)):
    counts = store.latest_counts(db, run_id=engine.run_id)
    cur = getattr(counts, body.side)
    new_val = max(0, cur - body.departed)
    right = getattr(counts, f"{body.side}_right")
    if right is not None:
        right = min(right, new_val)
    store.save_vehicle_count(
        db,
        side=body.side,
        vehicle_count=new_val,
        right_count=right,
        source="departure",
        run_id=engine.run_id,
    )
    return store.latest_counts(db, run_id=engine.run_id)


@router.get("/api/agent")
def get_agent():
    return {"enabled": engine.agent_enabled}


@router.post("/api/agent/on")
async def agent_on():
    engine.agent_enabled = True
    return {"enabled": True}


@router.post("/api/agent/off")
async def agent_off():
    engine.agent_enabled = False
    return {"enabled": False}


@router.get("/api/agent/debug")
def get_agent_debug(limit: int = 10):
    return agent_debug.recent(limit=limit)


@router.post("/api/agent/debug/clear")
def clear_agent_debug():
    agent_debug.clear()
    return {"cleared": True}


@router.post("/api/agent/recompute")
async def recompute(db: Session = Depends(get_db)):
    plan = run_plan_from_counts(trigger="manual")
    counts = store.latest_counts(db, run_id=engine.run_id)
    return AgentDecisionOut(plan=plan, counts=counts, explanation=plan.reason)


@router.get("/api/counts/latest")
def get_latest_counts(db: Session = Depends(get_db)):
    counts = store.latest_counts(db, run_id=engine.run_id)
    counts.tracks = track_store.all_tracks()
    return counts


@router.get("/api/counts/history")
def get_count_history(limit: int = 50, db: Session = Depends(get_db)):
    return store.recent_counts(db, limit=limit)


@router.get("/api/plans")
def get_plans(limit: int = 20, db: Session = Depends(get_db)):
    return store.recent_plans(db, limit=limit)


@router.get("/api/events")
def get_events(limit: int = 50, db: Session = Depends(get_db)):
    return store.recent_events(db, limit=limit)


@router.post("/api/timings")
def set_timings(plan: TimingPlanPayload, db: Session = Depends(get_db)):
    saved = store.save_timing_plan(db, plan, run_id=engine.run_id, applied=False)
    set_last_plan_id(saved.id)
    engine.queue_timing_plan(plan)
    return saved


@router.post("/api/timings/apply-now")
def apply_now(db: Session = Depends(get_db)):
    from junction_runtime import _last_plan_id

    applied = engine.apply_pending_now()
    if applied and _last_plan_id:
        store.mark_plan_applied(db, _last_plan_id)
    return {"applied": applied, "snapshot": engine.snapshot()}


@router.post("/api/reset")
def reset(db: Session = Depends(get_db)):
    plan = default_timings()
    engine.reset(plan)
    store.save_timing_plan(db, plan, run_id=engine.run_id, applied=True)
    return engine.snapshot()


@router.get("/api/sim")
def get_sim():
    return {"enabled": simulator.enabled}


@router.post("/api/sim")
async def set_sim(body: EnabledToggle):
    simulator.set_enabled(bool(body.enabled))
    return {"enabled": simulator.enabled}


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    async with _ws_lock:
        ws_clients.add(websocket)
    try:
        await websocket.send_json({"type": "snapshot", "data": engine.snapshot().model_dump()})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        async with _ws_lock:
            ws_clients.discard(websocket)
