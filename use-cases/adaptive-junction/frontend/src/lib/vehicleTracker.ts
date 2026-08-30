/**
 * Multi-object tracker for phone capture: find blobs, assign L/S/R lanes,
 * keep stable IDs, size-filter with camera distance, detect forward motion.
 */

export type Lane = "left" | "straight" | "right";
export type Intent = "left" | "straight" | "right";

export interface TrackedVehicle {
  track_id: string;
  lane: Lane;
  /** 0 = far / back of queue, 1 = near stop line. */
  depth: number;
  moving: boolean;
  intent: Intent;
  /** Pixel bbox matching the detected object (not a fixed square). */
  bbox: { x: number; y: number; w: number; h: number };
}

export interface Blob {
  cx: number;
  cy: number;
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Scale expected pixel size from real object size + camera distance. */
export interface SizeModel {
  /** Distance from camera lens to the middle of the captured scene (cm). */
  distanceMidCm: number;
  /** Real object length along the approach (cm). Toy car ≈ 6–8. */
  objectLengthCm: number;
  /** Real object width across the lane (cm). Toy car ≈ 3–4. */
  objectWidthCm: number;
  /** Phone horizontal FOV degrees (typical wide ≈ 65–75). */
  hfovDeg: number;
}

export const DEFAULT_SIZE_MODEL: SizeModel = {
  distanceMidCm: 40,
  objectLengthCm: 7,
  objectWidthCm: 3.5,
  hfovDeg: 70,
};

/** Runtime tuning from the calibration wizard (lanes, sensitivity, etc.). */
export interface TrackerTuning {
  laneSplitLeft: number;
  laneSplitRight: number;
  sensitivity: number;
  satMin: number;
}

export const DEFAULT_TUNING: TrackerTuning = {
  laneSplitLeft: 1 / 3,
  laneSplitRight: 2 / 3,
  sensitivity: 1,
  satMin: 35,
};

interface InternalTrack {
  id: string;
  cx: number;
  cy: number;
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  lane: Lane;
  depth: number;
  moving: boolean;
  intent: Intent;
  missing: number;
  /** cy history — forward = toward camera = increasing cy in our capture pose. */
  cyHist: number[];
  startedMoving: boolean;
}

export interface TrackerState {
  bg: Float32Array | null;
  frames: number;
  nextId: number;
  tracks: InternalTrack[];
}

export function createTrackerState(): TrackerState {
  return { bg: null, frames: 0, nextId: 1, tracks: [] };
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function looksLikeObject(r: number, g: number, b: number, satMin: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max - min;
  return sat > satMin && max > 50;
}

/** Reject blank / not-yet-started camera buffers so we don't count on blackness. */
export function frameLooksAlive(data: Uint8ClampedArray, sampleStep = 16): boolean {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i + 2 < data.length; i += 4 * sampleStep) {
    const lum = luminance(data[i], data[i + 1], data[i + 2]);
    sum += lum;
    sumSq += lum * lum;
    n++;
  }
  if (n < 8) return false;
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  // Flat near-black (spinner / closed shutter) → not alive
  return mean > 28 && variance > 150;
}

/**
 * Browser video loading spinner: mostly black frame with a small bright blob in the center.
 * Must not be treated as toy cars.
 */
export function looksLikeLoadingSpinner(
  data: Uint8ClampedArray,
  w: number,
  h: number
): boolean {
  let n = 0;
  let dark = 0;
  let bright = 0;
  let brightCenter = 0;
  const x0 = w * 0.3;
  const x1 = w * 0.7;
  const y0 = h * 0.3;
  const y1 = h * 0.7;

  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4;
      const lum = luminance(data[i], data[i + 1], data[i + 2]);
      n++;
      if (lum < 45) dark++;
      if (lum > 170) {
        bright++;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) brightCenter++;
      }
    }
  }
  if (n < 8) return true;
  const darkFrac = dark / n;
  const brightFrac = bright / n;
  if (darkFrac > 0.92 && brightFrac < 0.015) return true;
  if (
    darkFrac > 0.8 &&
    brightFrac > 0.001 &&
    brightFrac < 0.1 &&
    bright > 0 &&
    brightCenter / bright > 0.55
  ) {
    return true;
  }
  return false;
}

