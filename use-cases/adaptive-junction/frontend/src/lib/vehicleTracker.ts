/**
 * Simple table detector: background subtract → blobs → left / middle / right.
 * No calibration, no size model, no turn intent.
 */

export type Lane = "left" | "straight" | "right";
export type Intent = "left" | "straight" | "right";

export interface TrackedVehicle {
  track_id: string;
  lane: Lane;
  depth: number;
  moving: boolean;
  intent: Intent;
  bbox?: { x: number; y: number; w: number; h: number };
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

export interface SizeModel {
  distanceMidCm: number;
  objectLengthCm: number;
  objectWidthCm: number;
  hfovDeg: number;
}

export const DEFAULT_SIZE_MODEL: SizeModel = {
  distanceMidCm: 40,
  objectLengthCm: 7,
  objectWidthCm: 3.5,
  hfovDeg: 70,
};

export interface TrackerTuning {
  laneSplitLeft: number;
  laneSplitRight: number;
  sensitivity: number;
  satMin: number;
  calibrate?: boolean;
}

export const DEFAULT_TUNING: TrackerTuning = {
  laneSplitLeft: 1 / 3,
  laneSplitRight: 2 / 3,
  sensitivity: 1,
  satMin: 40,
};

const LEARN_FRAMES = 12;
const MIN_AREA = 70;
const MIN_W = 12;
const MIN_H = 10;
const MAX_TRACKS = 10;
const FG = 26;

interface Track {
  id: string;
  cx: number;
  cy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  missing: number;
}

export interface TrackerState {
  bg: Float32Array | null;
  frames: number;
  nextId: number;
  tracks: Track[];
}

export function createTrackerState(): TrackerState {
  return { bg: null, frames: 0, nextId: 1, tracks: [] };
}

function lum(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function expectedSizePx(
  _cy: number,
  _frameW: number,
  _frameH: number,
  _model: SizeModel
): { w: number; h: number; area: number } {
  return { w: 40, h: 28, area: 1120 };
}

export function frameLooksAlive(data: Uint8ClampedArray, step = 16): boolean {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < data.length; i += 4 * step) {
    sum += lum(data[i], data[i + 1], data[i + 2]);
    n++;
  }
  return n > 8 && sum / n > 10;
}

export function looksLikeLoadingSpinner(
  data: Uint8ClampedArray,
  w: number,
  h: number
): boolean {
  let n = 0;
  let dark = 0;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      n++;
      if (lum(data[i], data[i + 1], data[i + 2]) < 40) dark++;
    }
  }
  return n > 0 && dark / n > 0.94;
}

