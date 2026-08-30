"""shapes i keep dumping counts/plans into. don't redefine these in other folders."""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Side = Literal["north", "east", "south", "west"]
LampColor = Literal["red", "yellow", "green", "orange"]
Phase = Literal["green", "yellow", "all_red"]


class SideTiming(BaseModel):
    # straight = how long that side stays green. right overlaps the start of that.
    # cap at 240 so pydantic doesn't scream if i fat-finger; real cap is 210 in pipeline.
    straight_s: float = Field(ge=5, le=240)
    right_s: float = Field(ge=0, le=240)


class TimingPlanPayload(BaseModel):
    north: SideTiming
    east: SideTiming
    south: SideTiming
    west: SideTiming
    reason: str = ""


class BBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


class TrackedVehicle(BaseModel):
    """one blob the phone is tracking. i don't use this in the allocator, ui does."""

    track_id: str
    lane: Literal["left", "straight", "right"]
    # 0 = stuck at the back, 1 = already at the stop line
    depth: float = Field(ge=0, le=1, default=0.5)
    moving: bool = False
    intent: Literal["left", "straight", "right"] = "straight"
    bbox: Optional[BBox] = None


class DetectFrameIn(BaseModel):
    image: str
    side: Optional[Side] = None


class VehicleCountIn(BaseModel):
    side: Side
    vehicle_count: int = Field(ge=0)
    left_count: Optional[int] = None
    straight_count: Optional[int] = None
    right_count: Optional[int] = None
    source: str = "camera"
    timestamp: Optional[datetime] = None
    tracks: Optional[list[TrackedVehicle]] = None


class DepartIn(BaseModel):
    side: Side
    departed: int = Field(ge=1, le=20, default=1)


class EnabledToggle(BaseModel):
    enabled: bool = False


class LampState(BaseModel):
    straight: LampColor
    right: LampColor
    left: LampColor


class SideSignalState(BaseModel):
    lamps: LampState
    remaining_straight_s: float
    remaining_right_s: float


class SignalSnapshot(BaseModel):
    active_side: Side
    phase: Phase
    elapsed_s: float
    phase_remaining_s: float
    cycle_index: int
    cycle_elapsed_s: float = 0.0
    cycle_remaining_s: float = 0.0
    timings: TimingPlanPayload
    sides: dict[str, SideSignalState]
    pending_plan: bool
    pending_timings: Optional[TimingPlanPayload] = None
    agent_enabled: bool = False
    run_id: Optional[int] = None


class VehicleCountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    side: str
    vehicle_count: int
    left_count: Optional[int]
    straight_count: Optional[int]
    right_count: Optional[int]
    source: str
    recorded_at: datetime


class TimingPlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    north_straight: float
    north_right: float
    east_straight: float
    east_right: float
    south_straight: float
    south_right: float
    west_straight: float
    west_right: float
    reason: str
    created_at: datetime
    applied_at: Optional[datetime]


class SignalEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    side: str
    phase: str
    straight_color: str
    right_color: str
    left_color: str
    elapsed_s: float
    detail: Optional[str]
    recorded_at: datetime


class LatestCounts(BaseModel):
    north: int = 0
    east: int = 0
    south: int = 0
    west: int = 0
    north_right: Optional[int] = None
    east_right: Optional[int] = None
    south_right: Optional[int] = None
    west_right: Optional[int] = None
    north_left: Optional[int] = None
    east_left: Optional[int] = None
    south_left: Optional[int] = None
    west_left: Optional[int] = None
    north_straight: Optional[int] = None
    east_straight: Optional[int] = None
    south_straight: Optional[int] = None
    west_straight: Optional[int] = None
    tracks: dict[str, list[TrackedVehicle]] = Field(default_factory=dict)  # live camera stuff, not used here


class AgentDecisionOut(BaseModel):
    plan: TimingPlanPayload
    counts: LatestCounts
    explanation: str


class AgentSent(BaseModel):
    """debug dump of what i fed the allocator that time."""

    counts: dict[str, int] = Field(default_factory=dict)
    right_counts: dict[str, int] = Field(default_factory=dict)
    through_queue_m: dict[str, float] = Field(default_factory=dict)
    right_queue_m: dict[str, float] = Field(default_factory=dict)
    green_pool_s: float = 0.0


class AgentReceived(BaseModel):
    """what came back. llm field is leftover, we don't call gemini anymore."""

    straight_s: dict[str, float] = Field(default_factory=dict)
    right_s: dict[str, float] = Field(default_factory=dict)
    cycle_total_s: float = 0.0
    reason: str = ""
    llm: str = ""


class AgentExchange(BaseModel):
    id: int
    at: datetime
    trigger: str
    cycle_index: int
    duration_ms: float
    ok: bool
    sent: AgentSent
    received: Optional[AgentReceived] = None
    error: Optional[str] = None