function erode(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) out[i] = 1;
    }
  }
  return out;
}

function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) out[i] = 1;
    }
  }
  return out;
}

/** LHT approach: lane from calibrated splits (defaults = equal thirds). */
export function laneFromX(
  cx: number,
  w: number,
  splitLeft = 1 / 3,
  splitRight = 2 / 3
): Lane {
  const t = cx / w;
  if (t < splitLeft) return "left";
  if (t < splitRight) return "straight";
  return "right";
}

/**
 * Assign L/S/R from left→right among cars that sit in the same “row”.
 * Three objects side-by-side (even if all in the middle of the frame) → L, S, R.
 * A queue stacked in one lane (similar x, different y) keeps calibrated frame lanes.
 */
export function assignLanesByRow(
  tracks: { cx: number; cy: number; lane: Lane }[],
  w: number,
  h: number,
  tuning: TrackerTuning = DEFAULT_TUNING
): void {
  if (tracks.length === 0) return;
  if (tracks.length === 1) {
    tracks[0].lane = laneFromX(
      tracks[0].cx,
      w,
      tuning.laneSplitLeft,
      tuning.laneSplitRight
    );
    return;
  }

  const sortedY = [...tracks].sort((a, b) => a.cy - b.cy);
  const rowTol = h * 0.18;
  const rows: (typeof tracks)[] = [];
  let row: typeof tracks = [sortedY[0]];
  for (let i = 1; i < sortedY.length; i++) {
    if (Math.abs(sortedY[i].cy - row[0].cy) <= rowTol) {
      row.push(sortedY[i]);
    } else {
      rows.push(row);
      row = [sortedY[i]];
    }
  }
  rows.push(row);

  for (const group of rows) {
    if (group.length === 1) {
      group[0].lane = laneFromX(
        group[0].cx,
        w,
        tuning.laneSplitLeft,
        tuning.laneSplitRight
      );
      continue;
    }
    const byX = [...group].sort((a, b) => a.cx - b.cx);
    const span = byX[byX.length - 1].cx - byX[0].cx;
    if (span >= w * 0.12 || byX.length >= 2) {
      if (byX.length === 2) {
        byX[0].lane = "left";
        byX[1].lane = "right";
      } else if (byX.length === 3) {
        byX[0].lane = "left";
        byX[1].lane = "straight";
        byX[2].lane = "right";
      } else {
        for (const t of byX) {
          const u = (t.cx - byX[0].cx) / Math.max(1, span);
          t.lane = u < 1 / 3 ? "left" : u < 2 / 3 ? "straight" : "right";
        }
      }
    } else {
      for (const t of group) {
        t.lane = laneFromX(t.cx, w, tuning.laneSplitLeft, tuning.laneSplitRight);
      }
    }
  }
}

/** Depth from vertical position: lower in frame (near camera) = closer to stop line. */
export function depthFromY(cy: number, h: number): number {
  return Math.min(1, Math.max(0, cy / h));
}

/**
 * Approx ground distance (cm) at image row cy.
 * Mid-frame = user distance; top (far) farther, bottom (near) closer.
 */
export function distanceAtY(cy: number, h: number, midCm: number): number {
  const t = (cy / Math.max(1, h) - 0.5) * 2; // -1 top … +1 bottom
  // Looking down a table: near ~0.65× mid, far ~1.55× mid
  const scale = 1.1 - 0.45 * t;
  return Math.max(8, midCm * scale);
}