function laneOf(cx: number, w: number): Lane {
  const t = cx / w;
  if (t < 1 / 3) return "left";
  if (t < 2 / 3) return "straight";
  return "right";
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

function findBlobs(mask: Uint8Array, w: number, h: number): Blob[] {
  const n = w * h;
  const seen = new Uint8Array(n);
  const blobs: Blob[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || seen[start]) continue;
      let area = 0;
      let sx = 0;
      let sy = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const idx = stack.pop()!;
        area++;
        const cx = idx % w;
        const cy = (idx / w) | 0;
        sx += cx;
        sy += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const nb of [idx - 1, idx + 1, idx - w, idx + w]) {
          if (nb < 0 || nb >= n || seen[nb] || !mask[nb]) continue;
          const nx = nb % w;
          const ny = (nb / w) | 0;
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          seen[nb] = 1;
          stack.push(nb);
        }
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (area < MIN_AREA || bw < MIN_W || bh < MIN_H) continue;
      if (area / (bw * bh) < 0.22) continue;
      blobs.push({
        cx: sx / area,
        cy: sy / area,
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

/** Two toys sitting side by side often join after dilate — cut at the thinnest column. */
function splitWide(blob: Blob, mask: Uint8Array, w: number): Blob[] {
  const bw = blob.maxX - blob.minX + 1;
  const bh = blob.maxY - blob.minY + 1;
  if (bw < 48 || bw < bh * 1.35) return [blob];

  let bestX = -1;
  let best = 1e9;
  const lo = blob.minX + Math.floor(bw * 0.25);
  const hi = blob.maxX - Math.floor(bw * 0.25);
  let peak = 0;
  for (let x = blob.minX; x <= blob.maxX; x++) {
    let col = 0;
    for (let y = blob.minY; y <= blob.maxY; y++) {
      if (mask[y * w + x]) col++;
    }
    if (col > peak) peak = col;
    if (x >= lo && x <= hi && col < best) {
      best = col;
      bestX = x;
    }
  }
  if (bestX < 0 || peak < 4 || best > peak * 0.4) return [blob];

  const left: Blob = {
    cx: 0,
    cy: 0,
    area: 0,
    minX: blob.minX,
    maxX: bestX - 1,
    minY: blob.minY,
    maxY: blob.maxY,
  };
  const right: Blob = {
    cx: 0,
    cy: 0,
    area: 0,
    minX: bestX + 1,
    maxX: blob.maxX,
    minY: blob.minY,
    maxY: blob.maxY,
  };
  for (const part of [left, right]) {
    let sx = 0;
    let sy = 0;
    let a = 0;
    let minX = part.maxX;
    let maxX = part.minX;
    let minY = part.maxY;
    let maxY = part.minY;
    for (let y = blob.minY; y <= blob.maxY; y++) {
      for (let x = part.minX; x <= part.maxX; x++) {
        if (!mask[y * w + x]) continue;
        a++;
        sx += x;
        sy += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (a < MIN_AREA) return [blob];
    part.area = a;
    part.cx = sx / a;
    part.cy = sy / a;
    part.minX = minX;
    part.maxX = maxX;
    part.minY = minY;
    part.maxY = maxY;
  }
  return [left, right];
}

function iou(
  a: { minX: number; maxX: number; minY: number; maxY: number },
  b: { minX: number; maxX: number; minY: number; maxY: number }
): number {
  const x1 = Math.max(a.minX, b.minX);
  const y1 = Math.max(a.minY, b.minY);
  const x2 = Math.min(a.maxX, b.maxX);
  const y2 = Math.min(a.maxY, b.maxY);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const aa = (a.maxX - a.minX) * (a.maxY - a.minY);
  const bb = (b.maxX - b.minX) * (b.maxY - b.minY);
  return inter / (aa + bb - inter);
}

export function trackFrame(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  state: TrackerState,
  resetBg: boolean,
  _model?: SizeModel,
  _tuning?: TrackerTuning
): { vehicles: TrackedVehicle[]; warming: boolean } {
  const n = w * h;

  if (resetBg || !state.bg || state.bg.length !== n) {
    state.bg = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      state.bg[p] = lum(data[i], data[i + 1], data[i + 2]);
    }
    state.frames = 0;
    state.tracks = [];
    return { vehicles: [], warming: true };
  }

  const bg = state.bg;
  const mask = new Uint8Array(n);
  state.frames += 1;
  const warming = state.frames < LEARN_FRAMES;
  const rate = warming ? 0.25 : 0.006;

  let fg = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const v = lum(data[i], data[i + 1], data[i + 2]);
    const d = Math.abs(v - bg[p]);
    const dark = v < 58 && bg[p] > 88 && d > 16;
    if (d > FG || dark) {
      mask[p] = 1;
      fg++;
    } else {
      bg[p] += (v - bg[p]) * rate;
    }
  }

  if (fg > n * 0.7 && state.tracks.length === 0) {
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      bg[p] = lum(data[i], data[i + 1], data[i + 2]);
    }
    state.frames = 0;
    return { vehicles: [], warming: true };
  }

  let cleaned = erode(mask, w, h);
  cleaned = dilate(cleaned, w, h);

  const raw = findBlobs(cleaned, w, h);
  const split: Blob[] = [];
  for (const b of raw) split.push(...splitWide(b, cleaned, w));

  split.sort((a, b) => b.area - a.area);
  const blobs: Blob[] = [];
  for (const b of split) {
    if (blobs.some((u) => iou(u, b) > 0.35)) continue;
    blobs.push(b);
    if (blobs.length >= MAX_TRACKS) break;
  }

  const used = new Set<number>();
  for (const t of state.tracks) {
    let best = -1;
    let bestD = 40;
    for (let i = 0; i < blobs.length; i++) {
      if (used.has(i)) continue;
      const b = blobs[i];
      const d = Math.hypot(b.cx - t.cx, b.cy - t.cy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      t.missing += 1;
      continue;
    }
    used.add(best);
    const b = blobs[best];
    t.cx = b.cx;
    t.cy = b.cy;
    t.minX = b.minX;
    t.maxX = b.maxX;
    t.minY = b.minY;
    t.maxY = b.maxY;
    t.missing = 0;
  }

  state.tracks = state.tracks.filter((t) => t.missing < 2);

  for (let i = 0; i < blobs.length; i++) {
    if (used.has(i)) continue;
    if (state.tracks.length >= MAX_TRACKS) break;
    const b = blobs[i];
    if (state.tracks.some((t) => iou(t, b) > 0.25)) continue;
    state.tracks.push({
      id: `t${state.nextId++}`,
      cx: b.cx,
      cy: b.cy,
      minX: b.minX,
      maxX: b.maxX,
      minY: b.minY,
      maxY: b.maxY,
      missing: 0,
    });
  }

  const vehicles: TrackedVehicle[] = state.tracks
    .filter((t) => t.missing === 0)
    .map((t) => ({
      track_id: t.id,
      lane: laneOf(t.cx, w),
      depth: Math.min(1, Math.max(0, t.cy / h)),
      moving: false,
      intent: "straight" as Intent,
      bbox: {
        x: t.minX,
        y: t.minY,
        w: Math.max(1, t.maxX - t.minX + 1),
        h: Math.max(1, t.maxY - t.minY + 1),
      },
    }));

  return { vehicles, warming };
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
