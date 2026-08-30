import type {
  AgentExchange,
  LatestCounts,
  SignalEventRow,
  SignalSnapshot,
  TimingPlan,
  TimingPlanRow,
  TrackedVehicle,
  VehicleCountRow,
  Side,
} from "./types";

/** Same host as the UI. Vite proxies /api → :8000; phones use LAN host :8000. */
function apiBase(): string {
  const { protocol, hostname, port } = window.location;
  if (port === "5173") return "/api";
  return `${protocol}//${hostname}:8000/api`;
}

export async function fetchSignal(): Promise<SignalSnapshot> {
  const r = await fetch(`${apiBase()}/signal`);
  if (!r.ok) throw new Error("Failed to fetch signal");
  return r.json();
}

export async function postCount(payload: {
  side: Side;
  vehicle_count: number;
  left_count?: number;
  straight_count?: number;
  right_count?: number;
  source?: string;
  tracks?: TrackedVehicle[];
}): Promise<VehicleCountRow> {
  const r = await fetch(`${apiBase()}/counts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("Failed to post count");
  return r.json();
}

/** Reduce queue count when cars leave on green. */
export async function postDepartures(payload: {
  side: Side;
  departed: number;
}): Promise<LatestCounts> {
  const r = await fetch(`${apiBase()}/counts/depart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("Failed to post departures");
  return r.json();
}

export async function fetchLatestCounts(): Promise<LatestCounts> {
  const r = await fetch(`${apiBase()}/counts/latest`);
  return r.json();
}

export async function fetchCountHistory(limit = 40): Promise<VehicleCountRow[]> {
  const r = await fetch(`${apiBase()}/counts/history?limit=${limit}`);
  return r.json();
}

export async function fetchPlans(limit = 10): Promise<TimingPlanRow[]> {
  const r = await fetch(`${apiBase()}/plans?limit=${limit}`);
  return r.json();
}

export async function fetchEvents(limit = 30): Promise<SignalEventRow[]> {
  const r = await fetch(`${apiBase()}/events?limit=${limit}`);
  return r.json();
}

export async function fetchAgent(): Promise<{ enabled: boolean }> {
  const r = await fetch(`${apiBase()}/agent`);
  return r.json();
}

export async function setAgent(enabled: boolean): Promise<{ enabled: boolean }> {
  const r = await fetch(`${apiBase()}/agent/${enabled ? "on" : "off"}`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`agent toggle failed (${r.status})`);
  return r.json();
}

export async function fetchAgentDebug(limit = 10): Promise<AgentExchange[]> {
  const r = await fetch(`${apiBase()}/agent/debug?limit=${limit}`);
  if (!r.ok) throw new Error(`agent debug failed (${r.status})`);
  return r.json();
}

export async function clearAgentDebug(): Promise<{ cleared: boolean }> {
  const r = await fetch(`${apiBase()}/agent/debug/clear`, { method: "POST" });
  return r.json();
}

export async function recomputeAgent(): Promise<{
  plan: TimingPlan;
  counts: LatestCounts;
  explanation: string;
}> {
  const r = await fetch(`${apiBase()}/agent/recompute`, { method: "POST" });
  return r.json();
}

export async function applyNow(): Promise<{ applied: boolean; snapshot: SignalSnapshot }> {
  const r = await fetch(`${apiBase()}/timings/apply-now`, { method: "POST" });
  return r.json();
}

export async function resetSignal(): Promise<SignalSnapshot> {
  const r = await fetch(`${apiBase()}/reset`, { method: "POST" });
  return r.json();
}

export async function fetchSim(): Promise<{ enabled: boolean }> {
  const r = await fetch(`${apiBase()}/sim`);
  return r.json();
}

export async function setSim(enabled: boolean): Promise<{ enabled: boolean }> {
  const r = await fetch(`${apiBase()}/sim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  return r.json();
}

export function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:8000/ws`;
}
