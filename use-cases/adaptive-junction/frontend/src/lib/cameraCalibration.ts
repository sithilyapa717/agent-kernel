/**
 * Per-side camera calibration profile: size, lanes, sensitivity, ROI, quality.
 * Saved in localStorage so each phone approach keeps its own tuning.
 */

import {
  DEFAULT_SIZE_MODEL,
  type Blob,
  type SizeModel,
  type TrackedVehicle,
} from "./vehicleTracker";

export interface CamRoi {
  /** Fraction of frame to crop from each edge (0–0.3). */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface CamProfile {
  size: SizeModel;
  /** x/width boundary between left and straight. */
  laneSplitLeft: number;
  /** x/width boundary between straight and right. */
  laneSplitRight: number;
  /** 0.6 = pickier, 1.4 = more sensitive. */
  sensitivity: number;
  /** Min RGB saturation for “coloured object” boost. */
  satMin: number;
  roi: CamRoi;
  focusCm: number | null;
  qualityScore: number;
  calibratedAt: string | null;
  /** Which physical camera this profile belongs to (phones differ per side). */
  camera: CamIdentity | null;
}

export interface CamIdentity {
  deviceId: string;
  label: string;
  facingMode?: string;
  width?: number;
  height?: number;
}

export const DEFAULT_CAM_PROFILE: CamProfile = {
  size: { ...DEFAULT_SIZE_MODEL },
  laneSplitLeft: 1 / 3,
  laneSplitRight: 2 / 3,
  sensitivity: 0.55,
  satMin: 80,
  roi: { top: 0.05, bottom: 0.05, left: 0.02, right: 0.02 },
  focusCm: null,
  qualityScore: 0,
  calibratedAt: null,
  camera: null,
};

export type CalibStep =
  | "idle"
  | "background"
  | "lighting"
  | "size"
  | "lanes"
  | "done";

export interface FrameQuality {
  mean: number;
  variance: number;
  glareFrac: number;
  darkFrac: number;
  contrast: number;
  score: number;
  tips: string[];
}

// v4: ignore far focus-sensor distances that treated wood grain as cars
function profileKey(side: string, deviceId?: string | null): string {
  const id = (deviceId || "default").replace(/[^\w-]+/g, "").slice(0, 48) || "default";
  return `junction-cam-profile-v4-${side}-${id}`;
}

function legacySideKey(side: string): string {
  return `junction-cam-profile-v4-${side}`;
}

/** Table-demo range. Phone focus often reports ~1 m and that is not usable. */
export function usableTableDistanceCm(cm: number | null | undefined): number | null {
  if (cm == null || !Number.isFinite(cm)) return null;
  if (cm < 15 || cm > 80) return null;
  return Math.round(cm);
}

function saneLaneSplits(
  left?: number,
  right?: number
): { laneSplitLeft: number; laneSplitRight: number } {
  const l = left ?? 1 / 3;
  const r = right ?? 2 / 3;
  if (r - l < 0.2 || l < 0.22 || r < 0.5 || r > 0.82) {
    return { laneSplitLeft: 1 / 3, laneSplitRight: 2 / 3 };
  }
  return { laneSplitLeft: l, laneSplitRight: r };
}

export function loadCamProfile(side: string, deviceId?: string | null): CamProfile {
  try {
    const keys = [profileKey(side, deviceId), legacySideKey(side)];
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<CamProfile>;
      const splits = saneLaneSplits(parsed.laneSplitLeft, parsed.laneSplitRight);
      return {
        ...DEFAULT_CAM_PROFILE,
        ...parsed,
        ...splits,
        size: { ...DEFAULT_SIZE_MODEL, ...(parsed.size ?? {}) },
        roi: { ...DEFAULT_CAM_PROFILE.roi },
        camera: parsed.camera ?? null,
      };
    }
    return structuredClone(DEFAULT_CAM_PROFILE);
  } catch {
    return structuredClone(DEFAULT_CAM_PROFILE);
  }
}

export function saveCamProfile(side: string, profile: CamProfile): void {
  try {
    const key = profileKey(side, profile.camera?.deviceId);
    localStorage.setItem(key, JSON.stringify(profile));
    // Also keep side-only mirror for quick load before deviceId is known
    localStorage.setItem(legacySideKey(side), JSON.stringify(profile));
  } catch {
    /* ignore quota */
  }
}

export function readCamIdentity(track: MediaStreamTrack | null): CamIdentity | null {
  if (!track) return null;
  const settings = track.getSettings();
  return {
    deviceId: settings.deviceId || track.id || "unknown",
    label: track.label || settings.deviceId || "Camera",
    facingMode: settings.facingMode,
    width: settings.width,
    height: settings.height,
  };
}

/** True when saved profile was for a different physical camera than the one open now. */
export function cameraMismatch(profile: CamProfile, current: CamIdentity | null): boolean {
  if (!profile.calibratedAt || !profile.camera?.deviceId || !current?.deviceId) return false;
  return profile.camera.deviceId !== current.deviceId;
}

/**
 * If the user measures mid-distance with a tape, solve this phone's HFOV from the
 * measured object width in pixels (each phone lens is different).
 */
export function hfovFromTapeAndWidth(
  measuredWpx: number,
  objectWidthCm: number,
  tapeMidCm: number,
  frameW: number
): number {
  const fx = (measuredWpx * Math.max(8, tapeMidCm)) / Math.max(0.5, objectWidthCm);
  const hfov = (2 * Math.atan(frameW / (2 * Math.max(1, fx))) * 180) / Math.PI;
  return Math.max(40, Math.min(100, Math.round(hfov)));
}