/** Expected bbox width/height in detection pixels at this row. */
export function expectedSizePx(
  cy: number,
  frameW: number,
  frameH: number,
  model: SizeModel
): { w: number; h: number; area: number } {
  const dist = distanceAtY(cy, frameH, model.distanceMidCm);
  const hfov = (Math.max(30, Math.min(120, model.hfovDeg)) * Math.PI) / 180;
  const fx = frameW / (2 * Math.tan(hfov / 2));
  const vfov = 2 * Math.atan((frameH / frameW) * Math.tan(hfov / 2));
  const fy = frameH / (2 * Math.tan(vfov / 2));

  const w = (model.objectWidthCm / dist) * fx;
  const h = (model.objectLengthCm / dist) * fy;
  return { w, h, area: Math.max(1, w * h) };
}

function intentFor(lane: Lane, moving: boolean): Intent {
  if (lane === "left" && moving) return "left";
  if (lane === "right") return "right";
  if (lane === "left") return "left";
  return "straight";
}

function findBlobs(
  mask: Uint8Array,
  w: number,
  h: number,
  model: SizeModel
): Blob[] {
  const n = w * h;
  const visited = new Uint8Array(n);
  const blobs: Blob[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || visited[start]) continue;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const stack = [start];
      visited[start] = 1;
      while (stack.length) {
        const idx = stack.pop()!;
        area++;
        const cx = idx % w;
        const cy = (idx / w) | 0;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const nb of [idx - 1, idx + 1, idx - w, idx + w]) {
          if (nb < 0 || nb >= n || visited[nb] || !mask[nb]) continue;
          const nx = nb % w;
          const ny = (nb / w) | 0;
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          visited[nb] = 1;
          stack.push(nb);
        }
      }

      const cx = sumX / area;
      const cy = sumY / area;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw / Math.max(1, bh);
      if (aspect > 4.5 || aspect < 0.2) continue;
      if (area / (bw * bh) < 0.22) continue;

      // Reject glare crumbs / huge table patches using expected car size at this depth
      const exp = expectedSizePx(cy, w, h, model);
      const sizeRatio = Math.sqrt(area / exp.area);
      if (sizeRatio < 0.35 || sizeRatio > 2.8) continue;
      if (bw < exp.w * 0.3 || bh < exp.h * 0.3) continue;
      if (bw > exp.w * 3.2 || bh > exp.h * 3.2) continue;

      blobs.push({
        cx,
        cy,
        area,
        minX,
        maxX,
        minY,
        maxY,
      });
    }
  }
  return blobs;
}

/**
 * Run one detection + association step.
 * Point the phone so the approach fills the frame: far cars higher up, near cars lower.
 */
export function trackFrame(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  state: TrackerState,
  resetBg: boolean,
  model: SizeModel = DEFAULT_SIZE_MODEL,
  tuning: TrackerTuning = DEFAULT_TUNING
): { vehicles: TrackedVehicle[]; warming: boolean } {
  const n = w * h;

  if (resetBg || !state.bg || state.bg.length !== n) {
    state.bg = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      state.bg[p] = luminance(data[i], data[i + 1], data[i + 2]);
    }
    state.frames = 0;
    state.tracks = [];
    return { vehicles: [], warming: true };
  }

  const bg = state.bg;
  const mask = new Uint8Array(n);
  state.frames += 1;
  const learning = state.frames < 15;
  const bgRate = learning ? 0.4 : 0.015;
  const sens = Math.max(0.5, Math.min(1.6, tuning.sensitivity));
  const fgThresh = (learning ? 36 : 24) / sens;

  let fg = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = luminance(r, g, b);
    const delta = Math.abs(lum - bg[p]);
    const paint = looksLikeObject(r, g, b, tuning.satMin);
    if (delta > fgThresh || (paint && delta > fgThresh * 0.4)) {
      mask[p] = 1;
      fg++;
    } else {
      bg[p] = bg[p] * (1 - bgRate) + lum * bgRate;
    }
  }

  if (fg > n * 0.55) {
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      bg[p] = luminance(data[i], data[i + 1], data[i + 2]);
    }
    state.frames = 0;
    return {
      vehicles: state.tracks.map(exportTrack),
      warming: true,
    };
  }

  let cleaned = erode(mask, w, h);
  cleaned = dilate(cleaned, w, h);
  cleaned = dilate(cleaned, w, h);
  cleaned = erode(cleaned, w, h);

  const blobs = findBlobs(cleaned, w, h, model);
  associate(state, blobs, w, h, tuning);

  return {
    vehicles: state.tracks.map(exportTrack),
    warming: learning,
  };
}

