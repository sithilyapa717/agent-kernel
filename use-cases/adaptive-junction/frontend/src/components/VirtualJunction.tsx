import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { LatestCounts, Side, SignalSnapshot, TrackedVehicle } from "../types";
import { TrafficLight, type LightPos } from "./TrafficLight";

type Lane = "left" | "straight" | "right";
type Intent = "left" | "straight" | "right";

const LIGHT_POS_KEY = "junction-light-positions-v2";

/** Defaults match the in-box corner layout (N top-right, E bottom-right, S bottom-left, W top-left). */
const DEFAULT_LIGHT_POS: Record<Side, LightPos> = {
  north: { x: 62, y: 35 },
  east: { x: 65, y: 58 },
  south: { x: 38, y: 65 },
  west: { x: 35, y: 42 },
};

function loadLightPos(): Record<Side, LightPos> {
  try {
    const raw = localStorage.getItem(LIGHT_POS_KEY);
    if (!raw) return { ...DEFAULT_LIGHT_POS };
    const parsed = JSON.parse(raw) as Partial<Record<Side, LightPos>>;
    return {
      north: parsed.north ?? DEFAULT_LIGHT_POS.north,
      east: parsed.east ?? DEFAULT_LIGHT_POS.east,
      south: parsed.south ?? DEFAULT_LIGHT_POS.south,
      west: parsed.west ?? DEFAULT_LIGHT_POS.west,
    };
  } catch {
    return { ...DEFAULT_LIGHT_POS };
  }
}

interface Car {
  id: string;
  side: Side;
  lane: Lane;
  intent: Intent;
  color: string;
  /** Path along approach: SPAWN (off-screen) → STOP (line) → exit. Never decreases. */
  path: number;
  /**
   * Right-lane straight: merge into middle when a gap opens.
   * null = still looking; true = merging/merged; false unused (kept checking until true or exit).
   */
  mergeToMiddle: boolean | null;
  /** Random exit pocket (L / S / R) on the destination road for every maneuver. */
  exitLane: Lane;
  /** Camera track id when this car is mirrored from the phone feed. */
  trackId?: string;
  /** Camera said this object started moving forward. */
  camMoving?: boolean;
}

const CAR_COLORS = ["#e85d04", "#0077b6", "#2d6a4f", "#9b2226", "#6a4c93", "#bc6c25"];
const STOP = 0.3;
/** Off the visible junction — cars drive in from here. */
const SPAWN = -0.1;
/** Minimum path spacing so cars never overlap (~9% of the junction). */
const CAR_GAP = 0.085;
/** How close in path another car must be to block a merge. */
const MERGE_GAP = CAR_GAP * 1.4;
const MAX_QUEUE = 24;
const PATH_ORIGIN = -5;
const PATH_SPAN = 110;
/** Constant on-screen speed (% of junction / second) for all normal motion. */
const GEO_SPEED = 16;
/** Slower only while hunting for a lane-change gap. */
const GEO_SPEED_YIELD = 7;
const PATH_EPS = 0.005;
const EXIT_LEN = 40;
/** Shared path length through the junction for straight / right. */
const MANEUVER_LEN = 0.36;
/**
 * Minimum swing along the exit road for a left turn. The near exit lane sits only
 * ~4 units past the stop line, so without this the 90° of yaw lands in half a car
 * length and reads as a snap.
 */
const MIN_LEFT_REACH = 13;
/** Past this, car is committed and must clear even if light goes red. */
const COMMITTED = STOP + 0.015;
/**
 * On-screen gap kept between cars converging on the same exit lane from different
 * approaches. Path units are per-approach and not comparable, so this one is measured
 * in real junction distance.
 */
const EXIT_SEP = 8;
/** Clearance a left turner needs around its landing spot before it commits. */
const JOIN_LOOK_BACK = 12;
const JOIN_LOOK_AHEAD = 8;

interface Props {
  snapshot: SignalSnapshot;
  counts: LatestCounts;
  onCountsChange?: (counts: LatestCounts) => void;
  /** Cars released onto each approach per second (SIM / animate mode). */
  spawnRate?: number;
  /** Bump to wipe every car off the junction (and reset spawn clocks). */
  clearToken?: number;
  /**
   * When false (SIM OFF): only show a static queue matching counts/tracks.
   * No driving through the box — decreasing the queue just removes cars.
   */
  simOn?: boolean;
}

export const DEFAULT_SPAWN_RATE = 2;
const ALL_SIDES: Side[] = ["north", "east", "south", "west"];

function intentAllowed(snap: SignalSnapshot, side: Side, intent: Intent): boolean {
  const lamps = snap.sides?.[side]?.lamps;
  if (!lamps) return false;
  // Left is always permitted (filter) — go when there's space
  if (intent === "left") return true;
  if (intent === "right") return lamps.right === "green";
  return lamps.straight === "green";
}

function pickVehicle(
  side: Side,
  counts: LatestCounts,
  preferLeft: boolean
): { lane: Lane; intent: Intent } {
  // On red/yellow approaches left is the movement that can still go — spawn those
  if (preferLeft && Math.random() < 0.62) {
    return { lane: "left", intent: "left" };
  }

  const n = counts[side] ?? 0;
  const rightShare =
    (counts[`${side}_right` as keyof LatestCounts] as number | null | undefined) ?? null;
  const roll = Math.random();
  let intent: Intent = "straight";
  if (rightShare != null && n > 0) {
    const frac = Math.min(0.55, rightShare / n);
    if (roll < frac) intent = "right";
    else if (roll < frac + 0.25) intent = "left";
  } else if (roll < 0.18) intent = "right";
  else if (roll < 0.38) intent = "left";

  if (intent === "left") return { lane: "left", intent };
  if (intent === "right") return { lane: "right", intent };
  if (Math.random() < 0.28) return { lane: "right", intent: "straight" };
  return { lane: "straight", intent: "straight" };
}