export function analyzeFrameQuality(data: Uint8ClampedArray, step = 8): FrameQuality {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  let glare = 0;
  let dark = 0;
  let min = 255;
  let max = 0;

  for (let i = 0; i + 2 < data.length; i += 4 * step) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
    sumSq += lum * lum;
    n++;
    if (lum > 235) glare++;
    if (lum < 35) dark++;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }

  const mean = n ? sum / n : 0;
  const variance = n ? sumSq / n - mean * mean : 0;
  const glareFrac = n ? glare / n : 0;
  const darkFrac = n ? dark / n : 0;
  const contrast = max - min;

  let score = 70;
  const tips: string[] = [];

  if (mean < 45) {
    score -= 25;
    tips.push("Scene is dark — add light or raise exposure");
  } else if (mean > 200) {
    score -= 20;
    tips.push("Scene is washed out — reduce glare / bright lights");
  } else {
    score += 10;
  }

  if (glareFrac > 0.12) {
    score -= 30;
    tips.push("Strong glare on the table — matte surface or change angle");
  } else if (glareFrac > 0.05) {
    score -= 12;
    tips.push("Some specular highlights — tilt phone slightly");
  }

  if (variance < 200) {
    score -= 15;
    tips.push("Low contrast — need clearer separation from the table");
  } else if (variance > 800) {
    score += 8;
  }

  if (contrast < 40) {
    score -= 15;
    tips.push("Flat lighting — use side light so toys stand out");
  }

  if (darkFrac > 0.55) {
    score -= 10;
    tips.push("Large dark regions — check framing / lens cover");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (tips.length === 0) tips.push("Lighting looks usable for tracking");

  return { mean, variance, glareFrac, darkFrac, contrast, score, tips };
}

/** Back-solve camera→mid distance from a measured object width in pixels. */
export function distanceFromMeasuredWidth(
  measuredWpx: number,
  objectWidthCm: number,
  frameW: number,
  hfovDeg: number
): number {
  const hfov = (Math.max(30, Math.min(120, hfovDeg)) * Math.PI) / 180;
  const fx = frameW / (2 * Math.tan(hfov / 2));
  const dist = (objectWidthCm * fx) / Math.max(1, measuredWpx);
  return Math.max(10, Math.min(250, Math.round(dist)));
}

/** Back-solve distance from measured height (object length along road). */
export function distanceFromMeasuredHeight(
  measuredHpx: number,
  objectLengthCm: number,
  frameW: number,
  frameH: number,
  hfovDeg: number
): number {
  const hfov = (Math.max(30, Math.min(120, hfovDeg)) * Math.PI) / 180;
  const vfov = 2 * Math.atan((frameH / frameW) * Math.tan(hfov / 2));
  const fy = frameH / (2 * Math.tan(vfov / 2));
  const dist = (objectLengthCm * fy) / Math.max(1, measuredHpx);
  return Math.max(10, Math.min(250, Math.round(dist)));
}

/** Average distance estimate from width + height measurements. */
export function refineDistanceFromBlob(
  blob: { w: number; h: number },
  size: SizeModel,
  frameW: number,
  frameH: number
): number {
  const dW = distanceFromMeasuredWidth(blob.w, size.objectWidthCm, frameW, size.hfovDeg);
  const dH = distanceFromMeasuredHeight(
    blob.h,
    size.objectLengthCm,
    frameW,
    frameH,
    size.hfovDeg
  );
  return Math.round((dW + dH) / 2);
}

/** Lane splits from three side-by-side detections (left→right). */
export function laneSplitsFromThree(cxSorted: number[], frameW: number): {
  laneSplitLeft: number;
  laneSplitRight: number;
} {
  if (cxSorted.length < 3) {
    return { laneSplitLeft: 1 / 3, laneSplitRight: 2 / 3 };
  }
  const [a, b, c] = cxSorted;
  let left = (a + b) / 2 / frameW;
  let right = (b + c) / 2 / frameW;
  left = Math.min(0.42, Math.max(0.25, left));
  right = Math.min(0.78, Math.max(0.55, right));
  if (right - left < 0.18) {
    return { laneSplitLeft: 1 / 3, laneSplitRight: 2 / 3 };
  }
  return { laneSplitLeft: left, laneSplitRight: right };
}

/** Suggest ROI that tightens around current detections + margin. */
export function suggestRoiFromTracks(
  _vehicles: TrackedVehicle[],
  _frameW: number,
  _frameH: number
): CamRoi {
  // Keep almost the full frame — a tight crop drops the far-left / far-right toy.
  return { top: 0.04, bottom: 0.04, left: 0.02, right: 0.02 };
}

/** Pick the blob closest to frame center (for size calibration). */
export function pickCenterBlob(blobs: Blob[], frameW: number, frameH: number): Blob | null {
  if (!blobs.length) return null;
  const cx = frameW / 2;
  const cy = frameH / 2;
  let best = blobs[0];
  let bestD = Infinity;
  for (const b of blobs) {
    const d = Math.hypot(b.cx - cx, b.cy - cy);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

export function sensitivityLabel(s: number): string {
  if (s < 0.6) return "very strict";
  if (s < 0.85) return "strict";
  if (s > 1.15) return "loose";
  return "normal";
}