function exportTrack(t: InternalTrack): TrackedVehicle {
  return {
    track_id: t.id,
    lane: t.lane,
    depth: t.depth,
    moving: t.moving,
    intent: t.intent,
    bbox: {
      x: t.minX,
      y: t.minY,
      w: Math.max(1, t.maxX - t.minX + 1),
      h: Math.max(1, t.maxY - t.minY + 1),
    },
  };
}

function associate(
  state: TrackerState,
  blobs: Blob[],
  w: number,
  h: number,
  tuning: TrackerTuning = DEFAULT_TUNING
): void {
  const used = new Set<number>();
  const maxDist = Math.hypot(w, h) * 0.22;

  for (const track of state.tracks) {
    let best = -1;
    let bestD = maxDist;
    for (let i = 0; i < blobs.length; i++) {
      if (used.has(i)) continue;
      const b = blobs[i];
      const d = Math.hypot(b.cx - track.cx, b.cy - track.cy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      track.missing += 1;
      continue;
    }
    used.add(best);
    const b = blobs[best];
    const prevCy = track.cy;
    track.cx = track.cx * 0.35 + b.cx * 0.65;
    track.cy = track.cy * 0.35 + b.cy * 0.65;
    track.area = b.area;
    track.minX = Math.round(track.minX * 0.35 + b.minX * 0.65);
    track.maxX = Math.round(track.maxX * 0.35 + b.maxX * 0.65);
    track.minY = Math.round(track.minY * 0.35 + b.minY * 0.65);
    track.maxY = Math.round(track.maxY * 0.35 + b.maxY * 0.65);
    track.depth = depthFromY(track.cy, h);
    track.missing = 0;
    track.cyHist.push(track.cy);
    if (track.cyHist.length > 10) track.cyHist.shift();

    if (track.cyHist.length >= 5) {
      const early = track.cyHist.slice(0, 3).reduce((a, c) => a + c, 0) / 3;
      const late = track.cyHist.slice(-3).reduce((a, c) => a + c, 0) / 3;
      const delta = late - early;
      if (delta > h * 0.025) {
        track.startedMoving = true;
      }
      if (track.cy - prevCy > h * 0.012) {
        track.startedMoving = true;
      }
    }
    track.moving = track.startedMoving;
    track.intent = intentFor(track.lane, track.moving);
  }

  state.tracks = state.tracks.filter((t) => t.missing < 8);

  for (let i = 0; i < blobs.length; i++) {
    if (used.has(i)) continue;
    const b = blobs[i];
    state.tracks.push({
      id: `t${state.nextId++}`,
      cx: b.cx,
      cy: b.cy,
      area: b.area,
      minX: b.minX,
      maxX: b.maxX,
      minY: b.minY,
      maxY: b.maxY,
      lane: "straight",
      depth: depthFromY(b.cy, h),
      moving: false,
      intent: "straight",
      missing: 0,
      cyHist: [b.cy],
      startedMoving: false,
    });
  }

  assignLanesByRow(state.tracks, w, h, tuning);
  for (const t of state.tracks) {
    t.intent = intentFor(t.lane, t.moving);
  }

  state.tracks.sort((a, b) => a.lane.localeCompare(b.lane) || a.depth - b.depth);
}

export function laneTallies(vehicles: TrackedVehicle[]): {
  left: number;
  straight: number;
  right: number;
  total: number;
} {
  const left = vehicles.filter((v) => v.lane === "left").length;
  const straight = vehicles.filter((v) => v.lane === "straight").length;
  const right = vehicles.filter((v) => v.lane === "right").length;
  return { left, straight, right, total: left + straight + right };
}
