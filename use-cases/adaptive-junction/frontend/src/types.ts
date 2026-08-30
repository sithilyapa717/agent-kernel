export type Side = "north" | "east" | "south" | "west";
export type LampColor = "red" | "yellow" | "green" | "orange";
export type Phase = "green" | "yellow" | "all_red";

export interface SideTiming {
  straight_s: number;
  right_s: number;
}

export interface TimingPlan {
  north: SideTiming;
  east: SideTiming;
  south: SideTiming;
  west: SideTiming;
  reason: string;
}

export interface LampState {
  straight: LampColor;
  right: LampColor;
  left: LampColor;
}

export interface SideSignalState {
  lamps: LampState;
  remaining_straight_s: number;
  remaining_right_s: number;
}

export interface SignalSnapshot {
  active_side: Side;
  phase: Phase;
  elapsed_s: number;
  phase_remaining_s: number;
  cycle_index: number;
  cycle_elapsed_s?: number;
  cycle_remaining_s?: number;
  timings: TimingPlan;
  sides: Record<string, SideSignalState>;
    pending_plan: boolean;
    agent_enabled?: boolean;
    run_id: number | null;
}

export interface TrackedVehicle {
  track_id: string;
  lane: "left" | "straight" | "right";
  depth: number;
  moving: boolean;
  intent: "left" | "straight" | "right";
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface LatestCounts {
  north: number;
  east: number;
  south: number;
  west: number;
  north_right?: number | null;
  east_right?: number | null;
  south_right?: number | null;
  west_right?: number | null;
  north_left?: number | null;
  east_left?: number | null;
  south_left?: number | null;
  west_left?: number | null;
  north_straight?: number | null;
  east_straight?: number | null;
  south_straight?: number | null;
  west_straight?: number | null;
  tracks?: Partial<Record<Side, TrackedVehicle[]>>;
}

export interface VehicleCountRow {
  id: number;
  side: string;
  vehicle_count: number;
  left_count: number | null;
  straight_count: number | null;
  right_count: number | null;
  source: string;
  recorded_at: string;
}

export interface TimingPlanRow {
  id: number;
  north_straight: number;
  north_right: number;
  east_straight: number;
  east_right: number;
  south_straight: number;
  south_right: number;
  west_straight: number;
  west_right: number;
  reason: string;
  created_at: string;
  applied_at: string | null;
}

export interface SignalEventRow {
  id: number;
  side: string;
  phase: string;
  straight_color: string;
  right_color: string;
  left_color: string;
  elapsed_s: number;
  detail: string | null;
  recorded_at: string;
}

export interface AgentSent {
  counts: Record<string, number>;
  right_counts: Record<string, number>;
  through_queue_m: Record<string, number>;
  right_queue_m: Record<string, number>;
  green_pool_s: number;
}

export interface AgentReceived {
  straight_s: Record<string, number>;
  right_s: Record<string, number>;
  cycle_total_s: number;
  reason: string;
  llm: string;
}

export interface AgentExchange {
  id: number;
  at: string;
  trigger: string;
  cycle_index: number;
  duration_ms: number;
  ok: boolean;
  sent: AgentSent;
  received: AgentReceived | null;
  error: string | null;
}

export const SIDES: Side[] = ["north", "east", "south", "west"];

/** Loop order the signal engine runs. */
export const CYCLE_ORDER: Side[] = ["north", "east", "west", "south"];