function pickExitLane(): Lane {
  const r = Math.random();
  if (r < 1 / 3) return "left";
  if (r < 2 / 3) return "straight";
  return "right";
}

function exitAt(side: Side, intent: Intent = "straight", exitLane: Lane = "right"): number {
  const man = intent === "left" ? leftPathLen(side, exitLane) : MANEUVER_LEN;
  return STOP + man + EXIT_LEN / PATH_SPAN;
}

/** True if `targetLane` has a free slot near this car's path. */
function mergeGapClear(car: Car, list: Car[], targetLane: Lane): boolean {
  for (const other of list) {
    if (other.id === car.id || other.side !== car.side) continue;
    if (!Number.isFinite(other.path)) continue;
    const onTarget =
      other.lane === targetLane ||
      (other.lane === "right" &&
        other.intent === "straight" &&
        other.mergeToMiddle === true &&
        targetLane === "straight");
    if (!onTarget) continue;
    if (Math.abs(other.path - car.path) < MERGE_GAP) return false;
  }
  return true;
}

/** Keep clear of cars already on / merging into a lane. */
function spacingVsLane(car: Car, list: Car[], targetLane: Lane, cap: number): number {
  let next = cap;
  for (const other of list) {
    if (other.id === car.id || other.side !== car.side) continue;
    if (!Number.isFinite(other.path)) continue;
    const onTarget =
      other.lane === targetLane ||
      (other.lane === "right" &&
        other.intent === "straight" &&
        other.mergeToMiddle === true &&
        targetLane === "straight");
    if (!onTarget) continue;
    if (other.path > car.path) {
      next = Math.min(next, other.path - CAR_GAP);
    }
  }
  return next;
}

/** True if a car already in the box is using this left-exit pocket tightly ahead. */
function leftExitSpotClear(car: Car, list: Car[], exitLane: Lane): boolean {
  for (const other of list) {
    if (other.id === car.id || other.side !== car.side) continue;
    if (!Number.isFinite(other.path)) continue;
    if (other.intent !== "left" || other.exitLane !== exitLane) continue;
    // Only cars already past the stop line count — queued cars behind must not block
    if (other.path < COMMITTED) continue;
    if (other.path > car.path && other.path - Math.max(car.path, STOP) < MERGE_GAP * 1.25) {
      return false;
    }
  }
  return true;
}

/** Road a maneuver ends up on. Three streams can feed the same arm. */
type Arm = "north" | "east" | "south" | "west";

function exitArm(side: Side, intent: Intent): Arm {
  if (side === "north") return intent === "straight" ? "south" : intent === "left" ? "east" : "west";
  if (side === "east") return intent === "straight" ? "west" : intent === "left" ? "south" : "north";
  if (side === "south") return intent === "straight" ? "north" : intent === "left" ? "west" : "east";
  return intent === "straight" ? "east" : intent === "left" ? "north" : "south";
}

/** Distance outward along an arm — higher means further from the junction. */
function armProgress(arm: Arm, x: number, y: number): number {
  if (arm === "east") return x;
  if (arm === "west") return -x;
  if (arm === "south") return y;
  return -y;
}

/** Two cars with the same key are headed for the same physical lane. */
function exitLaneKey(side: Side, intent: Intent, exitLane: Lane): string {
  return `${exitArm(side, intent)}|${resolveExitLat(side, intent, exitLane).toFixed(1)}`;
}

type ExitSlot = { key: string; prog: number };

function exitSlotFor(car: Car): ExitSlot {
  const exit: Lane = car.exitLane ?? "straight";
  const pose = samplePath(car.side, car.lane, car.intent, car.path, car.mergeToMiddle, exit);
  return {
    key: exitLaneKey(car.side, car.intent, exit),
    prog: armProgress(exitArm(car.side, car.intent), pose.x, pose.y),
  };
}

/**
 * Where every committed car sits on the lane it is claiming. Cars still waiting at
 * the line are left out on purpose — they are not in the junction yet and must not
 * make cross traffic brake for them.
 */
function buildExitSlots(list: Car[]): Map<string, ExitSlot> {
  const slots = new Map<string, ExitSlot>();
  for (const car of list) {
    if (!Number.isFinite(car.path) || car.path < COMMITTED) continue;
    slots.set(car.id, exitSlotFor(car));
  }
  return slots;
}

/** Gap to the nearest car ahead on the same exit lane, from any approach. */
function nearestExitGap(id: string, slots: Map<string, ExitSlot>, self: ExitSlot): number {
  let gap = Number.POSITIVE_INFINITY;
  for (const [otherId, other] of slots) {
    if (otherId === id || other.key !== self.key) continue;
    const d = other.prog - self.prog;
    if (d > 0 && d < gap) gap = d;
  }
  return gap;
}

/** Landing spot for a left turn into `lane`, projected onto that lane. */
function leftJoinProgress(car: Car, lane: Lane): number {
  const end = STOP + leftPathLen(car.side, lane);
  const pose = samplePath(car.side, car.lane, "left", end, car.mergeToMiddle, lane);
  return armProgress(exitArm(car.side, "left"), pose.x, pose.y);
}

/** True if nothing from any approach is sitting where this left turn would land. */
function joinClear(car: Car, slots: Map<string, ExitSlot>, lane: Lane): boolean {
  const key = exitLaneKey(car.side, "left", lane);
  const p = leftJoinProgress(car, lane);
  for (const [otherId, other] of slots) {
    if (otherId === car.id || other.key !== key) continue;
    const d = other.prog - p;
    if (d > -JOIN_LOOK_BACK && d < JOIN_LOOK_AHEAD) return false;
  }
  return true;
}

/** First exit pocket free of both same-approach and cross-approach traffic. */
function pickClearLeftExit(
  car: Car,
  list: Car[],
  slots: Map<string, ExitSlot>
): { lane: Lane; clear: boolean } {
  const order: Lane[] = [car.exitLane, "left", "straight", "right"];
  const seen = new Set<Lane>();
  for (const lane of order) {
    if (seen.has(lane)) continue;
    seen.add(lane);
    if (leftExitSpotClear(car, list, lane) && joinClear(car, slots, lane)) {
      return { lane, clear: true };
    }
  }
  return { lane: car.exitLane, clear: false };
}

export function VirtualJunction({
  snapshot,
  counts,
  onCountsChange,
  spawnRate = DEFAULT_SPAWN_RATE,
  clearToken = 0,
  simOn = true,
}: Props) {
  const [cars, setCars] = useState<Car[]>([]);
  const [lightPos, setLightPos] = useState<Record<Side, LightPos>>(loadLightPos);
  const carsRef = useRef<Car[]>([]);
  const idRef = useRef(0);
  const snapRef = useRef(snapshot);
  const countsRef = useRef(counts);
  const onCountsRef = useRef(onCountsChange);
  const spawnRateRef = useRef(spawnRate);
  const simOnRef = useRef(simOn);
  /** Time banked toward the next release on each approach. */
  const spawnClock = useRef<Record<Side, number>>({ north: 0, east: 0, south: 0, west: 0 });
  /** Camera tracks that already drove through — don't respawn until the object leaves the frame. */
  const departedCam = useRef(new Set<string>());
  snapRef.current = snapshot;
  countsRef.current = counts;
  onCountsRef.current = onCountsChange;
  spawnRateRef.current = spawnRate;
  simOnRef.current = simOn;

  // Wipe the road when the dashboard bumps clearToken (SIM-off clear button)
  useEffect(() => {
    if (clearToken <= 0) return;
    carsRef.current = [];
    setCars([]);
    spawnClock.current = { north: 0, east: 0, south: 0, west: 0 };
    departedCam.current.clear();
  }, [clearToken]);

  // SIM OFF: pull any cars out of the box back into a static queue (or drop them)
  useEffect(() => {
    if (simOn) return;
    departedCam.current.clear();
    const list = carsRef.current;
    let dirty = false;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].path >= COMMITTED) {
        list.splice(i, 1);
        dirty = true;
      } else if (list[i].path > STOP) {
        list[i].path = STOP;
        dirty = true;
      }
    }
    if (dirty) {
      carsRef.current = list;
      setCars([...list]);
    }
  }, [simOn]);

  function moveLight(side: Side, pos: LightPos) {
    setLightPos((prev) => {
      const next = { ...prev, [side]: pos };
      try {
        localStorage.setItem(LIGHT_POS_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota */
      }
      return next;
    });
  }

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    /**
     * Keep cars matched to the latest absolute count — or, when the phone sends
     * live tracks, mirror that stack (lane + depth) 1:1.
     * SIM OFF = queue display only (no drive-through).
     */
    const syncCarsToCounts = (list: Car[], snap: SignalSnapshot, dt: number): boolean => {
      const counts = countsRef.current;
      const queueOnly = !simOnRef.current;
      const interval = 1 / Math.max(0.05, spawnRateRef.current);
      let changed = false;

      for (const side of ALL_SIDES) {
        const camTracks = (counts.tracks?.[side] ?? []) as TrackedVehicle[];
        if (camTracks.length > 0) {
          if (syncSideFromTracks(list, side, camTracks, snap, dt, queueOnly)) changed = true;
          continue;
        }

        const target = Math.min(MAX_QUEUE, Math.max(0, Math.round(counts[side] ?? 0)));

        // Drop leftover camera cars if this side switched to count-only
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].side === side && list[i].trackId) {
            list.splice(i, 1);
            changed = true;
          }
        }

        // Queue-only: never keep cars past the stop line
        if (queueOnly) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].side !== side) continue;
            if (list[i].path >= COMMITTED) {
              list.splice(i, 1);
              changed = true;
            } else if (list[i].path > STOP) {
              list[i].path = STOP;
              changed = true;
            }
          }
        }

        let onSide = list.filter((c) => c.side === side).length;

        if (onSide > target) {
          const ranked = list
            .filter((c) => c.side === side)
            .sort((a, b) => a.path - b.path);
          const drop = new Set(ranked.slice(0, onSide - target).map((c) => c.id));
          for (let i = list.length - 1; i >= 0; i--) {
            if (drop.has(list[i].id)) {
              list.splice(i, 1);
              changed = true;
            }
          }
          onSide = target;
        }

        // Restack remaining cars into a neat queue (SIM OFF) or keep free motion (SIM ON)
        if (queueOnly) {
          const byLane = new Map<Lane, Car[]>();
          for (const c of list) {
            if (c.side !== side) continue;
            if (!byLane.has(c.lane)) byLane.set(c.lane, []);
            byLane.get(c.lane)!.push(c);
          }
          for (const group of byLane.values()) {
            group.sort((a, b) => b.path - a.path);
            for (let i = 0; i < group.length; i++) {
              const want = STOP - i * CAR_GAP;
              if (Math.abs(group[i].path - want) > 0.0005) {
                group[i].path = want;
                changed = true;
              }
            }
          }
        }

        if (queueOnly) {
          // Instant fill to match absolute count — no spawn metering
          const need = target - onSide;
          if (need <= 0) continue;
          const straightLamp = snap?.sides?.[side]?.lamps?.straight;
          const preferLeft = straightLamp !== "green";
          for (let n = 0; n < need; n++) {
            idRef.current += 1;
            const leftOnSide = list.filter((c) => c.side === side && c.intent === "left").length;
            const forceLeft = preferLeft && leftOnSide < 1;
            const { lane, intent } = forceLeft
              ? { lane: "left" as Lane, intent: "left" as Intent }
              : pickVehicle(side, counts, preferLeft);
            const onLane = list.filter((c) => c.side === side && c.lane === lane);
            const path = STOP - onLane.length * CAR_GAP;
            list.push({
              id: `${side}-${idRef.current}`,
              side,
              lane,
              intent,
              color: CAR_COLORS[idRef.current % CAR_COLORS.length],
              path: Math.min(STOP, path),
              mergeToMiddle: null,
              exitLane: pickExitLane(),
            });
            changed = true;
          }
          continue;
        }

        const banked = Math.min(interval * 2, (spawnClock.current[side] ?? 0) + dt);
        spawnClock.current[side] = banked;
        if (banked < interval) continue;

        const need = target - onSide;
        if (need <= 0) continue;

        spawnClock.current[side] = banked - interval;
        const straightLamp = snap?.sides?.[side]?.lamps?.straight;
        const preferLeft = straightLamp !== "green";
        const leftOnSide = list.filter((c) => c.side === side && c.intent === "left").length;
        idRef.current += 1;
        const forceLeft = preferLeft && leftOnSide < 1;
        const { lane, intent } = forceLeft
          ? { lane: "left" as Lane, intent: "left" as Intent }
          : pickVehicle(side, counts, preferLeft);
        const onLane = list.filter((c) => c.side === side && c.lane === lane);
        const tail = onLane.length ? Math.min(...onLane.map((c) => c.path)) : SPAWN;
        list.push({
          id: `${side}-${idRef.current}`,
          side,
          lane,
          intent,
          color: CAR_COLORS[idRef.current % CAR_COLORS.length],
          path: Math.min(SPAWN, tail - CAR_GAP),
          mergeToMiddle: null,
          exitLane: pickExitLane(),
        });
        changed = true;
      }
      return changed;
    };

    /** Mirror phone tracks into the approach queue (static when SIM OFF). */
    const syncSideFromTracks = (
      list: Car[],
      side: Side,
      tracks: TrackedVehicle[],
      _snap: SignalSnapshot,
      dt: number,
      queueOnly: boolean
    ): boolean => {
      let changed = false;
      const byId = new Map(
        list.filter((c) => c.side === side && c.trackId).map((c) => [c.trackId!, c])
      );
      const keep = new Set<string>();

      for (const tr of tracks) {
        const key = `${side}:${tr.track_id}`;
        keep.add(tr.track_id);
        if (!queueOnly && departedCam.current.has(key)) continue;

        let car = byId.get(tr.track_id);
        // Depth 0 far → SPAWN, depth 1 near → STOP (stacked like the camera)
        const wantPath = SPAWN + (STOP - SPAWN) * Math.min(1, Math.max(0, tr.depth));
        const intent = tr.intent;
        const lane = tr.lane;

        if (!car) {
          idRef.current += 1;
          car = {
            id: `cam-${side}-${tr.track_id}`,
            side,
            lane,
            intent,
            color: CAR_COLORS[idRef.current % CAR_COLORS.length],
            path: Math.min(STOP, wantPath),
            mergeToMiddle: null,
            exitLane: pickExitLane(),
            trackId: tr.track_id,
            camMoving: tr.moving,
          };
          list.push(car);
          changed = true;
        } else {
          if (car.lane !== lane) {
            car.lane = lane;
            changed = true;
          }
          if (car.intent !== intent) {
            car.intent = intent;
            changed = true;
          }
          if (car.camMoving !== tr.moving) {
            car.camMoving = tr.moving;
            changed = true;
          }
          if (queueOnly) {
            // Static queue: snap to camera depth, never enter the box
            const next = Math.min(STOP, wantPath);
            if (Math.abs(car.path - next) > 0.0005) {
              car.path = next;
              changed = true;
            }
          } else if (car.path < COMMITTED) {
            const target = tr.moving ? Math.min(STOP, Math.max(wantPath, STOP - 0.002)) : wantPath;
            const next = car.path + (target - car.path) * Math.min(1, dt * 5);
            if (Math.abs(next - car.path) > 0.0005) {
              car.path = next;
              changed = true;
            }
          }
        }
      }

      for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (c.side !== side) continue;
        // Queue-only: drop as soon as the camera drops the track (count down = remove)
        if (c.trackId && !keep.has(c.trackId) && (queueOnly || c.path < COMMITTED)) {
          list.splice(i, 1);
          changed = true;
        }
      }

      if (!queueOnly) {
        for (const key of [...departedCam.current]) {
          if (!key.startsWith(`${side}:`)) continue;
          const tid = key.slice(side.length + 1);
          if (!keep.has(tid)) departedCam.current.delete(key);
        }
      }

      return changed;
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const snap = snapRef.current;
      const list = carsRef.current;
      const queueOnly = !simOnRef.current;

      const spawned = snap?.sides ? syncCarsToCounts(list, snap, dt) : false;

      // SIM OFF: only sync the static queue — no path animation through the junction
      if (queueOnly) {
        if (spawned) {
          carsRef.current = list;
          setCars([...list]);
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      if (!list.length || !snap?.sides) {
        if (spawned) {
          carsRef.current = list;
          setCars([...list]);
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      const byLane = new Map<string, Car[]>();
      for (const c of list) {
        const k = `${c.side}:${c.lane}`;
        if (!byLane.has(k)) byLane.set(k, []);
        byLane.get(k)!.push(c);
      }

      const slots = buildExitSlots(list);
      const finished: Car[] = [];
      let dirty = spawned;

      for (const group of byLane.values()) {
        group.sort((a, b) => b.path - a.path); // index 0 = furthest ahead

        // Lane-change yield cascades back so followers match the crawl (not race-then-stop)
        let aheadYielding = false;

        for (let i = 0; i < group.length; i++) {
          const car = group[i];
          const ahead = i === 0 ? null : group[i - 1];
          const signalOk = intentAllowed(snap, car.side, car.intent);
          const committed = car.path >= COMMITTED;

          // Hard spacing behind the car in front (never push path backward)
          let cap = ahead && Number.isFinite(ahead.path) ? ahead.path - CAR_GAP : Number.POSITIVE_INFINITY;
          /** Only true for blocked right→middle lane change (and cars stuck behind that). */
          let yielding: boolean = aheadYielding;

          if (!committed) {
            const blockersAhead = group.slice(0, i).filter((c) => c.path < COMMITTED).length;
            const stopCap = STOP - blockersAhead * CAR_GAP;
            const clearToEnter = !ahead || ahead.path >= COMMITTED + CAR_GAP * 0.5;

            // Camera cars stay put until the phone marks them moving (waiting left OK)
            const camHold = Boolean(car.trackId) && !car.camMoving;

            let canEnter = !camHold && signalOk && clearToEnter;

            // Left filter gives way like a real unprotected turn: take the first exit
            // pocket that is free, and hold at the line if every one is occupied.
            if (!camHold && car.intent === "left" && clearToEnter) {
              const spot = pickClearLeftExit(car, list, slots);
              if (spot.lane !== car.exitLane) {
                car.exitLane = spot.lane;
                dirty = true;
              }
              canEnter = spot.clear;
            }

            if (!canEnter) {
              cap = Math.min(cap, stopCap);
            }
          }

          // Right→middle merge: slow only while hunting a gap beside an occupied lane
          if (car.lane === "right" && car.intent === "straight" && car.path >= STOP) {
            if (car.mergeToMiddle !== true) {
              if (mergeGapClear(car, list, "straight")) {
                car.mergeToMiddle = true;
                dirty = true;
              } else if (car.path < STOP + MANEUVER_LEN * 0.8) {
                yielding = true;
              }
            }
            if (car.mergeToMiddle === true) {
              cap = spacingVsLane(car, list, "straight", cap);
            }
          }

          // Left turners already in the box: keep spacing on the same exit pocket
          if (car.intent === "left" && car.path >= STOP) {
            for (const other of list) {
              if (other.id === car.id || other.side !== car.side) continue;
              if (other.intent !== "left" || other.exitLane !== car.exitLane) continue;
              if (!Number.isFinite(other.path) || other.path < STOP) continue;
              if (other.path > car.path) {
                cap = Math.min(cap, other.path - CAR_GAP);
              }
            }
          }

          // Same exit pocket / same intent in the box — don't pile into each other
          if (car.path >= STOP && car.intent !== "left") {
            for (const other of list) {
              if (other.id === car.id || other.side !== car.side) continue;
              if (other.path < STOP || !Number.isFinite(other.path)) continue;
              if (other.intent !== car.intent || other.exitLane !== car.exitLane) continue;
              if (other.path > car.path) {
                cap = Math.min(cap, other.path - CAR_GAP);
              }
            }
          }

          if (!Number.isFinite(cap)) cap = Number.POSITIVE_INFINITY;
          if (!Number.isFinite(car.path)) car.path = SPAWN;

          const dens = pathDensity(car, car.path);

          // Three streams can feed one exit lane (a left filter, the green approach
          // going straight, and the opposite approach turning right). Whoever is
          // further along the lane has priority; the one behind keeps a real gap.
          const slot = slots.get(car.id);
          if (slot) {
            const room = nearestExitGap(car.id, slots, slot) - EXIT_SEP;
            if (Number.isFinite(room)) {
              cap = Math.min(cap, car.path + Math.max(0, room) / Math.max(1, dens));
            }
          }

          // One on-screen speed for all motion; yield only for lane-change gap hunt (+ followers)
          const geo = (yielding ? GEO_SPEED_YIELD : GEO_SPEED) * turnEase(car);
          const rate = geo / dens;
          const next = Math.min(car.path + rate * dt, cap);
          // Path must never decrease — avoids NaN/jitter wiping cars off the board
          if (Number.isFinite(next) && next > car.path) {
            car.path = next;
            // Keep the lane map fresh so cars later in this frame see the new spot
            if (slot) slots.set(car.id, exitSlotFor(car));
            dirty = true;
          }

          aheadYielding = yielding;

          if (car.path >= exitAt(car.side, car.intent, car.exitLane)) {
            finished.push(car);
          }
        }
      }

      if (finished.length) {
        for (const c of finished) {
          if (c.trackId) departedCam.current.add(`${c.side}:${c.trackId}`);
        }
        const drop = new Set(finished);
        carsRef.current = list.filter((c) => !drop.has(c));
        setCars([...carsRef.current]);
      } else if (dirty) {
        setCars([...list]);
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="junction-stage">
      <div className="junction">
        <div className="road road-ns">
          <div className="carriage southbound" />
          <div className="carriage northbound" />
        </div>
        <div className="road road-ew">
          <div className="carriage westbound" />
          <div className="carriage eastbound" />
        </div>

        <LaneArrows />

        <div className="lane-guide lg-v lg-ns-e-a" aria-hidden />
        <div className="lane-guide lg-v lg-ns-e-b" aria-hidden />
        <div className="lane-guide lg-v lg-ns-e-a exit" aria-hidden />
        <div className="lane-guide lg-v lg-ns-e-b exit" aria-hidden />
        <div className="lane-guide lg-v lg-ns-w-a" aria-hidden />
        <div className="lane-guide lg-v lg-ns-w-b" aria-hidden />
        <div className="lane-guide lg-v lg-ns-w-a exit" aria-hidden />
        <div className="lane-guide lg-v lg-ns-w-b exit" aria-hidden />
        <div className="lane-guide lg-h lg-ew-s-a" aria-hidden />
        <div className="lane-guide lg-h lg-ew-s-b" aria-hidden />
        <div className="lane-guide lg-h lg-ew-s-a exit" aria-hidden />
        <div className="lane-guide lg-h lg-ew-s-b exit" aria-hidden />
        <div className="lane-guide lg-h lg-ew-n-a" aria-hidden />
        <div className="lane-guide lg-h lg-ew-n-b" aria-hidden />
        <div className="lane-guide lg-h lg-ew-n-a exit" aria-hidden />
        <div className="lane-guide lg-h lg-ew-n-b exit" aria-hidden />

        <div className="divider divider-ns" />
        <div className="divider divider-ew" />
        <div className="stop-line stop-n" />
        <div className="stop-line stop-s" />
        <div className="stop-line stop-e" />
        <div className="stop-line stop-w" />
        <div className="intersection-box" />

        {(["north", "east", "south", "west"] as Side[]).map((side) =>
          snapshot.sides[side] ? (
            <TrafficLight
              key={side}
              side={side}
              state={snapshot.sides[side]}
              active={snapshot.active_side === side}
              pos={lightPos[side]}
              onPosChange={moveLight}
            />
          ) : null
        )}

        <div className="side-label label-north">NORTH</div>
        <div className="side-label label-east">EAST</div>
        <div className="side-label label-south">SOUTH</div>
        <div className="side-label label-west">WEST</div>
        <div className="lht-badge">LHT</div>

        {cars.map((car) => (
          <div
            key={car.id}
            className={`toy-car lane-${car.lane} intent-${car.intent}`}
            style={{ ...carStyle(car), background: car.color }}
          />
        ))}
      </div>
    </div>
  );
}

function driverPockets(side: Side): Record<Lane, number> {
  switch (side) {
    case "north":
      return { left: 68, straight: 61, right: 53.5 };
    case "south":
      return { left: 32, straight: 39, right: 46.5 };
    case "east":
      return { left: 68, straight: 61, right: 53.5 };
    case "west":
      return { left: 32, straight: 39, right: 46.5 };
  }
}

function LaneArrows() {
  const LEFT = "↳";
  const STRAIGHT = "↓";
  const RIGHT = "↲";
  const mk = (side: Side, lane: Lane, symbol: string) => {
    const p = driverPockets(side)[lane];
    const style: CSSProperties =
      side === "north"
        ? { left: `${p}%`, top: "16%" }
        : side === "south"
          ? { left: `${p}%`, top: "80%" }
          : side === "east"
            ? { left: "80%", top: `${p}%` }
            : { left: "16%", top: `${p}%` };
    return (
      <span key={`${side}-${lane}`} className={`lane-arrow face-${side}`} style={style} aria-hidden>
        {symbol}
      </span>
    );
  };
  return (
    <div className="lane-arrow-layer" aria-hidden>
      {(["north", "south", "east", "west"] as Side[]).flatMap((side) => [
        mk(side, "left", LEFT),
        mk(side, "straight", STRAIGHT),
        mk(side, "right", RIGHT),
      ])}
    </div>
  );
}

type Pose = { x: number; y: number; rot: number };
type Curve = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  startRot: number;
  endRot: number;
};

function along(p: number): number {
  return PATH_ORIGIN + p * PATH_SPAN;
}

function approachPose(side: Side, lat: number, prog: number): Pose {
  if (side === "north") return { x: lat, y: along(prog), rot: 180 };
  if (side === "south") return { x: lat, y: PATH_ORIGIN + PATH_SPAN - prog * PATH_SPAN, rot: 0 };
  if (side === "east") return { x: PATH_ORIGIN + PATH_SPAN - prog * PATH_SPAN, y: lat, rot: -90 };
  return { x: along(prog), y: lat, rot: 90 };
}

/** Outbound L/S/R laterals after a left or right turn. */
function exitPockets(from: Side, intent: Intent): Record<Lane, number> {
  if (intent === "left") {
    if (from === "north" || from === "west") return { left: 32, straight: 39, right: 46.5 };
    return { left: 68, straight: 61, right: 53.5 };
  }
  // right
  if (from === "north" || from === "west") return { left: 68, straight: 61, right: 53.5 };
  return { left: 32, straight: 39, right: 46.5 };
}

/**
 * Straight-through exit pockets: stay on the same carriageway half.
 */
function straightExitPockets(from: Side): Record<Lane, number> {
  if (from === "south") return { left: 32, straight: 39, right: 46.5 }; // northbound
  if (from === "north") return { left: 68, straight: 61, right: 53.5 }; // southbound
  if (from === "west") return { left: 32, straight: 39, right: 46.5 }; // eastbound
  return { left: 68, straight: 61, right: 53.5 }; // westbound
}

function resolveExitLat(from: Side, intent: Intent, exitLane: Lane): number {
  const lane: Lane =
    exitLane === "left" || exitLane === "straight" || exitLane === "right" ? exitLane : "straight";
  if (intent === "straight") return straightExitPockets(from)[lane];
  return exitPockets(from, intent)[lane];
}

function cubic1d(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function cubic1dDt(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

/** Shortest-path angle blend — avoids a visual 270° spin. */
function lerpRot(from: number, to: number, t: number): number {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return from + d * t;
}

function smoothstep(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
}

function sampleCurve(c: Curve, t: number): Pose {
  const u = Math.min(1, Math.max(0, t));
  const x = cubic1d(u, c.x0, c.x1, c.x2, c.x3);
  const y = cubic1d(u, c.y0, c.y1, c.y2, c.y3);
  return { x, y, rot: lerpRot(c.startRot, c.endRot, u) };
}

/**
 * Left turn described in the car's own frame: `f` = direction of travel,
 * `l` = the way it turns. `depth` is how far ahead the exit lane sits, `reach`
 * how far it runs out along that lane before the maneuver ends.
 */
type LeftTurn = {
  sx: number;
  sy: number;
  fx: number;
  fy: number;
  lx: number;
  ly: number;
  depth: number;
  reach: number;
  startRot: number;
};

function leftTurn(side: Side, exitLane: Lane): LeftTurn {
  const start = approachPose(side, driverPockets(side).left, STOP);
  const dest = resolveExitLat(side, "left", exitLane);
  let fx = 0;
  let fy = 0;
  let lx = 0;
  let ly = 0;
  let depth = 0;
  let startRot = 0;

  if (side === "north") {
    fy = 1;
    lx = 1;
    depth = dest - start.y;
    startRot = 180;
  } else if (side === "south") {
    fy = -1;
    lx = -1;
    depth = start.y - dest;
    startRot = 0;
  } else if (side === "east") {
    fx = -1;
    ly = 1;
    depth = start.x - dest;
    startRot = -90;
  } else {
    fx = 1;
    ly = -1;
    depth = dest - start.x;
    startRot = 90;
  }

  depth = Math.max(3, depth);
  return { sx: start.x, sy: start.y, fx, fy, lx, ly, depth, reach: Math.max(MIN_LEFT_REACH, depth), startRot };
}

/** Bezier control weight that makes a cubic match a quarter circle. */
const ARC_K = 0.5523;
/** Comfortable yaw rate (rad/s). Turn speed is derived from this so tight corners crawl. */
const TURN_YAW = 1.25;

/** Corner arc radius, then how much straight run-out follows it. */
function leftSegments(g: LeftTurn): { r: number; arc: number; tail: number; total: number } {
  const r = g.depth;
  const arc = (Math.PI / 2) * r;
  const tail = Math.max(0, g.reach - r);
  return { r, arc, tail, total: arc + tail };
}

/** Maneuver length in path units, matched to real on-screen distance. */
function leftPathLen(side: Side, exitLane: Lane): number {
  return leftSegments(leftTurn(side, exitLane)).total / PATH_SPAN;
}

/**
 * Constant-radius corner arc onto the exit lane, then straight out along it.
 * Even curvature is what keeps the yaw rate flat — a wide-then-tight curve spikes
 * the rotation at one end and that spike is what reads as a snap.
 */
function sampleLeftSmooth(side: Side, exitLane: Lane, t: number): Pose {
  const g = leftTurn(side, exitLane);
  const seg = leftSegments(g);
  const s = Math.min(1, Math.max(0, t)) * seg.total;

  let a: number;
  let b: number;
  let swept: number;

  if (s <= seg.arc) {
    const u = s / Math.max(0.001, seg.arc);
    const k = ARC_K * seg.r;
    a = cubic1d(u, 0, k, seg.r, seg.r);
    b = cubic1d(u, 0, 0, seg.r - k, seg.r);
    const da = cubic1dDt(u, 0, k, seg.r, seg.r);
    const db = cubic1dDt(u, 0, 0, seg.r - k, seg.r);
    swept = (Math.atan2(Math.max(0, db), Math.max(0, da)) * 180) / Math.PI;
  } else {
    a = seg.r;
    b = seg.r + (s - seg.arc);
    swept = 90;
  }

  return {
    x: g.sx + g.fx * a + g.lx * b,
    y: g.sy + g.fy * a + g.ly * b,
    rot: g.startRot - swept,
  };
}

/**
 * Speed through a left turn, set so the car sweeps 90° at a steady, readable rate
 * instead of whipping around. Eases in before the stop line and picks back up once
 * the car is straightened out on the exit lane.
 */
function turnEase(car: Car): number {
  if (car.intent !== "left") return 1;
  const g = leftTurn(car.side, car.exitLane ?? "straight");
  const seg = leftSegments(g);
  const t = (car.path - STOP) / Math.max(0.001, seg.total / PATH_SPAN);
  const arcEnd = seg.arc / seg.total;
  if (t <= -0.5 || t >= arcEnd + 0.5) return 1;

  const floor = Math.min(1, Math.max(0.3, (seg.r * TURN_YAW) / GEO_SPEED));
  const ramp =
    t < 0
      ? smoothstep((t + 0.5) / 0.5)
      : t <= arcEnd
        ? 1
        : smoothstep((arcEnd + 0.5 - t) / 0.5);
  return 1 - (1 - floor) * ramp;
}

/** Smooth junction curve: entry pocket → chosen exit pocket (L / S / R). */
function maneuverCurve(side: Side, lane: Lane, intent: Intent, exitLane: Lane): Curve {
  const start = approachPose(side, driverPockets(side)[lane], STOP);
  const dest = resolveExitLat(side, intent, exitLane);

  if (intent === "straight") {
    if (side === "north") {
      return {
        x0: start.x, y0: start.y,
        x1: start.x, y1: 45,
        x2: dest, y2: 55,
        x3: dest, y3: 72,
        startRot: 180, endRot: 180,
      };
    }
    if (side === "south") {
      return {
        x0: start.x, y0: start.y,
        x1: start.x, y1: 55,
        x2: dest, y2: 45,
        x3: dest, y3: 28,
        startRot: 0, endRot: 0,
      };
    }
    if (side === "east") {
      return {
        x0: start.x, y0: start.y,
        x1: 55, y1: start.y,
        x2: 45, y2: dest,
        x3: 28, y3: dest,
        startRot: -90, endRot: -90,
      };
    }
    return {
      x0: start.x, y0: start.y,
      x1: 45, y1: start.y,
      x2: 55, y2: dest,
      x3: 72, y3: dest,
      startRot: 90, endRot: 90,
    };
  }

  if (intent === "left") {
    // Handled by sampleLeftSmooth / leftTurnBezier
    return {
      x0: start.x, y0: start.y,
      x1: start.x, y1: start.y,
      x2: start.x, y2: start.y,
      x3: start.x, y3: start.y,
      startRot: start.rot, endRot: start.rot,
    };
  }

  // right turn — short 90° right; exit furthest along outbound (no bounce)
  if (side === "north") {
    // heading south → right = west
    return {
      x0: start.x,
      y0: start.y,
      x1: start.x,
      y1: (start.y + dest) / 2,
      x2: (start.x + 30) / 2,
      y2: dest,
      x3: 25,
      y3: dest,
      startRot: 180,
      endRot: -90,
    };
  }
  if (side === "south") {
    // heading north → right = east
    return {
      x0: start.x,
      y0: start.y,
      x1: start.x,
      y1: (start.y + dest) / 2,
      x2: (start.x + 70) / 2,
      y2: dest,
      x3: 75,
      y3: dest,
      startRot: 0,
      endRot: 90,
    };
  }
  if (side === "east") {
    // heading west → right = north
    return {
      x0: start.x,
      y0: start.y,
      x1: (start.x + dest) / 2,
      y1: start.y,
      x2: dest,
      y2: (start.y + 30) / 2,
      x3: dest,
      y3: 25,
      startRot: -90,
      endRot: 0,
    };
  }
  // west: heading east → right = south
  return {
    x0: start.x,
    y0: start.y,
    x1: (start.x + dest) / 2,
    y1: start.y,
    x2: dest,
    y2: (start.y + 70) / 2,
    x3: dest,
    y3: 75,
    startRot: 90,
    endRot: 180,
  };
}

function cruiseAfter(side: Side, intent: Intent, end: Pose, extra: number, dest: number): Pose {
  const u = Math.min(1, Math.max(0, extra));
  const d = u * EXIT_LEN;

  if (intent === "straight") {
    // Gentle lateral settle over the whole exit — no early snap that eats forward speed
    const ease = u * u * (3 - 2 * u);
    if (side === "north") return { x: end.x + (dest - end.x) * ease, y: end.y + d, rot: 180 };
    if (side === "south") return { x: end.x + (dest - end.x) * ease, y: end.y - d, rot: 0 };
    if (side === "east") return { x: end.x - d, y: end.y + (dest - end.y) * ease, rot: -90 };
    return { x: end.x + d, y: end.y + (dest - end.y) * ease, rot: 90 };
  }
  // Turns already finish on `dest` — only continue forward, never slide/bounce laterally
  if (intent === "left") {
    if (side === "north") return { x: end.x + d, y: dest, rot: 90 };
    if (side === "south") return { x: end.x - d, y: dest, rot: -90 };
    if (side === "east") return { x: dest, y: end.y + d, rot: 180 };
    return { x: dest, y: end.y - d, rot: 0 };
  }
  if (side === "north") return { x: end.x - d, y: dest, rot: -90 };
  if (side === "south") return { x: end.x + d, y: dest, rot: 90 };
  if (side === "east") return { x: dest, y: end.y - d, rot: 0 };
  return { x: dest, y: end.y + d, rot: 180 };
}

function samplePath(
  side: Side,
  lane: Lane,
  intent: Intent,
  p: number,
  mergeToMiddle: boolean | null = null,
  exitLane: Lane = "straight"
): Pose {
  const pockets = driverPockets(side);
  const chosen: Lane =
    exitLane === "left" || exitLane === "straight" || exitLane === "right" ? exitLane : "straight";

  if (p <= STOP) {
    return approachPose(side, pockets[lane], p);
  }

  const leftLen = intent === "left" ? leftPathLen(side, chosen) : MANEUVER_LEN;
  const turnEnd = STOP + (intent === "left" ? leftLen : MANEUVER_LEN);
  const dest = resolveExitLat(side, intent, chosen);

  // Left: quarter-ellipse onto the exit lane, then straight out
  if (intent === "left") {
    if (p <= turnEnd) {
      const t = (p - STOP) / Math.max(0.001, leftLen);
      return sampleLeftSmooth(side, chosen, t);
    }
    const end = sampleLeftSmooth(side, chosen, 1);
    const extra = (p - turnEnd) / Math.max(0.001, EXIT_LEN / PATH_SPAN);
    return cruiseAfter(side, "left", end, extra, dest);
  }

  // Right-lane straight: stay on right until a gap opens, then ease into middle
  if (intent === "straight" && lane === "right") {
    let lat = pockets.right;
    if (mergeToMiddle === true) {
      const mergeSpan = MANEUVER_LEN * 0.65;
      const u = Math.min(1, Math.max(0, (p - STOP) / Math.max(0.001, mergeSpan)));
      const blend = u * u * (3 - 2 * u);
      lat = pockets.right + (pockets.straight - pockets.right) * blend;
    }
    const curve = maneuverCurve(side, "straight", "straight", chosen);
    if (p <= turnEnd) {
      const t = (p - STOP) / Math.max(0.001, MANEUVER_LEN);
      const alongPose = sampleCurve(curve, t);
      if (side === "north" || side === "south") {
        return { x: lat, y: alongPose.y, rot: alongPose.rot };
      }
      return { x: alongPose.x, y: lat, rot: alongPose.rot };
    }
    const end = sampleCurve(curve, 1);
    if (side === "north" || side === "south") end.x = lat;
    else end.y = lat;
    const extra = (p - turnEnd) / Math.max(0.001, EXIT_LEN / PATH_SPAN);
    return cruiseAfter(side, "straight", end, extra, dest);
  }

  const curve = maneuverCurve(side, lane, intent, chosen);

  if (p <= turnEnd) {
    const t = (p - STOP) / Math.max(0.001, MANEUVER_LEN);
    return sampleCurve(curve, t);
  }
  const end = sampleCurve(curve, 1);
  const extra = (p - turnEnd) / Math.max(0.001, EXIT_LEN / PATH_SPAN);
  return cruiseAfter(side, intent, end, extra, dest);
}

function carStyle(car: Car): CSSProperties {
  const pose = samplePath(
    car.side,
    car.lane,
    car.intent,
    Number.isFinite(car.path) ? car.path : SPAWN,
    car.mergeToMiddle,
    car.exitLane ?? "straight"
  );
  const x = Number.isFinite(pose.x) ? pose.x : 50;
  const y = Number.isFinite(pose.y) ? pose.y : 50;
  const rot = Number.isFinite(pose.rot) ? pose.rot : 0;
  return {
    left: `${x}%`,
    top: `${y}%`,
    width: 13,
    height: 13 * 0.55,
    transform: `translate(-50%, -50%) rotate(${rot}deg)`,
  };
}

/** Screen-distance per path unit — keeps approach / turn / exit at the same visual speed. */
function pathDensity(car: Car, p: number): number {
  const a = samplePath(car.side, car.lane, car.intent, p, car.mergeToMiddle, car.exitLane);
  const b = samplePath(
    car.side,
    car.lane,
    car.intent,
    p + PATH_EPS,
    car.mergeToMiddle,
    car.exitLane
  );
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  // Near-zero samples (past exit clamp) must not spike path rate — fall back to approach scale
  if (dist < 1e-6) return PATH_SPAN;
  return dist / PATH_EPS;
}
